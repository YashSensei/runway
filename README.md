# Runway — CFO Co-Pilot

> **An AI that doesn't just warn you that you're running out of cash — it goes and collects the money, then decides what you can safely spend.**

An autonomous financial operator built on Cloudflare Workers. It manages **both sides** of a company's cash position, on its own, without being asked.

**Status:** in development · hackathon build · [Product spec →](./cfo_copilot_prd.md)

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
headroom = projected_minimum_cash − safety_threshold − reserved_commitments
```

So the agent's own actions compound. It can recover ₹12L in receivables on Tuesday and approve a request on Wednesday that it would otherwise have escalated — and say exactly that. And two requests that each individually pass can cause the second to escalate, because the first consumed the buffer.

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
              │  D1              │   │  Email           │
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
| **D1** | Historical ledger backing budgets, vendor history, and the immutable audit trail. |
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

**Workflows deliberately not used.**
The natural production home for the collection chase (send → wait days → resume) is Cloudflare Workflows. For this build the Durable Object is already durable and alarms provide scheduling, so the added primitive wasn't worth the complexity on the timeline. Documented here as a conscious tradeoff, not an oversight.

---

## What's real vs. staged

Honest scope, since this is a time-boxed build.

| Component | Fidelity |
| --- | --- |
| Forecast engine, headroom math | Real |
| Decision engine, precedence, reserve/commit | Real |
| Durable Object serialization / concurrency | Real |
| Alarm-driven autonomous loop | Real |
| Outbound collection email | Real |
| Inbound reply parsing | Staged — pre-seeded mailbox |
| Company financial history | Seeded fixture data |
| Spend requests arriving | Triggered from the UI |
| Auth, multi-tenancy, bank integrations | Not built |

The staged pieces are plumbing. The reasoning is real.

---

## Running locally

```bash
npm install
npm run dev
```

_(Setup instructions to be completed as the build progresses.)_

---

## Repo layout

_To be added._

---

## License

MIT
