/**
 * Counterfactual replay — the proof layer.
 *
 * Re-decides the company's real historical requests with the same engine that
 * runs live, then compares against what the humans actually did. This is the
 * only honest way to answer "how do you know its judgment is any good?".
 *
 * One deliberate limitation, stated plainly: we cannot reconstruct the cash
 * position as it stood on each historical date, so the cash rules are held
 * neutral and the replay judges only what IS reconstructable — budget
 * position, vendor record, and spend pattern against category history. A
 * replay that silently invented a historical forecast would be a nicer
 * number and a dishonest one.
 */

import type {
  CategoryStat,
  Department,
  DecisionOutcome,
  HistoricalRequest,
  ReplayResult,
  Vendor,
  CfoRules,
} from "../types";
import {
  ruleAnomaly,
  ruleBudgetOverage,
  ruleMaxAutonomousAmount,
  ruleRequireVendorHistory,
  type RuleContext,
} from "./rules";
import { resolveOutcome } from "./decision";
import type { Forecast } from "../types";

export interface ReplayInput {
  historical: HistoricalRequest[];
  departments: Department[];
  vendors: Vendor[];
  categoryStats: CategoryStat[];
  rules: CfoRules;
}

/** A forecast with ample headroom, so cash never drives a replay outcome. */
function neutralForecast(rules: CfoRules): Forecast {
  const generous = rules.minCashThreshold * 100;
  return {
    generatedAt: new Date(0).toISOString(),
    weeks: [],
    threshold: rules.minCashThreshold,
    projectedMinimum: generous,
    projectedMinimumWeek: 0,
    breachWeek: null,
    breachGap: 0,
    endingCash: generous,
    headroom: generous - rules.minCashThreshold,
  };
}

export function runReplay(input: ReplayInput): ReplayResult {
  const forecast = neutralForecast(input.rules);
  const rows: ReplayResult["rows"] = [];

  let agreed = 0;
  let flagged = 0;
  let flaggedThatWentOverBudget = 0;
  let turnaroundTotal = 0;

  for (const historical of input.historical) {
    const department = input.departments.find((d) => d.id === historical.departmentId);
    const vendor = input.vendors.find((v) => v.id === historical.vendorId);
    if (!department || !vendor) continue;

    const categoryStat = input.categoryStats.find(
      (c) => c.departmentId === historical.departmentId && c.category === historical.category,
    );

    const ctx: RuleContext = {
      request: {
        id: historical.id,
        idempotencyKey: historical.id,
        departmentId: historical.departmentId,
        vendorId: historical.vendorId,
        amount: historical.amount,
        category: historical.category,
        description: "",
        requestedBy: "",
        expectedWeek: 1,
        status: "pending",
        createdAt: `${historical.decidedAt}T00:00:00.000Z`,
      },
      department,
      vendor,
      categoryStat,
      rules: input.rules,
      forecastBefore: forecast,
      forecastAfter: forecast,
    };

    // Cash rules are omitted rather than faked — see the note at the top.
    const evaluations = [
      ruleMaxAutonomousAmount(ctx),
      ruleBudgetOverage(ctx),
      ruleRequireVendorHistory(ctx),
      ruleAnomaly(ctx),
    ];

    const { outcome } = resolveOutcome(evaluations);
    const humanApproved = historical.humanDecision === "approved";
    const agentApproved: boolean = outcome === "APPROVED";
    const matches = humanApproved === agentApproved;

    if (matches) agreed++;
    if (humanApproved && !agentApproved) {
      flagged++;
      if (historical.wentOverBudget) flaggedThatWentOverBudget++;
    }
    turnaroundTotal += historical.turnaroundDays;

    rows.push({
      request: historical,
      agentOutcome: outcome as DecisionOutcome,
      agreed: matches,
    });
  }

  return {
    total: rows.length,
    agreed,
    flagged,
    flaggedThatWentOverBudget,
    averageHumanTurnaroundDays:
      rows.length > 0 ? Math.round((turnaroundTotal / rows.length) * 10) / 10 : 0,
    rows,
  };
}
