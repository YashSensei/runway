# Runway — CFO Co-Pilot

> **An AI that doesn't just warn you that you're running out of cash — it goes and collects the money, then decides what you can safely spend.**

An autonomous financial operator built on Cloudflare Workers. It manages **both sides** of a company's cash position: it defends the inflow side unprompted, on its own schedule, and decides the outflow side as requests arrive.

**Status:** working end-to-end · hackathon build · [Product spec →](./cfo_copilot_prd.md)

---

## The idea

Most "AI CFO" tools are dashboards with a chatbot bolted on. They tell you what already happened and wait for you to act.

Runway acts. It forecasts 13 weeks of cash on its own schedule, and when the projection breaches the CFO's safety line it does something about it — then uses the result to inform what it lets you spend.

### Two capabilities, one loop

**Inflow — Autonomous Cash Defense**
The agent wakes itself on a Durable Object alarm that re-arms every 20 seconds, recomputes the forecast, and detects that projected cash will breach the CFO's safety threshold. It ranks overdue receivables by amount, age, customer payment history, and *whether collection lands before the breach week*, then sends the collection emails and folds committed cash back into the forecast.

When the forecast breaches, the detection, the ranking and the sending all happen with no human in the loop — the agent is deciding and acting on its own schedule, not responding to a click.

Two honest qualifications on that. The alarm is only armed the first time `getDashboardState()` is called, so something has to have loaded the page once before the loop starts. And `TODAY` in `src/db/seed.ts` is a frozen constant, so the clock never advances and no new event can arise on its own — in this build the breach exists because a human POSTs `/api/demo/shock`. What is unattended is everything after that.

**Outflow — Delegated Authority with Judgment**
The CFO grants a spending authority limit. The agent evaluates requests against department budgets, historical spend, vendor record, and the live forecast.

The key idea:

> **The limit is a ceiling on the agent's authority — not permission to approve.**

A request comfortably under the limit still gets escalated if approving it would push projected cash near the safety line, or if it looks anomalous against history.

### The part that makes it one product

Authority is a **consumable resource**. Every approval reserves against available headroom. Recovered cash does not release a reservation — it raises the projected minimum, and headroom is derived from that, so a successful collection widens the band the agent is allowed to spend inside.

```
headroom = projected_minimum_cash − safety_threshold
```

So the agent's own actions compound. It recovers ₹15L in receivables, then approves a request it would have escalated before that recovery — and says exactly that. And two requests that each individually pass can cause the second to escalate, because the first consumed the buffer. Both behaviours are asserted in `test/scenario.test.ts`, including the order-dependence case: the identical Sales request is escalated when it arrives third and approved when it arrives first.

---

## Architecture

```
                    ┌──────────────────────────────┐
   Browser ────────▶│  Worker (API + static UI)    │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │  Durable Object              │
                    │  CompanyAgent (1 per org)    │
                    │  · financial state           │
                    │  · headroom ledger           │
                    │  · SERIALIZES all decisions  │
                    │  · alarm() → autonomous loop │
                    └───┬──────────────────────┬───┘
                        │                      │
              ┌─────────▼────────┐   ┌─────────▼────────┐
              │  DO storage      │   │  Email adapter   │
              │  one JSON blob   │   │  simulated by    │
              │  under key       │   │  default, Resend │
              │  "state"         │   │  outbound only   │
              └──────────────────┘   └──────────────────┘
                        │
              ┌─────────▼────────┐
              │  LLM adapter     │
              │  narration only  │
              │  plain fetch to  │
              │  an OpenAI-      │
              │  compatible URL  │
              │  off by default  │
              └──────────────────┘
```

`wrangler.jsonc` declares exactly two bindings: `ASSETS` and `COMPANY_AGENT`. The email and LLM adapters are not bindings — they are plain `fetch` calls to configurable endpoints, and both are inert unless credentials are supplied.

### Why each piece is load-bearing

| Component | Role |
| --- | --- |
| **Durable Object** (`COMPANY_AGENT`) | Single-threaded execution is what makes headroom reservation *correct*. Two concurrent requests physically cannot read the same balance. The concurrency guarantee is real, not simulated. |
| **DO Alarm** | The autonomous wake-up — the difference between an app and an agent. Re-arms every 20s and chases unattended. |
| **DO storage** | Ledger, budgets, vendor history, reservations and the audit trail, held as a *single JSON blob* under the key `"state"` — not a database, not indexed, rewritten whole on every save. What it buys is that the state the decision reads and the state it writes are the same object, inside the same single-threaded actor. |
| **Email adapter** | The agent's hands, and outbound only. `SimulatedEmailAdapter` is the default; Resend is used only when `EMAIL_PROVIDER=resend` and a key is present. |
| **LLM adapter** (no binding) | Narration of decisions already made, and nothing else. Any OpenAI-compatible endpoint, called directly over `fetch` at a user-supplied `LLM_BASE_URL`; off by default, hard-capped at 8s, and returns `null` rather than throwing. |

---

## Design decisions

**The model never decides where money goes.**
A deterministic engine computes the forecast, applies the rules, and makes the decision. The LLM's only job in this codebase is to restate a decision that has already been committed — `src/engine/` contains no model call of any kind, and `src/engine/decision.ts` produces a `fallbackNarration` for every outcome before the model is ever consulted. This is the correct engineering choice, it's the answer to every trust question, and it means demo outcomes can't flip on stage.

**Collection emails are deterministic templates, on purpose.**
The chase emails are not model-generated. `src/adapters/email.ts` holds three hand-written templates selected by a tone ladder on days overdue — gentle under 15 days, firm from 15 to 45, serious beyond 45 — with only the figures interpolated. This is a choice, not a gap: the text goes out under the company's name to a real customer, where a fluent-but-wrong sentence is a commercial problem, so it is written once by a human and the engine picks which one to send and to whom. It also means the emails cannot vary between rehearsal and the live run.

**Decision precedence is explicit.**

```
1. Hard rule violation           → REJECT
2. Amount exceeds authority      → ESCALATE
3. Insufficient headroom         → ESCALATE
4. Anomaly vs. history / vendor  → ESCALATE
5. Otherwise                     → APPROVE
```

Rejection means a configured rule was broken. Escalation means the agent *has* the authority but judges the call to need a human.

**Autonomy is bounded by reversibility.**
The agent acts freely where being wrong is cheap and recoverable — chasing an overdue receivable, sending a reminder to a customer who already owes the money. It never initiates an outbound payment. It also holds itself back where the cost is not financial: an invoice marked `sensitive` is never auto-chased, it is skipped with a reason and handed to the CFO to send manually. That's what makes real autonomy defensible rather than a liability.

**The engine has no Cloudflare dependencies, and the model is provably absent from the decision path.**
Everything under `src/engine/` is pure TypeScript — plain functions in, plain data out, no `cloudflare:` import anywhere in the directory and no model call anywhere in it either. It is tested in isolation under vitest with no runtime, no bindings, and no deploy cycle, and the Durable Object wraps an already-proven core rather than debugging both at once.

**Every decision explains itself with every model offline.**
`buildFallbackNarration` in `src/engine/decision.ts` produces prose for all five outcomes deterministically, at decision time, from the same rule evaluations that produced the outcome. LLM narration is fired afterwards through `waitUntil` and merged in only if it returns; the adapter returns `null` on timeout, non-200, or malformed JSON rather than throwing. The default configuration has no model at all, and the product is fully articulate in that state.

**Decisions are serialized by the runtime, not by application code.**
All spend evaluation goes through one Durable Object instance per company. Between reading headroom and writing the reservation there is no `fetch`, so no other request can interleave and observe stale headroom. This is a property of where the code runs, not of a lock someone remembered to take.

**Workflows and D1 deliberately not used.**
The natural production home for the collection chase (send → wait days → resume) is Cloudflare Workflows, and historical ledger data would ordinarily sit in D1. For this build the Durable Object is already durable, alarms provide scheduling, and keeping state in one place removes a whole class of consistency bug between "the balance the decision read" and "the balance in the database". Recorded as conscious tradeoffs, not oversights.

---

## What's real vs. staged

Honest scope, since this is a time-boxed build.

| Component | Fidelity |
| --- | --- |
| Forecast engine, headroom math | Real |
| Decision engine, precedence, reserve/commit | Real |
| Durable Object serialization / concurrency | Real |
| Alarm-driven autonomous loop | Real — re-arms every 20s and chases unattended, but is only armed once `getDashboardState()` has been called, and `TODAY` is frozen so nothing arises on its own |
| Receivable ranking and selection | Real |
| Collection email copy | Real, and deliberately not model-generated — three hand-written templates on a tone ladder |
| Counterfactual replay | Real engine, synthetic fixture — a demonstration, not a validation. See below. |
| Outbound collection email | Real via Resend; simulated by default |
| Inbound reply parsing | Not built — `injectReply` writes the commitment straight into state |
| Company financial history | Seeded fixture data, hand-tuned to the narrative |
| Spend requests arriving | Triggered from the UI |
| Auth, multi-tenancy, bank integrations | Not built |

The staged pieces are plumbing. The reasoning is real.

---

## The demo path, as computed

None of these figures are hardcoded. They fall out of the forecast engine over the fixture in `src/db/seed.ts`, and `test/scenario.test.ts` asserts every one of them — if a change makes the story untrue, the suite fails.

| Step | Projected minimum | Headroom | Outcome |
| --- | --- | --- | --- |
| Baseline | ₹37.5L | ₹12.5L | healthy |
| Helios slips ₹15L, payroll steps up ₹6L | ₹19.4L | −₹5.6L | **breach in week 7** |
| Agent chases ₹15L across 2 invoices | — | — | unattended |
| Acme + Northwind commit | ₹34.4L | ₹9.4L | repaired |
| Engineering requests ₹3.2L | ₹31.2L | ₹6.2L | **APPROVED** |
| Marketing requests ₹4.5L | ₹26.7L | ₹1.7L | **APPROVED** |
| Sales requests ₹2.8L | would be ₹23.9L | would be −₹1.1L | **ESCALATED** |

The Sales request is within the authority limit, within budget, from a trusted vendor, and consistent with history. It escalates purely because the two approvals before it consumed the buffer. Submitted first instead, the identical request is approved — there is a test for exactly that.

### Counterfactual replay — what it does and does not show

`src/engine/replay.ts` runs the live rule set over the 47 prior-quarter rows in the fixture and produces an explainable per-row comparison: **agreed on 41, flagged 6, and 4 of those 6 carry `wentOverBudget: true`.** Those numbers are computed, not typed — but the fixture they run over was written to produce them, so read them as a demonstration that the engine can be pointed at historical data and made to explain itself, not as evidence that the agent's judgement is good.

Specifically, and all of it checkable in `src/db/seed.ts`:

- **There are no human rejections.** All 47 rows are `humanDecision: "approved"`. "Agreement" can therefore only ever mean co-approval, and half the confusion matrix — the cases where a human said no — does not exist. There is no measurable false-negative rate.
- **Recall is 100% by construction.** The 6 rows the engine flags are exactly the 6 the fixture's own comment calls "the six the agent should catch". They were written to exceed 2× their category average, and every one also exceeds the ₹5L authority ceiling, so they would be flagged on amount alone even with the anomaly rule switched off.
- **`wentOverBudget` is a hand-typed boolean.** It is not derived from any budget computation and has no causal link to one. The "4 of 6" figure is the 4 rows labelled `true` being counted back out.
- **The budget rule is evaluated against today's numbers.** `replay.ts` neutralises the cash rules and says so in its own header comment, because the historical cash position is not reconstructable. But `ruleBudgetOverage` is still evaluated against each department's *current* `periodSpend` for all 47 prior-quarter rows — the same class of problem, and previously undisclosed. Three of the six flags are REJECTs produced this way.
- The reported average human turnaround (3.5 days) is the mean of a hand-set `turnaroundDays` field.

The feature is worth keeping: it is the same engine, it runs over data it did not decide, and every row opens to the rules that produced the outcome. That is the shape of a real validation harness. It is not a validation.

---

## Known limitations

These are simplifications made to fit a time-boxed build. They are listed so a reviewer reads them here rather than discovers them in the code. Each one is a place where the arithmetic is honest but the model of the business is thinner than reality.

**Cash model**

- **Payroll is a flat weekly rate** (₹2.6L/week as a `RecurringCost`). Real payroll is monthly and lumpy, which means this understates intra-month troughs — the real trough is deeper than the line shown. The only lumpy payroll event in the fixture is the shock's step-up.
- **No GST, TDS, or statutory remittances.** Every figure is net operating cash. A real Indian SaaS company's weekly cash line has tax obligations sitting on top of this.
- **No debt service, interest, capex, leases, FX, or undrawn credit facilities.** A company with an unused overdraft line has headroom this model cannot see; a company with a term loan has outflows it cannot see either.
- **No new invoices are generated during the horizon.** Collections come only from receivables that already exist in the fixture, so a 13-week forecast contains no new revenue.
- **Weekly granularity only.** The breach test runs on each week's closing cash, so a week can close healthy while dipping below the threshold mid-week.
- **Receivables are assumed 100% collectible.** There is no bad-debt provision and no write-off path; every open invoice contributes its full amount on its expected date.
- **Committed receivables are booked at full face value.** When a customer commits, the forecast takes the whole amount with no haircut and no probability weighting.

**Decision model**

- **A single deterministic forecast path.** There is no downside case, no confidence band, no distribution. Delegated authority is sized off a base case, which means headroom is exactly as reliable as the assumptions above.
- **Category baselines are hand-set constants.** `CATEGORY_STATS` in `src/db/seed.ts` is typed in rather than computed, and the sample sizes run from n=3 to n=8. A 2× mean test over three observations is not a statistically meaningful anomaly detector; it is a threshold with a statistical-sounding name.

**Plumbing**

- **Inbound email and reply parsing are not implemented.** `injectReply` writes the commitment directly into state. The forecast effect is entirely real; the arrival of the reply is not.
- **Single company.** The Durable Object is keyed by a hardcoded `COMPANY_ID`, so multi-tenancy is structurally supported but never exercised. There is no auth.

---

## Running locally

```bash
npm install
npm run build        # build the UI into dist/
npm run dev          # wrangler dev on http://127.0.0.1:8787
npm test             # engine + adapter suites (vitest)
```

Two suites: `scenario.test.ts` asserts every figure in the demo narrative against the real engine, and `adapters.test.ts` covers the email and LLM adapters, including their failure paths.

Open `http://127.0.0.1:8787`. That first page load is what arms the alarm; from then on the agent re-forecasts every 20 seconds and will act without further input.

Press **`d`** in the UI for the demo control panel, or drive it over HTTP:

```bash
curl -X POST localhost:8787/api/demo/reset          # scene 1 — baseline
curl -X POST localhost:8787/api/demo/shock          # scene 2 — the shortfall
curl -X POST localhost:8787/api/demo/run-agent      # scene 3 — force the defense now
curl -X POST localhost:8787/api/demo/inject-reply   # scene 3 — customers commit
curl -X POST localhost:8787/api/demo/request/engineering
curl -X POST localhost:8787/api/demo/request/marketing
curl -X POST localhost:8787/api/demo/request/sales   # escalates on consumed headroom
curl -X POST localhost:8787/api/demo/replay
```

Every scene is reachable directly, so a rehearsal never has to replay the whole script and a live failure can be skipped past.

### Optional configuration

Both are off by default and the product is fully functional without them.

```bash
# Real collection emails (no domain needed — Resend delivers to your own
# verified address). Set DEMO_RECIPIENT_EMAIL to route every chase to you.
wrangler secret put RESEND_API_KEY
# then in wrangler.jsonc: EMAIL_PROVIDER = "resend"

# LLM narration over decisions the engine has already made.
wrangler secret put LLM_API_KEY
# then: LLM_PROVIDER = "openai-compatible", LLM_BASE_URL, LLM_MODEL
```

`LLM_BASE_URL` is any endpoint speaking the OpenAI chat-completions dialect — OpenAI, Groq, Together, OpenRouter, a local llama.cpp server, Workers AI's compatibility endpoint. It is called directly over `fetch`; there is no gateway, no proxy, and no binding in front of it. Partial configuration is treated as no configuration.

With no LLM configured, every decision still explains itself using the deterministic narration built in `src/engine/decision.ts`.

---

## Repo layout

```
src/
  index.ts                  Worker entry — routes, demo control, asset serving
  types.ts                  Shared contract: engine, adapters, API
  money.ts                  Indian-format currency, single source of truth
  agent/
    company-agent.ts        Durable Object: state, serialized decisions, alarm
  engine/                   Pure TypeScript. No Cloudflare imports.
    dates.ts                UTC-only week bucketing
    forecast.ts             13-week projection, headroom
    rules.ts                Six CFO rules, each reporting pass/fail + prose
    decision.ts             Precedence ladder, reserve/commit, fallback prose
    collections.ts          Receivable ranking, timing-dominated
    replay.ts               Counterfactual replay over history
  adapters/
    email.ts                Simulated | Resend; hand-written tone-ladder templates
    llm.ts                  Null | OpenAI-compatible, never throws
  db/seed.ts                Vertex Labs fixture, tuned to the narrative
web/                        React + Vite single-screen console
test/                       scenario.test.ts is the demo as spec; adapters.test.ts
```

---

## License

MIT
