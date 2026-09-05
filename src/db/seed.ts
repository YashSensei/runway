/**
 * Demo fixture: Vertex Labs, a mid-stage Indian SaaS company.
 *
 * These numbers are hand-tuned so the demo narrative lands on real arithmetic
 * rather than hardcoded strings. Nothing here is faked at the presentation
 * layer — the forecast engine genuinely produces the figures in the script.
 *
 * The story the data has to tell:
 *   baseline   healthy, trough well clear of the safety line
 *   shock      a large receivable slips and payroll steps up -> breach
 *   defense    agent chases the right invoices -> commitment -> repaired
 *   approvals  two land, a third escalates purely on consumed headroom
 */

import type {
  CategoryStat,
  Company,
  Department,
  HistoricalRequest,
  Invoice,
  LedgerState,
  Payable,
  RecurringCost,
  SpendRequest,
  Vendor,
} from "../types";

const L = (lakhs: number): number => Math.round(lakhs * 100_000);

/** Monday of forecast week 1. Everything else is relative to this. */
export const ANCHOR_DATE = "2026-09-07";
/** "Today" for overdue arithmetic. Same as the anchor for a clean demo. */
export const TODAY = "2026-09-07";

export const COMPANY: Company = {
  id: "vertex-labs",
  name: "Vertex Labs",
  currentCash: L(52),
  forecastHorizonWeeks: 13,
  anchorDate: ANCHOR_DATE,
  rules: {
    maxAutonomousAmount: L(5),
    minCashThreshold: L(25),
    maxBudgetOverage: 0.1,
    requireVendorHistory: true,
    anomalyMultiplier: 2,
  },
};

export const DEPARTMENTS: Department[] = [
  { id: "engineering", name: "Engineering", quarterlyBudget: L(22), periodSpend: L(13.6) },
  { id: "marketing", name: "Marketing", quarterlyBudget: L(15), periodSpend: L(9) },
  { id: "sales", name: "Sales", quarterlyBudget: L(10), periodSpend: L(6) },
  { id: "operations", name: "Operations", quarterlyBudget: L(12), periodSpend: L(7) },
];

export const VENDORS: Vendor[] = [
  { id: "cloudscale", name: "Cloudscale Infrastructure", firstSeen: "2024-04-12", invoiceCount: 14, avgAmount: L(2.9) },
  { id: "adworks", name: "Adworks Media", firstSeen: "2024-08-02", invoiceCount: 9, avgAmount: L(3.8) },
  { id: "vertex-events", name: "Vertex Events", firstSeen: "2025-01-18", invoiceCount: 6, avgAmount: L(2.4) },
  { id: "peoplestack", name: "PeopleStack HR", firstSeen: "2024-02-01", invoiceCount: 21, avgAmount: L(1.1) },
  { id: "nimbus", name: "Nimbus Consulting", firstSeen: null, invoiceCount: 0, avgAmount: 0 },
];

export const CATEGORY_STATS: CategoryStat[] = [
  { departmentId: "engineering", category: "infrastructure", sampleCount: 8, averageAmount: L(2.9) },
  { departmentId: "marketing", category: "campaign", sampleCount: 6, averageAmount: L(3.8) },
  { departmentId: "sales", category: "events", sampleCount: 5, averageAmount: L(2.4) },
  { departmentId: "operations", category: "consulting", sampleCount: 3, averageAmount: L(1.8) },
];

/**
 * Receivables.
 *
 * The four overdue accounts carry deliberately long `customerAvgLagDays`, so
 * the baseline forecast already assumes they arrive late in the horizon. That
 * is what gives the collection agent something real to do: a successful chase
 * pulls the cash forward into the weeks that are actually short.
 */
export const INVOICES: Invoice[] = [
  // --- Overdue, chaseable ---------------------------------------------------
  {
    id: "INV-2041",
    customer: "Acme Retail Group",
    customerEmail: "ap@acmeretail.example.com",
    amount: L(9),
    issuedDate: "2026-06-20",
    dueDate: "2026-07-20",
    status: "overdue",
    customerAvgLagDays: 110,
    chasedAt: null,
  },
  {
    id: "INV-2038",
    customer: "Northwind Logistics",
    customerEmail: "finance@northwind.example.com",
    amount: L(6),
    issuedDate: "2026-07-05",
    dueDate: "2026-08-05",
    status: "overdue",
    customerAvgLagDays: 95,
    chasedAt: null,
  },
  {
    id: "INV-2044",
    customer: "Kestrel Analytics",
    customerEmail: "accounts@kestrel.example.com",
    amount: L(4),
    issuedDate: "2026-07-25",
    dueDate: "2026-08-25",
    status: "overdue",
    customerAvgLagDays: 80,
    chasedAt: null,
  },
  {
    id: "INV-2029",
    customer: "Sentinel Bank",
    customerEmail: "vendor.payments@sentinelbank.example.com",
    amount: L(5),
    issuedDate: "2026-06-10",
    dueDate: "2026-07-10",
    status: "overdue",
    customerAvgLagDays: 100,
    chasedAt: null,
    sensitive: true,
  },

  // --- The big one that slips in the shock ---------------------------------
  {
    id: "INV-2052",
    customer: "Helios Enterprises",
    customerEmail: "payables@helios.example.com",
    amount: L(15),
    issuedDate: "2026-09-01",
    dueDate: "2026-10-01",
    status: "open",
    customerAvgLagDays: 4,
    chasedAt: null,
  },

  // --- Ordinary future receivables -----------------------------------------
  { id: "INV-2055", customer: "Bluepeak Systems", customerEmail: "ap@bluepeak.example.com", amount: L(2.4), issuedDate: "2026-08-20", dueDate: "2026-09-12", status: "open", customerAvgLagDays: 3, chasedAt: null },
  { id: "INV-2056", customer: "Orbit Softworks", customerEmail: "ap@orbitsoft.example.com", amount: L(1.8), issuedDate: "2026-08-24", dueDate: "2026-09-20", status: "open", customerAvgLagDays: 5, chasedAt: null },
  { id: "INV-2057", customer: "Cardinal Health Tech", customerEmail: "ap@cardinalht.example.com", amount: L(2.2), issuedDate: "2026-08-28", dueDate: "2026-09-27", status: "open", customerAvgLagDays: 6, chasedAt: null },
  { id: "INV-2058", customer: "Bluepeak Systems", customerEmail: "ap@bluepeak.example.com", amount: L(1.6), issuedDate: "2026-09-02", dueDate: "2026-10-10", status: "open", customerAvgLagDays: 3, chasedAt: null },
  { id: "INV-2059", customer: "Tessellate Labs", customerEmail: "ap@tessellate.example.com", amount: L(2.8), issuedDate: "2026-09-04", dueDate: "2026-10-18", status: "open", customerAvgLagDays: 4, chasedAt: null },
  { id: "INV-2060", customer: "Orbit Softworks", customerEmail: "ap@orbitsoft.example.com", amount: L(1.5), issuedDate: "2026-09-06", dueDate: "2026-10-25", status: "open", customerAvgLagDays: 5, chasedAt: null },
  { id: "INV-2061", customer: "Cardinal Health Tech", customerEmail: "ap@cardinalht.example.com", amount: L(2.4), issuedDate: "2026-09-08", dueDate: "2026-11-01", status: "open", customerAvgLagDays: 6, chasedAt: null },
  { id: "INV-2062", customer: "Helios Enterprises", customerEmail: "payables@helios.example.com", amount: L(3.6), issuedDate: "2026-09-10", dueDate: "2026-11-08", status: "open", customerAvgLagDays: 4, chasedAt: null },
  { id: "INV-2063", customer: "Tessellate Labs", customerEmail: "ap@tessellate.example.com", amount: L(2.0), issuedDate: "2026-09-12", dueDate: "2026-11-15", status: "open", customerAvgLagDays: 4, chasedAt: null },
  { id: "INV-2064", customer: "Bluepeak Systems", customerEmail: "ap@bluepeak.example.com", amount: L(3.4), issuedDate: "2026-09-14", dueDate: "2026-11-22", status: "open", customerAvgLagDays: 3, chasedAt: null },
  { id: "INV-2065", customer: "Kestrel Analytics", customerEmail: "accounts@kestrel.example.com", amount: L(2.6), issuedDate: "2026-09-16", dueDate: "2026-11-29", status: "open", customerAvgLagDays: 5, chasedAt: null },
  { id: "INV-2066", customer: "Meridian Retail", customerEmail: "ap@meridianretail.example.com", amount: L(3.3), issuedDate: "2026-09-18", dueDate: "2026-11-10", status: "open", customerAvgLagDays: 5, chasedAt: null },
  { id: "INV-2067", customer: "Silverline Foods", customerEmail: "ap@silverlinefoods.example.com", amount: L(2.0), issuedDate: "2026-09-20", dueDate: "2026-10-30", status: "open", customerAvgLagDays: 4, chasedAt: null },
];

/** Dated outflows: vendor bills, taxes, and lumpy payroll events. */
export const PAYABLES: Payable[] = [
  { id: "AP-501", vendorId: "cloudscale", description: "Cloud infrastructure — September", amount: L(2.8), scheduledDate: "2026-09-10", category: "infrastructure", discretionary: false },
  { id: "AP-502", vendorId: "peoplestack", description: "HR platform quarterly", amount: L(1.1), scheduledDate: "2026-09-16", category: "software", discretionary: false },
  { id: "AP-503", vendorId: "adworks", description: "Q3 campaign retainer", amount: L(2.6), scheduledDate: "2026-09-24", category: "campaign", discretionary: true },
  { id: "AP-504", vendorId: "cloudscale", description: "Cloud infrastructure — October", amount: L(3.1), scheduledDate: "2026-10-10", category: "infrastructure", discretionary: false },
  { id: "AP-505", vendorId: "vertex-events", description: "Annual sales offsite", amount: L(2.2), scheduledDate: "2026-10-15", category: "events", discretionary: true },
  { id: "AP-506", vendorId: "peoplestack", description: "Advance tax instalment", amount: L(3.3), scheduledDate: "2026-10-22", category: "tax", discretionary: false },
  { id: "AP-507", vendorId: "cloudscale", description: "Cloud infrastructure — November", amount: L(1.8), scheduledDate: "2026-11-10", category: "infrastructure", discretionary: false },
  { id: "AP-508", vendorId: "adworks", description: "Q4 campaign retainer", amount: L(2.6), scheduledDate: "2026-11-18", category: "campaign", discretionary: true },
  { id: "AP-509", vendorId: "peoplestack", description: "Statutory filings and audit", amount: L(0.8), scheduledDate: "2026-11-26", category: "compliance", discretionary: false },
];

export const RECURRING: RecurringCost[] = [
  { id: "REC-payroll", label: "Payroll", weeklyAmount: L(2.6), kind: "payroll" },
  { id: "REC-saas", label: "Software subscriptions", weeklyAmount: L(0.55), kind: "subscription" },
  { id: "REC-office", label: "Office and operations", weeklyAmount: L(0.45), kind: "subscription" },
];

/** Prior-quarter decisions, used by the counterfactual replay. */
export const HISTORICAL: HistoricalRequest[] = buildHistorical();

function buildHistorical(): HistoricalRequest[] {
  const rows: HistoricalRequest[] = [];
  const push = (
    id: string,
    departmentId: string,
    vendorId: string,
    amount: number,
    category: string,
    wentOverBudget: boolean,
    turnaroundDays: number,
    decidedAt: string,
    humanDecision: "approved" | "rejected" = "approved",
  ): void => {
    rows.push({ id, departmentId, vendorId, amount, category, humanDecision, wentOverBudget, turnaroundDays, decidedAt });
  };

  // Routine, well-behaved requests the agent should agree with.
  const routine: Array<[string, string, number, string]> = [
    ["engineering", "cloudscale", 2.6, "infrastructure"],
    ["engineering", "cloudscale", 3.1, "infrastructure"],
    ["engineering", "cloudscale", 2.4, "infrastructure"],
    ["engineering", "cloudscale", 2.9, "infrastructure"],
    ["marketing", "adworks", 3.4, "campaign"],
    ["marketing", "adworks", 3.9, "campaign"],
    ["marketing", "adworks", 2.8, "campaign"],
    ["sales", "vertex-events", 2.1, "events"],
    ["sales", "vertex-events", 2.6, "events"],
    ["sales", "vertex-events", 1.9, "events"],
    ["operations", "peoplestack", 1.4, "consulting"],
    ["operations", "peoplestack", 1.9, "consulting"],
  ];
  routine.forEach(([dept, vendor, lakhs, category], i) => {
    push(`H-${100 + i}`, dept!, vendor!, L(lakhs as number), category!, false, 2 + (i % 4), "2026-07-15");
  });

  // Filler: a spread of small, unremarkable approvals.
  for (let i = 0; i < 29; i++) {
    const dept = ["engineering", "marketing", "sales", "operations"][i % 4]!;
    const vendor = ["cloudscale", "adworks", "vertex-events", "peoplestack"][i % 4]!;
    const category = ["infrastructure", "campaign", "events", "consulting"][i % 4]!;
    const base = [2.7, 3.5, 2.2, 1.6][i % 4]!;
    push(`H-${200 + i}`, dept, vendor, L(base + ((i % 5) - 2) * 0.2), category, false, 1 + (i % 5), "2026-08-02");
  }

  // The six the agent should catch: oversized against their category baseline.
  // Four of them genuinely blew the department budget afterwards.
  const outliers: Array<[string, string, number, string, boolean]> = [
    ["engineering", "cloudscale", 7.4, "infrastructure", true],
    ["marketing", "adworks", 9.2, "campaign", true],
    ["sales", "vertex-events", 6.1, "events", true],
    ["operations", "peoplestack", 5.8, "consulting", true],
    ["marketing", "adworks", 8.4, "campaign", false],
    ["engineering", "cloudscale", 6.6, "infrastructure", false],
  ];
  outliers.forEach(([dept, vendor, lakhs, category, over], i) => {
    push(`H-${300 + i}`, dept!, vendor!, L(lakhs as number), category!, over as boolean, 4 + i, "2026-08-20");
  });

  return rows;
}

/** A clean, healthy starting state. Scene 1 of the demo. */
export function baseSeed(): LedgerState {
  return {
    company: structuredClone(COMPANY),
    departments: structuredClone(DEPARTMENTS),
    vendors: structuredClone(VENDORS),
    categoryStats: structuredClone(CATEGORY_STATS),
    invoices: structuredClone(INVOICES),
    payables: structuredClone(PAYABLES),
    recurring: structuredClone(RECURRING),
    requests: [],
    decisions: [],
    reservations: [],
    activity: [],
    historical: structuredClone(HISTORICAL),
  };
}

/**
 * Scene 2 — reality intrudes.
 *
 * Helios pushes the ₹15L invoice out by eight weeks, and a mid-quarter
 * headcount increase adds a payroll step. Neither is exotic; together they
 * open a hole in the middle of the horizon.
 */
export function applyShock(state: LedgerState): LedgerState {
  const invoices = state.invoices.map((invoice) =>
    invoice.id === "INV-2052"
      ? { ...invoice, dueDate: "2026-11-26", customerAvgLagDays: 6 }
      : invoice,
  );

  const payables: Payable[] = [
    ...state.payables,
    {
      id: "AP-590",
      vendorId: "peoplestack",
      description: "Payroll step-up — 6 new hires plus arrears",
      amount: L(6),
      scheduledDate: "2026-10-12",
      category: "payroll",
      discretionary: false,
    },
  ];

  return { ...state, invoices, payables };
}

/** The demo's spend requests, in the order the script submits them. */
export const DEMO_REQUESTS: Record<string, Omit<SpendRequest, "id" | "createdAt" | "status">> = {
  engineering: {
    idempotencyKey: "demo-engineering",
    departmentId: "engineering",
    vendorId: "cloudscale",
    amount: L(3.2),
    category: "infrastructure",
    description: "Additional cloud capacity for the December launch",
    requestedBy: "Priya Nair (VP Engineering)",
    expectedWeek: 2,
  },
  marketing: {
    idempotencyKey: "demo-marketing",
    departmentId: "marketing",
    vendorId: "adworks",
    amount: L(4.5),
    category: "campaign",
    description: "Q4 demand generation campaign",
    requestedBy: "Rohan Mehta (Head of Marketing)",
    expectedWeek: 3,
  },
  sales: {
    idempotencyKey: "demo-sales",
    departmentId: "sales",
    vendorId: "vertex-events",
    amount: L(2.8),
    category: "events",
    description: "SaaSBoomi conference sponsorship",
    requestedBy: "Aditi Sharma (Sales Director)",
    expectedWeek: 4,
  },
  "new-vendor": {
    idempotencyKey: "demo-new-vendor",
    departmentId: "operations",
    vendorId: "nimbus",
    amount: L(6.2),
    category: "consulting",
    description: "ISO 27001 readiness engagement",
    requestedBy: "Karan Desai (Head of Operations)",
    expectedWeek: 5,
  },
};
