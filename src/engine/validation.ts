/**
 * The boundary between untrusted HTTP input and the engine.
 *
 * The engine assumes integer rupees and in-horizon week indices, and it is
 * correct under those assumptions. Nothing enforced them.
 *
 * That gap was not theoretical. A string amount makes `bucket[w] + amount`
 * concatenate rather than add, the week's closing becomes NaN, and every
 * comparison against NaN is false — so the trough never updates and the
 * forecast reports the company as HEALTHY with headroom to spend. A missing
 * `expectedWeek` lands the reservation in `bucket[NaN]`, a property the week
 * loop never reads, so approved spend becomes invisible to the forecast
 * entirely. A negative amount is subtracted as an outflow, which means it
 * *manufactures* headroom out of nothing.
 *
 * Every one of those is a single unauthenticated POST. Validate here.
 */

import type { ISODate, Rupees } from "../types";
import { toDayNumber } from "./dates";

/** ₹1,000 crore. Not a real limit, just a bound on obvious nonsense. */
const MAX_AMOUNT: Rupees = 100_000_000_000;
const MAX_TEXT = 500;

export interface SpendRequestInput {
  idempotencyKey: string;
  departmentId: string;
  vendorId: string;
  amount: number;
  category: string;
  description: string;
  requestedBy: string;
  expectedWeek: number;
}

function badText(value: unknown, field: string, max = MAX_TEXT): string | null {
  if (typeof value !== "string") return `${field} must be a string`;
  if (value.trim().length === 0) return `${field} must not be empty`;
  if (value.length > max) return `${field} must be at most ${max} characters`;
  return null;
}

/** Positive, integral, finite rupees. Rejects strings, NaN, null, floats. */
export function validateAmount(amount: unknown, field = "amount"): string | null {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return `${field} must be a finite number`;
  }
  if (!Number.isInteger(amount)) return `${field} must be whole rupees`;
  if (amount <= 0) return `${field} must be greater than zero`;
  if (amount > MAX_AMOUNT) return `${field} exceeds the maximum permitted value`;
  return null;
}

/** A 1-based week that actually exists in the forecast horizon. */
export function validateWeek(week: unknown, horizon: number): string | null {
  if (typeof week !== "number" || !Number.isInteger(week)) {
    return "expectedWeek must be an integer";
  }
  if (week < 1 || week > horizon) {
    return `expectedWeek must be between 1 and ${horizon}`;
  }
  return null;
}

/**
 * A well-formed calendar date.
 *
 * Round-trips through the day-number conversion because `Date.UTC` silently
 * rolls over out-of-range components ("2026-13-45" becomes 2027-02-14) and
 * remaps two-digit years ("0026-09-25" becomes 1926-09-25). Either one lets a
 * malformed date land in forecast week 1 and conjure cash out of a typo.
 */
export function validateISODate(value: unknown, field = "date"): string | null {
  if (typeof value !== "string") return `${field} must be a string`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${field} must be YYYY-MM-DD`;
  try {
    const roundTripped = new Date(toDayNumber(value) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    if (roundTripped !== value) return `${field} is not a valid calendar date`;
  } catch {
    return `${field} is not a valid calendar date`;
  }
  return null;
}

/** Full validation for an incoming spend request. Returns null when clean. */
export function validateSpendRequest(
  input: unknown,
  horizon: number,
): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "request body must be an object";
  }
  const r = input as Record<string, unknown>;

  const amountError = validateAmount(r["amount"]);
  if (amountError) return amountError;

  const weekError = validateWeek(r["expectedWeek"], horizon);
  if (weekError) return weekError;

  for (const field of ["departmentId", "vendorId", "category", "idempotencyKey"]) {
    const error = badText(r[field], field, 120);
    if (error) return error;
  }
  for (const field of ["description", "requestedBy"]) {
    const error = badText(r[field], field);
    if (error) return error;
  }
  return null;
}

/** Validation for an inbound customer commitment. */
export function validateCommitment(
  input: unknown,
  bounds: { earliest: ISODate; latest: ISODate },
): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "request body must be an object";
  }
  const r = input as Record<string, unknown>;

  if (r["invoiceId"] !== undefined) {
    const error = badText(r["invoiceId"], "invoiceId", 120);
    if (error) return error;
  }
  if (r["amount"] !== undefined) {
    const error = validateAmount(r["amount"]);
    if (error) return error;
  }
  if (r["date"] !== undefined) {
    const error = validateISODate(r["date"]);
    if (error) return error;
    const day = toDayNumber(r["date"] as string);
    if (day < toDayNumber(bounds.earliest) || day > toDayNumber(bounds.latest)) {
      return `date must fall between ${bounds.earliest} and ${bounds.latest}`;
    }
  }
  return null;
}
