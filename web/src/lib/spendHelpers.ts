/**
 * Pure, client-side derivations over `DashboardState` for the Spend, Policy
 * and Agent pages.
 *
 * Nothing here is authoritative. The engine on the Durable Object decides;
 * these helpers only let the UI *preview* what it will most likely say, and
 * summarise what it has already said. Every function is deterministic and
 * side-effect free so it can be called on every render.
 */

import { useEffect, useState } from "react";
import type {
  CfoRules,
  DashboardState,
  DecisionView,
  Forecast,
  ReasonCode,
  RuleEvaluation,
  RuleId,
  Rupees,
  SpendRequest,
  DecisionOutcome,
} from "@shared/types";
import { evaluateRules, type PriorCommitments, type RuleContext } from "@engine/rules";
import { resolveOutcome } from "@engine/decision";

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Decisions and requests
// ---------------------------------------------------------------------------

/** Newest first, stable on id. `state.decisions` already arrives this way; sort defensively. */
export function sortNewestFirst(decisions: readonly DecisionView[]): DecisionView[] {
  return [...decisions].sort(
    (a, b) =>
      Date.parse(b.decision.createdAt) - Date.parse(a.decision.createdAt) ||
      b.decision.id.localeCompare(a.decision.id),
  );
}

/**
 * One row per request: the LATEST decision recorded for it. Older decisions
 * (the agent's escalation under a CFO override, a deferred run under its
 * re-evaluation) stay reachable through `supersedes`.
 */
export function latestPerRequest(decisions: readonly DecisionView[]): DecisionView[] {
  const seen = new Set<string>();
  const out: DecisionView[] = [];
  for (const view of sortNewestFirst(decisions)) {
    if (seen.has(view.decision.requestId)) continue;
    seen.add(view.decision.requestId);
    out.push(view);
  }
  return out;
}

/** Every distinct request we know about, taken from the decision views. */
export function knownRequests(decisions: readonly DecisionView[]): SpendRequest[] {
  return latestPerRequest(decisions).map((v) => v.request);
}

/**
 * Requests that currently hold a reservation: status approved or paid. This is
 * the same predicate the Durable Object uses for the rolling pool, so the
 * pre-check agrees with the engine on aggregate authority.
 */
export function approvedRequests(decisions: readonly DecisionView[]): SpendRequest[] {
  return knownRequests(decisions).filter(
    (r) => r.status === "approved" || r.status === "paid",
  );
}

/** Approved by the engine itself — the latest decision is APPROVED and not a CFO override. */
export function agentApprovedViews(decisions: readonly DecisionView[]): DecisionView[] {
  return latestPerRequest(decisions).filter(
    (v) =>
      v.decision.outcome === "APPROVED" &&
      v.decision.actor !== "cfo" &&
      (v.request.status === "approved" || v.request.status === "paid"),
  );
}

/** Inside the rolling window, measured from `now` like the server does. */
function inWindow(request: SpendRequest, windowDays: number, now: number): boolean {
  return Date.parse(request.createdAt) >= now - windowDays * DAY_MS;
}

/**
 * What the agent has already committed for this department (and this vendor)
 * inside the rolling window. Mirrors `CompanyAgent.priorCommitments` exactly:
 * approved-or-paid requests, keyed on `request.createdAt`.
 */
export function priorCommitmentsFor(
  state: DashboardState,
  departmentId: string,
  vendorId: string,
  now: number = Date.now(),
): PriorCommitments {
  const windowDays = state.company.rules.rollingWindowDays;
  let departmentWindowTotal: Rupees = 0;
  let vendorWindowTotal: Rupees = 0;

  for (const request of approvedRequests(state.decisions)) {
    if (request.departmentId !== departmentId) continue;
    if (!inWindow(request, windowDays, now)) continue;
    departmentWindowTotal += request.amount;
    if (request.vendorId === vendorId) vendorWindowTotal += request.amount;
  }

  return { departmentWindowTotal, vendorWindowTotal, windowDays };
}

/** Approved spend that went to a vendor inside the rolling window, all departments. */
export function vendorWindowSpend(
  state: DashboardState,
  vendorId: string,
  now: number = Date.now(),
): { total: Rupees; autonomous: Rupees; count: number } {
  const windowDays = state.company.rules.rollingWindowDays;
  let total: Rupees = 0;
  let autonomous: Rupees = 0;
  let count = 0;
  for (const view of latestPerRequest(state.decisions)) {
    const r = view.request;
    if (r.vendorId !== vendorId) continue;
    if (r.status !== "approved" && r.status !== "paid") continue;
    if (!inWindow(r, windowDays, now)) continue;
    total += r.amount;
    count += 1;
    if (view.decision.actor !== "cfo") autonomous += r.amount;
  }
  return { total, autonomous, count };
}

/** Department-level pool consumption this window, for the budgets and policy panels. */
export function departmentWindowSpend(
  state: DashboardState,
  departmentId: string,
  now: number = Date.now(),
): Rupees {
  return priorCommitmentsFor(state, departmentId, "", now).departmentWindowTotal;
}

/** Approved requests (latest decision) for one department, newest first. */
export function approvedForDepartment(
  decisions: readonly DecisionView[],
  departmentId: string,
): DecisionView[] {
  return latestPerRequest(decisions).filter(
    (v) =>
      v.request.departmentId === departmentId &&
      (v.request.status === "approved" || v.request.status === "paid"),
  );
}

/**
 * The most likely category for a vendor: what the ledger has paid them for,
 * then what has been requested against them. Null when nothing is known.
 */
export function inferVendorCategory(state: DashboardState, vendorId: string): string | null {
  const tally = new Map<string, number>();
  const bump = (category: string, weight: number): void => {
    const c = category.trim();
    if (!c) return;
    tally.set(c, (tally.get(c) ?? 0) + weight);
  };
  for (const p of state.payables) if (p.vendorId === vendorId) bump(p.category, 2);
  for (const r of knownRequests(state.decisions)) if (r.vendorId === vendorId) bump(r.category, 1);

  let best: string | null = null;
  let bestWeight = 0;
  for (const [category, weight] of tally) {
    if (weight > bestWeight) {
      best = category;
      bestWeight = weight;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Rule failure history (Policy page)
// ---------------------------------------------------------------------------

export const ALL_RULE_IDS: readonly RuleId[] = [
  "max_autonomous_amount",
  "aggregate_authority",
  "budget_overage",
  "require_vendor_history",
  "headroom_check",
  "min_cash_threshold",
  "anomaly_multiplier",
];

/**
 * For each rule, the decisions in which it failed — agent decisions only,
 * because a CFO override copies the agent's rule list verbatim and would
 * double-count. Newest first.
 */
export function ruleFailures(decisions: readonly DecisionView[]): Map<RuleId, DecisionView[]> {
  const out = new Map<RuleId, DecisionView[]>();
  for (const id of ALL_RULE_IDS) out.set(id, []);
  for (const view of sortNewestFirst(decisions)) {
    if (view.decision.actor === "cfo") continue;
    for (const rule of view.decision.rules) {
      if (rule.passed) continue;
      const list = out.get(rule.rule);
      if (list) list.push(view);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Forecast arithmetic (pre-check and policy impact)
// ---------------------------------------------------------------------------

/**
 * The live forecast with one extra outflow folded in, reconstructed from the
 * published weekly closings. A reservation in week `w` lowers every closing
 * from `w` onward by the amount, so this is exact against the same inputs;
 * it is only "estimated" because the engine may have re-forecast since the
 * last poll.
 */
export function withHypotheticalSpend(
  forecast: Forecast,
  amount: Rupees,
  week: number,
): Forecast {
  const horizon = forecast.weeks.length;
  const landing = Math.min(Math.max(1, Math.trunc(week)), Math.max(1, horizon));
  return rebuildForecast(
    forecast,
    forecast.weeks.map((w) =>
      w.week >= landing ? w.closingCash - amount : w.closingCash,
    ),
    forecast.threshold,
  );
}

/** The live forecast judged against a different safety threshold. */
export function withThreshold(forecast: Forecast, threshold: Rupees): Forecast {
  return rebuildForecast(
    forecast,
    forecast.weeks.map((w) => w.closingCash),
    threshold,
  );
}

function rebuildForecast(base: Forecast, closings: readonly number[], threshold: Rupees): Forecast {
  const weeks = base.weeks.map((w, i) => {
    const closingCash = closings[i] ?? w.closingCash;
    return { ...w, closingCash, belowThreshold: closingCash < threshold };
  });

  const first = weeks[0];
  let projectedMinimum = first ? first.closingCash : base.projectedMinimum;
  let projectedMinimumWeek = first ? first.week : 0;
  let breachWeek: number | null = null;
  let breachWeekShortfall = 0;

  for (const w of weeks) {
    if (w.closingCash < projectedMinimum) {
      projectedMinimum = w.closingCash;
      projectedMinimumWeek = w.week;
    }
    if (breachWeek === null && w.belowThreshold) {
      breachWeek = w.week;
      breachWeekShortfall = threshold - w.closingCash;
    }
  }

  const last = weeks[weeks.length - 1];
  return {
    ...base,
    weeks,
    threshold,
    projectedMinimum,
    projectedMinimumWeek,
    breachWeek,
    breachGap: Math.max(0, threshold - projectedMinimum),
    breachWeekShortfall: Math.max(0, breachWeekShortfall),
    endingCash: last ? last.closingCash : base.endingCash,
    headroom: projectedMinimum - threshold,
  };
}

// ---------------------------------------------------------------------------
// Live pre-check (Spend page form)
// ---------------------------------------------------------------------------

export interface PreCheckDraft {
  departmentId: string;
  vendorId: string;
  amount: Rupees;
  category: string;
  expectedWeek: number;
}

export interface PreCheck {
  rules: RuleEvaluation[];
  outcome: DecisionOutcome;
  reasonCode: ReasonCode;
  /** Headroom after the request, from the reconstructed forecast. */
  headroomAfter: Rupees;
  /**
   * The category baseline lives only on the server (`categoryStats` is not
   * in `DashboardState`), so the spend-pattern rule cannot be previewed. It
   * is listed as unchecked, never as passed.
   */
  unchecked: readonly RuleId[];
}

/**
 * Run the real rules engine on a draft request against the live forecast.
 * Returns null while the draft is not yet evaluable (no department, no
 * vendor, or no positive whole-rupee amount).
 */
export function preCheck(state: DashboardState, draft: PreCheckDraft): PreCheck | null {
  const department = state.departments.find((d) => d.id === draft.departmentId);
  const vendor = state.vendors.find((v) => v.id === draft.vendorId);
  if (!department || !vendor) return null;
  if (!Number.isInteger(draft.amount) || draft.amount <= 0) return null;

  const horizon = state.company.forecastHorizonWeeks;
  const week = Math.min(Math.max(1, Math.trunc(draft.expectedWeek || 1)), Math.max(1, horizon));

  const request: SpendRequest = {
    id: "preview",
    idempotencyKey: "preview",
    departmentId: draft.departmentId,
    vendorId: draft.vendorId,
    amount: draft.amount,
    category: draft.category.trim() || "uncategorised",
    description: "",
    requestedBy: "",
    expectedWeek: week,
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  const forecastBefore = state.forecast;
  const forecastAfter = withHypotheticalSpend(forecastBefore, draft.amount, week);

  const ctx: RuleContext = {
    request,
    department,
    vendor,
    categoryStat: undefined,
    rules: state.company.rules,
    forecastBefore,
    forecastAfter,
    priorCommitments: priorCommitmentsFor(state, draft.departmentId, draft.vendorId),
  };

  const rules = evaluateRules(ctx);
  const { outcome, reasonCode } = resolveOutcome(rules);
  return {
    rules,
    outcome,
    reasonCode,
    headroomAfter: forecastAfter.headroom,
    unchecked: ["anomaly_multiplier"],
  };
}

// ---------------------------------------------------------------------------
// Policy impact preview
// ---------------------------------------------------------------------------

export interface PolicyImpact {
  /** Headroom the agent would have under the proposed threshold. */
  headroomAfter: Rupees;
  headroomDelta: Rupees;
  /** Breach week under the current and proposed threshold. */
  breachBefore: number | null;
  breachAfter: number | null;
  /** Escalated requests that would newly fit inside the per-request ceiling, pool and headroom. */
  nowFits: DecisionView[];
  /** Escalated requests that fit today but would no longer under the proposal. */
  noLongerFits: DecisionView[];
}

/**
 * What a rules change would do, computed from the live forecast. Threshold
 * changes move headroom and the breach week; limit and pool changes move
 * which open escalations would now be inside the agent's authority. Nothing
 * here touches the anomaly or vendor rules — those need server-side data.
 */
export function policyImpact(
  state: DashboardState,
  proposed: CfoRules,
  now: number = Date.now(),
): PolicyImpact {
  const current = state.company.rules;
  const before = state.forecast;
  const after = withThreshold(before, proposed.minCashThreshold);

  const fits = (view: DecisionView, rules: CfoRules, fc: Forecast): boolean => {
    const r = view.request;
    const prior = priorCommitmentsFor(
      { ...state, company: { ...state.company, rules } },
      r.departmentId,
      r.vendorId,
      now,
    );
    const withinLimit = r.amount <= rules.maxAutonomousAmount;
    const withinPool = prior.departmentWindowTotal + r.amount <= rules.rollingAuthorityPool;
    const withinHeadroom = r.amount <= fc.headroom;
    const hyp = withHypotheticalSpend(fc, r.amount, r.expectedWeek);
    const aboveThreshold = hyp.projectedMinimum >= rules.minCashThreshold;
    return withinLimit && withinPool && withinHeadroom && aboveThreshold;
  };

  const open = state.escalations.map<DecisionView>((e) => ({
    decision: e.decision,
    request: e.request,
    departmentName: e.departmentName,
    vendorName: e.vendorName,
  }));

  const nowFits: DecisionView[] = [];
  const noLongerFits: DecisionView[] = [];
  for (const view of open) {
    const fitsNow = fits(view, current, before);
    const fitsAfter = fits(view, proposed, after);
    if (!fitsNow && fitsAfter) nowFits.push(view);
    if (fitsNow && !fitsAfter) noLongerFits.push(view);
  }

  return {
    headroomAfter: after.headroom,
    headroomDelta: after.headroom - before.headroom,
    breachBefore: before.breachWeek,
    breachAfter: after.breachWeek,
    nowFits,
    noLongerFits,
  };
}

/** Only the fields that differ, so `PUT /api/rules` receives a minimal patch. */
export function rulesPatch(current: CfoRules, proposed: CfoRules): Partial<CfoRules> {
  const patch: Partial<CfoRules> = {};
  if (proposed.maxAutonomousAmount !== current.maxAutonomousAmount)
    patch.maxAutonomousAmount = proposed.maxAutonomousAmount;
  if (proposed.rollingAuthorityPool !== current.rollingAuthorityPool)
    patch.rollingAuthorityPool = proposed.rollingAuthorityPool;
  if (proposed.rollingWindowDays !== current.rollingWindowDays)
    patch.rollingWindowDays = proposed.rollingWindowDays;
  if (proposed.minCashThreshold !== current.minCashThreshold)
    patch.minCashThreshold = proposed.minCashThreshold;
  if (Math.abs(proposed.maxBudgetOverage - current.maxBudgetOverage) > 1e-9)
    patch.maxBudgetOverage = proposed.maxBudgetOverage;
  if (proposed.requireVendorHistory !== current.requireVendorHistory)
    patch.requireVendorHistory = proposed.requireVendorHistory;
  if (Math.abs(proposed.anomalyMultiplier - current.anomalyMultiplier) > 1e-9)
    patch.anomalyMultiplier = proposed.anomalyMultiplier;
  return patch;
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------


/** Client clock ticking every `everyMs`; for countdowns. */
export function useNow(everyMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** `12s`, `1m 04s`, `2h 10m`. Never negative. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${String(rs).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Whole rupees from a text input; null when it is not a positive integer. */
export function parseRupees(text: string): Rupees | null {
  const cleaned = text.replace(/[₹,\s]/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isSafeInteger(n) ? n : null;
}

export { clamp01 } from "./forecastMath";
