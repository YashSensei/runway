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
  SentEmail,
  SpendRequest,
} from "../types";
import { buildForecast, type ForecastInput } from "../engine/forecast";
import { decide } from "../engine/decision";
import { buildCollectionPlan, markChased, recordCommitment } from "../engine/collections";
import { runReplay } from "../engine/replay";
import { baseSeed, applyShock, DEMO_REQUESTS, TODAY } from "../db/seed";
import { buildCollectionEmail, createEmailAdapter } from "../adapters/email";
import {
  createLLMAdapter,
  buildDecisionNarrationPrompt,
  DECISION_NARRATION_SYSTEM_PROMPT,
} from "../adapters/llm";
import { formatINR } from "../money";

/** How often the agent wakes itself to re-forecast and defend. */
const ALARM_INTERVAL_MS = 20_000;

interface PersistedState extends LedgerState {
  emails: SentEmail[];
  replay: ReplayResult | null;
  autonomyEnabled: boolean;
  /** Last breach the agent announced, so it does not repeat itself. */
  lastBreachWeek?: number | null;
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

  // ---------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------

  private async load(): Promise<PersistedState> {
    if (this.cache) return this.cache;
    const stored = await this.ctx.storage.get<PersistedState>("state");
    this.cache = stored ?? this.freshState();
    return this.cache;
  }

  private async save(state: PersistedState): Promise<void> {
    this.cache = state;
    await this.ctx.storage.put("state", state);
  }

  private freshState(): PersistedState {
    return { ...baseSeed(), emails: [], replay: null, autonomyEnabled: true };
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

  /** Schedule the next self-wake. Idempotent. */
  private async ensureAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  /**
   * The wake-up. Nobody triggered this.
   *
   * Re-forecasts, and if the projection has fallen through the CFO's safety
   * line, goes and does something about it.
   */
  override async alarm(): Promise<void> {
    try {
      await this.defendCashPosition({ triggeredBy: "alarm" });
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  /**
   * Autonomous cash defense.
   *
   * Diagnose -> rank receivables by whether they land before the shortfall ->
   * chase -> record. Sending is deliberately done after state is committed so
   * a slow mail provider cannot wedge the object.
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
      // Healthy. Record the check on manual runs only — an idle agent should
      // not fill the log with "nothing to do" every twenty seconds.
      if (opts.triggeredBy === "manual") {
        this.log(state, "forecast_updated", "agent", `Forecast re-run — projected minimum ${formatINR(forecast.projectedMinimum)}, no action needed.`, {
          projectedMinimum: forecast.projectedMinimum,
          headroom: forecast.headroom,
        });
        await this.save(state);
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
        state.lastBreachWeek = forecast.breachWeek;
        this.log(
          state,
          "breach_detected",
          "agent",
          `Projected cash breaches the ${formatINR(forecast.threshold)} safety threshold in week ${forecast.breachWeek} — short by ${formatINR(forecast.breachGap)}. No collectable receivable would arrive in time; this needs you.`,
          { breachWeek: forecast.breachWeek, gap: forecast.breachGap },
        );
        await this.save(state);
      }
      return { acted: false, chased: 0, breachWeek: forecast.breachWeek };
    }

    const week = forecast.weeks[forecast.breachWeek - 1];
    state.lastBreachWeek = forecast.breachWeek;
    this.log(
      state,
      "breach_detected",
      "agent",
      `Projected cash breaches the ${formatINR(forecast.threshold)} safety threshold in week ${forecast.breachWeek}${week ? ` (${week.startDate})` : ""} — short by ${formatINR(forecast.breachGap)}.`,
      {
        breachWeek: forecast.breachWeek,
        gap: forecast.breachGap,
        projectedMinimum: forecast.projectedMinimum,
      },
    );

    for (const skip of plan.skipped) {
      if (/sensitive/i.test(skip.reason)) {
        this.log(state, "system", "agent", `Holding ${skip.invoiceId} for you — ${skip.reason}`, skip);
      }
    }

    // Commit "chased" before transmitting. If a send fails we would rather
    // under-chase than double-chase a customer.
    const now = new Date().toISOString();
    const targetIds = plan.targets.map((t) => t.invoice.id);
    state.invoices = state.invoices.map((inv) =>
      targetIds.includes(inv.id) ? markChased(inv, now) : inv,
    );
    await this.save(state);

    const emailAdapter = createEmailAdapter(this.env);
    const recipientOverride = this.env.DEMO_RECIPIENT_EMAIL?.trim();

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

      const fresh = await this.load();
      fresh.emails = [...fresh.emails, sent];
      this.log(
        fresh,
        "email_sent",
        "agent",
        `Collection email sent — ${target.invoice.customer}, ${formatINR(target.invoice.amount)}, ${target.daysOverdue} days overdue.`,
        { emailId: sent.id, invoiceId: target.invoice.id, simulated: result.simulated, rationale: target.rationale },
      );
      await this.save(fresh);
    }

    const after = await this.load();
    this.log(
      after,
      "system",
      "agent",
      `Chased ${formatINR(plan.totalChased)} across ${plan.targets.length} overdue invoice${plan.targets.length === 1 ? "" : "s"} to cover a ${formatINR(plan.gap)} shortfall.`,
      { totalChased: plan.totalChased, gap: plan.gap },
    );
    await this.save(after);

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
  async submitRequest(input: {
    idempotencyKey: string;
    departmentId: string;
    vendorId: string;
    amount: number;
    category: string;
    description: string;
    requestedBy: string;
    expectedWeek: number;
  }): Promise<{ decision: Decision; request: SpendRequest } | { error: string }> {
    const state = await this.load();

    const existing = state.requests.find((r) => r.idempotencyKey === input.idempotencyKey);
    if (existing) {
      const priorDecision = state.decisions.find((d) => d.requestId === existing.id);
      if (priorDecision) return { decision: priorDecision, request: existing };
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
      now: new Date().toISOString(),
    });

    request.status =
      decision.outcome === "APPROVED"
        ? "approved"
        : decision.outcome === "REJECTED"
          ? "rejected"
          : "escalated";

    state.requests = [...state.requests, request];
    state.decisions = [...state.decisions, decision];
    if (reservation) state.reservations = [...state.reservations, reservation];

    this.log(
      state,
      "decision",
      "agent",
      `${decision.outcome} — ${formatINR(request.amount)} for ${department.name} (${vendor.name}).`,
      { decisionId: decision.id, requestId: request.id, outcome: decision.outcome },
    );

    await this.save(state);

    // Narration is an upgrade, never a dependency. Fire and forget.
    this.ctx.waitUntil(this.narrate(decision.id, department.name, vendor.name));

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

    const fresh = await this.load();
    fresh.decisions = fresh.decisions.map((d) => (d.id === decisionId ? { ...d, narration: text } : d));
    await this.save(fresh);
  }

  /** CFO acts on an escalation. */
  async resolveEscalation(
    requestId: string,
    action: "approve" | "reject" | "defer",
  ): Promise<{ ok: boolean }> {
    const state = await this.load();
    const request = state.requests.find((r) => r.id === requestId);
    if (!request) return { ok: false };

    if (action === "approve") {
      request.status = "approved";
      state.reservations = [
        ...state.reservations,
        {
          id: crypto.randomUUID(),
          requestId: request.id,
          amount: request.amount,
          week: request.expectedWeek,
          createdAt: new Date().toISOString(),
          releasedAt: null,
        },
      ];
    } else if (action === "reject") {
      request.status = "rejected";
    } else {
      request.status = "cancelled";
    }

    state.requests = state.requests.map((r) => (r.id === requestId ? request : r));
    this.log(
      state,
      "decision",
      "human",
      `CFO ${action === "defer" ? "deferred" : `${action}d`} ${formatINR(request.amount)} — ${request.description}.`,
      { requestId },
    );
    await this.save(state);
    return { ok: true };
  }

  // ---------------------------------------------------------------------
  // Inbound replies
  // ---------------------------------------------------------------------

  /**
   * Record a customer's commitment.
   *
   * In production this is driven by inbound email parsing. For the build it is
   * invoked directly — the plumbing is staged, the effect on the forecast is
   * entirely real.
   */
  async injectReply(input: {
    invoiceId?: string;
    amount?: number;
    date?: string;
  } = {}): Promise<{ ok: boolean; recovered: number }> {
    const state = await this.load();

    const chased = state.invoices.filter(
      (inv) => inv.chasedAt !== null && inv.status !== "committed" && inv.status !== "paid",
    );
    const targets: Invoice[] = input.invoiceId
      ? state.invoices.filter((i) => i.id === input.invoiceId)
      : chased;

    if (targets.length === 0) return { ok: false, recovered: 0 };

    const before = buildForecast(this.forecastInput(state));
    let recovered = 0;

    for (const invoice of targets) {
      const amount = input.amount ?? invoice.amount;
      const date = input.date ?? "2026-09-25";
      state.invoices = state.invoices.map((inv) =>
        inv.id === invoice.id ? recordCommitment(inv, amount, date) : inv,
      );
      recovered += amount;
      this.log(
        state,
        "reply_parsed",
        "agent",
        `Reply from ${invoice.customer} — commits ${formatINR(amount)} by ${date}.`,
        { invoiceId: invoice.id, amount, date },
      );
    }

    const after = buildForecast(this.forecastInput(state));
    this.log(
      state,
      "commitment_recorded",
      "agent",
      `Forecast updated — projected minimum ${formatINR(before.projectedMinimum)} → ${formatINR(after.projectedMinimum)}, headroom ${formatINR(after.headroom)}.`,
      { before: before.projectedMinimum, after: after.projectedMinimum, headroom: after.headroom },
    );

    if (before.breachWeek !== null && after.breachWeek === null) {
      this.log(
        state,
        "breach_cleared",
        "agent",
        `Shortfall cleared. Projected cash stays above ${formatINR(after.threshold)} across the full horizon.`,
        { recovered },
      );
    }

    await this.save(state);
    return { ok: true, recovered };
  }

  // ---------------------------------------------------------------------
  // Demo control
  // ---------------------------------------------------------------------

  async reset(): Promise<void> {
    const state = this.freshState();
    this.log(state, "system", "human", "Demo state reset to baseline.", {});
    await this.save(state);
    await this.ctx.storage.deleteAlarm();
    await this.ensureAlarm();
  }

  async applyShockScenario(): Promise<void> {
    const state = await this.load();
    const shocked = applyShock(state) as PersistedState;
    shocked.emails = state.emails;
    shocked.replay = state.replay;
    shocked.autonomyEnabled = state.autonomyEnabled;
    shocked.activity = state.activity;

    const before = buildForecast(this.forecastInput(state));
    const after = buildForecast(this.forecastInput(shocked));

    this.log(
      shocked,
      "shock_applied",
      "human",
      `Helios pushed ${formatINR(1_500_000)} out by eight weeks and payroll stepped up ${formatINR(600_000)}.`,
      {},
    );
    this.log(
      shocked,
      "forecast_updated",
      "agent",
      `Forecast re-run — projected minimum ${formatINR(before.projectedMinimum)} → ${formatINR(after.projectedMinimum)}.`,
      { before: before.projectedMinimum, after: after.projectedMinimum },
    );

    await this.save(shocked);
  }

  async submitDemoRequest(key: string): Promise<unknown> {
    const template = DEMO_REQUESTS[key];
    if (!template) return { error: `Unknown demo request: ${key}` };
    return this.submitRequest({ ...template, idempotencyKey: `${template.idempotencyKey}-${crypto.randomUUID()}` });
  }

  async runReplayScenario(): Promise<ReplayResult> {
    const state = await this.load();
    const result = runReplay({
      historical: state.historical,
      departments: state.departments,
      vendors: state.vendors,
      categoryStats: state.categoryStats,
      rules: state.company.rules,
    });
    state.replay = result;
    this.log(
      state,
      "system",
      "human",
      `Replayed ${result.total} prior-quarter decisions — agreed on ${result.agreed}, flagged ${result.flagged}.`,
      {},
    );
    await this.save(state);
    return result;
  }

  // ---------------------------------------------------------------------
  // Read model
  // ---------------------------------------------------------------------

  async getDashboardState(): Promise<DashboardState> {
    await this.ensureAlarm();
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
      activity: [...state.activity].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
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
