# CFO Co-Pilot — Product Requirements Document

> **An AI that doesn't just warn you that you're running out of cash — it goes and collects the money, then decides what you can safely spend.**

---

## 1. Product Overview

**CFO Co-Pilot** is an autonomous financial operator for startups and small finance teams.

It is not a reporting tool. It runs continuously on its own and manages **both sides of the company's cash position**:

| Side | What the agent does | Trigger |
| --- | --- | --- |
| **Inflow** | Detects a future cash shortfall and acts to prevent it — chases the right overdue receivables, sends real collection emails, parses replies, updates the forecast | Autonomous (scheduled + threshold alarm) |
| **Outflow** | Evaluates spend requests against budgets, history, vendor record, and the live forecast; approves within delegated authority, escalates when marginal | Event (request submitted) |

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
If the only output is a number on a screen, it isn't autonomous. The agent must do things while nobody is logged in.

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
    │  → parse replies   │            │  → reserve headroom │
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

Recovered cash raises headroom. Approvals consume headroom. Both write to the same ledger. That coupling is the product.

---

## 7. USP #1 — Autonomous Cash Defense (Inflow)

### Objective

Detect a future breach of the CFO's cash safety threshold and **act to prevent it**, without being asked.

### Trigger

Not a button. The agent wakes itself:

- **Scheduled:** forecast recomputed on a fixed interval (demo: every few minutes; production: daily).
- **Event-driven:** recomputed whenever underlying data changes — a receivable slips, a payable is scheduled, an approval is committed.
- **Alarm:** if `projected_minimum_cash < safety_threshold` at any point in the horizon, the defense routine fires.

### Action sequence

1. **Diagnose.** Identify the week of the projected breach and the magnitude of the gap.
2. **Select targets.** Rank overdue receivables by a deterministic score: amount, days overdue, customer payment history, and whether collection lands *before* the breach week. Chasing ₹20L that arrives after the shortfall is useless — timing is part of the ranking.
3. **Act.** Send collection emails to the selected customers. Tone escalates with days overdue. Content is drafted by the AI, but recipient selection and amounts come from the engine.
4. **Listen.** Inbound replies are parsed for a commitment: will they pay, how much, by when.
5. **Update.** Confirmed commitments are folded into the forecast as expected collections with the stated date. Headroom is recalculated.
6. **Report.** Everything above is written to the audit trail and surfaced in the action log.

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
- Current-period and prior-period spend by that department
- Similar historical requests — is this amount normal for this category?
- Vendor record — known vendor, price movement, first-time vendor
- **Projected cash impact against the live forecast**
- Remaining headroom after the request is committed

### Worked example — approve

> **AUTO-APPROVED — ₹3.2L, Engineering, cloud infrastructure**
>
> Within ₹5L delegated authority.
> Engineering has ₹8.4L remaining in its quarterly infrastructure budget.
> Comparable requests last quarter averaged ₹2.9L — this is in range.
> Vendor has 14 prior invoices, no price anomaly.
> Projected minimum cash after commitment: ₹31.2L, ₹6.2L above your ₹25L threshold.

### Worked example — escalate despite being under the limit

> **ESCALATED — ₹4.5L, Marketing, campaign spend**
>
> This is within your ₹5L authority, but committing it would reduce projected minimum cash from ₹19.4L to ₹14.9L — already below your ₹25L safety threshold.
>
> Marketing is also 25% over its quarterly budget, exceeding the 10% overage allowance.
>
> **Reason:** hard rule violation + cash impact.
> **Recommended:** CFO review, or defer to next month.

### Worked example — reject

> **REJECTED — ₹6.2L, Operations, new vendor**
>
> Two hard rules violated: the amount exceeds the ₹5L autonomous limit, and the vendor has no prior history — your rules require human approval for first-time vendors.
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

Every approval **reserves** against headroom immediately, before the money actually moves. Every recovered receivable **releases** headroom. All requests are evaluated against *current* headroom, and evaluation is serialized so two concurrent requests cannot both read the same balance.

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

### Optional second dimension

A rolling authority pool (e.g. ₹10L per 7 days) can be layered on top of headroom to bound total autonomous spend independent of cash position. Implement only if time permits.

---

## 10. Decision Engine

### Division of labour — non-negotiable

| Layer | Responsibility |
| --- | --- |
| **Deterministic engine** | Computes the forecast. Applies rules. **Makes the decision.** |
| **AI layer** | Explains the decision. Drafts emails. Parses replies. Answers questions about decisions already made. |

**The model never decides where money goes.** This is both the correct engineering choice and the answer to every trust question a reviewer will ask. It also makes the demo deterministic — the outcome cannot flip on stage.

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

| Rule | Structured form | Type |
| --- | --- | --- |
| AI can approve up to ₹5L | `max_autonomous_amount = 500000` | Hard |
| Never let cash fall below ₹25L | `min_cash_threshold = 2500000` | Hard |
| Departments may exceed budget by max 10% | `max_budget_overage = 0.10` | Hard |
| New vendors require human approval | `require_vendor_history = true` | Hard |
| Flag requests >2× the category historical average | `anomaly_multiplier = 2.0` | Soft |

Hard rules produce REJECT. Soft rules produce ESCALATE.

---

## 12. Audit Trail

Every autonomous action — approval, escalation, rejection, and every collection email — produces an immutable record.

```text
DECISION      APPROVED · ₹3,20,000 · Engineering · 2026-09-05 14:22 IST

RULES APPLIED
  ✓ max_autonomous_amount     3.2L ≤ 5.0L
  ✓ budget_overage            Engineering at 62% of quarterly budget
  ✓ require_vendor_history    vendor has 14 prior invoices
  ✓ anomaly_multiplier        3.2L vs 2.9L category average (1.1×)
  ✓ headroom_check            9.4L available → 6.2L remaining

DATA USED
  Q3 department spend · Q4 budget · current cash · 13-week forecast
  · vendor invoice history · 8 comparable requests

STATE CHANGE
  headroom  9.4L → 6.2L        projected minimum  34.4L → 31.2L

ACTION      Auto-approved. Requester notified.
```

The audit record is produced by the durable execution log of the approval run, not written by hand — so it cannot drift from what actually happened.

---

## 13. Proof Layer — Counterfactual Replay

Not a third USP. The mechanism that makes the first two credible.

### What it does

Replay the company's **actual historical requests** through the decision engine and compare the agent's judgment against what the humans actually did.

### Output

> **Q3 Replay — 47 requests**
>
> Agreed with your decision: 41
> Would have flagged for review: 6
>
> Of those 6, **4 subsequently exceeded their department budget** and 1 coincided with the September cash dip.
>
> Requests I would have approved faster: 38 (average human turnaround 2.4 days).

### Why it matters

It is the only way to *demonstrate* that the agent's judgment is good rather than assert it, and it directly answers the hardest reviewer question: **"how do you know it's any good?"**

It also reuses the decision engine entirely — near-zero marginal build cost.

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

Monthly burn, runway, budget variance by department, category historical averages, vendor price movement.

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
14:31  ✉  Sent collection email — Acme Corp, ₹9L, 47 days overdue
14:31  ✉  Sent collection email — Northwind, ₹6L, 31 days overdue
14:38  ⬆  Reply parsed — Acme commits ₹9L by 25 Sep
14:38  ↻  Forecast updated — projected minimum 19.4L → 34.4L
14:41  ✓  Auto-approved ₹3.2L — Engineering
14:52  ⚠  Escalated ₹2.8L — Sales — insufficient headroom
```

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

---

## 16. Chat — Scoped

Not open-ended chat over financial data. The assistant answers questions **about decisions and actions the agent has already taken**, grounded in the audit trail:

- "Why did you escalate the Sales request?"
- "Why did you approve Marketing but not Sales?"
- "What did you do while I was out?"
- "What happens if I approve the escalated request anyway?"

The last one runs the deterministic engine with the request hypothetically committed and returns real numbers, not prose.

---

## 17. Architecture (Cloudflare)

Every binding is load-bearing.

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

### Why each piece is necessary, not decorative

| Component | Why it is required |
| --- | --- |
| **Durable Object** | Single-threaded execution is what makes headroom reservation correct. Two concurrent requests physically cannot read the same balance. This is Section 9 implemented, not simulated. |
| **DO Alarm** | The autonomous wake-up. This is the difference between an app and an agent — it acts with nobody logged in. |
| **Workflow (Approval)** | Durable, replayable, step-by-step execution. Its history *is* the audit trail from Section 12. |
| **Workflow (Collection)** | Long-running with a human/email in the loop — send, wait days for a reply, resume. Exactly what workflows exist for. |
| **Email** | The agent's hands. Where autonomy becomes visible and real. |
| **D1** | Historical ledger backing budgets, vendor history, and counterfactual replay. |

---

## 18. Data Model (minimum)

```text
company        id, current_cash, safety_threshold, autonomous_limit
department     id, name, quarterly_budget, period_spend
vendor         id, name, first_seen, invoice_count, avg_amount, trusted
invoice        id, customer, amount, issued, due, status, days_overdue,
               customer_avg_lag, chased_at
payable        id, vendor_id, amount, scheduled_date, category, discretionary
request        id, dept_id, vendor_id, amount, category, status,
               idempotency_key, created_at
decision       id, request_id, outcome, rules_applied[], data_used[],
               headroom_before, headroom_after, narration, created_at
action_log     id, type, payload, created_at
```

Seed with hand-tuned mock data so the demo numbers land exactly.

---

## 19. Demo Script

Built around one company. The two USPs must be shown **interacting** — that is the whole point.

### Scene 1 — Baseline (15s)

Dashboard. Current cash ₹52L. Projected minimum ₹37.5L. Threshold ₹25L. Healthy.

### Scene 2 — Reality intrudes (20s)

A ₹15L receivable slips and payroll rises ₹3L. Forecast recomputes automatically.

> Projected minimum: **₹37.5L → ₹19.4L.** Breach in week 7. Chart turns red.

**Nobody clicked anything.** Say this out loud.

### Scene 3 — The agent defends (45s)

The alarm fires. The activity log fills in real time:

- Diagnoses a ₹5.6L shortfall in week 7
- Ranks overdue receivables by amount, age, payment history, and expected arrival date
- Sends two collection emails, and holds a third back because that account is relationship-sensitive — show one, it is a genuinely good email
- Replies arrive: Acme and Northwind commit ₹15L between them
- Replies parsed → forecast updated → **projected minimum ₹19.4L → ₹34.4L**, chart returns to green

> "It didn't tell me I was going to run out of money. It went and got the money."

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

### Scene 7 — Proof (20s)

> **Q3 replay: 47 real requests. Agreed on 41. Flagged 6. Four of those six went over budget.**

Close.

**Total: ~3 minutes.**

---

## 20. Build Order (1–2 days)

Strictly sequential. Each stage is demoable on its own, so you always have something to show.

| # | Stage | Output |
| --- | --- | --- |
| 1 | **Data + financial engine** | Seed D1, 13-week forecast, headroom calc. Hand-tune numbers to Section 19. |
| 2 | **Decision engine** | Rules, precedence, reserve/commit, idempotency. Pure functions, unit tested. Deterministic. |
| 3 | **Durable Object** | Company state, serialized decisions, headroom ledger. |
| 4 | **Autonomous loop** | Alarm → breach detect → rank receivables → send email → parse reply → update forecast. |
| 5 | **Thin UI** | Four numbers, forecast chart, activity log, escalation card. |
| 6 | **AI narration** | Layer explanations over decisions already made. Draft emails. Parse replies. |
| 7 | **Counterfactual replay** | Reuses stage 2 against historical data. |
| 8 | **Rehearsal** | Non-negotiable. Two hours minimum. |

If time runs short, cut in this order: counterfactual replay → chat → reply parsing (pre-seed the commitment instead).

---

## 21. Risks

| Risk | Mitigation |
| --- | --- |
| **Inbound email doesn't arrive on cue** — the one fragile link in the demo | Pre-seed the mailbox and poll, or trigger the reply from a second device before it is needed. The UI must degrade gracefully — a manual "simulate reply" control behind a keystroke. |
| **LLM latency stalls the demo** | Narration is generated after the decision and cached. The decision itself never waits on a model. |
| **LLM non-determinism flips an outcome on stage** | Structurally impossible — the engine decides, the model only narrates. |
| **"Who's accountable if the AI is wrong?"** | Autonomous actions are limited to reversible ones. Money never leaves without delegated authority, hard rules, headroom checks, and a full audit trail. Answer in one sentence, then move on. |
| **Reads as a dashboard with a chatbot** | Lead with Scene 3 — autonomous action with nobody logged in. Never open on the dashboard. |
| **Numbers don't create tension** | Keep margins tight: ₹1.7L headroom against a ₹25L threshold. Rehearse with the exact seed data. |

---

## 22. Success Criteria (demoable, not aspirational)

Deliberately narrow. Everything here can be shown in three minutes.

1. The agent takes a cash-defending action **with no human input**, on camera.
2. A recovered receivable **visibly repairs** the forecast.
3. A request is approved that would have been escalated before that recovery — **and the agent says so**.
4. A request under the limit is escalated **purely because earlier approvals consumed headroom**.
5. Every decision opens to a complete audit record.
6. Counterfactual replay shows agreement with historical human decisions, plus catches.

---

## 23. One-Line Pitch

> **CFO Co-Pilot defends your cash position on its own — chasing the receivables that matter before a shortfall hits — and decides what you can safely spend within the authority you delegate, escalating only the calls that actually need you.**
