# CFO Co-Pilot — Product Requirements Document

> **An AI that doesn't just warn you that you're running out of cash — it goes and collects the money, then decides what you can safely spend.**

**Read this as the specification, not as a description of the shipped build.** Sections marked **Not built** or **Built differently** did not survive the time box. Where this document and the code disagree, the code wins; the README's *What's real vs. staged* and *Known limitations* sections are the authoritative account of what actually exists.

The main divergences, up front:

| Spec says | Built |
| --- | --- |
| Cloudflare Workflows for approval and collection runs | Not built. The Durable Object is already durable and its alarm provides scheduling. |
| D1 for the historical ledger | Not built. State is one JSON blob in Durable Object storage. |
| Workers AI / any model binding | Not built. There are exactly two bindings, `ASSETS` and `COMPANY_AGENT`. The LLM is a plain `fetch` to a configurable OpenAI-compatible URL, off by default. |
| AI drafts collection emails | Built differently, on purpose. Emails are deterministic hand-written templates on a tone ladder. See §7. |
| AI parses inbound replies | Not built. The commitment is injected directly. See §7. |
| Counterfactual replay proves the agent's judgement | Overstated. It demonstrates the mechanism over a synthetic fixture. See §13. |
| Chat over the audit trail (§16) | Not built. |
| Monthly burn, runway, budget variance, vendor price movement (§14) | Not built. |

---

## 1. Product Overview

**CFO Co-Pilot** is an autonomous financial operator for startups and small finance teams.

It is not a reporting tool. It re-forecasts on its own schedule, and when the projection breaches the safety threshold it acts without a human, on **both sides of the company's cash position**:

| Side | What the agent does | Trigger |
| --- | --- | --- |
| **Inflow** | Detects a future cash shortfall and acts to prevent it — chases the right overdue receivables, sends real collection emails, folds committed cash back into the forecast | Autonomous (Durable Object alarm, re-armed every 20s) |
| **Outflow** | Evaluates spend requests against budgets, history, vendor record, and the live forecast; approves within delegated authority, escalates when marginal | Event (request submitted) |

**As built, precisely.** The alarm is real, re-arms every 20 seconds, and the whole detect → rank → chase sequence runs unattended. Two qualifications: the alarm is only armed the first time `getDashboardState()` is called, so a page has to have been loaded once; and `TODAY` in `src/db/seed.ts` is a frozen constant, so the clock never advances and no event ever arises by itself — in this build the shortfall exists because a human POSTs `/api/demo/shock`. The claim that survives is the one that matters: **when the forecast breaches, the agent detects it and acts on its own, with nobody in the loop.** It is not "always on" in the sense of an unattended production service.

The two sides share the same state, which means **the agent's own actions compound**: cash it recovers on Tuesday changes what it is willing to approve on Wednesday — and it can tell you exactly that.

### Positioning

Not *"an AI that replaces the CFO."*

> **The AI financial operator that defends your cash position and makes routine spending decisions within the authority you delegate — and escalates the ones that actually need you.**

---

## 2. Problem

Finance teams spend most of their time on two repetitive loops.

**The collection loop.** Cash is projected to get tight. Someone has to notice, work out which receivables matter, write the chase emails, follow up, track replies, and update the forecast. It is entirely mechanical and it is almost always done late — after the shortfall is visible, not before.

**The approval loop.** Requests arrive. Someone checks the budget, looks at what this department spent last quarter, checks whether the vendor is known, estimates the cash impact, and approves or escalates. Most of these decisions are routine. All of them cost attention.

Existing software gives you **dashboards and approval workflows**. The human still interprets and still decides.

The shift:

**Data → Dashboard → Human analysis → Decision**

to

**Data → Agent analysis → Autonomous action → Escalation only when it matters**

---

## 3. Core Philosophy

Three principles drive every design decision in this document.

**1. The agent acts, it doesn't report.**
If the only output is a number on a screen, it isn't autonomous. The agent must do things while nobody is logged in. *(Held in the build for the collection loop, with the frozen-clock caveat in §1.)*

**2. Autonomy is bounded by reversibility, not by caution.**
The agent acts freely where being wrong is cheap and recoverable — collecting money, deferring payments, drafting emails. It never moves money out on its own beyond explicitly delegated authority. This is what makes real autonomy defensible.

**3. Authority is a ceiling, not a rule.**
`request < limit` is not a decision. The limit is the maximum authority the CFO has delegated; the agent still judges whether exercising it is sound. This is the central idea of the product.

---

## 4. Target User

**Primary:** CFO / Finance Head at a startup or SME — responsible for cash, budgets, approvals, and financial risk, usually without a large team.

**Secondary:** finance associates, department heads submitting requests, founders.

---

## 5. Goals and Non-Goals

### Goals

1. Detect projected cash shortfalls **before** they occur.
2. Autonomously act to close those shortfalls through reversible actions.
3. Autonomously handle routine spend approvals within delegated authority.
4. Escalate precisely — only when human judgment genuinely adds value.
5. Make every autonomous action fully auditable and explainable.

### Non-Goals (explicitly out of scope)

The agent does **not** make strategic decisions: fundraising, M&A, hiring strategy, restructuring, capital allocation.

The agent does **not** initiate outbound payments or transfers.

The following are deliberately **cut from the MVP** to protect build time:

- Multi-panel financial dashboard (~25 metrics)
- Dedicated AR / AP browsing screens
- Natural-language → policy rule compiler
- Open-ended chat over financial data
- Accuracy/efficiency success metrics that cannot be measured without ground truth

Anything that is not in service of the two USPs is not built.

---

## 6. System Concept — The Cash Loop

```text
                    ┌──────────────────────────┐
                    │   Financial Engine       │
                    │   (deterministic)        │
                    │   forecast + headroom    │
                    └───────────┬──────────────┘
                                │
              ┌─────────────────┴─────────────────┐
              │                                   │
    ┌─────────▼──────────┐            ┌───────────▼─────────┐
    │  USP 1 — INFLOW    │            │  USP 2 — OUTFLOW    │
    │  Cash Defense      │            │  Delegated Approval │
    │                    │            │                     │
    │  breach detected   │            │  request received   │
    │  → chase AR        │            │  → evaluate         │
    │  → send emails     │            │  → approve/escalate │
    │  → book commitment │            │  → reserve headroom │
    └─────────┬──────────┘            └───────────┬─────────┘
              │                                   │
              └─────────────────┬─────────────────┘
                                │
                       ┌────────▼─────────┐
                       │  Shared State    │
                       │  headroom ledger │
                       │  audit trail     │
                       └──────────────────┘
```

Recovered cash raises the projected minimum, and headroom is derived from it. Approvals reserve against headroom. Both write to the same state, inside the same single-threaded object. That coupling is the product.

---

## 7. USP #1 — Autonomous Cash Defense (Inflow)

### Objective

Detect a future breach of the CFO's cash safety threshold and **act to prevent it**, without being asked.

### Trigger

Not a button. The agent wakes itself:

- **Scheduled:** a Durable Object alarm re-arms every 20 seconds and re-forecasts on each wake. Production would be daily; 20s exists so the behaviour is visible inside a three-minute demo.
- **Conditional:** the alarm fires unconditionally; the *defense routine* only acts if `projected_minimum_cash < safety_threshold` somewhere in the horizon. A healthy forecast produces no log entry at all, deliberately — an idle agent should not write "nothing to do" every twenty seconds.
- **On read:** the forecast is also recomputed on every dashboard read and inside every spend decision, so it is never served stale.

**As built:** the alarm is armed the first time `getDashboardState()` is called, so a page load bootstraps the loop. `TODAY` is a frozen constant, so no event ever arises on its own — a shortfall has to be introduced. Everything after that is unattended, including the re-chase suppression that stops the agent emailing the same customer every twenty seconds while a reply is outstanding.

### Action sequence

1. **Diagnose.** Identify the week of the projected breach and the magnitude of the gap.
2. **Select targets.** Rank overdue receivables by a deterministic score: amount, days overdue, customer payment history, and whether collection lands *before* the breach week. Chasing ₹20L that arrives after the shortfall is useless — timing is part of the ranking.
3. **Act.** Send collection emails to the selected customers. Tone escalates with days overdue: gentle under 15 days, firm from 15 to 45, serious beyond 45.

   **Built differently, and deliberately.** The email text is *not* drafted by a model. `src/adapters/email.ts` holds three hand-written templates chosen by that tone ladder, with only the figures interpolated. This is a design decision, not a shortcut: the message goes out under the company's name to a paying customer, so a fluent-but-wrong sentence is a commercial problem rather than a cosmetic one. Writing it once, by a human, means the copy is reviewable, identical every run, and cannot drift between rehearsal and the live demo. The engine still decides *which* customers, *which* tone, and *what* amounts — the judgement is automated, the prose is not.
4. **Listen.** **Not built.** There is no inbound email route and no reply parser. `injectReply` on the Durable Object writes the commitment straight into state, and is invoked from `/api/demo/inject-reply`. Everything downstream of that write is real.
5. **Update.** Confirmed commitments are folded into the forecast as expected collections with the stated date, overriding the customer's historical lag estimate. Headroom is recalculated. This part is fully implemented.
6. **Report.** Everything above is written to the activity log and surfaced in the UI.

### Guardrails

- Only receivables that are genuinely overdue are eligible.
- One chase per invoice per cooldown window — no spamming.
- Any customer flagged `sensitive` is escalated to the CFO for manual sending instead of auto-sent.
- Emails are logged verbatim in the audit trail.

### Why this is safe to automate

Worst case is an unnecessary polite email to a customer who already owes the money. Nothing irreversible happens. This is what allows genuine autonomy without an accountability problem.

---

## 8. USP #2 — Delegated Authority with Judgment (Outflow)

### The configuration

The CFO sets:

| Setting | Demo value |
| --- | --- |
| Autonomous approval limit (per request) | ₹5,00,000 |
| Cash safety threshold | ₹25,00,000 |
| Forecast horizon | 13 weeks |

### The central idea

The agent must **not** decide by checking `request ≤ limit`.

> **The limit is the maximum authority delegated to the agent. It is not permission to approve.**

Within that authority the agent still evaluates:

- Department budget remaining for the period
- Current-period spend by that department
- Similar historical requests — is this amount normal for this category?
- Vendor record — known vendor or first-time vendor. **As built this is a presence test only:** `ruleRequireVendorHistory` checks `vendor.invoiceCount > 0` and nothing else. There is no price-movement or per-vendor price-anomaly check; the vendor's `avgAmount` is displayed in the audit trail but never compared against.
- **Projected cash impact against the live forecast**
- Remaining headroom after the request is committed

### Worked example — approve

> **AUTO-APPROVED — ₹3.2L, Engineering, cloud infrastructure**
>
> Within ₹5L delegated authority.
> Engineering has ₹8.4L remaining in its quarterly infrastructure budget.
> Comparable requests last quarter averaged ₹2.9L — this is in range.
> Vendor has 14 prior invoices.
> Projected minimum cash after commitment: ₹31.2L, ₹6.2L above your ₹25L threshold.

### Worked example — escalate despite being under the limit

> **ESCALATED — ₹4.5L, Marketing, campaign spend**
>
> This is within your ₹5L authority, but committing it would reduce projected minimum cash from ₹19.4L to ₹14.9L — and the forecast is already ₹5.6L below your ₹25L safety threshold, so there is no headroom to spend against at all.
>
> Marketing is at 90% of its quarterly budget, comfortably inside the 10% overage allowance, so the budget rule is not what stopped this.
>
> **Reason:** insufficient headroom — a soft rule, which escalates rather than rejects.
> **Recommended:** CFO review, or defer until the collection lands.

*(Corrected against the fixture. The earlier draft of this example claimed Marketing was 25% over budget and called it a hard rule violation; both were wrong. Marketing's `periodSpend` is ₹9L against a ₹15L quarterly budget, and a hard rule violation would have produced REJECT, not ESCALATE. `test/scenario.test.ts` asserts this request escalates on `insufficient_headroom`.)*

### Worked example — reject

> **REJECTED — ₹6.2L, Operations, new vendor**
>
> One hard rule violated: the vendor has no prior transaction history, and your rules require human approval for first-time vendors. That alone forces the rejection.
>
> The ₹6.2L amount does also exceed your ₹5L autonomous limit — but that limit is a **soft** rule (`severity: "soft"` in `src/engine/rules.ts`). On its own it escalates; it never rejects. The distinction matters: the authority ceiling bounds what the agent may do alone, it is not a policy the requester broke.
>
> Routed to you. No autonomous action taken.

---

## 9. Authority as a Consumable Resource

This is the mechanic most approval systems miss.

Two requests that each individually pass can **jointly** breach the threshold. Evaluating each against a static snapshot is wrong.

### Headroom

```text
headroom = projected_minimum_cash − safety_threshold
```

Every approval **reserves** against headroom immediately, before the money actually moves — the reservation is booked into the forecast as a future outflow, which is what pulls the projected minimum down.

Recovered cash works the other way but not symmetrically: it does not *release* a reservation. A commitment raises the projected minimum, and since headroom is defined as the trough minus the threshold, more headroom falls out. Nothing is un-reserved.

All requests are evaluated against *current* headroom, and evaluation is serialized: every request goes through one Durable Object instance, and between reading headroom and writing the reservation there is no `fetch`, so two concurrent requests cannot both observe the same balance.

### Worked sequence

| Event | Projected min | Headroom | Outcome |
| --- | --- | --- | --- |
| Baseline after collection recovery | ₹34.4L | ₹9.4L | — |
| Engineering requests ₹3.2L | ₹31.2L | ₹6.2L | **APPROVED** |
| Marketing requests ₹4.5L | ₹26.7L | ₹1.7L | **APPROVED** |
| Sales requests ₹2.8L | — | would be −₹1.1L | **ESCALATED** |

The Sales request is under the ₹5L limit, within its department budget, from a trusted vendor, and consistent with history. It escalates purely because **the earlier two approvals consumed the buffer**.

> **ESCALATED — ₹2.8L, Sales**
>
> Nothing is wrong with this request. I have ₹1.7L of headroom left this cycle after approving ₹3.2L (Engineering) and ₹4.5L (Marketing) earlier today. Approving this would put projected minimum cash at ₹23.9L, below your ₹25L threshold.
>
> **Options:** approve and accept the breach, defer to next cycle, or let me chase ₹4L more in receivables first.

### Optional second dimension — not built

A rolling authority pool (e.g. ₹10L per 7 days) could be layered on top of headroom to bound total autonomous spend independent of cash position. It was not implemented; headroom is the only consumable dimension in the build.

---

## 10. Decision Engine

### Division of labour — non-negotiable

| Layer | Responsibility |
| --- | --- |
| **Deterministic engine** | Computes the forecast. Applies rules. **Makes the decision.** Writes the audit record and a fallback narration for every outcome. |
| **AI layer** | Restates a decision that has already been committed. Nothing else. |

**As built, the AI layer is smaller than this section originally claimed.** It does not draft emails (deterministic templates — §7), does not parse replies (not implemented — §7), and does not answer questions (chat not built — §16). What remains is narration, and even that is optional: `LLM_PROVIDER` defaults to `none`, `src/engine/decision.ts` produces a deterministic `fallbackNarration` for every outcome at decision time, and the LLM call is fired afterwards through `waitUntil` and merged in only if it returns. The adapter returns `null` on timeout, non-200, or malformed JSON rather than throwing.

**The model never decides where money goes.** `src/engine/` contains no model call of any kind. This is both the correct engineering choice and the answer to every trust question a reviewer will ask. It also makes the demo deterministic — the outcome cannot flip on stage.

### Precedence order

Evaluated top-down; first match wins.

```text
1. Hard rule violation           → REJECT
2. Amount exceeds authority      → ESCALATE
3. Insufficient headroom         → ESCALATE
4. Anomaly vs. history / vendor  → ESCALATE
5. Otherwise                     → APPROVE
```

This resolves the ambiguity between REJECT and ESCALATE: **rejection means a configured rule was broken; escalation means the agent has authority but judges the call to need a human.**

### Reserve / commit lifecycle

```text
PENDING → (engine evaluates, serialized) → APPROVED   → headroom reserved
                                        → ESCALATED   → no reservation, CFO queue
                                        → REJECTED    → no reservation, closed

APPROVED → PAID     → reservation converted to actual outflow
         → CANCELLED → reservation released
```

Every request carries an idempotency key. Re-submission cannot double-reserve.

---

## 11. CFO Rules

For the MVP these are **structured and hardcoded**, presented in the UI as readable statements. No natural-language compiler.

| Rule | Structured form | Severity as built |
| --- | --- | --- |
| AI can approve up to ₹5L | `max_autonomous_amount = 500000` | **Soft** |
| Approval must fit remaining headroom | `headroom_check` (derived) | **Soft** |
| Never let cash fall below ₹25L | `min_cash_threshold = 2500000` | **Soft** |
| Departments may exceed budget by max 10% | `max_budget_overage = 0.10` | Hard |
| New vendors require human approval | `require_vendor_history = true` | Hard |
| Flag requests >2× the category historical average | `anomaly_multiplier = 2.0` | Soft |

Hard rules produce REJECT. Soft rules produce ESCALATE.

**Corrected against `src/engine/rules.ts`.** An earlier draft of this table marked the ₹5L authority limit and the ₹25L cash threshold as Hard. Both are `severity: "soft"` in the code, and that is the right call — exceeding the agent's own authority ceiling is not a policy the requester broke, it is the boundary of what the agent may do alone, so it hands the request to the CFO rather than refusing it. Only two rules can reject: department budget overage, and first-time vendor. The table also omitted `headroom_check`, which is the rule that makes authority consumable and therefore the most load-bearing one in the product.

---

## 12. Audit Trail

Every autonomous action — approval, escalation, rejection, and every collection email — produces an immutable record.

```text
DECISION      APPROVED · ₹3,20,000 · Engineering · 2026-09-07 14:22 IST

RULES APPLIED
  ✓ max_autonomous_amount     3.2L ≤ 5.0L
  ✓ budget_overage            Engineering at 76.4% of quarterly budget
  ✓ require_vendor_history    vendor has 14 prior invoices
  ✓ anomaly_multiplier        3.2L vs 2.9L category average (1.1×)
  ✓ headroom_check            9.4L available → 6.2L remaining
  ✓ min_cash_threshold        34.4L → 31.2L, above the 25L line

DATA USED
  department period spend · quarterly budget · current cash · 13-week
  forecast · headroom · vendor invoice history · 8 comparable requests

STATE CHANGE
  headroom  9.4L → 6.2L        projected minimum  34.4L → 31.2L

ACTION      Auto-approved.
```

The audit record is not written by hand. `RULES APPLIED` is the array of `RuleEvaluation` objects the engine actually evaluated to reach the outcome — the same objects, not a re-description of them — and `DATA USED` is assembled by `buildDataUsed` from the same context. It therefore cannot drift from what the decision was based on.

**Built differently:** the spec attributed this to a Cloudflare Workflow execution log. Workflows were not used; the record is produced inline by `decide()` in `src/engine/decision.ts` and persisted with the decision in Durable Object storage. Requester notification is not implemented.

---

## 13. Counterfactual Replay

Originally specced as the "proof layer". **That framing was wrong and is withdrawn.** What is built demonstrates the *mechanism* — the live engine run against historical data, producing an explainable row-by-row comparison. It is not evidence that the agent's judgement is good.

### What it does

`src/engine/replay.ts` replays 47 prior-quarter requests through the same rule functions that run live, and compares each agent outcome against the recorded human decision.

### Output

> **Q3 Replay — 47 requests**
>
> Agreed with your decision: 41
> Would have flagged for review: 6
>
> Of those 6, 4 carry `wentOverBudget: true` in the record.
>
> Average recorded human turnaround: 3.5 days.

Those numbers are computed by the engine, not typed into the UI. But the fixture they are computed over was written to produce them.

### What this does not show

All of the following is verifiable in `src/db/seed.ts`:

- **There are no human rejections.** All 47 rows are `humanDecision: "approved"`. "Agreement" can only ever mean co-approval. The half of the confusion matrix where a human said no does not exist, so there is no measurable false-negative rate and no way to detect the agent being over-permissive.
- **Recall is 100% by construction.** The 6 flagged rows are exactly the 6 the fixture's own comment calls "the six the agent should catch", written to exceed 2× their category average. Every one of them also exceeds the ₹5L authority ceiling, so they would be flagged on amount alone with the anomaly rule switched off entirely.
- **`wentOverBudget` is a hand-typed boolean** with no causal relationship to any budget computation anywhere in the codebase. The "4 of 6" result is the four rows labelled `true` being counted back out of the fixture.
- **The budget rule is anachronistic.** `replay.ts` neutralises the cash rules and documents why: the historical cash position is not reconstructable, and inventing one would be a nicer number and a dishonest one. But `ruleBudgetOverage` is still evaluated against each department's *current* `periodSpend` for all 47 prior-quarter rows — the same class of problem, and it was not disclosed. Three of the six flags are REJECTs produced this way.
- **`turnaroundDays` is fixture data.** The 3.5-day average is the mean of a hand-set field, not a measurement. The earlier draft of this section also claimed "38 requests I would have approved faster" and "1 coincided with the September cash dip"; neither figure is computed anywhere and both have been removed.

### Why it is still worth having

It is the same engine, pointed at data it did not produce, and every row opens to the rule evaluations behind its outcome. That is the correct *shape* for a validation harness, and against a real ledger — with real rejections in it — it would become one at near-zero marginal cost, because it reuses the decision engine entirely.

Against this fixture it is a demonstration. Present it that way.

---

## 14. Financial Engine

Deterministic. No model involvement.

### Forecast

Weekly buckets across a 13-week horizon:

```text
projected_cash(w) = current_cash
                  + Σ expected_collections(≤ w)
                  − Σ scheduled_payables(≤ w)
                  − Σ payroll(≤ w)
                  − Σ recurring_subscriptions(≤ w)
                  − Σ reserved_commitments(≤ w)

projected_minimum = min over w ∈ [1..13] of projected_cash(w)
breach_week       = argmin w where projected_cash(w) < safety_threshold
```

Expected collections use invoice due dates adjusted by each customer's historical payment lag. Confirmed commitments from the collection agent override the estimate.

### Also computed

Category historical averages, used by the anomaly rule — though as built these are hand-set constants in `CATEGORY_STATS` rather than aggregated from the historical table, over samples of n=3 to n=8.

**Not built.** Monthly burn, runway in months, budget variance by department, and vendor price movement do not exist anywhere in `src/`. Department budget *utilisation* is computed inside `ruleBudgetOverage` for the audit trail, but it is not a standing metric and nothing consumes it. Despite the product being named Runway, a runway figure is never calculated — the horizon is a fixed 13 weeks and the output is a projected minimum, not a months-of-cash number.

### Honest framing

This is transparent arithmetic over known obligations, not a predictive model. That is a **strength** — it is inspectable, defensible, and cannot hallucinate. The AI's role is attribution and explanation, never computation.

---

## 15. Interface

Deliberately thin. Every element on screen must be something the agent cited in a decision.

### Single screen

**Header — four numbers**
Current cash · Projected minimum · Safety threshold · Remaining headroom

**Forecast chart**
13-week cash line with the safety threshold drawn across it. Breach region highlighted red. Updates live as the agent acts.

**Agent activity log** *(the centrepiece)*
Reverse-chronological feed of everything the agent did on its own:

```text
14:31  ✉  Sent collection email — Acme Retail Group, ₹9L, 49 days overdue
14:31  ✉  Sent collection email — Northwind Logistics, ₹6L, 33 days overdue
14:31  ⏸  Holding INV-2029 for you — relationship-sensitive account
14:38  ⬆  Reply from Acme Retail Group — commits ₹9L by 25 Sep
14:38  ↻  Forecast updated — projected minimum 19.4L → 34.4L
14:41  ✓  Auto-approved ₹3.2L — Engineering
14:52  ⚠  Escalated ₹2.8L — Sales — insufficient headroom
```

The days-overdue figures are computed from `dueDate` against `TODAY`; an earlier draft of this block quoted 47 and 31, which are two days short of what the engine produces. The reply line is logged with activity type `reply_parsed`, but nothing is parsed — see §7. The skipped-invoice line is real and worth showing: the agent explicitly declines to auto-chase the account flagged `sensitive` and records why.

**Escalation card**
Appears when the agent hands back control.

```text
🔴  CFO REVIEW REQUIRED

Sales requested ₹2.8L for a conference sponsorship.

Nothing is wrong with the request. I have ₹1.7L headroom left
after two approvals earlier today. Approving takes projected
minimum to ₹23.9L, below your ₹25L threshold.

[ Approve ]  [ Reject ]  [ Defer ]  [ Ask why ]
```

**Decision detail**
Clicking any log entry opens the full audit record from Section 12.

That is the entire UI.

The `[ Ask why ]` control is built, but it opens the decision detail panel rather than starting a conversation — it is a shortcut into the audit record, not a chat entry point.

---

## 16. Chat — Scoped — **not built**

This section describes an intended capability that was cut. There is no chat endpoint, no conversational surface, and no question-answering over the audit trail in the shipped build.

The intent was a deliberately narrow assistant answering questions **about decisions and actions the agent has already taken**, grounded in the audit trail:

- "Why did you escalate the Sales request?"
- "Why did you approve Marketing but not Sales?"
- "What did you do while I was out?"
- "What happens if I approve the escalated request anyway?"

The engine primitive for the last one does exist: `forecastWithHypothetical` in `src/engine/forecast.ts` re-runs the forecast with a request provisionally reserved and returns real numbers. It is used by the decision engine to compute `projectedMinimumAfter`. Nothing exposes it to a user as a question.

---

## 17. Architecture (Cloudflare)

### As built

`wrangler.jsonc` declares **exactly two bindings**: `ASSETS` (static assets) and `COMPANY_AGENT` (the Durable Object). There is no Workflow, no D1, no queue, no AI binding and no AI Gateway.

```text
                    ┌──────────────────────────────┐
   Browser ────────▶│  Worker (API + static UI)    │
                    │  Hono · ASSETS binding       │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │  Durable Object COMPANY_AGENT│
                    │  CompanyAgent (1 per org)    │
                    │  · financial state           │
                    │  · rules + headroom ledger   │
                    │  · SERIALIZES all decisions  │
                    │  · alarm() → autonomous loop │
                    └───┬──────────────────────┬───┘
                        │                      │
              ┌─────────▼────────┐   ┌─────────▼──────────┐
              │  DO storage      │   │  Email adapter     │
              │  one JSON blob   │   │  simulated default │
              │  under "state"   │   │  Resend over fetch │
              └──────────────────┘   │  outbound only     │
                        │            └────────────────────┘
              ┌─────────▼────────┐
              │  LLM adapter     │
              │  narration only  │
              │  plain fetch to  │
              │  any OpenAI-     │
              │  compatible URL  │
              │  off by default  │
              └──────────────────┘
```

| Component | Role as built |
| --- | --- |
| **Durable Object** | Single-threaded execution is what makes headroom reservation correct. Two concurrent requests physically cannot read the same balance. This is Section 9 implemented, not simulated. |
| **DO Alarm** | The autonomous wake-up. Re-arms every 20s. Armed on the first `getDashboardState()` call. |
| **DO storage** | Not a database. One JSON blob under the key `"state"`, rewritten whole on every save. The benefit is that the state a decision reads and the state it writes are the same object in the same actor. |
| **Email adapter** | Outbound only. Simulated unless `EMAIL_PROVIDER=resend` and a key is present. Never throws. |
| **LLM adapter** | Narration of already-committed decisions. Direct `fetch` to a configurable OpenAI-compatible endpoint, 8s cap, returns `null` on any failure. Off by default. |

**Deliberately not used.** Workflows are the natural production home for the collection chase (send → wait days → resume), and a historical ledger would ordinarily live in D1. For this build the Durable Object is already durable, its alarm provides scheduling, and keeping state in one place removes a whole class of consistency bug between "the balance the decision read" and "the balance in the database". Recorded as conscious tradeoffs, not oversights.

### Original spec — **not built**

Retained for the record. Everything below the Durable Object in this diagram is aspirational.

```text
                    ┌──────────────────────────────┐
   Browser ────────▶│  Worker (API + static UI)    │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │  Durable Object              │
                    │  CompanyAgent (1 per org)    │
                    │  · financial state           │
                    │  · rules + headroom ledger   │
                    │  · SERIALIZES all decisions  │
                    │  · alarm() → autonomous loop │
                    └───┬──────────────────────┬───┘
                        │                      │
        ┌───────────────▼──────┐   ┌───────────▼────────────┐
        │  Workflow            │   │  Workflow              │
        │  ApprovalRun         │   │  CollectionRun         │
        │  (per request)       │   │  (per invoice chase)   │
        │  exec log = audit    │   │  send → wait → parse   │
        └──────────┬───────────┘   └───────────┬────────────┘
                   │                           │
        ┌──────────▼───────────┐   ┌───────────▼────────────┐
        │  D1                  │   │  Email                 │
        │  ledger, invoices,   │   │  outbound collections  │
        │  budgets, vendors,   │   │  inbound reply routing │
        │  decision log        │   └────────────────────────┘
        └──────────────────────┘
                   │
        ┌──────────▼───────────┐
        │  Workers AI          │
        │  narration · drafting│
        │  · reply parsing     │
        │  (never decisions)   │
        └──────────────────────┘
```

### Why each piece was specced, and what happened to it

| Component | Intent | Status |
| --- | --- | --- |
| **Durable Object** | Single-threaded execution is what makes headroom reservation correct. Two concurrent requests physically cannot read the same balance. | **Built.** |
| **DO Alarm** | The autonomous wake-up — the difference between an app and an agent. | **Built.** Re-arms every 20s; see §1 for the two qualifications. |
| **Email** | The agent's hands. Where autonomy becomes visible and real. | **Built**, outbound only. |
| **Workflow (Approval)** | Durable, replayable, step-by-step execution whose history *is* the audit trail from §12. | **Not built.** The audit record is produced inline by `decide()` instead. |
| **Workflow (Collection)** | Long-running with a human/email in the loop — send, wait days for a reply, resume. | **Not built.** The DO alarm handles scheduling; there is no wait-for-reply step because there is no inbound path. |
| **D1** | Historical ledger backing budgets, vendor history, and counterfactual replay. | **Not built.** All of it is fixture data in Durable Object storage. |
| **Workers AI** | Narration, email drafting, reply parsing. | **Not built as a binding**, and two of the three jobs no longer exist. Narration goes over plain `fetch` to a configurable endpoint; drafting is deterministic templates; reply parsing does not exist. |

---

## 18. Data Model (minimum)

```text
company        id, current_cash, safety_threshold, autonomous_limit
department     id, name, quarterly_budget, period_spend
vendor         id, name, first_seen, invoice_count, avg_amount
invoice        id, customer, customer_email, amount, issued, due, status,
               customer_avg_lag, chased_at, sensitive,
               committed_amount, committed_date
payable        id, vendor_id, amount, scheduled_date, category, discretionary
request        id, dept_id, vendor_id, amount, category, status,
               idempotency_key, created_at
decision       id, request_id, outcome, rules_applied[], data_used[],
               headroom_before, headroom_after, narration, created_at
action_log     id, type, payload, created_at
```

Seed with hand-tuned mock data so the demo numbers land exactly.

**As built:** there is no `trusted` flag on vendors — the vendor rule is a presence test on `invoice_count`. `days_overdue` is computed from `due` against `TODAY` rather than stored. `sensitive` was added during the build and is load-bearing: it is what makes the agent hold an account back from auto-chase. All of these live in TypeScript structures in `src/db/seed.ts`, persisted as a single JSON blob in Durable Object storage, not in a relational schema.

---

## 19. Demo Script

Built around one company. The two USPs must be shown **interacting** — that is the whole point.

### Scene 1 — Baseline (15s)

Dashboard. Current cash ₹52L. Projected minimum ₹37.5L. Threshold ₹25L. Healthy.

### Scene 2 — Reality intrudes (20s)

A ₹15L receivable slips out by eight weeks and a payroll step-up of ₹6L lands in week 6. Forecast recomputes.

> Projected minimum: **₹37.5L → ₹19.4L.** Breach in week 7. Chart turns red.

Do not say "nobody clicked anything" here — you did, `/api/demo/shock`. The clock is frozen in this build, so the shock has to be introduced. The unattended claim belongs to Scene 3 and it is strong enough on its own.

### Scene 3 — The agent defends (45s)

The alarm fires on its own — this is the unattended part, and it is real. The activity log fills:

- Diagnoses a ₹5.6L shortfall in week 7
- Ranks overdue receivables by amount, age, payment history, and expected arrival date — timing dominates: chasing money that lands after week 7 does nothing for a week 7 shortfall
- Sends two collection emails (Acme ₹9L, Northwind ₹6L), and holds a third back because that account is flagged relationship-sensitive — show one, it is a genuinely good email, and it is a hand-written template rather than model output
- Commitments are recorded: Acme and Northwind for ₹15L between them. **Say plainly that this step is injected** — there is no inbound email parsing in this build, and `/api/demo/inject-reply` writes the commitment directly.
- Forecast updated → **projected minimum ₹19.4L → ₹34.4L**, chart returns to green

> "It didn't tell me I was going to run out of money. It worked out which money to go and get, and went and asked for it — with nobody logged in."

### Scene 4 — Routine approval (20s)

Engineering requests ₹3.2L.

> **AUTO-APPROVED.** Within authority, within budget, consistent with history, headroom ₹9.4L → ₹6.2L.

### Scene 5 — The compounding moment (30s) ★

Marketing requests ₹4.5L.

> **APPROVED.**
>
> *"I'm approving this because I recovered ₹15L in receivables this morning. Before that collection, projected minimum was ₹19.4L and committing ₹4.5L would have taken it to ₹14.9L — I would have escalated this to you."*

**The agent's own autonomous action changed its own decision.** Pause here.

### Scene 6 — The escalation nobody expects (30s)

Sales requests ₹2.8L. Under the limit, within budget, trusted vendor, normal amount.

> **ESCALATED.**
>
> *"Nothing is wrong with this request. I have ₹1.7L of headroom left after approving ₹3.2L and ₹4.5L earlier. This would put projected minimum at ₹23.9L, below your ₹25L threshold."*

> "The limit is a ceiling on its authority — not permission to spend."

### Scene 7 — Replay (20s)

> **Q3 replay: 47 requests through the same engine. Agreed on 41. Flagged 6. Four of those six are recorded as having gone over budget.**

Say what it is: *"this is the live engine run against historical data, with every row opening to the rules that produced it. The history is a fixture, so treat it as a demonstration of the harness rather than a measurement of the agent."* Claiming it as proof invites the one question that unravels it — there are no human rejections in the data, so agreement can only ever mean co-approval. See §13.

Close.

**Total: ~3 minutes.**

---

## 20. Build Order (1–2 days)

Strictly sequential. Each stage is demoable on its own, so you always have something to show.

| # | Stage | Output | Outcome |
| --- | --- | --- | --- |
| 1 | **Data + financial engine** | 13-week forecast, headroom calc. Hand-tune numbers to Section 19. | Built; fixture in `src/db/seed.ts`, not D1. |
| 2 | **Decision engine** | Rules, precedence, reserve/commit, idempotency. Pure functions, unit tested. Deterministic. | Built. |
| 3 | **Durable Object** | Company state, serialized decisions, headroom ledger. | Built. |
| 4 | **Autonomous loop** | Alarm → breach detect → rank receivables → send email → update forecast. | Built. The reply-parsing step was cut, as anticipated below. |
| 5 | **Thin UI** | Four numbers, forecast chart, activity log, escalation card. | Built. |
| 6 | **AI narration** | Layer explanations over decisions already made. | Built, and optional. Email drafting was deliberately kept deterministic rather than moved to the model. |
| 7 | **Counterfactual replay** | Reuses stage 2 against historical data. | Built; see §13 for what it does and does not show. |
| 8 | **Rehearsal** | Non-negotiable. Two hours minimum. | — |

The planned cut order was: counterfactual replay → chat → reply parsing (pre-seed the commitment instead). What actually got cut was chat and reply parsing, in that order. Replay survived.

---

## 21. Risks

| Risk | Mitigation |
| --- | --- |
| **Inbound email doesn't arrive on cue** — the one fragile link in the demo | Resolved by removing the link. Inbound parsing was not built; `/api/demo/inject-reply` writes the commitment directly, behind a keystroke in the demo panel. This must be disclosed when demoing, not glossed — see §7 and Scene 3. |
| **LLM latency stalls the demo** | Narration is generated after the decision through `waitUntil`, hard-capped at 8s, and persisted. The decision itself never waits on a model, and the default configuration has no model at all. |
| **LLM non-determinism flips an outcome on stage** | Structurally impossible — `src/engine/` contains no model call, and every decision carries a deterministic `fallbackNarration` produced before the model is consulted. |
| **Email copy embarrasses you in front of a customer** | The chase templates are hand-written and reviewed once, not generated per send. Only the figures vary. |
| **"Who's accountable if the AI is wrong?"** | Autonomous actions are limited to reversible ones. Money never leaves without delegated authority, hard rules, headroom checks, and a full audit trail. Answer in one sentence, then move on. |
| **Reads as a dashboard with a chatbot** | Lead with Scene 3 — autonomous action with nobody logged in. Never open on the dashboard. |
| **Numbers don't create tension** | Keep margins tight: ₹1.7L headroom against a ₹25L threshold. Rehearse with the exact seed data. |

---

## 22. Success Criteria (demoable, not aspirational)

Deliberately narrow. Everything here can be shown in three minutes.

1. The agent takes a cash-defending action **with no human input**, on camera — alarm fires, breach detected, receivables ranked, emails sent. **Met.**
2. A recovered receivable **visibly repairs** the forecast. **Met** — though the commitment is injected rather than parsed from a reply.
3. A request is approved that would have been escalated before that recovery — **and the agent says so**. **Met**, and asserted in `test/scenario.test.ts`.
4. A request under the limit is escalated **purely because earlier approvals consumed headroom**. **Met**, with the order-dependence proven: the identical Sales request is approved when submitted first and escalated when submitted third.
5. Every decision opens to a complete audit record. **Met.**
6. Counterfactual replay runs the live engine over historical data and produces an explainable per-row comparison. **Met.** It does *not* establish that the agent's judgement is good — the fixture contains no human rejections. Do not claim otherwise. See §13.

---

## 23. One-Line Pitch

> **CFO Co-Pilot defends your cash position on its own — chasing the receivables that matter before a shortfall hits — and decides what you can safely spend within the authority you delegate, escalating only the calls that actually need you.**
