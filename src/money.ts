/**
 * Money formatting. Single source of truth.
 *
 * Everything in the system is integer RUPEES (see `types.ts`). This module is
 * the only place that turns those integers into something a human reads.
 */

import type { Rupees } from "./types";

/**
 * Format integer rupees in the Indian numbering system (lakh/crore grouping):
 * the last three digits are grouped together, everything above that is grouped
 * in pairs.
 *
 * ```
 * formatINR(0)        // "₹0"
 * formatINR(52_00_000) // "₹52,00,000"
 * formatINR(1520000)  // "₹15,20,000"
 * formatINR(-4500)    // "-₹4,500"
 * ```
 *
 * Non-finite input degrades to "₹0" rather than throwing — this is used inside
 * email and prompt rendering paths that must never blow up.
 */
export function formatINR(rupees: Rupees): string {
  if (!Number.isFinite(rupees)) return "₹0";

  const rounded = Math.round(rupees);
  const negative = rounded < 0;
  const digits = String(Math.abs(rounded));

  let grouped: string;
  if (digits.length <= 3) {
    grouped = digits;
  } else {
    const last3 = digits.slice(-3);
    const head = digits.slice(0, -3);
    // Insert a comma before every trailing pair of digits in the head.
    grouped = `${head.replace(/\B(?=(?:\d{2})+(?!\d))/g, ",")},${last3}`;
  }

  return `${negative ? "-" : ""}₹${grouped}`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * Render a `YYYY-MM-DD` string as "14 March 2026".
 *
 * Deliberately parses the string by hand instead of going through `Date` so
 * the output is identical regardless of the runtime's timezone — a Worker in
 * UTC and a laptop in IST must produce byte-identical emails.
 *
 * Anything that isn't a well-formed ISO date is passed straight through.
 */
export function formatISODate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;

  const [, year, month, day] = match;
  if (year === undefined || month === undefined || day === undefined) return iso;

  const monthName = MONTHS[Number(month) - 1];
  if (monthName === undefined) return iso;

  return `${Number(day)} ${monthName} ${year}`;
}
