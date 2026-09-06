/**
 * Client-side forecast arithmetic for the Cash workspace.
 *
 * Everything here reuses the pure engine (`@engine/forecast`, `@engine/dates`)
 * rather than re-implementing it, so a week drawer, a breach explainer and a
 * what-if projection can never bucket a payable differently from the number
 * on the chart. The engine throws on malformed dates; every entry point here
 * catches and degrades to "unknown" instead, because a drawer that blanks
 * the whole page over one bad row is worse than a drawer with a gap.
 */

import type {
  DashboardState,
  Forecast,
  ISODate,
  Invoice,
  Rupees,
} from "@shared/types";
import { buildForecast, expectedInflows } from "@engine/forecast";
import { weekIndex } from "@engine/dates";

// ---------------------------------------------------------------------------
// Safe wrappers
// ---------------------------------------------------------------------------

/** Engine bucketing, but `null` instead of a throw on a malformed date. */
export function safeWeekIndex(
  anchor: ISODate,
  date: ISODate,
  horizon: number,
): number | null {
  try {
    return weekIndex(anchor, date, horizon);
  } catch {
    return null;
  }
}

/** The engine clamps reservation weeks into the horizon; so do we. */
export function clampWeek(week: number, horizon: number): number {
  if (!Number.isFinite(week)) return 1;
  return Math.min(Math.max(1, Math.trunc(week)), Math.max(1, horizon));
}

// ---------------------------------------------------------------------------
// Week drawer — what lands in a given week
// ---------------------------------------------------------------------------

export type WeekLineKind = "inflow" | "payable" | "payroll" | "reservation";

export interface WeekLine {
  id: string;
  kind: WeekLineKind;
  /** Primary text: customer, payable description, request description. */
  label: string;
  /** Secondary text: id, vendor, date, kind of inflow. */
  detail: string;
  amount: Rupees;
  date: ISODate | null;
}

export interface WeekBreakdown {
  week: number;
  inflows: WeekLine[];
  /** Dated payables and payroll lumps, individually. */
  outflows: WeekLine[];
  /** Approved-but-unpaid commitments landing this week. */
  reservations: WeekLine[];
  /** Steady weekly payroll not explained by a dated payable. */
  steadyPayroll: Rupees;
  /** Steady weekly subscriptions / office costs. */
  steadyRecurring: Rupees;
}

export function weekBreakdown(state: DashboardState, week: number): WeekBreakdown {
  const { company, invoices, payables, reservations, vendors, decisions, forecast } = state;
  const anchor = company.anchorDate;
  const horizon = Math.max(1, company.forecastHorizonWeeks);

  const inflows: WeekLine[] = [];
  let flows: ReturnType<typeof expectedInflows> = [];
  try {
    flows = expectedInflows(invoices);
  } catch {
    flows = [];
  }
  for (const f of flows) {
    if (safeWeekIndex(anchor, f.date, horizon) !== week) continue;
    inflows.push({
      id: `${f.invoiceId}:${f.kind}`,
      kind: "inflow",
      label: f.customer,
      detail: `${f.invoiceId} · ${f.kind}`,
      amount: f.amount,
      date: f.date,
    });
  }

  const outflows: WeekLine[] = [];
  let payrollLumps = 0;
  for (const p of payables) {
    if (safeWeekIndex(anchor, p.scheduledDate, horizon) !== week) continue;
    const vendor = vendors.find((v) => v.id === p.vendorId);
    const isPayroll = p.category === "payroll";
    if (isPayroll) payrollLumps += p.amount;
    outflows.push({
      id: p.id,
      kind: isPayroll ? "payroll" : "payable",
      label: p.description,
      detail: `${vendor?.name ?? p.vendorId} · ${p.category.replace(/_/g, " ")}`,
      amount: p.amount,
      date: p.scheduledDate,
    });
  }

  const reservationLines: WeekLine[] = [];
  for (const r of reservations) {
    if (r.releasedAt !== null) continue;
    if (clampWeek(r.week, horizon) !== week) continue;
    const view = decisions.find((d) => d.request.id === r.requestId);
    reservationLines.push({
      id: r.id,
      kind: "reservation",
      label: view?.request.description ?? r.requestId,
      detail: view
        ? `${view.departmentName} · ${view.vendorName} · ${r.requestId}`
        : r.requestId,
      amount: r.amount,
      date: null,
    });
  }

  const fw = forecast.weeks.find((w) => w.week === week);
  const steadyPayroll = Math.max(0, (fw?.payroll ?? 0) - payrollLumps);
  const steadyRecurring = fw?.recurring ?? 0;

  const byAmount = (a: WeekLine, b: WeekLine) => b.amount - a.amount || a.id.localeCompare(b.id);
  inflows.sort(byAmount);
  outflows.sort(byAmount);
  reservationLines.sort(byAmount);

  return {
    week,
    inflows,
    outflows,
    reservations: reservationLines,
    steadyPayroll,
    steadyRecurring,
  };
}

// ---------------------------------------------------------------------------
// Breach explainer — why does week N breach?
// ---------------------------------------------------------------------------

export interface BreachContributor {
  label: string;
  detail: string;
  amount: Rupees;
  week: number;
}

export interface BreachExplanation {
  /** Last high point before the breach; 0 means the opening balance. */
  fromWeek: number;
  breachWeek: number;
  /** Closing cash at `fromWeek` (or opening cash) minus closing at the breach. */
  drop: Rupees;
  contributors: BreachContributor[];
}

/**
 * Walks from the last high point before the breach to the breaching week
 * and ranks what took the cash out: dated payables, payroll, reservations,
 * steady costs, and — when a healthy baseline exists — collections that
 * slipped relative to it.
 */
export function explainBreach(state: DashboardState, top = 3): BreachExplanation | null {
  const { forecast, lastHealthyForecast } = state;
  const breachWeek = forecast.breachWeek;
  if (breachWeek === null) return null;
  const target = forecast.weeks.find((w) => w.week === breachWeek);
  if (target === undefined) return null;

  // Last high point strictly before the breach.
  let fromWeek = 0;
  let fromCash = target.openingCash;
  const earlier = forecast.weeks.filter((w) => w.week < breachWeek);
  if (earlier.length > 0) {
    let best = earlier[0];
    for (const w of earlier) {
      if (best === undefined || w.closingCash > best.closingCash) best = w;
    }
    if (best !== undefined) {
      fromWeek = best.week;
      fromCash = best.closingCash;
    }
  } else {
    fromCash = state.company.currentCash;
  }

  const contributors: BreachContributor[] = [];
  for (let week = fromWeek + 1; week <= breachWeek; week++) {
    const bd = weekBreakdown(state, week);
    for (const o of bd.outflows) {
      contributors.push({ label: o.label, detail: o.detail, amount: o.amount, week });
    }
    for (const r of bd.reservations) {
      contributors.push({
        label: r.label,
        detail: `reserved · ${r.detail}`,
        amount: r.amount,
        week,
      });
    }
    if (bd.steadyPayroll > 0) {
      contributors.push({
        label: "Payroll",
        detail: "steady weekly run-rate",
        amount: bd.steadyPayroll,
        week,
      });
    }
    if (bd.steadyRecurring > 0) {
      contributors.push({
        label: "Recurring costs",
        detail: "subscriptions and operations",
        amount: bd.steadyRecurring,
        week,
      });
    }
    if (lastHealthyForecast !== null) {
      const live = forecast.weeks.find((w) => w.week === week);
      const ghost = lastHealthyForecast.weeks.find((w) => w.week === week);
      if (live !== undefined && ghost !== undefined) {
        const slipped = ghost.collections - live.collections;
        if (slipped > 0) {
          contributors.push({
            label: "Collections slipped",
            detail: "expected in the healthy baseline, no longer landing here",
            amount: slipped,
            week,
          });
        }
      }
    }
  }

  contributors.sort((a, b) => b.amount - a.amount || a.week - b.week);

  return {
    fromWeek,
    breachWeek,
    drop: fromCash - target.closingCash,
    contributors: contributors.slice(0, Math.max(0, top)),
  };
}

// ---------------------------------------------------------------------------
// What-if — a hypothetical outflow and scenario deltas, computed exactly
// ---------------------------------------------------------------------------

export type ScenarioId = "helios-slips" | "sentinel-pays";

export interface ScenarioDef {
  id: ScenarioId;
  label: string;
  /** Which invoice the toggle rewrites. Disabled when it is not in the ledger. */
  invoiceId: string;
  describe: string;
}

export const SCENARIOS: ScenarioDef[] = [
  {
    id: "helios-slips",
    label: "Helios slips 8 weeks",
    invoiceId: "INV-2052",
    describe: "INV-2052 due date moves to 26 Nov 2026",
  },
  {
    id: "sentinel-pays",
    label: "Sentinel pays this week",
    invoiceId: "INV-2029",
    describe: "INV-2029 committed in full, dated today",
  },
];

/** Whether a scenario can be applied to this ledger. */
export function scenarioAvailable(state: DashboardState, id: ScenarioId): boolean {
  const def = SCENARIOS.find((s) => s.id === id);
  if (def === undefined) return false;
  const inv = state.invoices.find((i) => i.id === def.invoiceId);
  if (inv === undefined || inv.status === "paid") return false;
  if (id === "sentinel-pays" && inv.status === "committed") return false;
  return true;
}

export function applyScenarios(
  invoices: Invoice[],
  today: ISODate,
  active: ReadonlySet<ScenarioId>,
): Invoice[] {
  if (active.size === 0) return invoices;
  return invoices.map((inv) => {
    if (active.has("helios-slips") && inv.id === "INV-2052" && inv.status !== "paid") {
      return { ...inv, dueDate: "2026-11-26" };
    }
    if (active.has("sentinel-pays") && inv.id === "INV-2029" && inv.status !== "paid") {
      return {
        ...inv,
        status: "committed",
        committedAmount: inv.amount,
        committedDate: today,
      };
    }
    return inv;
  });
}

export interface WhatIf {
  amount: Rupees;
  week: number;
}

export interface Projection {
  /** Hypothetical closing cash per live forecast week, same order. */
  closings: Rupees[];
  projectedMinimum: Rupees;
  projectedMinimumWeek: number;
  headroom: Rupees;
  breachWeek: number | null;
}

export type ProjectionResult =
  | { ok: true; projection: Projection }
  | { ok: false; error: string };

/**
 * Re-run the engine for base and hypothetical WITHOUT recurring costs
 * (`DashboardState` does not carry them) and apply the per-week difference to
 * the live forecast. Recurring is identical in both runs, so the delta is
 * exact: live + (hyp − base) is precisely what the server would compute.
 */
export function projectWhatIf(
  state: DashboardState,
  whatIf: WhatIf | null,
  scenarios: ReadonlySet<ScenarioId>,
): ProjectionResult | null {
  const hasWhatIf = whatIf !== null && Number.isFinite(whatIf.amount) && whatIf.amount > 0;
  if (!hasWhatIf && scenarios.size === 0) return null;

  const { company, invoices, payables, reservations, forecast, today } = state;
  const horizon = Math.max(1, company.forecastHorizonWeeks);

  try {
    const base = buildForecast({
      company,
      invoices,
      payables,
      recurring: [],
      reservations,
      now: today,
      generatedAt: forecast.generatedAt,
    });

    const hypReservations = hasWhatIf && whatIf !== null
      ? [
          ...reservations,
          {
            id: "what-if",
            requestId: "what-if",
            amount: Math.round(whatIf.amount),
            week: clampWeek(whatIf.week, horizon),
            createdAt: new Date(0).toISOString(),
            releasedAt: null,
          },
        ]
      : reservations;

    const hyp = buildForecast({
      company,
      invoices: applyScenarios(invoices, today, scenarios),
      payables,
      recurring: [],
      reservations: hypReservations,
      now: today,
      generatedAt: forecast.generatedAt,
    });

    const closings: Rupees[] = forecast.weeks.map((live, i) => {
      const b = base.weeks[i]?.closingCash ?? live.closingCash;
      const h = hyp.weeks[i]?.closingCash ?? b;
      return live.closingCash + (h - b);
    });

    return { ok: true, projection: summarise(closings, forecast) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function summarise(closings: Rupees[], forecast: Forecast): Projection {
  const threshold = forecast.threshold;
  let projectedMinimum = closings[0] ?? forecast.projectedMinimum;
  let projectedMinimumWeek = forecast.weeks[0]?.week ?? 0;
  let breachWeek: number | null = null;

  closings.forEach((c, i) => {
    const week = forecast.weeks[i]?.week ?? i + 1;
    if (c < projectedMinimum) {
      projectedMinimum = c;
      projectedMinimumWeek = week;
    }
    if (breachWeek === null && c < threshold) breachWeek = week;
  });

  return {
    closings,
    projectedMinimum,
    projectedMinimumWeek,
    headroom: projectedMinimum - threshold,
    breachWeek,
  };
}

// ---------------------------------------------------------------------------
// Shared chart domain — stable across scenes
// ---------------------------------------------------------------------------

/** Every closing balance the chart might need to fit, in rupees. */
export function domainSamples(
  forecast: Forecast,
  ghost: Forecast | null,
  extra: readonly Rupees[] | null,
): Rupees[] {
  const out: Rupees[] = [forecast.threshold];
  for (const w of forecast.weeks) out.push(w.closingCash);
  if (ghost !== null) for (const w of ghost.weeks) out.push(w.closingCash);
  if (extra !== null) for (const v of extra) out.push(v);
  return out.filter((v) => Number.isFinite(v));
}

/** True when two forecasts disagree on any week's closing balance. */
export function forecastsDiffer(a: Forecast, b: Forecast | null): boolean {
  if (b === null) return false;
  if (a.weeks.length !== b.weeks.length) return true;
  for (let i = 0; i < a.weeks.length; i++) {
    if (a.weeks[i]?.closingCash !== b.weeks[i]?.closingCash) return true;
  }
  return false;
}

/** Clamp to [0, 1]. NaN collapses to 0 so a bad ratio never paints a full bar. */
export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
