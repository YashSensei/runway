# Runway — CFO Co-Pilot

> **An AI that doesn't just warn you that you're running out of cash — it goes and collects the money, then decides what you can safely spend.**

An autonomous financial operator built on Cloudflare Workers. It manages **both sides** of a company's cash position, on its own, without being asked.

**Status:** working end-to-end · hackathon build · [Product spec →](./cfo_copilot_prd.md)

---

## The idea

Most "AI CFO" tools are dashboards with a chatbot bolted on. They tell you what already happened and wait for you to act.

Runway acts. It runs on a schedule, forecasts 13 weeks of cash, and when it sees a shortfall coming it does something about it — then uses the result to inform what it lets you spend.

### Two capabilities, one loop

**Inflow — Autonomous Cash Defense**
The agent wakes itself up, recomputes the forecast, and detects that projected cash will breach the CFO's safety threshold. It ranks overdue receivables by amount, age, customer payment history, and *whether collection lands before the breach week*, then sends real collection emails, parses the replies, and folds committed cash back into the forecast.

Nobody triggers this. It happens while you're logged out.

**Outflow — Delegated Authority with Judgment**
The CFO grants a spending authority limit. The agent evaluates requests against department budgets, historical spend, vendor record, and the live forecast.

The key idea:

> **The limit is a ceiling on the agent's authority — not permission to approve.**

A request comfortably under the limit still gets escalated if approving it would push projected cash near the safety line, or if it looks anomalous against history.

### The part that makes it one product

Authority is a **consumable resource**. Every approval reserves against available headroom; every recovered receivable releases it.

```
headroom = projected_minimum_cash − safety_threshold
```

So the agent's own actions compound. It recovers ₹15L in receivables on Tuesday and approve a request on Wednesday that it would otherwise have escalated — and say exactly that. And two requests that each individually pass can cause the second to escalate, because the first consumed the buffer.

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
              │  DO storage      │   │  Email           │
              │  ledger, audit,  │   │  collection sends│
              │  history         │   │  reply ingest    │
              └──────────────────┘   └──────────────────┘
                        │
              ┌─────────▼────────┐
              │  AI Gateway      │
              │  narration only  │
              │  (never decides) │
              └──────────────────┘
```

### Why each piece is load-bearing

| Component | Role |
| --- | --- |
| **Durable Object** | Single-threaded execution is what makes headroom reservation *correct*. Two concurrent requests physically cannot read the same balance. The concurrency guarantee is real, not simulated. |
| **DO Alarm** | The autonomous wake-up — the difference between an app and an agent. |
| **DO storage** | The single source of truth: ledger, budgets, vendor history, reservations, and the audit trail — all inside the same single-threaded object that makes the decisions. |
| **Email** | The agent's hands. Where autonomy becomes visible. |
| **AI Gateway** | Narration, email drafting, reply parsing. |

---

## Design decisions

**The model never decides where money goes.**
A deterministic engine computes the forecast, applies the rules, and makes the decision. The LLM only explains decisions already made, drafts emails, and parses replies. This is the correct engineering choice, it's the answer to every trust question, and it means demo outcomes can't flip on stage.

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
The agent acts freely where being wrong is cheap and recoverable — chasing receivables, drafting emails, proposing deferrals. It never initiates an outbound payment. That's what makes real autonomy defensible rather than a liability.

**The engine has no Cloudflare dependencies.**
Everything under `src/engine/` is pure TypeScript — plain functions in, plain data out. It is tested in isolation under vitest with no runtime, no bindings, and no deploy cycle, and the Durable Object wraps an already-proven core rather than debugging both at once.

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
| Alarm-driven autonomous loop | Real — fires every 20s, acts unattended |
| Receivable ranking and selection | Real |
| Counterfactual replay | Real — same engine, run against history |
| Outbound collection email | Real via Resend; simulated by default |
| Inbound reply parsing | Staged — commitment injected directly |
| Company financial history | Seeded fixture data |
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

Counterfactual replay over the prior quarter: **47 decisions, agreed on 41, flagged 6 — and 4 of those 6 went on to exceed their department budget.**

---

## Running locally

```bash
npm install
npm run build        # build the UI into dist/
npm run dev          # wrangler dev on http://127.0.0.1:8787
npm test             # 51 engine + adapter tests
```

Open `http://127.0.0.1:8787`. The agent starts its own alarm on first load and will act without further input.

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
    email.ts                Simulated | Resend, tone-escalating templates
    llm.ts                  Null | OpenAI-compatible, never throws
  db/seed.ts                Vertex Labs fixture, tuned to the narrative
web/                        React + Vite single-screen console
test/                       51 tests; scenario.test.ts is the demo as spec
```

---

## License

MIT
