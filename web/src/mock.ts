/**
 * Development / offline fixture.
 *
 * This is the state the UI renders when `GET /api/state` is unreachable, and
 * the fixture every component is developed against. It is arithmetically
 * self-consistent: the weekly rows are folded, not typed by hand, so the
 * closing balances, projected minimum, breach week and headroom cannot drift
 * from each other.
 *
 * Narrative encoded here (07 Sep 2026, Vertex Labs):
 *   09:05  baseline forecast, projected minimum ?31.2L, no breach
 *   11:14  agent auto-approves ?3.2L Engineering
 *   12:40  agent auto-approves ?1.8L Marketing
 *   13:05  Northwind's ?12.4L slips to November + Q2 GST lands in week 6
 *   13:05  forecast rebuilt � projected minimum ?18.9L, week 7 breaches
 *   13:07  agent chases Acme and Northwind, skips relationship-sensitive Kestrel
 *   14:22  Acme replies committing ?8.2L by 30 Sep � forecast repairs to ?23.6L
 *   14:52  Sales asks for ?2.8L; no headroom left, first-time vendor -> escalate
 */

import type {
  ActivityEntry,
  AgentStatus,
  Company,
  DashboardState,
  Decision,
  DecisionView,
  Department,
  EscalationView,
  Forecast,
  ForecastWeek,
  Invoice,
  Payable,
  ReplayResult,
  Reservation,
  SentEmail,
  SpendRequest,
  Vendor,
} from "@shared/types";

// ---------------------------------------------------------------------------
// Company
// ---------------------------------------------------------------------------

const company: Company = {
  id: "co_vertexlabs",
  name: "Vertex Labs",
  currentCash: 52_00_000,
  forecastHorizonWeeks: 13,
  anchorDate: "2026-09-07",
  rules: {
    maxAutonomousAmount: 5_00_000,
    minCashThreshold: 25_00_000,
    maxBudgetOverage: 0.1,
    requireVendorHistory: true,
    anomalyMultiplier: 2.5,
    rollingAuthorityPool: 10_00_000,
    rollingWindowDays: 30,
  },
};

// ---------------------------------------------------------------------------
// Forecast � 13 weekly buckets, folded from the flow inputs
// ---------------------------------------------------------------------------

const WEEK_STARTS = [
  "2026-09-07",
  "2026-09-14",
  "2026-09-21",
  "2026-09-28",
  "2026-10-05",
  "2026-10-12",
  "2026-10-19",
  "2026-10-26",
  "2026-11-02",
  "2026-11-09",
  "2026-11-16",
  "2026-11-23",
  "2026-11-30",
];

/** Expected collections, due date shifted by each customer's payment lag. */
const COLLECTIONS = [
  11_50_000, // Zeta Labs INV-2038
  0,
  4_80_000, // Kestrel Media INV-2055
  8_20_000, // Acme Corp � committed 30 Sep
  0,
  2_60_000, // misc retainers
  0,
  5_70_000,
  10_25_000, // Orbital Systems INV-2049
  6_85_000, // Helios Manufacturing INV-2052
  7_85_000,
  12_40_000, // Northwind INV-2044 � slipped to November
  4_80_000,
];

/** Dated, lumpy vendor bills and statutory outflows. */
const PAYABLES = [
  2_85_000, // cloud infrastructure
  0,
  1_90_000,
  0,
  4_15_000, // legal + statutory audit
  4_50_000, // Q2 GST remittance (arrived with the shock)
  2_80_000, // annual insurance renewal
  0,
  2_40_000,
  3_20_000,
  0,
  4_75_000,
  2_10_000,
];

/** Approved-but-unpaid commitments landing in their expected week. */
const RESERVATIONS = [0, 3_20_000, 0, 1_80_000, 0, 0, 0, 0, 0, 0, 0, 0, 0];

const WEEKLY_PAYROLL = 4_20_000;
const WEEKLY_RECURRING = 70_000;

function buildWeeks(openingCash: number, threshold: number): ForecastWeek[] {
  const weeks: ForecastWeek[] = [];
  let opening = openingCash;

  for (let i = 0; i < WEEK_STARTS.length; i += 1) {
    const collections = COLLECTIONS[i] ?? 0;
    const payables = PAYABLES[i] ?? 0;
    const reservations = RESERVATIONS[i] ?? 0;
    const payroll = WEEKLY_PAYROLL;
    const recurring = WEEKLY_RECURRING;
    const netChange =
      collections - payables - payroll - recurring - reservations;
    const closingCash = opening + netChange;

    weeks.push({
      week: i + 1,
      startDate: WEEK_STARTS[i] ?? "2026-09-07",
      openingCash: opening,
      collections,
      payables,
      payroll,
      recurring,
      reservations,
      netChange,
      closingCash,
      belowThreshold: closingCash < threshold,
    });

    opening = closingCash;
  }

  return weeks;
}

function buildForecast(generatedAt: string): Forecast {
  const threshold = company.rules.minCashThreshold;
  const weeks = buildWeeks(company.currentCash, threshold);

  let minWeek = weeks[0];
  for (const w of weeks) {
    if (minWeek === undefined || w.closingCash < minWeek.closingCash) {
      minWeek = w;
    }
  }

  const projectedMinimum = minWeek?.closingCash ?? company.currentCash;
  const projectedMinimumWeek = minWeek?.week ?? 1;
  const breach = weeks.find((w) => w.belowThreshold) ?? null;
  const last = weeks[weeks.length - 1];

  return {
    generatedAt,
    weeks,
    threshold,
    projectedMinimum,
    projectedMinimumWeek,
    breachWeek: breach ? breach.week : null,
    breachGap: breach ? Math.max(0, threshold - projectedMinimum) : 0,
  breachWeekShortfall: breach ? Math.max(0, threshold - breach.closingCash) : 0,
    endingCash: last?.closingCash ?? company.currentCash,
    headroom: projectedMinimum - threshold,
  };
}

const forecast = buildForecast("2026-09-07T14:23:11+05:30");

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

const departments: Department[] = [
  {
    id: "dept_eng",
    name: "Engineering",
    quarterlyBudget: 42_00_000,
    periodSpend: 26_04_000,
  },
  {
    id: "dept_mkt",
    name: "Marketing",
    quarterlyBudget: 18_00_000,
    periodSpend: 12_06_000,
  },
  {
    id: "dept_sales",
    name: "Sales",
    quarterlyBudget: 15_00_000,
    periodSpend: 10_35_000,
  },
  {
    id: "dept_ops",
    name: "Operations",
    quarterlyBudget: 9_00_000,
    periodSpend: 4_02_000,
  },
];

// ---------------------------------------------------------------------------
// Vendors, payables, reservations
// ---------------------------------------------------------------------------

const vendors: Vendor[] = [
  { id: "ven_nimbus", name: "Nimbus Cloud Services", firstSeen: "2024-11-03", invoiceCount: 14, avgAmount: 2_90_000 },
  { id: "ven_sable", name: "Sable Design Studio", firstSeen: "2025-03-12", invoiceCount: 6, avgAmount: 1_50_000 },
  { id: "ven_vertexevents", name: "Vertex Events", firstSeen: null, invoiceCount: 0, avgAmount: 0 },
  { id: "ven_brightpixel", name: "BrightPixel Media", firstSeen: "2025-01-20", invoiceCount: 5, avgAmount: 2_10_000 },
  { id: "ven_quilltools", name: "Quill Tools", firstSeen: "2025-06-02", invoiceCount: 2, avgAmount: 1_20_000 },
  { id: "ven_statutory", name: "Statutory & Compliance", firstSeen: "2024-01-15", invoiceCount: 22, avgAmount: 2_40_000 },
];

/** Dated outflows, mirroring the `PAYABLES` buckets above by week. */
const payables: Payable[] = [
  { id: "AP-701", vendorId: "ven_nimbus", description: "Cloud infrastructure � September", amount: 2_85_000, scheduledDate: "2026-09-09", category: "infrastructure", discretionary: false },
  { id: "AP-702", vendorId: "ven_quilltools", description: "Design tooling renewal", amount: 1_90_000, scheduledDate: "2026-09-23", category: "software", discretionary: true },
  { id: "AP-703", vendorId: "ven_statutory", description: "Legal and statutory audit", amount: 4_15_000, scheduledDate: "2026-10-07", category: "compliance", discretionary: false },
  { id: "AP-704", vendorId: "ven_statutory", description: "Q2 GST remittance", amount: 4_50_000, scheduledDate: "2026-10-14", category: "tax", discretionary: false },
  { id: "AP-705", vendorId: "ven_statutory", description: "Annual insurance renewal", amount: 2_80_000, scheduledDate: "2026-10-21", category: "insurance", discretionary: false },
  { id: "AP-706", vendorId: "ven_nimbus", description: "Cloud infrastructure � October", amount: 2_40_000, scheduledDate: "2026-11-04", category: "infrastructure", discretionary: false },
  { id: "AP-707", vendorId: "ven_brightpixel", description: "Q4 campaign retainer", amount: 3_20_000, scheduledDate: "2026-11-11", category: "campaign", discretionary: true },
  { id: "AP-708", vendorId: "ven_statutory", description: "Advance tax instalment", amount: 4_75_000, scheduledDate: "2026-11-25", category: "tax", discretionary: false },
  { id: "AP-709", vendorId: "ven_nimbus", description: "Cloud infrastructure � November", amount: 2_10_000, scheduledDate: "2026-12-02", category: "infrastructure", discretionary: false },
];

const reservations: Reservation[] = [
  { id: "RES-4471", requestId: "REQ-4471", amount: 3_20_000, week: 2, createdAt: "2026-09-07T11:14:07+05:30", releasedAt: null },
  { id: "RES-4478", requestId: "REQ-4478", amount: 1_80_000, week: 4, createdAt: "2026-09-07T12:40:22+05:30", releasedAt: null },
];

const agent: AgentStatus = {
  autonomyEnabled: true,
  nextAlarmAt: "2026-09-07T14:53:00+05:30",
  lastRunAt: "2026-09-07T14:52:30+05:30",
  intervalMs: 30_000,
  runs: [
    { at: "2026-09-07T13:05:09+05:30", trigger: "alarm", projectedMinimum: 18_90_000, headroom: -6_10_000, breachWeek: 7, outcome: "chased", chased: 21_40_000 },
    { at: "2026-09-07T14:23:11+05:30", trigger: "alarm", projectedMinimum: 23_60_000, headroom: -1_40_000, breachWeek: 7, outcome: "waiting_on_replies" },
    { at: "2026-09-07T14:52:30+05:30", trigger: "alarm", projectedMinimum: 23_60_000, headroom: -1_40_000, breachWeek: 7, outcome: "waiting_on_replies" },
  ],
  emailProvider: "console",
  llmProvider: "none",
  guardrails: { cooldownDays: 3, maxTargets: 3, coverageFactor: 1.5 },
};

// ---------------------------------------------------------------------------
// Receivables
// ---------------------------------------------------------------------------

const invoices: Invoice[] = [
  {
    id: "INV-2038",
    customer: "Zeta Labs",
    customerEmail: "ap@zetalabs.io",
    amount: 11_50_000,
    issuedDate: "2026-08-07",
    dueDate: "2026-09-04",
    status: "open",
    customerAvgLagDays: 3,
    chasedAt: null,
  },
  {
    id: "INV-2041",
    customer: "Acme Corp",
    customerEmail: "finance@acmecorp.in",
    amount: 9_00_000,
    issuedDate: "2026-07-10",
    dueDate: "2026-07-24",
    status: "committed",
    customerAvgLagDays: 22,
    chasedAt: "2026-09-07T13:07:36+05:30",
    committedAmount: 8_20_000,
    committedDate: "2026-09-30",
  },
  {
    id: "INV-2044",
    customer: "Northwind Traders",
    customerEmail: "accounts@northwindtraders.co.in",
    amount: 12_40_000,
    issuedDate: "2026-07-23",
    dueDate: "2026-08-06",
    status: "overdue",
    customerAvgLagDays: 31,
    chasedAt: "2026-09-07T13:07:38+05:30",
  },
  {
    id: "INV-2049",
    customer: "Orbital Systems",
    customerEmail: "payables@orbitalsystems.com",
    amount: 10_25_000,
    issuedDate: "2026-09-25",
    dueDate: "2026-10-23",
    status: "open",
    customerAvgLagDays: 12,
    chasedAt: null,
  },
  {
    id: "INV-2052",
    customer: "Helios Manufacturing",
    customerEmail: "finance@heliosmfg.in",
    amount: 6_85_000,
    issuedDate: "2026-10-09",
    dueDate: "2026-11-06",
    status: "open",
    customerAvgLagDays: 7,
    chasedAt: null,
  },
  {
    id: "INV-2055",
    customer: "Kestrel Media",
    customerEmail: "ops@kestrelmedia.in",
    amount: 4_80_000,
    issuedDate: "2026-08-21",
    dueDate: "2026-09-18",
    status: "open",
    customerAvgLagDays: 4,
    chasedAt: null,
    sensitive: true,
  },
];

// ---------------------------------------------------------------------------
// Spend requests + decisions
// ---------------------------------------------------------------------------

const reqEngineering: SpendRequest = {
  id: "REQ-4471",
  idempotencyKey: "req-4471-v1",
  departmentId: "dept_eng",
  vendorId: "ven_nimbus",
  amount: 3_20_000,
  category: "infrastructure",
  description: "Nimbus Cloud � Q4 reserved capacity, staging + inference tier",
  requestedBy: "priya.n@vertexlabs.io",
  expectedWeek: 2,
  status: "approved",
  createdAt: "2026-09-07T11:13:02+05:30",
};

const reqMarketing: SpendRequest = {
  id: "REQ-4478",
  idempotencyKey: "req-4478-v1",
  departmentId: "dept_mkt",
  vendorId: "ven_sable",
  amount: 1_80_000,
  category: "brand_design",
  description: "Sable Design Studio � product launch identity refresh",
  requestedBy: "arjun.r@vertexlabs.io",
  expectedWeek: 4,
  status: "approved",
  createdAt: "2026-09-07T12:39:41+05:30",
};

const reqSales: SpendRequest = {
  id: "REQ-4486",
  idempotencyKey: "req-4486-v1",
  departmentId: "dept_sales",
  vendorId: "ven_vertexevents",
  amount: 2_80_000,
  category: "events",
  description: "SaaSBoomi Annual � gold sponsorship + booth build",
  requestedBy: "meera.k@vertexlabs.io",
  expectedWeek: 5,
  status: "escalated",
  createdAt: "2026-09-07T14:51:55+05:30",
};

const decEngineering: Decision = {
  id: "DEC-1091",
  requestId: reqEngineering.id,
  outcome: "APPROVED",
  reasonCode: "within_authority",
  rules: [
    {
      rule: "max_autonomous_amount",
      passed: true,
      severity: "hard",
      detail: "?3.2L = ?5.0L delegated ceiling",
    },
    {
      rule: "budget_overage",
      passed: true,
      severity: "hard",
      detail: "Engineering at 62% of ?42.0L quarterly budget � 69% after",
    },
    {
      rule: "require_vendor_history",
      passed: true,
      severity: "soft",
      detail: "Nimbus Cloud Services � 14 prior invoices since Nov 2024",
    },
    {
      rule: "anomaly_multiplier",
      passed: true,
      severity: "soft",
      detail: "?3.2L vs ?2.9L infrastructure average � 1.1� � flag at 2.5�",
    },
    {
      rule: "min_cash_threshold",
      passed: true,
      severity: "hard",
      detail: "Projected minimum stays at ?28.0L, above the ?25.0L floor",
    },
    {
      rule: "headroom_check",
      passed: true,
      severity: "soft",
      detail: "?6.2L available ? ?3.0L remaining after reservation",
    },
  ],
  dataUsed: [
    "Q3 department spend � Engineering",
    "Q4 budget allocation",
    "Current cash ?52.0L",
    "13-week forecast (09:05 IST)",
    "Vendor history � Nimbus Cloud Services (14 invoices)",
    "Category average � infrastructure (18 samples)",
    "8 comparable requests",
    "Open reservations ledger",
  ],
  headroomBefore: 6_20_000,
  headroomAfter: 3_00_000,
  projectedMinimumBefore: 31_20_000,
  projectedMinimumAfter: 28_00_000,
  narration: null,
  fallbackNarration:
    "Approved. ?3.2L is within the ?5.0L delegated ceiling, Engineering is at 62% of its quarterly budget, Nimbus has 14 prior invoices, and the spend leaves projected minimum at ?28.0L � ?3.0L above your floor. Reserved against week 2.",
  createdAt: "2026-09-07T11:14:07+05:30",
};

const decMarketing: Decision = {
  id: "DEC-1096",
  requestId: reqMarketing.id,
  outcome: "APPROVED",
  reasonCode: "within_authority",
  rules: [
    {
      rule: "max_autonomous_amount",
      passed: true,
      severity: "hard",
      detail: "?1.8L = ?5.0L delegated ceiling",
    },
    {
      rule: "budget_overage",
      passed: true,
      severity: "hard",
      detail: "Marketing at 67% of ?18.0L quarterly budget � 77% after",
    },
    {
      rule: "require_vendor_history",
      passed: true,
      severity: "soft",
      detail: "Sable Design Studio � 6 prior invoices since Mar 2025",
    },
    {
      rule: "anomaly_multiplier",
      passed: true,
      severity: "soft",
      detail: "?1.8L vs ?1.5L brand_design average � 1.2� � flag at 2.5�",
    },
    {
      rule: "min_cash_threshold",
      passed: true,
      severity: "hard",
      detail: "Projected minimum stays at ?26.2L, above the ?25.0L floor",
    },
    {
      rule: "headroom_check",
      passed: true,
      severity: "soft",
      detail: "?3.0L available ? ?1.2L remaining after reservation",
    },
  ],
  dataUsed: [
    "Q3 department spend � Marketing",
    "Q4 budget allocation",
    "13-week forecast (11:14 IST)",
    "Vendor history � Sable Design Studio (6 invoices)",
    "Category average � brand_design (11 samples)",
    "Open reservations ledger",
  ],
  headroomBefore: 3_00_000,
  headroomAfter: 1_20_000,
  projectedMinimumBefore: 28_00_000,
  projectedMinimumAfter: 26_20_000,
  narration:
    "Approved, but this was the last comfortable one. ?1.8L is small and Sable is a known vendor, yet it consumes most of what was left: headroom goes ?3.0L ? ?1.2L and projected minimum sits ?1.2L above your floor in week 7. Anything material after this will come back to you.",
  fallbackNarration:
    "Approved. ?1.8L is within the ?5.0L ceiling, Sable Design Studio has 6 prior invoices, and Marketing remains inside its quarterly budget. Headroom falls to ?1.2L. Reserved against week 4.",
  createdAt: "2026-09-07T12:40:22+05:30",
};

const decSales: Decision = {
  id: "DEC-1103",
  requestId: reqSales.id,
  outcome: "ESCALATED",
  reasonCode: "insufficient_headroom",
  rules: [
    {
      rule: "max_autonomous_amount",
      passed: true,
      severity: "hard",
      detail: "?2.8L = ?5.0L delegated ceiling",
    },
    {
      rule: "budget_overage",
      passed: true,
      severity: "hard",
      detail: "Sales at 69% of ?15.0L quarterly budget � 88% after",
    },
    {
      rule: "require_vendor_history",
      passed: false,
      severity: "soft",
      detail: "Vertex Events � no prior invoices � first-time vendor",
    },
    {
      rule: "anomaly_multiplier",
      passed: true,
      severity: "soft",
      detail: "?2.8L vs ?2.4L events average � 1.2� � flag at 2.5�",
    },
    {
      rule: "min_cash_threshold",
      passed: false,
      severity: "soft",
      detail:
        "Projected minimum is already ?23.6L; approving takes it to ?20.8L, ?4.2L below the ?25.0L floor",
    },
    {
      rule: "headroom_check",
      passed: false,
      severity: "soft",
      detail: "Headroom is -?1.4L � request needs ?2.8L",
    },
  ],
  dataUsed: [
    "Q3 department spend � Sales",
    "Q4 budget allocation",
    "13-week forecast (14:23 IST)",
    "Vendor history � Vertex Events (none)",
    "Category average � events (9 samples)",
    "Acme commitment ?8.2L, week 4",
    "Open reservations ledger � ?5.0L reserved",
  ],
  headroomBefore: -1_40_000,
  headroomAfter: -4_20_000,
  projectedMinimumBefore: 23_60_000,
  projectedMinimumAfter: 20_80_000,
  narration: null,
  fallbackNarration:
    "Escalated. Nothing is wrong with this request. Two approvals earlier today consumed the ?6.2L of headroom I started with, and Northwind slipping ?12.4L to November has already pushed projected minimum to ?23.6L � ?1.4L under your ?25.0L threshold. Approving this would take week 7 to ?20.8L. Vertex Events is also a first-time vendor, which your rules always route to you.",
  createdAt: "2026-09-07T14:52:18+05:30",
};

const decisions: DecisionView[] = [
  {
    decision: decEngineering,
    request: reqEngineering,
    departmentName: "Engineering",
    vendorName: "Nimbus Cloud Services",
  },
  {
    decision: decMarketing,
    request: reqMarketing,
    departmentName: "Marketing",
    vendorName: "Sable Design Studio",
  },
  {
    decision: decSales,
    request: reqSales,
    departmentName: "Sales",
    vendorName: "Vertex Events",
  },
];

const escalations: EscalationView[] = [
  {
    request: reqSales,
    decision: decSales,
    departmentName: "Sales",
    vendorName: "Vertex Events",
  },
];

// ---------------------------------------------------------------------------
// Collection emails the agent wrote
// ---------------------------------------------------------------------------

const emails: SentEmail[] = [
  {
    id: "EM-3301",
    invoiceId: "INV-2041",
    message: {
      to: "finance@acmecorp.in",
      toName: "Acme Corp � Accounts Payable",
      subject: "Invoice INV-2041 � ?9,00,000 � outstanding since 24 July",
      body: `Hi Acme Accounts team,

Invoice INV-2041 for ?9,00,000, issued 10 July and due 24 July, is now 45 days past due.

  Invoice     INV-2041
  Issued      10 Jul 2026
  Due         24 Jul 2026
  Amount      ?9,00,000

Could you confirm a payment date? If the full amount is difficult this week, a partial settlement with a firm date for the balance is genuinely useful on our side � reply with the amount and the date and I will record it against the invoice.

If payment has already been released, please share the UTR and I will reconcile it today.

Thanks,
Finance Operations
Vertex Labs

Sent automatically on behalf of Vertex Labs finance. Reply to this address.`,
    },
    result: {
      provider: "resend",
      ok: true,
      id: "re_8f3ad21c9b04",
      simulated: false,
    },
    sentAt: "2026-09-07T13:07:36+05:30",
  },
  {
    id: "EM-3302",
    invoiceId: "INV-2044",
    message: {
      to: "accounts@northwindtraders.co.in",
      toName: "Northwind Traders � Accounts",
      subject: "Invoice INV-2044 � ?12,40,000 � 32 days past due",
      body: `Hi Northwind Accounts team,

Invoice INV-2044 for ?12,40,000, issued 23 July and due 6 August, is now 32 days past due.

  Invoice     INV-2044
  Issued      23 Jul 2026
  Due         06 Aug 2026
  Amount      ?12,40,000

Our records show your last four invoices settled around 31 days after the due date, so this may already be scheduled. If it is, a confirmation of the release date is all I need.

If the invoice is blocked on a PO reference or a GRN, tell me which and I will get it corrected and reissued the same day.

Thanks,
Finance Operations
Vertex Labs

Sent automatically on behalf of Vertex Labs finance. Reply to this address.`,
    },
    result: {
      provider: "console",
      ok: true,
      simulated: true,
    },
    sentAt: "2026-09-07T13:07:38+05:30",
  },
];

// ---------------------------------------------------------------------------
// Activity � the centrepiece feed
// ---------------------------------------------------------------------------

const activity: ActivityEntry[] = [
  {
    id: "ACT-01",
    type: "system",
    actor: "human",
    summary:
      "Ledger loaded � 6 open invoices, 4 departments, 13-week horizon anchored 07 Sep 2026",
    createdAt: "2026-09-07T09:02:14+05:30",
  },
  {
    id: "ACT-02",
    type: "forecast_updated",
    actor: "agent",
    summary:
      "Forecast rebuilt � projected minimum ?31.2L in week 7, ?6.2L above threshold, no breach",
    detail: { projectedMinimum: 31_20_000, breachWeek: null },
    createdAt: "2026-09-07T09:05:41+05:30",
  },
  {
    id: "ACT-03",
    type: "decision",
    actor: "agent",
    summary: "Auto-approved ?3.2L � Engineering � Nimbus Cloud Services",
    detail: { decisionId: "DEC-1091", requestId: "REQ-4471" },
    createdAt: "2026-09-07T11:14:07+05:30",
  },
  {
    id: "ACT-04",
    type: "decision",
    actor: "agent",
    summary: "Auto-approved ?1.8L � Marketing � Sable Design Studio",
    detail: { decisionId: "DEC-1096", requestId: "REQ-4478" },
    createdAt: "2026-09-07T12:40:22+05:30",
  },
  {
    id: "ACT-05",
    type: "shock_applied",
    actor: "human",
    summary:
      "Northwind ?12.4L payment slipped to November � Q2 GST remittance ?4.5L landed in week 6",
    detail: { slipped: 12_40_000, added: 4_50_000 },
    createdAt: "2026-09-07T13:05:03+05:30",
  },
  {
    id: "ACT-06",
    type: "forecast_updated",
    actor: "agent",
    summary: "Forecast rebuilt � projected minimum ?26.2L ? ?18.9L",
    detail: { before: 26_20_000, after: 18_90_000 },
    createdAt: "2026-09-07T13:05:09+05:30",
  },
  {
    id: "ACT-07",
    type: "breach_detected",
    actor: "agent",
    summary:
      "Breach detected � week 7 (19 Oct) closes at ?18.9L, ?6.1L below the ?25.0L threshold",
    detail: { week: 7, gap: 6_10_000 },
    createdAt: "2026-09-07T13:05:11+05:30",
  },
  {
    id: "ACT-08",
    type: "email_sent",
    actor: "agent",
    summary: "Collection email sent � Acme Corp, ?9.0L, 45 days overdue",
    detail: { emailId: "EM-3301", invoiceId: "INV-2041" },
    createdAt: "2026-09-07T13:07:36+05:30",
  },
  {
    id: "ACT-09",
    type: "email_sent",
    actor: "agent",
    summary:
      "Collection email sent � Northwind Traders, ?12.4L, 32 days overdue",
    detail: { emailId: "EM-3302", invoiceId: "INV-2044" },
    createdAt: "2026-09-07T13:07:38+05:30",
  },
  {
    id: "ACT-10",
    type: "system",
    actor: "agent",
    summary:
      "Kestrel Media ?4.8L skipped � account flagged relationship-sensitive, never auto-chased",
    detail: { invoiceId: "INV-2055", reason: "sensitive" },
    createdAt: "2026-09-07T13:07:40+05:30",
  },
  {
    id: "ACT-11",
    type: "reply_parsed",
    actor: "agent",
    summary: "Reply parsed � Acme Corp commits ?8.2L by 30 Sep",
    detail: { invoiceId: "INV-2041", amount: 8_20_000, date: "2026-09-30" },
    createdAt: "2026-09-07T14:22:05+05:30",
  },
  {
    id: "ACT-12",
    type: "commitment_recorded",
    actor: "agent",
    summary:
      "Commitment recorded � INV-2041, ?8.2L, lands week 4 � estimate overridden",
    detail: { invoiceId: "INV-2041", week: 4 },
    createdAt: "2026-09-07T14:22:06+05:30",
  },
  {
    id: "ACT-13",
    type: "forecast_updated",
    actor: "agent",
    summary:
      "Forecast rebuilt � projected minimum ?18.9L ? ?23.6L, breach narrowed to ?1.4L",
    detail: { before: 18_90_000, after: 23_60_000 },
    createdAt: "2026-09-07T14:23:11+05:30",
  },
  {
    id: "ACT-14",
    type: "decision",
    actor: "agent",
    summary: "Escalated ?2.8L � Sales � insufficient headroom",
    detail: { decisionId: "DEC-1103", requestId: "REQ-4486" },
    createdAt: "2026-09-07T14:52:18+05:30",
  },
];

// ---------------------------------------------------------------------------
// Counterfactual replay
// ---------------------------------------------------------------------------

const replay: ReplayResult = {
  total: 47,
  agreed: 41,
  flagged: 6,
  flaggedThatWentOverBudget: 4,
  averageHumanTurnaroundDays: 2.4,
  rows: [
    {
      request: {
        id: "H-3312",
        departmentId: "dept_eng",
        vendorId: "ven_nimbus",
        amount: 2_90_000,
        category: "infrastructure",
        humanDecision: "approved",
        wentOverBudget: false,
        turnaroundDays: 2,
        decidedAt: "2026-07-08",
      },
      agentOutcome: "APPROVED",
      agreed: true,
      failedRules: [],
    },
    {
      request: {
        id: "H-3327",
        departmentId: "dept_mkt",
        vendorId: "ven_brightpixel",
        amount: 4_60_000,
        category: "paid_media",
        humanDecision: "approved",
        wentOverBudget: true,
        turnaroundDays: 4,
        decidedAt: "2026-07-21",
      },
      agentOutcome: "ESCALATED",
      agreed: false,
      failedRules: ["anomaly_multiplier"],
    },
    {
      request: {
        id: "H-3341",
        departmentId: "dept_sales",
        vendorId: "ven_vertexevents",
        amount: 3_10_000,
        category: "events",
        humanDecision: "approved",
        wentOverBudget: true,
        turnaroundDays: 6,
        decidedAt: "2026-08-03",
      },
      agentOutcome: "ESCALATED",
      agreed: false,
      failedRules: ["anomaly_multiplier"],
    },
    {
      request: {
        id: "H-3358",
        departmentId: "dept_ops",
        vendorId: "ven_sable",
        amount: 74_000,
        category: "office",
        humanDecision: "approved",
        wentOverBudget: false,
        turnaroundDays: 3,
        decidedAt: "2026-08-11",
      },
      agentOutcome: "APPROVED",
      agreed: true,
      failedRules: [],
    },
    {
      request: {
        id: "H-3369",
        departmentId: "dept_eng",
        vendorId: "ven_quilltools",
        amount: 8_40_000,
        category: "tooling",
        humanDecision: "rejected",
        wentOverBudget: false,
        turnaroundDays: 1,
        decidedAt: "2026-08-19",
      },
      agentOutcome: "ESCALATED",
      agreed: false,
      failedRules: ["anomaly_multiplier"],
    },
    {
      request: {
        id: "H-3374",
        departmentId: "dept_mkt",
        vendorId: "ven_sable",
        amount: 1_35_000,
        category: "brand_design",
        humanDecision: "approved",
        wentOverBudget: false,
        turnaroundDays: 2,
        decidedAt: "2026-08-26",
      },
      agentOutcome: "APPROVED",
      agreed: true,
      failedRules: [],
    },
  ],
};

// ---------------------------------------------------------------------------

export const mockState: DashboardState = {
  company,
  today: "2026-09-07",
  forecast,
  lastHealthyForecast: null,
  departments,
  vendors,
  invoices,
  payables,
  reservations,
  activity,
  decisions,
  escalations,
  emails,
  reservedTotal: 5_00_000,
  replay,
  agent,
  lastCollectionPlan: null,
  lastBreachCleared: null,
};
