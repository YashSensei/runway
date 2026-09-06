/**
 * Regression tests for the findings of the adversarial review.
 *
 * Every case here corresponds to a bug that was actually reachable, most of
 * them with a single unauthenticated POST. They exist so that the fixes cannot
 * be quietly undone.
 */

import { describe, it, expect } from "vitest";
import {
  validateAmount,
  validateWeek,
  validateISODate,
  validateSpendRequest,
  validateCommitment,
} from "../src/engine/validation";
import { toDayNumber, weekIndex } from "../src/engine/dates";
import { buildForecast, residualAmount } from "../src/engine/forecast";
import { buildCollectionPlan, recordCommitment } from "../src/engine/collections";
import { decide, resolveOutcome, recoveryPreamble } from "../src/engine/decision";
import { noPriorCommitments, evaluateRules } from "../src/engine/rules";
import { runReplay } from "../src/engine/replay";
import { baseSeed, applyShock, DEMO_REQUESTS, TODAY } from "../src/db/seed";
import type { LedgerState, SpendRequest } from "../src/types";

const L = (n: number): number => Math.round(n * 100_000);

function forecastInput(state: LedgerState) {
  return {
    company: state.company,
    invoices: state.invoices,
    payables: state.payables,
    recurring: state.recurring,
    reservations: state.reservations,
    now: TODAY,
    generatedAt: "2026-09-07T09:00:00.000Z",
  };
}

function requestOf(overrides: Partial<SpendRequest> = {}): SpendRequest {
  return {
    ...DEMO_REQUESTS["engineering"]!,
    id: "R1",
    status: "pending",
    createdAt: "2026-09-07T10:00:00.000Z",
    ...overrides,
  };
}

function submit(
  state: LedgerState,
  request: SpendRequest,
  prior = noPriorCommitments(state.company.rules.rollingWindowDays),
) {
  const department = state.departments.find((d) => d.id === request.departmentId)!;
  const vendor = state.vendors.find((v) => v.id === request.vendorId)!;
  const categoryStat = state.categoryStats.find(
    (c) => c.departmentId === request.departmentId && c.category === request.category,
  );
  return decide({
    request,
    department,
    vendor,
    categoryStat,
    rules: state.company.rules,
    forecastInput: forecastInput(state),
    priorCommitments: prior,
    now: "2026-09-07T10:00:00.000Z",
  });
}

// ---------------------------------------------------------------------------

describe("input validation — the NaN forecast and minted-authority bugs", () => {
  it("rejects amounts that are not positive whole rupees", () => {
    expect(validateAmount("abc")).toMatch(/finite number/);
    expect(validateAmount(NaN)).toMatch(/finite number/);
    expect(validateAmount(Infinity)).toMatch(/finite number/);
    expect(validateAmount(null)).toMatch(/finite number/);
    expect(validateAmount(undefined)).toMatch(/finite number/);
    // A negative reservation is subtracted as an outflow, so it MANUFACTURES
    // headroom. This one cleared a live breach and unlocked further spend.
    expect(validateAmount(-100_000_000)).toMatch(/greater than zero/);
    expect(validateAmount(0)).toMatch(/greater than zero/);
    expect(validateAmount(1000.5)).toMatch(/whole rupees/);
    expect(validateAmount(1e15)).toMatch(/maximum/);
    expect(validateAmount(320_000)).toBeNull();
  });

  it("rejects weeks outside the forecast horizon", () => {
    // An out-of-range or missing week bucketed the reservation where the week
    // loop never reads it, making approved spend invisible to the forecast.
    expect(validateWeek(undefined, 13)).toMatch(/integer/);
    expect(validateWeek("4", 13)).toMatch(/integer/);
    expect(validateWeek(NaN, 13)).toMatch(/integer/);
    expect(validateWeek(0, 13)).toMatch(/between 1 and 13/);
    expect(validateWeek(-5, 13)).toMatch(/between 1 and 13/);
    expect(validateWeek(999, 13)).toMatch(/between 1 and 13/);
    expect(validateWeek(1, 13)).toBeNull();
    expect(validateWeek(13, 13)).toBeNull();
  });

  it("rejects dates that Date.UTC would silently accept", () => {
    expect(validateISODate("not-a-date")).toMatch(/YYYY-MM-DD/);
    // Rolls over to 2027-02-14 rather than failing.
    expect(validateISODate("2026-13-45")).toMatch(/valid calendar date/);
    // Legacy two-digit-year remap: becomes 1926, clamps into week 1, and
    // conjures the invoice's cash into the present.
    expect(validateISODate("0026-09-25")).toMatch(/valid calendar date/);
    expect(validateISODate("2026-02-30")).toMatch(/valid calendar date/);
    expect(validateISODate("2026-09-25")).toBeNull();
  });

  it("rejects whole malformed request bodies", () => {
    expect(validateSpendRequest(null, 13)).toMatch(/object/);
    expect(validateSpendRequest([1, 2, 3], 13)).toMatch(/object/);
    expect(validateSpendRequest({}, 13)).toMatch(/finite number/);
    const good = { ...DEMO_REQUESTS["engineering"]! };
    expect(validateSpendRequest(good, 13)).toBeNull();
  });

  it("confines a commitment date to the forecast horizon", () => {
    const bounds = { earliest: "2026-09-07", latest: "2026-12-07" };
    expect(validateCommitment({ date: "1926-09-25" }, bounds)).toMatch(/valid calendar date|between/);
    expect(validateCommitment({ date: "2027-06-01" }, bounds)).toMatch(/between/);
    expect(validateCommitment({ amount: -5 }, bounds)).toMatch(/greater than zero/);
    expect(validateCommitment({ date: "2026-09-25", amount: L(9) }, bounds)).toBeNull();
    expect(validateCommitment({}, bounds)).toBeNull();
  });
});

describe("date parsing", () => {
  it("round-trips and refuses out-of-range components", () => {
    expect(() => toDayNumber("2026-13-45")).toThrow();
    expect(() => toDayNumber("0026-09-25")).toThrow();
    expect(() => toDayNumber("2026-09-25T00:00:00Z")).toThrow();
    expect(toDayNumber("1970-01-01")).toBe(0);
    expect(toDayNumber("2026-09-08") - toDayNumber("2026-09-07")).toBe(1);
  });

  it("buckets dates on or before the anchor into week 1 and drops past-horizon", () => {
    expect(weekIndex("2026-09-07", "2026-08-01", 13)).toBe(1);
    expect(weekIndex("2026-09-07", "2026-09-07", 13)).toBe(1);
    expect(weekIndex("2026-09-07", "2026-09-14", 13)).toBe(2);
    expect(weekIndex("2026-09-07", "2027-01-01", 13)).toBeNull();
  });
});

describe("the forecast refuses to report a position it cannot compute", () => {
  it("throws rather than silently reporting healthy on non-finite input", () => {
    const state = baseSeed();
    // Exactly what an unvalidated string amount used to produce: every
    // comparison against NaN is false, so the trough never updated and the
    // agent reported spendable headroom against a forecast of NaN.
    state.reservations = [
      {
        id: "bad",
        requestId: "bad",
        amount: "abc" as unknown as number,
        week: 2,
        createdAt: "2026-09-07T00:00:00.000Z",
        releasedAt: null,
      },
    ];
    expect(() => buildForecast(forecastInput(state))).toThrow(/non-finite/);
  });

  it("reports the first breaching week's shortfall separately from the trough", () => {
    const state = baseSeed();
    state.payables = [
      ...state.payables,
      {
        id: "AP-TEST",
        vendorId: "peoplestack",
        description: "stress",
        amount: L(20),
        scheduledDate: "2026-10-19",
        category: "tax",
        discretionary: false,
      },
    ];
    const forecast = buildForecast(forecastInput(state));
    expect(forecast.breachWeek).not.toBeNull();

    const breachRow = forecast.weeks[forecast.breachWeek! - 1]!;
    // The number quoted against the breach week must be that week's number.
    expect(forecast.breachWeekShortfall).toBe(forecast.threshold - breachRow.closingCash);
    // And the trough is measured where the trough actually is.
    expect(forecast.breachGap).toBe(forecast.threshold - forecast.projectedMinimum);
    expect(forecast.breachGap).toBeGreaterThanOrEqual(forecast.breachWeekShortfall);
  });
});

describe("aggregate authority — split-purchase evasion", () => {
  it("refuses to let three small requests do what one large one cannot", () => {
    const state = baseSeed();
    const limit = state.company.rules.maxAutonomousAmount;

    // One ₹12L request is refused outright.
    const single = submit(state, requestOf({ amount: L(12), id: "BIG" }));
    expect(single.decision.outcome).not.toBe("APPROVED");

    // Split into three ₹4L requests to the same department and vendor.
    let prior = noPriorCommitments(state.company.rules.rollingWindowDays);
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const result = submit(state, requestOf({ amount: L(4), id: `SPLIT-${i}` }), prior);
      outcomes.push(result.decision.outcome);
      if (result.decision.outcome === "APPROVED") {
        prior = {
          ...prior,
          departmentWindowTotal: prior.departmentWindowTotal + L(4),
          vendorWindowTotal: prior.vendorWindowTotal + L(4),
        };
      }
    }

    // The second one already breaks the ceiling in aggregate.
    expect(outcomes[0]).toBe("APPROVED");
    expect(outcomes[1]).toBe("ESCALATED");
    expect(prior.vendorWindowTotal).toBeLessThanOrEqual(limit);
  });

  it("names the split explicitly rather than hiding behind a generic reason", () => {
    const state = baseSeed();
    const result = submit(state, requestOf({ amount: L(4) }), {
      departmentWindowTotal: L(4),
      vendorWindowTotal: L(4),
      windowDays: 30,
    });
    expect(result.decision.outcome).toBe("ESCALATED");
    expect(result.decision.reasonCode).toBe("exceeds_authority");
    expect(result.decision.fallbackNarration).toMatch(/split/i);
  });

  it("caps total autonomous spend per department across the window", () => {
    const state = baseSeed();
    // Under the per-request ceiling, different vendor, but the pool is spent.
    const result = submit(state, requestOf({ amount: L(3) }), {
      departmentWindowTotal: L(9),
      vendorWindowTotal: 0,
      windowDays: 30,
    });
    expect(result.decision.outcome).toBe("ESCALATED");
    expect(
      result.decision.rules.find((r) => r.rule === "aggregate_authority")!.passed,
    ).toBe(false);
  });

  it("leaves ordinary first-time requests untouched", () => {
    const state = baseSeed();
    const result = submit(state, requestOf({ amount: L(3.2) }));
    expect(result.decision.outcome).toBe("APPROVED");
    expect(
      result.decision.rules.find((r) => r.rule === "aggregate_authority")!.passed,
    ).toBe(true);
  });
});

describe("budget consumption accumulates", () => {
  it("tightens as a department spends, instead of resetting every request", () => {
    const state = baseSeed();
    const marketing = state.departments.find((d) => d.id === "marketing")!;
    const before = submit(state, requestOf({
      departmentId: "marketing",
      vendorId: "adworks",
      category: "campaign",
      amount: L(4.5),
    }));
    const beforeDetail = before.decision.rules.find((r) => r.rule === "budget_overage")!.detail;

    // Simulate the commit the Durable Object performs on approval.
    state.departments = state.departments.map((d) =>
      d.id === "marketing" ? { ...d, periodSpend: d.periodSpend + L(4.5) } : d,
    );

    const after = submit(state, requestOf({
      departmentId: "marketing",
      vendorId: "adworks",
      category: "campaign",
      amount: L(4.5),
      id: "R2",
    }));
    const afterDetail = after.decision.rules.find((r) => r.rule === "budget_overage")!.detail;

    // The identical request must not produce the identical budget sentence.
    expect(afterDetail).not.toBe(beforeDetail);
    expect(marketing.quarterlyBudget).toBe(L(15));
    // 9 + 4.5 + 4.5 = 18L against a 16.5L ceiling: a hard rule now bites.
    expect(after.decision.outcome).toBe("REJECTED");
    expect(after.decision.reasonCode).toBe("hard_rule_violation");
  });
});

describe("decision precedence", () => {
  it("prefers REJECT over ESCALATE when a hard rule is broken", () => {
    const evaluations = evaluateRules({
      request: requestOf({ amount: L(9) }),
      department: { id: "d", name: "D", quarterlyBudget: L(1), periodSpend: L(1) },
      vendor: { id: "v", name: "V", firstSeen: null, invoiceCount: 0, avgAmount: 0 },
      categoryStat: undefined,
      rules: baseSeed().company.rules,
      forecastBefore: buildForecast(forecastInput(baseSeed())),
      forecastAfter: buildForecast(forecastInput(baseSeed())),
      priorCommitments: noPriorCommitments(30),
    });
    expect(resolveOutcome(evaluations).outcome).toBe("REJECTED");
  });

  it("claims the request is sound only when every non-cash rule passes", () => {
    const state = baseSeed();
    // Cash availability is the only thing standing in the way.
    state.company.rules.minCashThreshold = L(37);
    const cashOnly = submit(state, requestOf({ amount: L(3) }));
    expect(cashOnly.decision.outcome).toBe("ESCALATED");
    expect(cashOnly.decision.fallbackNarration).toMatch(/Nothing is wrong with this request/);

    // The two cash rules normally fail together, so this must not be a count
    // of failures — it must be a test of which rules failed.
    const failed = cashOnly.decision.rules.filter((r) => !r.passed).map((r) => r.rule);
    expect(failed.length).toBeGreaterThan(1);

    // Now the request itself is anomalous too, so the claim would be a lie.
    const anomalous = submit(
      state,
      requestOf({ amount: L(4.9), id: "ANOM", vendorId: "nimbus" }),
    );
    expect(anomalous.decision.fallbackNarration).not.toMatch(/Nothing is wrong/);
  });
});

describe("counterfactual replay", () => {
  const state = baseSeed();
  const result = runReplay({
    historical: state.historical,
    departments: state.departments,
    vendors: state.vendors,
    categoryStats: state.categoryStats,
    rules: state.company.rules,
  });

  it("produces the figures quoted in the README", () => {
    expect(result.total).toBe(47);
    expect(result.agreed).toBe(41);
    expect(result.flagged).toBe(6);
    expect(result.flaggedThatWentOverBudget).toBe(4);
  });

  it("is deterministic", () => {
    const again = runReplay({
      historical: state.historical,
      departments: state.departments,
      vendors: state.vendors,
      categoryStats: state.categoryStats,
      rules: state.company.rules,
    });
    expect(again.rows.map((r) => r.agentOutcome)).toEqual(result.rows.map((r) => r.agentOutcome));
  });

  it("accounts for every row it was given", () => {
    expect(result.rows).toHaveLength(state.historical.length);
    expect(result.agreed + result.rows.filter((r) => !r.agreed).length).toBe(result.total);
  });

  it("names the rules behind every disagreement", () => {
    for (const row of result.rows) {
      if (row.agreed) expect(row.failedRules).toHaveLength(0);
      else expect(row.failedRules.length).toBeGreaterThan(0);
    }
  });
});

describe("partial commitments keep the residual receivable", () => {
  it("does not delete the uncommitted part of an invoice from the forecast", () => {
    const state = applyShock(baseSeed());
    const totalBefore = buildForecast(forecastInput(state)).weeks.reduce((s, w) => s + w.collections, 0);

    // Acme promises ₹3L of a ₹9L invoice.
    state.invoices = state.invoices.map((inv) =>
      inv.id === "INV-2041" ? recordCommitment(inv, L(3), "2026-09-25") : inv,
    );
    const acme = state.invoices.find((i) => i.id === "INV-2041")!;
    expect(residualAmount(acme)).toBe(L(6));

    // Total expected collections are unchanged: ₹3L moved earlier, ₹6L stayed
    // on the customer's normal timeline. Previously ₹6L simply vanished.
    const totalAfter = buildForecast(forecastInput(state)).weeks.reduce((s, w) => s + w.collections, 0);
    expect(totalAfter).toBe(totalBefore);

    // And the residual is still chaseable — only a FULL commitment retires it.
    const plan = buildCollectionPlan({
      invoices: state.invoices,
      forecast: buildForecast(forecastInput(state)),
      company: state.company,
      now: TODAY,
    });
    const retired = plan.skipped.find(
      (s) => s.invoiceId === "INV-2041" && /already committed/.test(s.reason),
    );
    expect(retired).toBeUndefined();
  });

  it("caps a commitment at the invoice face value", () => {
    const inv = baseSeed().invoices.find((i) => i.id === "INV-2041")!;
    expect(recordCommitment(inv, L(50), "2026-09-25").committedAmount).toBe(L(9));
  });
});

describe("recovery-aware narration", () => {
  const cleared = {
    recovered: L(15),
    customers: ["Acme Retail Group", "Northwind Logistics"],
    before: L(19.4),
    after: L(34.4),
  };

  it("credits the collection when an approval only fits because of it", () => {
    const text = recoveryPreamble({ outcome: "APPROVED", amount: L(4.5), threshold: L(25), cleared });
    expect(text).toMatch(/would have been escalated/);
    expect(text).toMatch(/₹15,00,000/);
    expect(text).toMatch(/Acme Retail Group and Northwind Logistics/);
    expect(text).toMatch(/₹19,40,000 to ₹34,40,000/);
  });

  it("stays silent when the request would have fit anyway, or nothing was recovered", () => {
    const roomy = { ...cleared, before: L(40), after: L(55) };
    expect(recoveryPreamble({ outcome: "APPROVED", amount: L(3), threshold: L(25), cleared: roomy })).toBeNull();
    expect(recoveryPreamble({ outcome: "APPROVED", amount: L(3), threshold: L(25), cleared: null })).toBeNull();
    expect(recoveryPreamble({ outcome: "ESCALATED", amount: L(3), threshold: L(25), cleared })).toBeNull();
  });
});
