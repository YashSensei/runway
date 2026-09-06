/**
 * The decision engine.
 *
 * This is the product. Given a request and the current financial state it
 * returns APPROVED / ESCALATED / REJECTED, deterministically.
 *
 * No language model is involved at any point in this file. The model's only
 * job, elsewhere, is to restate a decision that has already been made. That
 * separation is what makes the outcome auditable, reproducible, and safe to
 * put on a stage.
 */

import type {
  CategoryStat,
  Rupees,
  CfoRules,
  Decision,
  Department,
  Forecast,
  ISODateTime,
  ReasonCode,
  Reservation,
  RuleEvaluation,
  SpendRequest,
  Vendor,
} from "../types";
import { formatINR } from "../money";
import { buildForecast, forecastWithHypothetical, type ForecastInput } from "./forecast";
import { evaluateRules, type PriorCommitments, type RuleContext } from "./rules";

export interface DecideInput {
  request: SpendRequest;
  department: Department;
  vendor: Vendor;
  categoryStat: CategoryStat | undefined;
  rules: CfoRules;
  /** Everything needed to recompute the forecast, before this request. */
  forecastInput: ForecastInput;
  /** Autonomous spend already committed inside the rolling window. */
  priorCommitments: PriorCommitments;
  /** Precomputed current forecast. Recomputed if omitted. */
  forecastBefore?: Forecast;
  now: ISODateTime;
  newId?: () => string;
}

export interface DecisionResult {
  decision: Decision;
  /** Present only on APPROVED — this is what consumes headroom. */
  reservation: Reservation | null;
  forecastBefore: Forecast;
  forecastAfter: Forecast;
}

function defaultId(): string {
  return crypto.randomUUID();
}

/**
 * The precedence ladder from the spec, in order. First match wins.
 *
 *   1. Hard rule violation      -> REJECT
 *   2. Amount exceeds authority -> ESCALATE
 *   3. Insufficient headroom    -> ESCALATE
 *   4. Anomalous vs history     -> ESCALATE
 *   5. Otherwise                -> APPROVE
 *
 * Rejection means a policy the CFO configured was broken. Escalation means the
 * agent holds the authority to act but has judged that it should not.
 */
export function resolveOutcome(evaluations: RuleEvaluation[]): {
  outcome: Decision["outcome"];
  reasonCode: ReasonCode;
} {
  const failed = (rule: RuleEvaluation["rule"]): boolean =>
    evaluations.some((e) => e.rule === rule && !e.passed);

  const hardViolation = evaluations.some((e) => e.severity === "hard" && !e.passed);
  if (hardViolation) {
    return { outcome: "REJECTED", reasonCode: "hard_rule_violation" };
  }
  if (failed("max_autonomous_amount") || failed("aggregate_authority")) {
    return { outcome: "ESCALATED", reasonCode: "exceeds_authority" };
  }
  if (failed("headroom_check") || failed("min_cash_threshold")) {
    return { outcome: "ESCALATED", reasonCode: "insufficient_headroom" };
  }
  if (failed("anomaly_multiplier")) {
    return { outcome: "ESCALATED", reasonCode: "anomalous_request" };
  }
  return { outcome: "APPROVED", reasonCode: "within_authority" };
}

function detailFor(evaluations: RuleEvaluation[], rule: RuleEvaluation["rule"]): string {
  return evaluations.find((e) => e.rule === rule)?.detail ?? "";
}

/**
 * Deterministic explanation, always generated.
 *
 * The LLM narration is an upgrade layered on top of this, never a dependency.
 * If every model in the world is down, the demo still explains itself.
 */
export function buildFallbackNarration(args: {
  outcome: Decision["outcome"];
  reasonCode: ReasonCode;
  request: SpendRequest;
  department: Department;
  evaluations: RuleEvaluation[];
  forecastBefore: Forecast;
  forecastAfter: Forecast;
  rules: CfoRules;
}): string {
  const { outcome, reasonCode, request, department, evaluations, forecastBefore, forecastAfter, rules } = args;
  const amount = formatINR(request.amount);
  const dept = department.name;

  if (outcome === "REJECTED") {
    const broken = evaluations.filter((e) => e.severity === "hard" && !e.passed);
    const reasons = broken.map((e) => e.detail).join(" ");
    return `Rejected ${amount} for ${dept}. ${reasons} This breaks a policy you configured, so I have not acted on it — it is routed to you unchanged.`;
  }

  if (reasonCode === "exceeds_authority") {
    if (!evaluations.find((e) => e.rule === "aggregate_authority")?.passed) {
      return `Escalating ${amount} for ${dept}. ${detailFor(evaluations, "aggregate_authority")} Each request on its own is inside the ceiling you set; together they are not, and I am not going to let a limit be evaded by splitting the invoice.`;
    }
    return `Escalating ${amount} for ${dept}. ${detailFor(evaluations, "max_autonomous_amount")} This is above the authority you delegated to me, so it is your call regardless of the merits. For what it is worth: ${detailFor(evaluations, "budget_overage")}`;
  }

  if (reasonCode === "insufficient_headroom") {
    // "Nothing is wrong with this request in itself" is the most persuasive
    // sentence the agent says, so it must be exactly true: every rule about
    // the REQUEST passes, and only the rules about available CASH fail. Note
    // the two cash rules usually fail together, so counting failures is not
    // the same test.
    const cashRules = new Set(["headroom_check", "min_cash_threshold"]);
    const clean = evaluations.every((e) => e.passed || cashRules.has(e.rule));
    const preamble = clean
      ? `Escalating ${amount} for ${dept}. Nothing is wrong with this request in itself — it is within authority, within budget, and consistent with what ${dept} normally spends.`
      : `Escalating ${amount} for ${dept}.`;
    return `${preamble} ${detailFor(evaluations, "headroom_check")} ${detailFor(evaluations, "min_cash_threshold")} Approving it would leave you below the ${formatINR(rules.minCashThreshold)} line you set, so I am handing it back rather than using authority I technically have.`;
  }

  if (reasonCode === "anomalous_request") {
    return `Escalating ${amount} for ${dept}. It clears every hard rule and there is enough headroom, but the amount does not match the pattern. ${detailFor(evaluations, "anomaly_multiplier")} I would rather you looked at it.`;
  }

  return [
    `Approved ${amount} for ${dept}.`,
    detailFor(evaluations, "max_autonomous_amount"),
    detailFor(evaluations, "budget_overage"),
    detailFor(evaluations, "require_vendor_history"),
    detailFor(evaluations, "anomaly_multiplier"),
    `Projected minimum cash moves ${formatINR(forecastBefore.projectedMinimum)} → ${formatINR(forecastAfter.projectedMinimum)}, leaving ${formatINR(forecastAfter.headroom)} of headroom above your ${formatINR(rules.minCashThreshold)} threshold.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The sentence that ties the two halves of the product together.
 *
 * When an approval only fits because the agent's own collection work raised
 * the trough, say so — deterministically, from the recorded recovery. Without
 * this the demo's central claim ("its own action changed its own decision")
 * is something the presenter asserts instead of something the agent says.
 */
export function recoveryPreamble(args: {
  outcome: Decision["outcome"];
  amount: Rupees;
  threshold: Rupees;
  cleared: { recovered: Rupees; customers: string[]; before: Rupees; after: Rupees } | null;
}): string | null {
  const { outcome, amount, threshold, cleared } = args;
  if (outcome !== "APPROVED" || !cleared) return null;

  // Headroom as it stood before the commitments landed. If this request would
  // not have fit inside it, the recovery is what made room.
  const headroomBeforeRecovery = cleared.before - threshold;
  if (amount <= headroomBeforeRecovery) return null;

  const who =
    cleared.customers.length === 0
      ? "customers"
      : cleared.customers.length === 1
        ? cleared.customers[0]!
        : `${cleared.customers.slice(0, -1).join(", ")} and ${cleared.customers[cleared.customers.length - 1]!}`;

  return `This would have been escalated before the collection: the ${formatINR(cleared.recovered)} I recovered from ${who} raised projected minimum from ${formatINR(cleared.before)} to ${formatINR(cleared.after)}, which is what made room for it.`;
}

function buildDataUsed(ctx: RuleContext): string[] {
  const used = [
    `${ctx.department.name} quarter-to-date spend (${formatINR(ctx.department.periodSpend)})`,
    `${ctx.department.name} quarterly budget (${formatINR(ctx.department.quarterlyBudget)})`,
    "Current cash position",
    `${ctx.forecastBefore.weeks.length}-week cash forecast`,
    "Available headroom against the safety threshold",
  ];
  if (ctx.vendor.invoiceCount > 0) {
    used.push(`${ctx.vendor.name} invoice history (${ctx.vendor.invoiceCount} prior)`);
  } else {
    used.push(`${ctx.vendor.name} vendor record (no prior history)`);
  }
  if (ctx.categoryStat && ctx.categoryStat.sampleCount > 0) {
    used.push(
      `${ctx.categoryStat.sampleCount} comparable ${ctx.categoryStat.category} requests (avg ${formatINR(ctx.categoryStat.averageAmount)})`,
    );
  }
  return used;
}

/**
 * Evaluate one request against the current state.
 *
 * Pure: nothing is mutated and nothing is persisted. The caller (the Durable
 * Object) is responsible for committing the reservation, and because the DO is
 * single-threaded, two concurrent requests cannot both read the same headroom.
 */
export function decide(input: DecideInput): DecisionResult {
  const forecastBefore = input.forecastBefore ?? buildForecast(input.forecastInput);
  const forecastAfter = forecastWithHypothetical(input.forecastInput, {
    amount: input.request.amount,
    week: input.request.expectedWeek,
    id: input.request.id,
  });

  const ctx: RuleContext = {
    request: input.request,
    department: input.department,
    vendor: input.vendor,
    categoryStat: input.categoryStat,
    rules: input.rules,
    forecastBefore,
    forecastAfter,
    priorCommitments: input.priorCommitments,
  };

  const evaluations = evaluateRules(ctx);
  const { outcome, reasonCode } = resolveOutcome(evaluations);
  const newId = input.newId ?? defaultId;

  const decision: Decision = {
    id: newId(),
    requestId: input.request.id,
    outcome,
    reasonCode,
    rules: evaluations,
    dataUsed: buildDataUsed(ctx),
    headroomBefore: forecastBefore.headroom,
    // A rejected or escalated request reserves nothing, so headroom is unchanged.
    headroomAfter: outcome === "APPROVED" ? forecastAfter.headroom : forecastBefore.headroom,
    projectedMinimumBefore: forecastBefore.projectedMinimum,
    projectedMinimumAfter:
      outcome === "APPROVED" ? forecastAfter.projectedMinimum : forecastBefore.projectedMinimum,
    narration: null,
    fallbackNarration: buildFallbackNarration({
      outcome,
      reasonCode,
      request: input.request,
      department: input.department,
      evaluations,
      forecastBefore,
      forecastAfter,
      rules: input.rules,
    }),
    createdAt: input.now,
  };

  const reservation: Reservation | null =
    outcome === "APPROVED"
      ? {
          id: newId(),
          requestId: input.request.id,
          amount: input.request.amount,
          week: input.request.expectedWeek,
          createdAt: input.now,
          releasedAt: null,
        }
      : null;

  return { decision, reservation, forecastBefore, forecastAfter };
}
