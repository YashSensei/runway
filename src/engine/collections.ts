/**
 * Autonomous cash defense — deciding which receivables to chase.
 *
 * The non-obvious part is timing. Recovering a large invoice is worthless if
 * the money arrives after the week the forecast breaches, so arrival timing
 * dominates the ranking rather than raw amount. Chasing ₹20L that lands in
 * week 11 does nothing for a shortfall in week 7.
 */

import type {
  CollectionCandidate,
  CollectionPlan,
  Company,
  Forecast,
  Invoice,
  ISODate,
  Rupees,
} from "../types";
import { addDays, daysOverdue as computeDaysOverdue, weekIndex } from "./dates";
import { residualAmount } from "./forecast";

export interface CollectionPlanInput {
  invoices: Invoice[];
  forecast: Forecast;
  company: Company;
  now: ISODate;
  /** Don't chase the same invoice twice inside this window. */
  cooldownDays?: number;
  maxTargets?: number;
  /** Chase this multiple of the gap, since not everyone pays. */
  coverageFactor?: number;
}

/** Exported so the operator console can show the guardrails, not just imply them. */
export const COLLECTION_DEFAULTS = {
  cooldownDays: 7,
  maxTargets: 3,
  // Chase twice the shortfall. Roughly half of chased invoices produce a firm
  // commitment in practice, so covering the gap exactly would leave the
  // forecast dependent on every single customer replying.
  coverageFactor: 2,
} as const;

/**
 * How quickly we expect payment if we chase right now.
 *
 * A chase compresses the customer's normal lag rather than eliminating it —
 * historically slow payers stay comparatively slow.
 */
export function chaseResponseDays(invoice: Invoice): number {
  const compressed = Math.round(invoice.customerAvgLagDays * 0.5);
  return Math.min(21, Math.max(5, compressed));
}

/** What a chase could actually recover: the whole invoice, or the uncommitted part. */
export function chaseableAmount(invoice: Invoice): Rupees {
  return invoice.status === "committed" ? residualAmount(invoice) : invoice.amount;
}

function scoreCandidate(args: {
  invoice: Invoice;
  daysOverdue: number;
  landsBeforeBreach: boolean;
  maxAmount: Rupees;
}): { score: number; rationale: string } {
  const { invoice, daysOverdue, landsBeforeBreach, maxAmount } = args;

  const timing = landsBeforeBreach ? 1 : 0;
  const size = maxAmount > 0 ? chaseableAmount(invoice) / maxAmount : 0;
  const age = Math.min(daysOverdue / 90, 1);
  const reliability = 1 - Math.min(invoice.customerAvgLagDays / 60, 1);

  const score = timing * 0.4 + size * 0.3 + age * 0.2 + reliability * 0.1;

  const parts = [
    landsBeforeBreach ? "lands before the shortfall" : "would arrive after the shortfall",
    `${daysOverdue} days overdue`,
    invoice.customerAvgLagDays <= 20
      ? "customer normally pays close to terms"
      : `customer runs ~${invoice.customerAvgLagDays} days late`,
  ];

  return { score, rationale: parts.join("; ") };
}

/**
 * Describe one invoice as a chase candidate against the current forecast.
 *
 * Used by the plan for ranking, and by the CFO's manual "chase now" so the
 * email carries the same overdue/arrival reasoning the agent would have used.
 */
export function candidateFor(
  invoice: Invoice,
  forecast: Forecast,
  company: Company,
  now: ISODate,
  maxAmount: Rupees = chaseableAmount(invoice),
): CollectionCandidate {
  const overdue = computeDaysOverdue(invoice.dueDate, now);
  const arrival = addDays(now, chaseResponseDays(invoice));
  const arrivalWeek = weekIndex(company.anchorDate, arrival, company.forecastHorizonWeeks);
  const landsBeforeBreach =
    forecast.breachWeek !== null && arrivalWeek !== null && arrivalWeek <= forecast.breachWeek;
  const { score, rationale } = scoreCandidate({
    invoice,
    daysOverdue: overdue,
    landsBeforeBreach,
    maxAmount,
  });
  return {
    invoice,
    daysOverdue: overdue,
    expectedArrivalWeek: arrivalWeek ?? company.forecastHorizonWeeks + 1,
    landsBeforeBreach,
    score,
    rationale,
  };
}

export function buildCollectionPlan(input: CollectionPlanInput): CollectionPlan {
  const cooldownDays = input.cooldownDays ?? COLLECTION_DEFAULTS.cooldownDays;
  const maxTargets = input.maxTargets ?? COLLECTION_DEFAULTS.maxTargets;
  const coverageFactor = input.coverageFactor ?? COLLECTION_DEFAULTS.coverageFactor;

  const { forecast, company, now } = input;
  const gap = forecast.breachGap;
  const skipped: CollectionPlan["skipped"] = [];

  // No breach, nothing to defend against. The agent does not chase for sport;
  // every email it sends is a call on a customer relationship.
  if (forecast.breachWeek === null || gap <= 0) {
    return { breachWeek: null, gap: 0, targets: [], totalChased: 0, skipped };
  }

  const eligible: Invoice[] = [];
  for (const invoice of input.invoices) {
    if (invoice.status === "paid") continue;
    // A partial commitment leaves a residual that is still owed and still
    // chaseable. Only a full commitment takes the invoice off the table.
    if (invoice.status === "committed" && residualAmount(invoice) === 0) {
      skipped.push({ invoiceId: invoice.id, reason: "Customer has already committed to a date." });
      continue;
    }
    // Not yet due is not a judgement call — it is simply not a candidate, and
    // listing every one of them buries the decisions that were actually made.
    const overdue = computeDaysOverdue(invoice.dueDate, now);
    if (overdue <= 0) continue;
    if (invoice.sensitive) {
      skipped.push({
        invoiceId: invoice.id,
        reason: "Relationship-sensitive account — flagged for you to send manually.",
      });
      continue;
    }
    if (invoice.chasedAt) {
      const since = computeDaysOverdue(invoice.chasedAt.slice(0, 10), now);
      if (since < cooldownDays) {
        skipped.push({
          invoiceId: invoice.id,
          reason: `Chased ${since} day${since === 1 ? "" : "s"} ago, inside the ${cooldownDays}-day cooldown.`,
        });
        continue;
      }
    }
    eligible.push(invoice);
  }

  const maxAmount = eligible.reduce((max, inv) => Math.max(max, chaseableAmount(inv)), 0);
  const candidates = eligible.map((invoice) =>
    candidateFor(invoice, forecast, company, now, maxAmount),
  );

  candidates.sort(
    (a, b) => b.score - a.score || chaseableAmount(b.invoice) - chaseableAmount(a.invoice),
  );

  // Chase more than the gap — some customers will not pay, and stopping exactly
  // at the shortfall leaves no margin for that.
  const target = gap * coverageFactor;
  const selected: CollectionCandidate[] = [];
  let total = 0;
  let cappedByCount = false;

  for (const candidate of candidates) {
    if (selected.length >= maxTargets) {
      cappedByCount = true;
      break;
    }
    if (total >= target) break;
    selected.push(candidate);
    total += chaseableAmount(candidate.invoice);
  }

  for (const candidate of candidates) {
    if (selected.includes(candidate)) continue;
    skipped.push({
      invoiceId: candidate.invoice.id,
      reason: !candidate.landsBeforeBreach
        ? `Would not arrive until week ${candidate.expectedArrivalWeek}, after the week ${forecast.breachWeek} shortfall.`
        : cappedByCount && total < target
          ? `Held back — at most ${maxTargets} accounts are chased per run.`
          : "Shortfall already covered by higher-priority invoices.",
    });
  }

  return {
    breachWeek: forecast.breachWeek,
    gap,
    targets: selected,
    totalChased: total,
    skipped,
  };
}

/** Apply a customer's reply to an invoice, without mutating the original. */
export function recordCommitment(
  invoice: Invoice,
  committedAmount: Rupees,
  committedDate: ISODate,
): Invoice {
  return {
    ...invoice,
    status: "committed",
    committedAmount: Math.min(committedAmount, invoice.amount),
    committedDate,
  };
}

/** Mark an invoice as chased, without mutating the original. */
export function markChased(invoice: Invoice, at: string): Invoice {
  return { ...invoice, status: invoice.status === "open" ? "overdue" : invoice.status, chasedAt: at };
}
