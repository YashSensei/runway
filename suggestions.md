# Runway — Suggestions: from a single board to a CFO platform

This document proposes what to add so Runway reads as a complete finance
operations platform rather than one dashboard page, and what to change in the
existing board so the demo tells its story on screen instead of in the slides.

Everything here is scoped against what the backend already exposes. Each item
lists the backend work it needs, because many of these are cheap: the engine
already computes the data, the UI just never shows it.

Legend for effort: **S** under 2 hours, **M** half a day, **L** a day or more.

---

## 1. Information architecture

Today the app is one route rendering one grid. A platform has places to go.
Proposed shell:

```
┌──────────┬──────────────────────────────────────────────────────────┐
│ RUNWAY   │  topbar: company · live/stale · agent status · alerts    │
│          ├──────────────────────────────────────────────────────────┤
│ Overview │                                                          │
│ Cash     │                                                          │
│ Collect  │                 page content                             │
│ Spend    │                                                          │
│ Policy   │                                                          │
│ Audit    │                                                          │
│ Insights │                                                          │
│ Agent    │                                                          │
│          │                                                          │
│ ──────── │                                                          │
│ demo ▸   │                                                          │
└──────────┴──────────────────────────────────────────────────────────┘
```

- **Left rail, eight entries, icon plus label.** Collapses to icons under
  1280px. The current board becomes the Overview page unchanged.
- **Routing without a router library.** Hash routes (`#/cash`, `#/spend`) are
  enough. The SPA fallback in `wrangler.jsonc` already handles deep links.
- **One poll, every page.** `GET /api/state` already returns everything the
  pages below need except where noted. Pages are pure views over the same
  `DashboardState`, so switching pages costs nothing and never desyncs.
- **Attention badges on the rail.** Escalations count on Spend, chases
  awaiting reply on Collect, breach on Cash. This is what makes it feel alive
  when the presenter is on a different page and the agent acts.

Effort: **M** for the shell and rail. Each page below is separate.

---

## 2. New pages

### 2.1 Cash — the forecast as a workspace

The chart today is a picture. Make it the place where the CFO reasons about
cash.

| Feature | What it does | Backend | Effort |
| --- | --- | --- | --- |
| **Full-height forecast** with week table beneath | 13 rows: opening, collections, payables, payroll, recurring, reservations, closing. Click a week to expand what lands in it. | None. `ForecastWeek` already carries every column. | S |
| **Ghost line: pre-shock baseline** | Draw the last healthy forecast as a faint dashed line under the live one, so the hole and the recovery are visible as deltas. | Persist `lastHealthyForecast` in the DO on every alarm where `breachWeek === null`. Add to `DashboardState`. | S |
| **What-if slider** | "If I approve ₹X in week N, what happens?" Drag amount and week, chart re-renders the hypothetical instantly. | `forecastWithHypothetical` exists in the engine. Either bundle the engine into the client (it is pure TS with no Cloudflare imports) or add `POST /api/forecast/hypothetical`. | M |
| **Scenario toggles** | Checkboxes: "Helios slips 8 weeks", "payroll step-up", "Sentinel pays this week". Each is a delta applied on top of the live state, never persisted. | Same as above: a list of deltas passed to `buildForecast` on the client. | M |
| **Week detail drawer** | Click W7: list each invoice expected, each payable due, each reservation landing, with the customer or vendor name. | Add `itemsByWeek` to the forecast response, or compute client-side from `invoices` and a new `payables` field on `DashboardState`. | S |
| **Breach explainer card** | Above the chart when breaching: "Why week 7?" with the three largest contributors to the drop between the last healthy week and the breach week. | Client-side from week table. | S |

Demo value: high. The what-if slider is a strong live moment ("watch headroom
go negative as I drag").

### 2.2 Collect — the receivables desk

Collections is half the product and currently has five rows in a corner.

| Feature | What it does | Backend | Effort |
| --- | --- | --- | --- |
| **Ageing buckets header** | Current · 1-30 · 31-60 · 61-90 · 90+, each with count and ₹. Standard AR view; judges with finance exposure will recognise it instantly. | None. Derived from `dueDate` vs `TODAY`. Expose `TODAY` on `DashboardState` as `company.today`. | S |
| **Full receivables table** | Every invoice, sortable, filter by status, with `chasedAt`, tone of last email, expected arrival week, and a "lands before breach" indicator. | Expose `expectedCollectionDate` per invoice or compute client-side (needs `customerAvgLagDays`, already present). | S |
| **Invoice drawer** | Timeline for one invoice: issued → due → chased (email preview inline) → reply → committed → forecast effect. | Emails already carry `invoiceId`. Activity entries carry `invoiceId` in `detail`. Join client-side. | M |
| **Collection plan panel** | When the agent last ran: the ranked candidates with their scores, who it chose, who it skipped and why. This is the "judgement" the pitch promises and it is computed but thrown away. | Persist the last `CollectionPlan` on the DO state and return it. `plan.skipped` already has reasons. | S |
| **Manual chase** | Button per invoice: "Chase now" sends with the tone ladder; for `sensitive` accounts this is the CFO doing what the agent refused to do. | New RPC `chaseInvoice(id)` that reuses `buildCollectionEmail` and `markChased`. | S |
| **Simulate reply form** | Pick invoice, amount, date. Replaces the blind `inject-reply` button and makes partial commitments demoable. | `injectReply` already accepts `invoiceId`, `amount`, `date`. UI only. | S |
| **Customer reliability strip** | Per customer: avg lag days, open ₹, chase history. Groups the many `Bluepeak` and `Orbit` rows. | Client-side groupBy. | S |

Demo value: high. The collection plan panel turns "it sent two emails" into
"it ranked six, chose two, and here is why it skipped the ₹20L one".

### 2.3 Spend — the approvals inbox

Spend requests today arrive from a hidden demo panel. A platform has an
inbox and a way to submit.

| Feature | What it does | Backend | Effort |
| --- | --- | --- | --- |
| **Request inbox** | Tabs: Awaiting you · Approved · Rejected · Deferred · All. Row per request with amount, department, vendor, outcome chip, reason label, time. | None. `decisions` plus `requests` status. | S |
| **New request form** | Department, vendor, category, amount, week, description, requester. Submit hits the real engine and the decision appears in under a second. | `POST /api/requests` and `validateSpendRequest` already exist. Surface field-level errors from the validator. | S |
| **Live pre-check** | As the amount is typed, show which rules would pass or fail before submitting. Rules are pure functions. | Bundle `evaluateRules` client-side, or add `POST /api/requests/preview` that runs `decide` without committing. | M |
| **Escalation workspace** | Full-width card, not a 3-column squeeze. Left: request and narration. Right: the seven rules with pass/fail, the headroom bar showing exactly where this request would land, and Approve / Reject / Defer with a required note. | `resolveEscalation` exists. Add an optional `note` to the RPC and log it. | M |
| **Deferred queue with re-evaluate** | A deferred request can be re-run against today's forecast. This is the cleanest way to show "the agent's action changed its own decision": defer Marketing before the recovery, re-evaluate after, watch it approve. | New RPC `reevaluate(requestId)` that calls `decide` again and appends a second decision to the audit trail. | M |
| **Vendor directory** | Vendors with invoice count, average, first seen, autonomous spend this window. Flags first-time vendors. | `vendors` exists on `LedgerState`; add to `DashboardState`. | S |
| **Department budgets page section** | The current bars, plus per-department list of approved requests this quarter and remaining budget under the overage ceiling. | Client-side from `requests`. | S |

Demo value: very high. The new request form lets a judge type a number and
see the agent decide. That is participation, not a video.

### 2.4 Policy — the CFO's rulebook

The single most important product idea ("the limit is a ceiling, not
permission") is displayed as six read-only rows.

| Feature | What it does | Backend | Effort |
| --- | --- | --- | --- |
| **Editable rules** | Each `CfoRules` field as a control with a plain-English sentence beside it: "The agent may approve up to ₹5,00,000 per request." Saving re-forecasts. | New RPC `updateRules(partial)` with validation. Log as a human activity entry. | M |
| **Impact preview before saving** | "Lowering the safety threshold to ₹20L would give the agent ₹6.7L of headroom and clear the week 7 breach." | `buildForecast` with the proposed rules, server or client. | S after the above |
| **Rule cards with history** | Each rule shows how many times it fired this session, linked to the decisions. | Client-side from `decisions[].rules`. | S |
| **Policy presets** | Conservative · Balanced · Aggressive. One click sets all six values. Good for showing the same request flip outcomes under different policies. | Client-side, calls `updateRules`. | S |
| **Rule explainer** | For each rule: what it checks, hard or soft, what happens on failure. The precedence ladder drawn as a ladder. | Static content. | S |

Demo value: high. Changing the threshold live and watching the escalation
card disappear is the most direct proof that authority is derived, not
configured.

### 2.5 Audit — the decision ledger

The audit record modal is good. It deserves a page.

| Feature | What it does | Backend | Effort |
| --- | --- | --- | --- |
| **Decision ledger table** | All decisions, filter by outcome, reason, department, actor (agent vs CFO override). Export to CSV. | None. | S |
| **Decision page instead of modal** | Same content as `DecisionDetail`, with a permanent URL (`#/audit/<id>`) so it can be linked and left open. | None. | S |
| **Headroom ledger** | Every reservation: created, amount, week, released. Running balance of consumed headroom. This is the "authority is consumable" proof as a bank statement. | Add `reservations` to `DashboardState`. | S |
| **Override tracking** | When the CFO approves an escalation, show the divergence: "Agent escalated on insufficient headroom. CFO approved with note: '…'". Count overrides in a header stat. | Add the `note` field from 2.3. | S |
| **Session timeline** | Horizontal timeline of the whole session: shock, breach, chases, replies, decisions. Click any point to see state at that moment. | Store a compact forecast snapshot (`projectedMinimum`, `headroom`, `breachWeek`) on every activity entry. | M |

### 2.6 Insights — the replay, presented honestly

| Feature | What it does | Backend | Effort |
| --- | --- | --- | --- |
| **Replay against seeded departments** | Fix the order dependence: replay must produce 41 / 6 regardless of when it is pressed. | In `runReplayScenario`, pass `baseSeed().departments` instead of `draft.departments`. | S |
| **Confusion matrix** | Agreed-approve, agreed-reject, agent-flagged-human-approved, agent-approved-human-rejected. The last two cells are the interesting ones. Show empty cells as empty; the README already admits there are no human rejections. | None. | S |
| **Per-rule attribution** | Of the 6 flagged, how many by anomaly, by authority ceiling, by budget. | Return `evaluations` per row from `runReplay`. | S |
| **Turnaround comparison** | Human average 3.5 days vs agent under 1 second, with the caveat that the human figure is a fixture. | None. | S |
| **"What this does not show" panel** | Move the README's honesty into the UI. Judges reward it. | Static. | S |

### 2.7 Agent — the operator's console

The agent is the product and has no page of its own.

| Feature | What it does | Backend | Effort |
| --- | --- | --- | --- |
| **Autonomy switch** | On / Off. `autonomyEnabled` already exists on the DO and is never exposed. When off, the agent still forecasts and detects but does not send. | New RPC `setAutonomy(bool)`. | S |
| **Alarm status** | "Next wake in 14s", last run time, last outcome (no breach / chased / waiting on replies / stale). Countdown ring. | Return `nextAlarmAt` from `ctx.storage.getAlarm()` and `lastRunAt` on `DashboardState`. | S |
| **Run log** | Each alarm firing as a row, even the quiet ones: time, projected minimum, breach, action. Currently quiet runs are not logged. Log them to a separate capped array so the activity feed stays clean. | Append to `runs[]` in DO state, cap at 200. | S |
| **Capabilities matrix** | What the agent may do alone, what it hands back, what it never does (outbound payments). Straight from the README's "autonomy bounded by reversibility" section. | Static. | S |
| **Email provider and model status** | Simulated vs Resend, model on or off, with a test-send button. | `createEmailAdapter(env).provider` and `createLLMAdapter(env).provider` on `DashboardState`. | S |
| **Guardrails shown as state** | Cooldown days, max targets per run, coverage factor, sensitive accounts held. These are `DEFAULTS` in `collections.ts` and invisible. Show them; optionally make them editable. | Move defaults into `CfoRules` or a new `CollectionPolicy` on company. | M |

Demo value: very high for the "autonomous office" track. A visible heartbeat
answers "is it really running on its own?" before anyone asks.

---

## 3. Design upgrades to the existing board

These fix what I saw driving the demo at 1440×900 and 1280×720.

### 3.1 The narrative strip

Add one full-width component under the stat cards that the agent writes to in
plain English. It is the single highest-value change.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ● AGENT   18:09:39                                                      │
│ Approved ₹4.5L for Marketing. This would have been escalated an hour    │
│ ago: the ₹15L I recovered from Acme and Northwind raised projected      │
│ minimum from ₹19.4L to ₹34.4L, which is what made room for it.          │
│                                              ← prev · 6 of 9 · next →   │
└─────────────────────────────────────────────────────────────────────────┘
```

- Source: the activity log, grouped into episodes (see 3.3).
- The Marketing narration must reference the recovery. Today it does not.
  Implement: when a decision's `headroomBefore` exceeds the headroom at the
  last `breach_detected` entry, prepend a sentence citing the
  `commitment_recorded` entries between them. Deterministic, no model.
- Effort: **M**.

### 3.2 Recovery state on the banner

After the breach clears, the green banner reads exactly like baseline. Make
it say what happened:

> Breach in week 7 cleared. Agent recovered ₹15.0L from Acme Retail Group and
> Northwind Logistics; projected minimum ₹19.4L → ₹34.4L.

Persist `lastBreachCleared: { recovered, customers, before, after }` on the
DO in `injectReply`. Show for the rest of the session. Effort: **S**.

### 3.3 Episodes in the activity feed

Newest-first flat rows read backwards. Group into collapsible episodes with a
one-line outcome:

```
▾ Cash defence #1 · 18:09:20 → 18:09:39 · recovered ₹15.0L · breach cleared
    18:09:20  breach    Projected cash breaches ₹25L in week 7 …
    18:09:20  system    Holding INV-2029 (sensitive) for you
    18:09:20  email     Acme Retail Group, ₹9.0L, 49 days overdue
    18:09:20  email     Northwind Logistics, ₹6.0L, 33 days overdue
    18:09:39  reply     Northwind commits ₹6.0L by 25 Sep
    18:09:39  reply     Acme commits ₹9.0L by 25 Sep
    18:09:39  commit    Forecast updated — ₹19.4L → ₹34.4L
▸ Spend decisions · 18:09:39 · 2 approved · 1 escalated
▸ Shock applied · 18:09:20 · human
```

Episode boundaries: start at `breach_detected` or `shock_applied`, end at
`breach_cleared` or the next boundary. Effort: **M**, client-side only.

### 3.4 Layout fixes

- **Escalation card gets the wide column.** When an escalation exists, swap
  it into the 8-column slot and move Activity to 4. Approve must never
  truncate to "Appro...".
- **Decisions table header overlap.** "department" and "amount" render on
  top of each other at 1440. Give the grid explicit column widths.
- **Clipped text.** The principle quote in Delegated Authority, the deficit
  bar label, and the receivables customer names all clip. Allow wrap or
  shorten.
- **Pin hero receivables.** Chased and committed rows sort to the top during
  and after a defence. Today they fall under "+13 more" the moment the story
  gets good.
- **Fix the chart Y-domain for the session.** It rescales 70L → 60L → 50L
  across scenes so the hole visually jumps. Compute the domain from the
  baseline and shock forecasts together, or keep a session max/min.
- **Replace UUIDs** in the audit header with "Decision 3 · Request 3".
- **Surface the demo panel** as the last rail entry instead of a near-
  invisible "press d".

### 3.5 Visual weight

Everything is currently the same size. Establish three tiers:

1. **Hero:** the narrative strip and whichever panel the agent last acted in
   (pulse its border for 3 seconds on change).
2. **Primary:** forecast, escalations.
3. **Reference:** authority, budgets, receivables, decisions.

Reference panels drop to `--text-2` headings and lose their badges. Hero and
primary keep full contrast. Effort: **S**, CSS only.

### 3.6 Motion

- Number roll on the stat cards when values change.
- The forecast line morphs between states (recharts already animates; set a
  stable `key` so it tweens instead of remounting).
- New activity rows slide in from the top with a brief agent-blue flash.
- Nothing else moves. Motion means "the agent did something".

---

## 4. Platform features beyond pages

| Feature | Why it matters to judges | Backend | Effort |
| --- | --- | --- | --- |
| **Multi-company switcher** | The DO is already keyed by company id. A second seeded company ("Orbit Softworks", healthy, no breach) proves multi-tenancy is structural, not hypothetical. | Second seed, `COMPANY_ID` from a path prefix or header. | M |
| **Notifications drawer** | Bell in the topbar. Escalations, breaches, recoveries. Mark read. Feels like a product. | Client-side from activity. | S |
| **Command palette (⌘K)** | Jump to page, open a decision by id, run a demo scene. Cheap and reads as mature. | None. | S |
| **Keyboard shortcuts** | `1`-`8` for rail, `a`/`r`/`d` on a focused escalation. | None. | S |
| **CSV export** on Audit and Collect | Finance people expect it. | Client-side. | S |
| **Inbound reply webhook** | `POST /api/inbound/reply` accepting a Resend inbound payload, regex for an amount and a date, calling `injectReply`. Closes the loop the README admits is missing. Show the raw email in the invoice drawer. | New route plus a small parser with tests. | M |
| **Payable deferral recommendations** | `Payable.discretionary` exists and is unused. When breaching, the agent lists discretionary payables it could ask to defer, with the headroom each would free. It recommends; the CFO clicks defer. Second lever for the same shortfall. | New engine function over `payables`, new RPC `deferPayable(id, weeks)`. | M |
| **Advancing clock** | A "day" button or a real ticking `TODAY` that moves one day per alarm. Overdue counts grow, cooldowns expire, the agent re-chases on its own. Removes the README's biggest caveat. | Store `today` in DO state, advance in `alarm()`, pass to forecast. | M |
| **Auth stub** | A single shared passphrase behind the write routes. Judges will ask; "there is none" is a worse answer than "one secret, see `AUTH_TOKEN`". | Hono middleware on `POST /api/*`. | S |

---

## 5. Suggested build order

Ordered by demo value per hour. Stop wherever time runs out; each step leaves
the product coherent.

1. **Fix the story** (all S): recovery-aware Marketing narration, recovery
   banner, replay against seeded departments, pin hero receivables, widen
   escalation card, fix decisions header.
2. **Shell and rail** (M): hash routes, eight entries, Overview is the current
   board.
3. **Agent page** (S each): autonomy switch, alarm countdown, run log,
   capabilities matrix. This is the track's core question answered.
4. **Spend page** (S + M): inbox, new request form, wide escalation
   workspace.
5. **Policy page** (M): editable rules with impact preview. Live threshold
   change is the best proof of "derived authority".
6. **Collect page** (S each): ageing buckets, full table, collection plan
   panel, simulate-reply form.
7. **Narrative strip and episodes** (M + M).
8. **Cash page** what-if slider (M).
9. **Audit, Insights** (S each): mostly re-presenting existing data.
10. **Platform extras**: notifications, ⌘K, advancing clock, inbound webhook.

Items 1 through 5 are roughly two focused days and turn the submission from
"a dashboard with an agent" into "an agent with a control room".

---

## 6. What not to add

- **A chat box.** The README's positioning is explicitly against "a dashboard
  with a chatbot". Adding one undermines the pitch.
- **LLM-generated collection emails.** The deterministic templates are a
  deliberate trust decision. Keep them and say why.
- **Real bank or accounting integrations.** Out of scope for the build and
  the README already says so.
- **Charts for their own sake.** Every new visual should answer a question
  the CFO would actually ask. Ageing buckets yes, a donut of spend by
  category no.
