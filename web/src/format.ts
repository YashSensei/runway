/**
 * Display formatting. The engine speaks integer rupees; only this module
 * is allowed to divide.
 */

import type { ISODateTime, Rupees } from "@shared/types";

export const LAKH = 100_000;

/** Rupees -> lakhs as a plain number, for chart axes. */
export function toLakhs(value: Rupees): number {
  return value / LAKH;
}

/** `₹52.0L`, `-₹1.4L`. Always lakhs, so figures stay comparable on screen. */
export function lakh(value: Rupees, digits = 1): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}₹${(Math.abs(value) / LAKH).toFixed(digits)}L`;
}

/** Same as `lakh` but with an explicit `+` for gains. */
export function lakhSigned(value: Rupees, digits = 1): string {
  const sign = value < 0 ? "-" : "+";
  return `${sign}₹${(Math.abs(value) / LAKH).toFixed(digits)}L`;
}

/** Indian digit grouping: `₹52,00,000`. */
export function rupees(value: Rupees): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}₹${group(Math.abs(Math.trunc(value)))}`;
}

function group(n: number): string {
  const s = String(n);
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
}

const IST = "Asia/Kolkata";

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: IST,
});

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: IST,
});

const stampFmt = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: IST,
});

/** `14:52:18` */
export function clock(iso: ISODateTime): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return timeFmt.format(d);
}

/** en-GB renders September as "Sept" and comma-separates date from time. */
function tidy(s: string): string {
  return s.replace("Sept", "Sep").replace(",", "");
}

/** `07 Sep 2026` */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return tidy(dateFmt.format(d));
}

/** `07 Sep 2026 14:52 IST` */
export function stamp(iso: ISODateTime): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${tidy(stampFmt.format(d))} IST`;
}

/** `62%` from a 0..1 ratio. */
export function percent(ratio: number, digits = 0): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

const RULE_LABELS: Record<string, string> = {
  max_autonomous_amount: "max_autonomous_amount",
  min_cash_threshold: "min_cash_threshold",
  budget_overage: "budget_overage",
  require_vendor_history: "require_vendor_history",
  anomaly_multiplier: "anomaly_multiplier",
  headroom_check: "headroom_check",
};

export function ruleLabel(rule: string): string {
  return RULE_LABELS[rule] ?? rule;
}

const ACTIVITY_LABELS: Record<string, string> = {
  forecast_updated: "forecast updated",
  breach_detected: "breach detected",
  breach_cleared: "breach cleared",
  email_sent: "email sent",
  reply_parsed: "reply parsed",
  commitment_recorded: "commitment recorded",
  decision: "decision",
  shock_applied: "shock applied",
  system: "system",
};

export function activityLabel(type: string): string {
  return ACTIVITY_LABELS[type] ?? type.replace(/_/g, " ");
}

const REASON_LABELS: Record<string, string> = {
  within_authority: "Within delegated authority",
  hard_rule_violation: "Hard rule violation",
  exceeds_authority: "Exceeds delegated authority",
  insufficient_headroom: "Insufficient headroom",
  anomalous_request: "Anomalous request",
};

export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason.replace(/_/g, " ");
}
