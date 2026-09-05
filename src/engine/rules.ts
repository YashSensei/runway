/**
 * CFO rule evaluation.
 *
 * Each rule is a pure predicate that returns a pass/fail plus the human
 * sentence that will appear in the audit trail. Rules do NOT decide anything —
 * they only report. `decision.ts` owns the precedence ladder that turns these
 * results into an outcome.
 *
 * Severity encodes what a failure means:
 *   hard  -> a configured policy was broken            -> REJECT
 *   soft  -> the agent has authority but shouldn't use it -> ESCALATE
 */

import type {
  CategoryStat,
  CfoRules,
  Department,
  Forecast,
  RuleEvaluation,
  SpendRequest,
  Vendor,
} from "../types";
import { formatINR } from "../money";

export interface RuleContext {
  request: SpendRequest;
  department: Department;
  vendor: Vendor;
  /** Absent when this department has never spent in this category before. */
  categoryStat: CategoryStat | undefined;
  rules: CfoRules;
  /** Current forecast, before this request is committed. */
  forecastBefore: Forecast;
  /** Forecast with this request hypothetically reserved. */
  forecastAfter: Forecast;
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 1000) / 10}%`;
}

/** Ceiling on delegated authority. Exceeding it escalates — it never rejects. */
export function ruleMaxAutonomousAmount(ctx: RuleContext): RuleEvaluation {
  const { amount } = ctx.request;
  const limit = ctx.rules.maxAutonomousAmount;
  const passed = amount <= limit;
  return {
    rule: "max_autonomous_amount",
    passed,
    severity: "soft",
    detail: passed
      ? `${formatINR(amount)} is within the ${formatINR(limit)} delegated authority limit.`
      : `${formatINR(amount)} exceeds the ${formatINR(limit)} delegated authority limit by ${formatINR(amount - limit)}.`,
  };
}

/** Department budget, including the CFO's tolerated overage band. */
export function ruleBudgetOverage(ctx: RuleContext): RuleEvaluation {
  const { department, rules, request } = ctx;
  const ceiling = Math.round(department.quarterlyBudget * (1 + rules.maxBudgetOverage));
  const projected = department.periodSpend + request.amount;
  const passed = projected <= ceiling;
  const utilisation = department.quarterlyBudget > 0 ? projected / department.quarterlyBudget : 0;

  return {
    rule: "budget_overage",
    passed,
    severity: "hard",
    detail: passed
      ? `${department.name} would be at ${pct(utilisation)} of its ${formatINR(department.quarterlyBudget)} quarterly budget (${formatINR(projected)} of ${formatINR(ceiling)} allowed).`
      : `${department.name} would reach ${pct(utilisation)} of budget — ${formatINR(projected)} against a ${formatINR(ceiling)} ceiling (${pct(rules.maxBudgetOverage)} overage allowed). Over by ${formatINR(projected - ceiling)}.`,
  };
}

/** First-time vendors always need a human. Non-negotiable by design. */
export function ruleRequireVendorHistory(ctx: RuleContext): RuleEvaluation {
  const { vendor, rules } = ctx;
  const known = vendor.invoiceCount > 0;
  const passed = !rules.requireVendorHistory || known;
  return {
    rule: "require_vendor_history",
    passed,
    severity: "hard",
    detail: known
      ? `${vendor.name} has ${vendor.invoiceCount} prior invoice${vendor.invoiceCount === 1 ? "" : "s"}, averaging ${formatINR(vendor.avgAmount)}.`
      : `${vendor.name} has no prior transaction history. Your rules require human approval for first-time vendors.`,
  };
}

/**
 * The consumable-authority check.
 *
 * Headroom is what remains between the forecast trough and the safety line
 * *after* everything already approved this cycle. This is the rule that makes
 * two individually-reasonable requests interact.
 */
export function ruleHeadroom(ctx: RuleContext): RuleEvaluation {
  const available = ctx.forecastBefore.headroom;
  const { amount } = ctx.request;
  const passed = amount <= available;
  return {
    rule: "headroom_check",
    passed,
    severity: "soft",
    detail: passed
      ? `${formatINR(amount)} fits within ${formatINR(available)} of available headroom, leaving ${formatINR(available - amount)}.`
      : available <= 0
        ? `No headroom available — the forecast is already ${formatINR(-available)} below the safety threshold.`
        : `${formatINR(amount)} exceeds the ${formatINR(available)} of headroom remaining this cycle, short by ${formatINR(amount - available)}.`,
  };
}

/**
 * Absolute cash safety.
 *
 * Distinct from the headroom check: a request scheduled after the forecast
 * trough does not move the minimum at all, so this can pass where headroom
 * fails, and the audit trail should show both.
 */
export function ruleMinCashThreshold(ctx: RuleContext): RuleEvaluation {
  const after = ctx.forecastAfter.projectedMinimum;
  const before = ctx.forecastBefore.projectedMinimum;
  const threshold = ctx.rules.minCashThreshold;
  const passed = after >= threshold;
  return {
    rule: "min_cash_threshold",
    passed,
    severity: "soft",
    detail: passed
      ? `Projected minimum cash moves ${formatINR(before)} → ${formatINR(after)}, staying above the ${formatINR(threshold)} safety threshold.`
      : `Projected minimum cash would fall ${formatINR(before)} → ${formatINR(after)}, breaching the ${formatINR(threshold)} safety threshold by ${formatINR(threshold - after)}${ctx.forecastAfter.breachWeek !== null ? ` in week ${ctx.forecastAfter.breachWeek}` : ""}.`,
  };
}

/** Is this amount normal for this department and category? */
export function ruleAnomaly(ctx: RuleContext): RuleEvaluation {
  const stat = ctx.categoryStat;
  const { amount } = ctx.request;

  if (!stat || stat.sampleCount === 0) {
    return {
      rule: "anomaly_multiplier",
      passed: true,
      severity: "soft",
      detail: `No historical baseline for ${ctx.request.category} in ${ctx.department.name}; nothing to compare against.`,
    };
  }

  const ceiling = Math.round(stat.averageAmount * ctx.rules.anomalyMultiplier);
  const passed = amount <= ceiling;
  const ratio = stat.averageAmount > 0 ? amount / stat.averageAmount : 0;

  return {
    rule: "anomaly_multiplier",
    passed,
    severity: "soft",
    detail: passed
      ? `${formatINR(amount)} against a ${formatINR(stat.averageAmount)} average across ${stat.sampleCount} comparable requests (${ratio.toFixed(1)}×).`
      : `${formatINR(amount)} is ${ratio.toFixed(1)}× the ${formatINR(stat.averageAmount)} average across ${stat.sampleCount} comparable requests, past the ${ctx.rules.anomalyMultiplier}× flag threshold.`,
  };
}

/** Evaluate every rule. Order here is presentation order, not precedence. */
export function evaluateRules(ctx: RuleContext): RuleEvaluation[] {
  return [
    ruleMaxAutonomousAmount(ctx),
    ruleBudgetOverage(ctx),
    ruleRequireVendorHistory(ctx),
    ruleHeadroom(ctx),
    ruleMinCashThreshold(ctx),
    ruleAnomaly(ctx),
  ];
}

/** Human-readable label for each rule, for the audit trail UI. */
export const RULE_LABELS: Record<RuleEvaluation["rule"], string> = {
  max_autonomous_amount: "Delegated authority limit",
  budget_overage: "Department budget",
  require_vendor_history: "Vendor history",
  headroom_check: "Available headroom",
  min_cash_threshold: "Cash safety threshold",
  anomaly_multiplier: "Spend pattern",
};

/** Describe the configured policy, for the UI's rules panel. */
export function describeRules(rules: CfoRules): Array<{ label: string; value: string }> {
  return [
    { label: "Autonomous approval limit", value: formatINR(rules.maxAutonomousAmount) },
    { label: "Cash safety threshold", value: formatINR(rules.minCashThreshold) },
    { label: "Budget overage allowed", value: pct(rules.maxBudgetOverage) },
    { label: "New vendors need a human", value: rules.requireVendorHistory ? "Yes" : "No" },
    { label: "Anomaly flag threshold", value: `${rules.anomalyMultiplier}× category average` },
  ];
}
