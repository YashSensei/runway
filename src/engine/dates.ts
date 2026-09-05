/**
 * Date arithmetic for forecast bucketing.
 *
 * Everything is done on `YYYY-MM-DD` strings via UTC day numbers. No local
 * timezone ever enters the calculation, so a Worker in UTC and a laptop in IST
 * bucket the same payable into the same forecast week. Getting this wrong is a
 * silent off-by-one-week bug in the number the whole product is about.
 */

import type { ISODate } from "../types";

const MS_PER_DAY = 86_400_000;

/**
 * Days since the Unix epoch for a `YYYY-MM-DD` string.
 *
 * Anchored, not a prefix match. `Date.UTC` will happily accept out-of-range
 * components and roll them over ("2026-13-45" -> 2027-02-14), and it remaps
 * years 0-99 into the 1900s, so the parse is verified by reconstruction rather
 * than trusted.
 */
export function toDayNumber(iso: ISODate): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new Error(`Invalid ISO date: ${iso}`);
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);

  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`Invalid ISO date: ${iso}`);
  }
  return Math.floor(utc / MS_PER_DAY);
}

/** Inverse of `toDayNumber`. */
export function fromDayNumber(day: number): ISODate {
  const date = new Date(day * MS_PER_DAY);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(iso: ISODate, days: number): ISODate {
  return fromDayNumber(toDayNumber(iso) + days);
}

/** Signed day count from `from` to `to`. Positive when `to` is later. */
export function daysBetween(from: ISODate, to: ISODate): number {
  return toDayNumber(to) - toDayNumber(from);
}

/**
 * Which 1-based forecast week a date falls into, relative to the anchor.
 *
 * Anything on or before the anchor collapses into week 1 — an obligation that
 * was already due is money that leaves immediately, not money that never
 * leaves. Anything past the horizon returns null and is excluded entirely.
 */
export function weekIndex(
  anchor: ISODate,
  date: ISODate,
  horizonWeeks: number,
): number | null {
  const offset = daysBetween(anchor, date);
  const week = offset < 0 ? 1 : Math.floor(offset / 7) + 1;
  if (week > horizonWeeks) return null;
  return week;
}

/** First day of a 1-based forecast week. */
export function weekStartDate(anchor: ISODate, week: number): ISODate {
  return addDays(anchor, (week - 1) * 7);
}

/** Days a date is past due relative to `now`. Never negative. */
export function daysOverdue(dueDate: ISODate, now: ISODate): number {
  return Math.max(0, daysBetween(dueDate, now));
}
