/**
 * CompanyAgent — the autonomous operator.
 *
 * One instance per company. Everything that touches the cash position goes
 * through here, and that is the whole point: a Durable Object runs
 * single-threaded, so two spend requests arriving at the same instant cannot
 * both read the same headroom and both get approved. The consumable-authority
 * guarantee is enforced by the runtime, not by hopeful application code.
 *
 * Two things drive this object:
 *   - requests arriving  (outflow: delegated approval)
 *   - its own alarm      (inflow: autonomous cash defense)
 *
 * The second is the one that matters. It fires with nobody logged in.
 */

import { DurableObject } from "cloudflare:workers";
import type {
  ActivityEntry,
  ActivityType,
  DashboardState,
  Decision,
  DecisionView,
  EscalationView,
  Invoice,
  LedgerState,
  ReplayResult,
  Rupees,
  SentEmail,
  SpendRequest,
} from "../types";
import { buildForecast, type ForecastInput } from "../engine/forecast";
import { decide } from "../engine/decision";
import { buildCollectionPlan, markChased, recordCommitment } from "../engine/collections";
import { runReplay } from "../engine/replay";
import type { PriorCommitments } from "../engine/rules";
import {
  validateCommitment,
  validateSpendRequest,
  type SpendRequestInput,
} from "../engine/validation";
import { baseSeed, applyShock, DEMO_REQUESTS, TODAY } from "../db/seed";
import { buildCollectionEmail, createEmailAdapter } from "../adapters/email";
import {
  createLLMAdapter,
  buildDecisionNarrationPrompt,
  DECISION_NARRATION_SYSTEM_PROMPT,
} from "../adapters/llm";
import { formatINR } from "../money";
import { addDays } from "../engine/dates";

/** How often the agent wakes itself to re-forecast and defend. */
const ALARM_INTERVAL_MS = 20_000;

/** The id `applyShock` appends; used to make the scene idempotent. */
const SHOCK_PAYABLE_ID = "AP-590";

interface PersistedState extends LedgerState {
  emails: SentEmail[];
  replay: ReplayResult | null;
  autonomyEnabled: boolean;
  /** Last breach the agent announced, so it does not repeat itself. */
  lastBreachWeek?: number | null;
  /** Bumped on every commit; lets long-running work detect it went stale. */
  generation?: number;
}

/** Newest-first caps. The whole ledger is one storage value; it cannot grow forever. */
const MAX_ACTIVITY = 400;
const MAX_EMAILS = 60;

function trimHistory(state: PersistedState): void {
  if (state.activity.length > MAX_ACTIVITY) {
    state.activity = state.activity.slice(-MAX_ACTIVITY);
  }
  if (state.emails.length > MAX_EMAILS) {
    state.emails = state.emails.slice(-MAX_EMAILS);
  }
}

export interface AgentEnv {
  EMAIL_PROVIDER?: string;
  RESEND_API_KEY?: string;
  COLLECTION_FROM_NAME?: string;
  COLLECTION_FROM_EMAIL?: string;
  LLM_PROVIDER?: string;
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  LLM_API_KEY?: string;
  DEMO_RECIPIENT_EMAIL?: string;
}

export class CompanyAgent extends DurableObject<AgentEnv> {
  private cache: PersistedState | null = null;

  constructor(ctx: DurableObjectState, env: AgentEnv) {
    super(ctx, env);
    // Arm the alarm at construction rather than on first dashboard read.
    // "It acts while you are logged out" is not true if it only starts once
    // somebody logs in.
    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      }
    });
  }

  // ---------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------

  private async load(): Promise<PersistedState> {
    if (this.cache) return this.cache;
    const stored = await this.ctx.storage.get<PersistedState>("state");
    this.cache = stored ?? this.freshState();
    return this.cache;
  }

  /**
   * The only way state is allowed to change.
   *
   * Mutates a CLONE, and only publishes it once the write has succeeded. Two
   * bugs are closed by that ordering:
   *
   *   1. Mutating the live object and then throwing (a malformed date reaching
   *      the forecast, say) used to leave the in-memory cache poisoned while
   *      storage still held the last good state. Every subsequent read served
   *      corrupt data — the whole dashboard failing until someone reset it.
   *   2. Assigning the cache before awaiting the write meant a rejected `put`
   *      left the object serving state that does not durably exist.
   *
   * `fn` is synchronous on purpose. Durable Objects gate incoming events during
   * storage operations but NOT across `fetch`, so permitting an await in here
   * would reopen exactly the interleaving this exists to prevent.
   */
  private async mutate<T>(fn: (state: PersistedState) => T): Promise<T> {
    const current = await this.load();
    const draft = structuredClone(current);
    const result = fn(draft);
    draft.generation = (current.generation ?? 0) + 1;
    trimHistory(draft);
    await this.ctx.storage.put("state", draft);
    this.cache = draft;
    return result;
  }

  private freshState(): PersistedState {
    return {
      ...baseSeed(),
      emails: [],
      replay: null,
      autonomyEnabled: true,
      generation: 0,
    };
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  private forecastInput(state: LedgerState): ForecastInput {
    return {
      company: state.company,
      invoices: state.invoices,
      payables: state.payables,
      recurring: state.recurring,
      reservations: state.reservations,
      now: TODAY,
    };
  }

  /**
   * Autonomous spend already committed inside the rolling window.
   *
   * This is what turns a per-request ceiling into an actual ceiling: without
   * it, three ₹4L requests walk straight past a ₹5L limit.
   */
  private priorCommitments(
    state: PersistedState,
    departmentId: string,
    vendorId: string,
  ): PriorCommitments {
    const windowDays = state.company.rules.rollingWindowDays;
    const cutoff = Date.now() - windowDays * 86_400_000;

    let departmentWindowTotal: Rupees = 0;
    let vendorWindowTotal: Rupees = 0;

    for (const request of state.requests) {
      if (request.status !== "approved" && request.status !== "paid") continue;
      if (request.departmentId !== departmentId) continue;
      if (Date.parse(request.createdAt) < cutoff) continue;
      departmentWindowTotal += request.amount;
      if (request.vendorId === vendorId) vendorWindowTotal += request.amount;
    }

    return { departmentWindowTotal, vendorWindowTotal, windowDays };
  }

  private log(
    state: PersistedState,
    type: ActivityType,
    actor: "agent" | "human",
    summary: string,
    detail?: Record<string, unknown>,
  ): void {
    const entry: ActivityEntry = {
      id: crypto.randomUUID(),
      type,
      actor,
      summary,
      detail,
      createdAt: new Date().toISOString(),
    };
    state.activity = [...state.activity, entry];
  }

  // ---------------------------------------------------------------------
  // Autonomous loop
  // ---------------------------------------------------------------------

  /**
   * The wake-up. Nobody triggered this.
   *
   * The next alarm is scheduled BEFORE the work, not in a `finally`. Setting it
   * afterwards raced the runtime's own retry-on-failure, and a Durable Object
   * has a single alarm slot, so the two schedules would clobber each other and
   * silently drop work.
   */
  override async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    await this.defendCashPosition({ triggeredBy: "alarm" });
  }

  /**
   * Autonomous cash defense.
   *
   * Diagnose -> rank receivables by whether they land before the shortfall ->
   * chase -> record. Sending happens after state is committed so a slow mail
   * provider cannot wedge the object, and each send re-checks the generation
   * counter so a concurrent reset cannot have its fresh state written into
   * with stale conclusions.
   */
  async defendCashPosition(opts: { triggeredBy: "alarm" | "manual" }): Promise<{
    acted: boolean;
    chased: number;
    breachWeek: number | null;
  }> {
    const state = await this.load();
    if (!state.autonomyEnabled) return { acted: false, chased: 0, breachWeek: null };

    const forecast = buildForecast(this.forecastInput(state));

    if (forecast.breachWeek === null) {
      // Healthy. Only record the check on manual runs — an idle agent should
      // not fill the log with "nothing to do" every twenty seconds.
      if (opts.triggeredBy === "manual") {
        await this.mutate((draft) => {
          this.log(
            draft,
            "forecast_updated",
            "agent",
            `Forecast re-run — projected minimum ${formatINR(forecast.projectedMinimum)}, no action needed.`,
            { projectedMinimum: forecast.projectedMinimum, headroom: forecast.headroom },
          );
        });
      }
      return { acted: false, chased: 0, breachWeek: null };
    }

    // Already waiting on replies to an earlier chase. Piling on more emails
    // would not be persistence, it would be harassment — and it would double
    // count the recovery the moment those replies land.
    const outstanding = state.invoices.filter(
      (inv) => inv.chasedAt !== null && inv.status !== "committed" && inv.status !== "paid",
    );
    if (outstanding.length > 0) {
      return { acted: false, chased: 0, breachWeek: forecast.breachWeek };
    }

    const plan = buildCollectionPlan({
      invoices: state.invoices,
      forecast,
      company: state.company,
      now: TODAY,
    });

    if (plan.targets.length === 0) {
      if (state.lastBreachWeek !== forecast.breachWeek) {
        await this.mutate((draft) => {
          draft.lastBreachWeek = forecast.breachWeek;
          this.log(
            draft,
            "breach_detected",
            "agent",
            `Projected cash breaches the ${formatINR(forecast.threshold)} safety threshold in week ${forecast.breachWeek} — short by ${formatINR(forecast.breachWeekShortfall)} that week. No collectable receivable would arrive in time; this needs you.`,
            { breachWeek: forecast.breachWeek, gap: forecast.breachGap },
          );
        });
      }
      return { acted: false, chased: 0, breachWeek: forecast.breachWeek };
    }

    const week = forecast.weeks[forecast.breachWeek - 1];
    const targetIds = plan.targets.map((t) => t.invoice.id);
    const now = new Date().toISOString();

    // Commit "chased" before transmitting. If a send fails we would rather
    // under-chase than contact a customer twice.
    const generation = await this.mutate((draft) => {
      draft.lastBreachWeek = forecast.breachWeek;
      this.log(
        draft,
        "breach_detected",
        "agent",
        `Projected cash breaches the ${formatINR(forecast.threshold)} safety threshold in week ${forecast.breachWeek}${week ? ` (${week.startDate})` : ""} — ${formatINR(forecast.breachWeekShortfall)} short that week, bottoming out at ${formatINR(forecast.projectedMinimum)} in week ${forecast.projectedMinimumWeek}.`,
        {
          breachWeek: forecast.breachWeek,
          breachWeekShortfall: forecast.breachWeekShortfall,
          gap: forecast.breachGap,
          projectedMinimum: forecast.projectedMinimum,
        },
      );
      for (const skip of plan.skipped) {
        if (/sensitive/i.test(skip.reason)) {
          this.log(draft, "system", "agent", `Holding ${skip.invoiceId} for you — ${skip.reason}`, skip);
        }
      }
      draft.invoices = draft.invoices.map((inv) =>
        targetIds.includes(inv.id) ? markChased(inv, now) : inv,
      );
      return (draft.generation ?? 0) + 1;
    });

    const emailAdapter = createEmailAdapter(this.env);
    const recipientOverride = this.env.DEMO_RECIPIENT_EMAIL?.trim();
    let stale = false;

    for (const target of plan.targets) {
      const message = buildCollectionEmail(
        target,
        state.company.name,
        "Runway, on behalf of Vertex Labs Finance",
      );
      // In demo mode every chase is delivered to the operator's own inbox, so
      // a real email can be shown landing without contacting a real customer.
      const outgoing = recipientOverride ? { ...message, to: recipientOverride } : message;
      const result = await emailAdapter.send(outgoing);

      const sent: SentEmail = {
        id: crypto.randomUUID(),
        invoiceId: target.invoice.id,
        message: outgoing,
        result,
        sentAt: new Date().toISOString(),
      };

      // The send above is a real network await, during which a reset or a
      // shock can land. Writing this conclusion into a state generation it no
      // longer describes is how a dashboard ends up showing a pristine
      // baseline alongside emails chasing a shortfall that does not exist.
      const applied = await this.mutate((draft) => {
        const currentGeneration = draft.generation ?? 0;
        if (currentGeneration >= generation + plan.targets.length + 2) return false;
        if (!draft.invoices.some((inv) => inv.id === target.invoice.id && inv.chasedAt !== null)) {
          return false;
        }
        draft.emails = [...draft.emails, sent];
        this.log(
          draft,
          "email_sent",
          "agent",
          `Collection email sent — ${target.invoice.customer}, ${formatINR(target.invoice.amount)}, ${target.daysOverdue} days overdue.`,
          {
            emailId: sent.id,
            invoiceId: target.invoice.id,
            simulated: result.simulated,
            rationale: target.rationale,
          },
        );
        return true;
      });

      if (!applied) {
        stale = true;
        break;
      }
    }

    if (stale) return { acted: false, chased: 0, breachWeek: forecast.breachWeek };

    await this.mutate((draft) => {
      this.log(
        draft,
        "system",
        "agent",
        `Chased ${formatINR(plan.totalChased)} across ${plan.targets.length} overdue invoice${plan.targets.length === 1 ? "" : "s"} to cover a ${formatINR(plan.gap)} shortfall.`,
        { totalChased: plan.totalChased, gap: plan.gap },
      );
    });

    return { acted: true, chased: plan.totalChased, breachWeek: forecast.breachWeek };
  }

  // ---------------------------------------------------------------------
  // Outflow — delegated approval
  // ---------------------------------------------------------------------

  /**
   * Evaluate a spend request.
   *
   * The critical property: between reading headroom and writing the
   * reservation there is no `fetch`, so no other request can interleave and
   * observe stale headroom. Narration is generated afterwards, deliberately.
   */
  async submitRequest(
    input: SpendRequestInput,
  ): Promise<{ decision: Decision; request: SpendRequest } | { error: string }> {
    const state = await this.load();

    const invalid = validateSpendRequest(input, state.company.forecastHorizonWeeks);
    if (invalid) return { error: invalid };

    const existing = state.requests.find((r) => r.idempotencyKey === input.idempotencyKey);
    if (existing) {
      const priorDecision = state.decisions.find((d) => d.requestId === existing.id);
      if (priorDecision) return { decision: priorDecision, request: existing };
      // Key is taken but no decision exists. Falling through would create a
      // second request under the same key and reserve twice, so refuse.
      return { error: `Request ${input.idempotencyKey} is already in flight` };
    }

    const department = state.departments.find((d) => d.id === input.departmentId);
    const vendor = state.vendors.find((v) => v.id === input.vendorId);
    if (!department) return { error: `Unknown department: ${input.departmentId}` };
    if (!vendor) return { error: `Unknown vendor: ${input.vendorId}` };

    const request: SpendRequest = {
      ...input,
      id: crypto.randomUUID(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    const categoryStat = state.categoryStats.find(
      (c) => c.departmentId === input.departmentId && c.category === input.category,
    );

    const { decision, reservation } = decide({
      request,
      department,
      vendor,
      categoryStat,
      rules: state.company.rules,
      forecastInput: this.forecastInput(state),
      priorCommitments: this.priorCommitments(state, input.departmentId, input.vendorId),
      now: new Date().toISOString(),
    });

    request.status =
      decision.outcome === "APPROVED"
        ? "approved"
        : decision.outcome === "REJECTED"
          ? "rejected"
          : "escalated";

    await this.mutate((draft) => {
      draft.requests = [...draft.requests, request];
      draft.decisions = [...draft.decisions, decision];
      if (reservation) {
        draft.reservations = [...draft.reservations, reservation];
        // Budget is an accrual control and cash is a timing control; they are
        // deliberately separate ledgers. But the budget one was never written,
        // which made a "quarterly budget" rule behave as a second per-request
        // amount threshold that could never detect cumulative overspend.
        draft.departments = draft.departments.map((d) =>
          d.id === department.id ? { ...d, periodSpend: d.periodSpend + request.amount } : d,
        );
      }
      this.log(
        draft,
        "decision",
        "agent",
        `${decision.outcome} — ${formatINR(request.amount)} for ${department.name} (${vendor.name}).`,
        { decisionId: decision.id, requestId: request.id, outcome: decision.outcome },
      );
    });

    // Narration is an upgrade, never a dependency. Fire and forget.
    this.ctx.waitUntil(
      this.narrate(decision.id, department.name, vendor.name).catch(() => {
        /* narration is cosmetic; never let it surface after the response */
      }),
    );

    return { decision, request };
  }

  /** Ask the model to restate a decision that has already been made. */
  private async narrate(decisionId: string, departmentName: string, vendorName: string): Promise<void> {
    const llm = createLLMAdapter(this.env);
    if (llm.provider === "none") return;

    const state = await this.load();
    const decision = state.decisions.find((d) => d.id === decisionId);
    const request = state.requests.find((r) => r.id === decision?.requestId);
    if (!decision || !request) return;

    const text = await llm.complete(
      DECISION_NARRATION_SYSTEM_PROMPT,
      buildDecisionNarrationPrompt({
        outcome: decision.outcome,
        reasonCode: decision.reasonCode,
        amount: request.amount,
        departmentName,
        vendorName,
        category: request.category,
        rules: decision.rules,
        headroomBefore: decision.headroomBefore,
        headroomAfter: decision.headroomAfter,
        projectedMinimumBefore: decision.projectedMinimumBefore,
        projectedMinimumAfter: decision.projectedMinimumAfter,
        threshold: state.company.rules.minCashThreshold,
      }),
    );
    if (!text) return;

    await this.mutate((draft) => {
      draft.decisions = draft.decisions.map((d) =>
        d.id === decisionId ? { ...d, narration: text } : d,
      );
    });
  }

  /**
   * The CFO acts on an escalation.
   *
   * Guarded on status. Without it, a double-click — which the 500ms poll made
   * a normal user action, since nothing visibly happened on the first press —
   * appended a second reservation and consumed the headroom twice, falsifying
   * the exact invariant this product exists to demonstrate.
   */
  async resolveEscalation(
    requestId: string,
    action: "approve" | "reject" | "defer",
  ): Promise<{ ok: boolean; error?: string }> {
    return this.mutate((draft) => {
      const request = draft.requests.find((r) => r.id === requestId);
      if (!request) return { ok: false, error: "No such request" };
      if (request.status !== "escalated") {
        return { ok: false, error: `Request is already ${request.status}` };
      }

      const now = new Date().toISOString();

      if (action === "approve") {
        request.status = "approved";
        draft.reservations = [
          ...draft.reservations,
          {
            id: crypto.randomUUID(),
            requestId: request.id,
            amount: request.amount,
            week: request.expectedWeek,
            createdAt: now,
            releasedAt: null,
          },
        ];
        draft.departments = draft.departments.map((d) =>
          d.id === request.departmentId
            ? { ...d, periodSpend: d.periodSpend + request.amount }
            : d,
        );
      } else {
        request.status = action === "reject" ? "rejected" : "cancelled";
        // Release anything held against it, otherwise a declined request
        // sterilises authority permanently.
        draft.reservations = draft.reservations.map((r) =>
          r.requestId === request.id && r.releasedAt === null ? { ...r, releasedAt: now } : r,
        );
      }

      draft.requests = draft.requests.map((r) => (r.id === requestId ? request : r));
      this.log(
        draft,
        "decision",
        "human",
        `CFO ${action === "defer" ? "deferred" : `${action}d`} ${formatINR(request.amount)} — ${request.description}.`,
        { requestId },
      );
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------------
  // Inbound replies
  // ---------------------------------------------------------------------

  /**
   * Record a customer's commitment.
   *
   * In production this would be driven by inbound email parsing. Here it is
   * invoked directly — the plumbing is not built, the effect on the forecast
   * is entirely real.
   */
  async injectReply(
    input: { invoiceId?: string; amount?: number; date?: string } = {},
  ): Promise<{ ok: boolean; recovered: number; error?: string }> {
    const state = await this.load();

    const horizonEnd = addDays(
      state.company.anchorDate,
      state.company.forecastHorizonWeeks * 7,
    );
    const invalid = validateCommitment(input, {
      earliest: state.company.anchorDate,
      latest: horizonEnd,
    });
    if (invalid) return { ok: false, recovered: 0, error: invalid };

    const chased = state.invoices.filter(
      (inv) => inv.chasedAt !== null && inv.status !== "committed" && inv.status !== "paid",
    );
    const targets: Invoice[] = input.invoiceId
      ? state.invoices.filter((i) => i.id === input.invoiceId && i.status !== "committed")
      : chased;

    if (targets.length === 0) return { ok: false, recovered: 0, error: "Nothing outstanding to commit" };

    return this.mutate((draft) => {
      const before = buildForecast(this.forecastInput(draft));
      let recovered = 0;

      for (const invoice of targets) {
        const amount = input.amount ?? invoice.amount;
        const date = input.date ?? "2026-09-25";
        draft.invoices = draft.invoices.map((inv) =>
          inv.id === invoice.id ? recordCommitment(inv, amount, date) : inv,
        );
        recovered += amount;
        this.log(
          draft,
          "reply_parsed",
          "agent",
          `Reply from ${invoice.customer} — commits ${formatINR(amount)} by ${date}.`,
          { invoiceId: invoice.id, amount, date },
        );
      }

      const after = buildForecast(this.forecastInput(draft));
      this.log(
        draft,
        "commitment_recorded",
        "agent",
        `Forecast updated — projected minimum ${formatINR(before.projectedMinimum)} → ${formatINR(after.projectedMinimum)}, headroom ${formatINR(after.headroom)}.`,
        { before: before.projectedMinimum, after: after.projectedMinimum, headroom: after.headroom },
      );

      if (before.breachWeek !== null && after.breachWeek === null) {
        draft.lastBreachWeek = null;
        this.log(
          draft,
          "breach_cleared",
          "agent",
          `Shortfall cleared. Projected cash stays above ${formatINR(after.threshold)} across the full horizon.`,
          { recovered },
        );
      }

      return { ok: true, recovered };
    });
  }

  // ---------------------------------------------------------------------
  // Demo control
  // ---------------------------------------------------------------------

  async reset(): Promise<void> {
    const fresh = this.freshState();
    this.log(fresh, "system", "human", "Demo state reset to baseline.", {});
    await this.ctx.storage.put("state", fresh);
    this.cache = fresh;
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  /** Idempotent: clicking Shock twice must not silently double the payroll step. */
  async applyShockScenario(): Promise<{ ok: boolean; alreadyApplied: boolean }> {
    return this.mutate((draft) => {
      if (draft.payables.some((p) => p.id === SHOCK_PAYABLE_ID)) {
        return { ok: true, alreadyApplied: true };
      }

      const before = buildForecast(this.forecastInput(draft));
      const shocked = applyShock(draft);
      draft.invoices = shocked.invoices;
      draft.payables = shocked.payables;
      const after = buildForecast(this.forecastInput(draft));

      this.log(
        draft,
        "shock_applied",
        "human",
        `Helios pushed ${formatINR(1_500_000)} out by eight weeks and payroll stepped up ${formatINR(600_000)}.`,
        {},
      );
      this.log(
        draft,
        "forecast_updated",
        "agent",
        `Forecast re-run — projected minimum ${formatINR(before.projectedMinimum)} → ${formatINR(after.projectedMinimum)}.`,
        { before: before.projectedMinimum, after: after.projectedMinimum },
      );
      return { ok: true, alreadyApplied: false };
    });
  }

  async submitDemoRequest(key: string): Promise<unknown> {
    // Own-property check: `__proto__` and `constructor` resolve on the
    // prototype chain and would otherwise slip past a plain truthiness test.
    if (!Object.prototype.hasOwnProperty.call(DEMO_REQUESTS, key)) {
      return { error: `Unknown demo request: ${key}` };
    }
    const template = DEMO_REQUESTS[key]!;
    // Stable key, so pressing the button twice is genuinely idempotent rather
    // than quietly reserving the money a second time.
    return this.submitRequest({ ...template, idempotencyKey: template.idempotencyKey });
  }

  async runReplayScenario(): Promise<ReplayResult> {
    return this.mutate((draft) => {
      const result = runReplay({
        historical: draft.historical,
        departments: draft.departments,
        vendors: draft.vendors,
        categoryStats: draft.categoryStats,
        rules: draft.company.rules,
      });
      draft.replay = result;
      this.log(
        draft,
        "system",
        "human",
        `Replayed ${result.total} prior-quarter decisions — agreed on ${result.agreed}, flagged ${result.flagged}.`,
        {},
      );
      return result;
    });
  }

  // ---------------------------------------------------------------------
  // Read model
  // ---------------------------------------------------------------------

  async getDashboardState(): Promise<DashboardState> {
    const state = await this.load();
    const forecast = buildForecast(this.forecastInput(state));

    const nameOf = (id: string, list: Array<{ id: string; name: string }>): string =>
      list.find((x) => x.id === id)?.name ?? id;

    const views: DecisionView[] = [];
    const escalations: EscalationView[] = [];

    for (const decision of state.decisions) {
      const request = state.requests.find((r) => r.id === decision.requestId);
      if (!request) continue;
      const departmentName = nameOf(request.departmentId, state.departments);
      const vendorName = nameOf(request.vendorId, state.vendors);
      views.push({ decision, request, departmentName, vendorName });
      if (decision.outcome === "ESCALATED" && request.status === "escalated") {
        escalations.push({ request, decision, departmentName, vendorName });
      }
    }

    return {
      company: state.company,
      forecast,
      departments: state.departments,
      invoices: state.invoices,
      // Insertion order already encodes causality; several entries share a
      // millisecond, and sorting on the timestamp alone reorders them.
      activity: [...state.activity].reverse(),
      decisions: views.reverse(),
      escalations,
      emails: [...state.emails].reverse(),
      reservedTotal: state.reservations
        .filter((r) => r.releasedAt === null)
        .reduce((sum, r) => sum + r.amount, 0),
      replay: state.replay,
    };
  }
}
