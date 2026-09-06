/**
 * The forecast engine.
 *
 * Deterministic arithmetic over known obligations across a rolling weekly
 * horizon. No model is involved and none ever should be — this produces the
 * number every autonomous decision is judged against, so it has to be
 * inspectable and reproducible. Same inputs, same output, always.
 */

import type {
  Forecast,
  ForecastWeek,
  Invoice,
  Payable,
  RecurringCost,
  Reservation,
  Rupees,
  Company,
  ISODate,
} from "../types";
import { addDays, weekIndex, weekStartDate } from "./dates";

export interface ForecastInput {
  company: Company;
  invoices: Invoice[];
  payables: Payable[];
  recurring: RecurringCost[];
  reservations: Reservation[];
  /** Today, for overdue/arrival reasoning. Defaults to the company anchor. */
  now?: ISODate;
  generatedAt?: string;
}

/**
 * When we expect an invoice's cash to actually land.
 *
 * A firm commitment from the customer overrides everything — that is the whole
 * point of the collection agent. Otherwise we assume the customer behaves the
 * way they historically have, rather than the way the contract says.
 */
export function expectedCollectionDate(invoice: Invoice): ISODate | null {
  if (invoice.status === "paid") return null;
  if (invoice.status === "committed" && invoice.committedDate) {
    return invoice.committedDate;
  }
  return addDays(invoice.dueDate, invoice.customerAvgLagDays);
}

/** Amount we expect to receive — the committed figure if one exists. */
export function expectedCollectionAmount(invoice: Invoice): Rupees {
  if (invoice.status === "paid") return 0;
  if (invoice.status === "committed" && invoice.committedAmount !== undefined) {
    return invoice.committedAmount;
  }
  return invoice.amount;
}

/**
 * The part of a committed invoice the customer did NOT commit to.
 *
 * A promise of ₹3L against a ₹9L invoice is not a ₹6L write-off. The residual
 * is still owed, still expected on the customer's normal timeline, and still
 * chaseable. Dropping it silently deleted live receivables from the forecast.
 */
export function residualAmount(invoice: Invoice): Rupees {
  if (invoice.status !== "committed" || invoice.committedAmount === undefined) return 0;
  return Math.max(0, invoice.amount - invoice.committedAmount);
}

/** Where the uncommitted residual lands: the customer's historical timeline. */
export function residualCollectionDate(invoice: Invoice): ISODate {
  return addDays(invoice.dueDate, invoice.customerAvgLagDays);
}

/** A single dated inflow, for week drill-downs. */
export interface ExpectedInflow {
  invoiceId: string;
  customer: string;
  amount: Rupees;
  date: ISODate;
  kind: "expected" | "committed" | "residual";
}

/** Every inflow the forecast will count, with its date. */
export function expectedInflows(invoices: Invoice[]): ExpectedInflow[] {
  const out: ExpectedInflow[] = [];
  for (const invoice of invoices) {
    const date = expectedCollectionDate(invoice);
    if (date === null) continue;
    out.push({
      invoiceId: invoice.id,
      customer: invoice.customer,
      amount: expectedCollectionAmount(invoice),
      date,
      kind: invoice.status === "committed" ? "committed" : "expected",
    });
    const residual = residualAmount(invoice);
    if (residual > 0) {
      out.push({
        invoiceId: invoice.id,
        customer: invoice.customer,
        amount: residual,
        date: residualCollectionDate(invoice),
        kind: "residual",
      });
    }
  }
  return out;
}

export function buildForecast(input: ForecastInput): Forecast {
  const { company, invoices, payables, recurring, reservations } = input;
  const horizon = company.forecastHorizonWeeks;
  const anchor = company.anchorDate;
  const threshold = company.rules.minCashThreshold;

  // Zero-initialised weekly buckets, indexed 1..horizon.
  const collections = new Array<Rupees>(horizon + 1).fill(0);
  const payableTotals = new Array<Rupees>(horizon + 1).fill(0);
  const payrollTotals = new Array<Rupees>(horizon + 1).fill(0);
  const recurringTotals = new Array<Rupees>(horizon + 1).fill(0);
  const reservationTotals = new Array<Rupees>(horizon + 1).fill(0);

  const bump = (bucket: Rupees[], week: number, amount: Rupees): void => {
    bucket[week] = (bucket[week] ?? 0) + amount;
  };

  // --- Inflows -------------------------------------------------------------
  for (const inflow of expectedInflows(invoices)) {
    const week = weekIndex(anchor, inflow.date, horizon);
    if (week === null) continue; // Lands beyond the horizon: no help to us.
    bump(collections, week, inflow.amount);
  }

  // --- Dated outflows ------------------------------------------------------
  // Payroll arrives as dated payables too (a mid-quarter headcount increase is
  // a lump, not a smooth weekly rate), so it is split out by category for the
  // benefit of the UI tooltip rather than treated differently by the maths.
  for (const payable of payables) {
    const week = weekIndex(anchor, payable.scheduledDate, horizon);
    if (week === null) continue;
    if (payable.category === "payroll") {
      bump(payrollTotals, week, payable.amount);
    } else {
      bump(payableTotals, week, payable.amount);
    }
  }

  // --- Steady weekly outflows ---------------------------------------------
  for (const cost of recurring) {
    const from = Math.max(1, cost.startsWeek ?? 1);
    const to = Math.min(horizon, cost.endsWeek ?? horizon);
    for (let week = from; week <= to; week++) {
      if (cost.kind === "payroll") {
        bump(payrollTotals, week, cost.weeklyAmount);
      } else {
        bump(recurringTotals, week, cost.weeklyAmount);
      }
    }
  }

  // --- Approved-but-unpaid commitments ------------------------------------
  // These are real future outflows the moment the agent approves them, which
  // is precisely why approving consumes headroom before any money moves.
  for (const reservation of reservations) {
    if (reservation.releasedAt !== null) continue;
    const week = Math.min(Math.max(1, reservation.week), horizon);
    bump(reservationTotals, week, reservation.amount);
  }

  // --- Walk the horizon ----------------------------------------------------
  const weeks: ForecastWeek[] = [];
  let cash = company.currentCash;

  for (let week = 1; week <= horizon; week++) {
    const inflow = collections[week] ?? 0;
    const payableOut = payableTotals[week] ?? 0;
    const payrollOut = payrollTotals[week] ?? 0;
    const recurringOut = recurringTotals[week] ?? 0;
    const reservedOut = reservationTotals[week] ?? 0;

    const netChange = inflow - payableOut - payrollOut - recurringOut - reservedOut;
    const openingCash = cash;
    const closingCash = openingCash + netChange;
    cash = closingCash;

    weeks.push({
      week,
      startDate: weekStartDate(anchor, week),
      openingCash,
      collections: inflow,
      payables: payableOut,
      payroll: payrollOut,
      recurring: recurringOut,
      reservations: reservedOut,
      netChange,
      closingCash,
      belowThreshold: closingCash < threshold,
    });
  }

  // --- Summarise -----------------------------------------------------------
  const firstWeek = weeks[0];
  let projectedMinimum = firstWeek ? firstWeek.closingCash : company.currentCash;
  let projectedMinimumWeek = firstWeek ? firstWeek.week : 0;
  let breachWeek: number | null = null;
  let breachWeekShortfall = 0;

  for (const week of weeks) {
    // A non-finite balance means bad data reached the engine. Failing loudly
    // is mandatory here: every comparison against NaN is false, so a silent
    // pass would leave the trough un-updated and report the company healthy
    // with headroom to spend. Reporting "safe" is the worst possible failure.
    if (!Number.isFinite(week.closingCash)) {
      throw new Error(
        `Forecast produced a non-finite balance in week ${week.week}; refusing to report a cash position.`,
      );
    }
    if (week.closingCash < projectedMinimum) {
      projectedMinimum = week.closingCash;
      projectedMinimumWeek = week.week;
    }
    if (breachWeek === null && week.belowThreshold) {
      breachWeek = week.week;
      breachWeekShortfall = threshold - week.closingCash;
    }
  }

  const lastWeek = weeks[weeks.length - 1];

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    weeks,
    threshold,
    projectedMinimum,
    projectedMinimumWeek,
    breachWeek,
    breachGap: Math.max(0, threshold - projectedMinimum),
    breachWeekShortfall: Math.max(0, breachWeekShortfall),
    endingCash: lastWeek ? lastWeek.closingCash : company.currentCash,
    // Headroom is simply how far the trough sits above the safety line.
    // Reservations are already folded in above as outflows, so subtracting
    // them again here would double-count committed spend.
    headroom: projectedMinimum - threshold,
  };
}

/**
 * Re-run the forecast with one extra outflow, without mutating anything.
 *
 * This is how the decision engine answers "what would this request actually
 * do to us?" and how the chat answers "what if I approve it anyway?".
 */
export function forecastWithHypothetical(
  input: ForecastInput,
  hypothetical: { amount: Rupees; week: number; id?: string },
): Forecast {
  const probe: Reservation = {
    id: hypothetical.id ?? "hypothetical",
    requestId: hypothetical.id ?? "hypothetical",
    amount: hypothetical.amount,
    week: hypothetical.week,
    createdAt: new Date(0).toISOString(),
    releasedAt: null,
  };
  return buildForecast({
    ...input,
    reservations: [...input.reservations, probe],
  });
}
