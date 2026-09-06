/**
 * Receivables arithmetic for the Collect page.
 *
 * Every date is a `YYYY-MM-DD` string turned into a UTC day number. Local
 * time never enters — a laptop in IST and a Worker in UTC must put the same
 * invoice in the same forecast week, and the week rule here is the engine's
 * (`src/engine/dates.ts`): on or before the anchor collapses into week 1,
 * past the horizon is null.
 */

import type { Invoice, ISODate, Rupees } from "@shared/types";

const MS_PER_DAY = 86_400_000;

export type AgeingBucket = "current" | "1-30" | "31-60" | "61-90" | "90+";

export const AGEING_BUCKETS: readonly AgeingBucket[] = ["current", "1-30", "31-60", "61-90", "90+"];

/** Days since the Unix epoch, or null when the string is not a valid date. */
export function dayNumber(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(utc / MS_PER_DAY);
}

export function fromDayNumber(day: number): ISODate {
  const date = new Date(day * MS_PER_DAY);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** `iso + days`. An unparseable input is returned unchanged rather than thrown. */
export function addDays(iso: ISODate, days: number): ISODate {
  const n = dayNumber(iso);
  if (n === null) return iso;
  return fromDayNumber(n + days);
}

/** Signed day count from `from` to `to`; 0 when either side is invalid. */
export function daysBetween(from: ISODate, to: ISODate): number {
  const a = dayNumber(from);
  const b = dayNumber(to);
  if (a === null || b === null) return 0;
  return b - a;
}

/** Days past due as of `today`. Never negative. */
export function daysOverdue(due: ISODate, today: ISODate): number {
  return Math.max(0, daysBetween(due, today));
}

export function ageingBucket(days: number): AgeingBucket {
  if (days <= 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

export function bucketLabel(bucket: AgeingBucket): string {
  switch (bucket) {
    case "current":
      return "Current";
    case "1-30":
      return "1–30 days";
    case "31-60":
      return "31–60 days";
    case "61-90":
      return "61–90 days";
    case "90+":
      return "90+ days";
  }
}

export function isCommitted(invoice: Invoice): boolean {
  return invoice.status === "committed" && typeof invoice.committedAmount === "number";
}

/**
 * When the money is expected to land: the customer's firm date if they gave
 * one, otherwise due date plus their historical lag. Same rule as the engine.
 */
export function expectedArrivalDate(invoice: Invoice): ISODate {
  if (isCommitted(invoice) && invoice.committedDate) return invoice.committedDate;
  return addDays(invoice.dueDate, invoice.customerAvgLagDays);
}

/** Where an uncommitted residual lands: the customer's normal timeline. */
export function residualArrivalDate(invoice: Invoice): ISODate {
  return addDays(invoice.dueDate, invoice.customerAvgLagDays);
}

/**
 * 1-based forecast week for a date. Before the anchor collapses to week 1;
 * beyond the horizon returns null. Identical to the engine's `weekIndex`.
 */
export function weekOf(date: ISODate, anchor: ISODate, horizon: number): number | null {
  const a = dayNumber(anchor);
  const d = dayNumber(date);
  if (a === null || d === null) return null;
  const offset = d - a;
  const week = offset < 0 ? 1 : Math.floor(offset / 7) + 1;
  if (week > horizon) return null;
  return week;
}

/** Last day the engine will accept a commitment for. */
export function horizonEnd(anchor: ISODate, horizon: number): ISODate {
  return addDays(anchor, horizon * 7);
}

/** True when `date` is a valid date inside `anchor .. anchor + horizon×7`. */
export function withinHorizon(date: ISODate, anchor: ISODate, horizon: number): boolean {
  const d = dayNumber(date);
  const a = dayNumber(anchor);
  if (d === null || a === null) return false;
  return d >= a && d <= a + horizon * 7;
}

/** The part of a committed invoice the customer did NOT commit to. */
export function residual(invoice: Invoice): Rupees {
  if (!isCommitted(invoice)) return 0;
  return Math.max(0, invoice.amount - (invoice.committedAmount ?? 0));
}

/**
 * What is still owed with no firm date against it: the residual on a
 * committed invoice, the full amount otherwise, nothing when paid.
 */
export function outstanding(invoice: Invoice): Rupees {
  if (invoice.status === "paid") return 0;
  if (isCommitted(invoice)) return residual(invoice);
  return invoice.amount;
}

/** Chased, and the customer has not yet replied with a commitment. */
export function isAwaitingReply(invoice: Invoice): boolean {
  return invoice.chasedAt !== null && invoice.status !== "committed" && invoice.status !== "paid";
}

/** Tone tier of a collection email, read back from its subject line. */
export type ToneTier = "gentle" | "firm" | "urgent";

export function toneFromSubject(subject: string): ToneTier | null {
  if (subject.startsWith("Reminder:")) return "gentle";
  if (subject.startsWith("Overdue:")) return "firm";
  if (subject.startsWith("Action required:")) return "urgent";
  return null;
}

export interface AgeingTile {
  bucket: AgeingBucket;
  count: number;
  amount: Rupees;
}

/** Five buckets, always all five, in ageing order. Paid invoices are excluded. */
export function ageingTiles(invoices: readonly Invoice[], today: ISODate): AgeingTile[] {
  const tiles = new Map<AgeingBucket, AgeingTile>();
  for (const bucket of AGEING_BUCKETS) tiles.set(bucket, { bucket, count: 0, amount: 0 });
  for (const inv of invoices) {
    if (inv.status === "paid") continue;
    const tile = tiles.get(ageingBucket(daysOverdue(inv.dueDate, today)));
    if (!tile) continue;
    tile.count += 1;
    tile.amount += outstanding(inv);
  }
  return AGEING_BUCKETS.map((b) => tiles.get(b) ?? { bucket: b, count: 0, amount: 0 });
}

export interface CustomerGroup {
  customer: string;
  /** Mean of the invoices' historical lag — normally identical across a customer. */
  avgLagDays: number;
  openAmount: Rupees;
  invoiceCount: number;
  chasedCount: number;
  committedAmount: Rupees;
  sensitive: boolean;
}

/** One row per customer, open ₹ descending. Paid invoices are ignored. */
export function groupByCustomer(invoices: readonly Invoice[]): CustomerGroup[] {
  const groups = new Map<string, CustomerGroup & { lagTotal: number }>();
  for (const inv of invoices) {
    if (inv.status === "paid") continue;
    const g = groups.get(inv.customer) ?? {
      customer: inv.customer,
      avgLagDays: 0,
      lagTotal: 0,
      openAmount: 0,
      invoiceCount: 0,
      chasedCount: 0,
      committedAmount: 0,
      sensitive: false,
    };
    g.invoiceCount += 1;
    g.lagTotal += inv.customerAvgLagDays;
    g.openAmount += outstanding(inv);
    if (inv.chasedAt !== null) g.chasedCount += 1;
    if (isCommitted(inv)) g.committedAmount += inv.committedAmount ?? 0;
    if (inv.sensitive) g.sensitive = true;
    groups.set(inv.customer, g);
  }
  return [...groups.values()]
    .map(({ lagTotal, ...g }) => ({
      ...g,
      avgLagDays: g.invoiceCount > 0 ? Math.round(lagTotal / g.invoiceCount) : 0,
    }))
    .sort(
      (a, b) =>
        b.openAmount - a.openAmount ||
        b.committedAmount - a.committedAmount ||
        a.customer.localeCompare(b.customer),
    );
}
