/**
 * The demo, as executable specification.
 *
 * Every figure quoted in the pitch is asserted here. If someone changes the
 * fixture or the engine and the story stops being true, this fails loudly
 * rather than silently producing a demo that no longer makes its own point.
 */

import { describe, it, expect } from "vitest";
import { buildForecast, type ForecastInput } from "../src/engine/forecast";
import { buildCollectionPlan, recordCommitment } from "../src/engine/collections";
import { decide } from "../src/engine/decision";
import { baseSeed, applyShock, DEMO_REQUESTS, TODAY } from "../src/db/seed";
import type { Forecast, LedgerState, SpendRequest } from "../src/types";

const L = (n: number): number => Math.round(n * 100_000);

function forecastInput(state: LedgerState): ForecastInput {
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

function forecastOf(state: LedgerState): Forecast {
  return buildForecast(forecastInput(state));
}

function requestFrom(key: keyof typeof DEMO_REQUESTS, id: string): SpendRequest {
  return { ...DEMO_REQUESTS[key]!, id, status: "pending", createdAt: "2026-09-07T10:00:00.000Z" };
}

/** Submit a request and, if approved, commit its reservation to the state. */
function submit(state: LedgerState, key: keyof typeof DEMO_REQUESTS, id: string) {
  const request = requestFrom(key, id);
  const department = state.departments.find((d) => d.id === request.departmentId)!;
  const vendor = state.vendors.find((v) => v.id === request.vendorId)!;
  const categoryStat = state.categoryStats.find(
    (c) => c.departmentId === request.departmentId && c.category === request.category,
  );

  let counter = 0;
  const result = decide({
    request,
    department,
    vendor,
    categoryStat,
    rules: state.company.rules,
    forecastInput: forecastInput(state),
    now: "2026-09-07T10:00:00.000Z",
    newId: () => `${id}-${counter++}`,
  });

  const next: LedgerState = result.reservation
    ? { ...state, reservations: [...state.reservations, result.reservation] }
    : state;

  return { result, state: next };
}

/** Apply the agent's own collection plan, assuming every target commits. */
function applyCommitments(state: LedgerState, invoiceIds: string[], date: string): LedgerState {
  return {
    ...state,
    invoices: state.invoices.map((inv) =>
      invoiceIds.includes(inv.id) ? recordCommitment(inv, inv.amount, date) : inv,
    ),
  };
}

describe("scene 1 — baseline is healthy", () => {
  const forecast = forecastOf(baseSeed());

  it("projects a trough comfortably above the safety threshold", () => {
    expect(forecast.projectedMinimum).toBe(L(37.5));
    expect(forecast.breachWeek).toBeNull();
    expect(forecast.breachGap).toBe(0);
  });

  it("reports positive delegated headroom", () => {
    expect(forecast.headroom).toBe(L(12.5));
  });

  it("covers a 13-week horizon starting on the anchor Monday", () => {
    expect(forecast.weeks).toHaveLength(13);
    expect(forecast.weeks[0]!.startDate).toBe("2026-09-07");
    expect(forecast.weeks[0]!.openingCash).toBe(L(52));
  });
});

describe("scene 2 — the shock opens a hole", () => {
  const forecast = forecastOf(applyShock(baseSeed()));

  it("breaches the safety threshold in week 7", () => {
    expect(forecast.breachWeek).toBe(7);
    expect(forecast.weeks[6]!.closingCash).toBe(L(21.5));
  });

  it("bottoms out below the threshold with negative headroom", () => {
    expect(forecast.projectedMinimum).toBe(L(19.4));
    expect(forecast.projectedMinimumWeek).toBe(8);
    expect(forecast.breachGap).toBe(L(5.6));
    expect(forecast.headroom).toBe(L(-5.6));
  });
});

describe("scene 3 — the agent defends the cash position", () => {
  const state = applyShock(baseSeed());
  const forecast = forecastOf(state);
  const plan = buildCollectionPlan({
    invoices: state.invoices,
    forecast,
    company: state.company,
    now: TODAY,
  });

  it("targets the two overdue invoices that land before the shortfall", () => {
    expect(plan.targets.map((t) => t.invoice.id)).toEqual(["INV-2041", "INV-2038"]);
    expect(plan.totalChased).toBe(L(15));
    for (const target of plan.targets) {
      expect(target.landsBeforeBreach).toBe(true);
      expect(target.expectedArrivalWeek).toBeLessThanOrEqual(plan.breachWeek!);
    }
  });

  it("chases more than the gap, because not every customer replies", () => {
    expect(plan.gap).toBe(L(5.6));
    expect(plan.totalChased).toBeGreaterThan(plan.gap * 2);
  });

  it("refuses to auto-chase the relationship-sensitive account", () => {
    const sentinel = plan.skipped.find((s) => s.invoiceId === "INV-2029");
    expect(sentinel).toBeDefined();
    expect(sentinel!.reason).toMatch(/sensitive/i);
    expect(plan.targets.some((t) => t.invoice.id === "INV-2029")).toBe(false);
  });

  it("does not list invoices that simply are not due yet", () => {
    expect(plan.skipped.some((s) => s.invoiceId === "INV-2055")).toBe(false);
  });

  it("repairs the forecast once the customers commit", () => {
    const repaired = forecastOf(applyCommitments(state, ["INV-2041", "INV-2038"], "2026-09-25"));
    expect(repaired.breachWeek).toBeNull();
    expect(repaired.projectedMinimum).toBe(L(34.4));
    expect(repaired.headroom).toBe(L(9.4));
  });
});

describe("scenes 4-6 — delegated authority, consumed in sequence", () => {
  function repairedState(): LedgerState {
    return applyCommitments(applyShock(baseSeed()), ["INV-2041", "INV-2038"], "2026-09-25");
  }

  it("walks the full headroom ladder and escalates the third request", () => {
    let state = repairedState();

    const eng = submit(state, "engineering", "REQ-ENG");
    state = eng.state;
    expect(eng.result.decision.outcome).toBe("APPROVED");
    expect(eng.result.decision.reasonCode).toBe("within_authority");
    expect(eng.result.decision.headroomBefore).toBe(L(9.4));
    expect(eng.result.decision.headroomAfter).toBe(L(6.2));

    const mkt = submit(state, "marketing", "REQ-MKT");
    state = mkt.state;
    expect(mkt.result.decision.outcome).toBe("APPROVED");
    expect(mkt.result.decision.headroomBefore).toBe(L(6.2));
    expect(mkt.result.decision.headroomAfter).toBe(L(1.7));

    // The point of the whole product: this one is fine on every merit and is
    // handed back purely because the two before it consumed the buffer.
    const sales = submit(state, "sales", "REQ-SLS");
    expect(sales.result.decision.outcome).toBe("ESCALATED");
    expect(sales.result.decision.reasonCode).toBe("insufficient_headroom");

    const rules = sales.result.decision.rules;
    const byId = (id: string) => rules.find((r) => r.rule === id)!;
    expect(byId("max_autonomous_amount").passed).toBe(true);
    expect(byId("budget_overage").passed).toBe(true);
    expect(byId("require_vendor_history").passed).toBe(true);
    expect(byId("anomaly_multiplier").passed).toBe(true);
    expect(byId("headroom_check").passed).toBe(false);
  });

  it("approves the Sales request when it arrives first instead", () => {
    // Same request, same rules, different order — proof that authority is a
    // consumable resource rather than a static threshold.
    const sales = submit(repairedState(), "sales", "REQ-SLS-FIRST");
    expect(sales.result.decision.outcome).toBe("APPROVED");
  });

  it("rejects a first-time vendor above the authority limit", () => {
    const result = submit(repairedState(), "new-vendor", "REQ-NV").result;
    expect(result.decision.outcome).toBe("REJECTED");
    expect(result.decision.reasonCode).toBe("hard_rule_violation");
    expect(result.decision.rules.find((r) => r.rule === "require_vendor_history")!.passed).toBe(false);
    expect(result.reservation).toBeNull();
  });
});

describe("scene 5 — the agent's own action changed its own decision", () => {
  it("escalates Marketing before the collection and approves it after", () => {
    const shocked = applyShock(baseSeed());
    const before = submit(shocked, "marketing", "REQ-MKT-BEFORE").result;
    expect(before.decision.outcome).toBe("ESCALATED");
    expect(before.decision.reasonCode).toBe("insufficient_headroom");

    const repaired = applyCommitments(shocked, ["INV-2041", "INV-2038"], "2026-09-25");
    const after = submit(repaired, "marketing", "REQ-MKT-AFTER").result;
    expect(after.decision.outcome).toBe("APPROVED");
  });
});

describe("engine invariants", () => {
  it("never lets a rejected or escalated request consume headroom", () => {
    const state = applyShock(baseSeed());
    const escalated = submit(state, "marketing", "X1").result;
    expect(escalated.reservation).toBeNull();
    expect(escalated.decision.headroomAfter).toBe(escalated.decision.headroomBefore);
  });

  it("is deterministic — identical inputs give an identical outcome", () => {
    const a = submit(baseSeed(), "engineering", "D1").result.decision;
    const b = submit(baseSeed(), "engineering", "D2").result.decision;
    expect(b.outcome).toBe(a.outcome);
    expect(b.reasonCode).toBe(a.reasonCode);
    expect(b.headroomAfter).toBe(a.headroomAfter);
    expect(b.fallbackNarration).toBe(a.fallbackNarration);
  });

  it("always produces a fallback narration, with no model involved", () => {
    const decision = submit(baseSeed(), "engineering", "N1").result.decision;
    expect(decision.narration).toBeNull();
    expect(decision.fallbackNarration.length).toBeGreaterThan(80);
    expect(decision.fallbackNarration).toContain("₹3,20,000");
  });

  it("conserves cash — every week's closing equals opening plus net", () => {
    for (const week of forecastOf(baseSeed()).weeks) {
      expect(week.closingCash).toBe(week.openingCash + week.netChange);
      expect(week.netChange).toBe(
        week.collections - week.payables - week.payroll - week.recurring - week.reservations,
      );
    }
  });
});
