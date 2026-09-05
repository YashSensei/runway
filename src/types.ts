/**
 * Shared contract for the entire system.
 *
 * Money is always integer RUPEES. Never floats, never paise. The UI formats
 * into lakhs for display; nothing else ever divides.
 */

export type Rupees = number;
/** `YYYY-MM-DD` */
export type ISODate = string;
/** Full ISO-8601 datetime */
export type ISODateTime = string;

// ---------------------------------------------------------------------------
// Company configuration
// ---------------------------------------------------------------------------

/**
 * The CFO's delegated-authority policy. In the MVP these are structured and
 * fixed; the product spec's natural-language rule compiler is out of scope.
 */
export interface CfoRules {
  /** Ceiling on what the agent may approve without a human. NOT permission. */
  maxAutonomousAmount: Rupees;
  /** Projected cash must never be driven below this. */
  minCashThreshold: Rupees;
  /** Fraction a department may exceed its budget by, e.g. 0.10 = 10%. */
  maxBudgetOverage: number;
  /** First-time vendors always require a human. */
  requireVendorHistory: boolean;
  /** Flag requests above this multiple of the category historical average. */
  anomalyMultiplier: number;
  /**
   * Total the agent may commit per department within the rolling window.
   *
   * Without this, a per-request ceiling is not a ceiling: three requests of
   * ₹4L each evade a ₹5L limit. Cash abundance is not the same as authority.
   */
  rollingAuthorityPool: Rupees;
  /** Window over which the pool and split-purchase detection are measured. */
  rollingWindowDays: number;
}

export interface Company {
  id: string;
  name: string;
  currentCash: Rupees;
  rules: CfoRules;
  forecastHorizonWeeks: number;
  /** Monday of forecast week 1. */
  anchorDate: ISODate;
}

export interface Department {
  id: string;
  name: string;
  quarterlyBudget: Rupees;
  /** Spend committed so far this quarter. */
  periodSpend: Rupees;
}

export interface Vendor {
  id: string;
  name: string;
  /** null => never transacted with before (triggers requireVendorHistory). */
  firstSeen: ISODate | null;
  invoiceCount: number;
  avgAmount: Rupees;
}

/** Historical spend baseline used for anomaly detection. */
export interface CategoryStat {
  departmentId: string;
  category: string;
  sampleCount: number;
  averageAmount: Rupees;
}

// ---------------------------------------------------------------------------
// Cash inflow — receivables
// ---------------------------------------------------------------------------

export type InvoiceStatus = "open" | "overdue" | "committed" | "paid";

export interface Invoice {
  id: string;
  customer: string;
  customerEmail: string;
  amount: Rupees;
  issuedDate: ISODate;
  dueDate: ISODate;
  status: InvoiceStatus;
  /** Historical days-late for this customer. Drives expected arrival. */
  customerAvgLagDays: number;
  /** Set when the agent has chased it; enforces the cooldown. */
  chasedAt: ISODateTime | null;
  /** Set once a customer replies with a firm commitment. */
  committedAmount?: Rupees;
  committedDate?: ISODate;
  /** Relationship-sensitive accounts are escalated, never auto-chased. */
  sensitive?: boolean;
}

// ---------------------------------------------------------------------------
// Cash outflow — payables and recurring costs
// ---------------------------------------------------------------------------

/** A dated, lumpy outflow: vendor bill, one-off payroll increase, tax, etc. */
export interface Payable {
  id: string;
  vendorId: string;
  description: string;
  amount: Rupees;
  scheduledDate: ISODate;
  category: string;
  /** Discretionary payables are candidates for deferral recommendations. */
  discretionary: boolean;
}

/** A steady weekly outflow across some or all of the horizon. */
export interface RecurringCost {
  id: string;
  label: string;
  weeklyAmount: Rupees;
  kind: "payroll" | "subscription";
  /** Inclusive 1-based week bounds; omitted => whole horizon. */
  startsWeek?: number;
  endsWeek?: number;
}

// ---------------------------------------------------------------------------
// Spend requests
// ---------------------------------------------------------------------------

export type RequestStatus =
  | "pending"
  | "approved"
  | "escalated"
  | "rejected"
  | "paid"
  | "cancelled";

export interface SpendRequest {
  id: string;
  /** Re-submission with the same key must never double-reserve. */
  idempotencyKey: string;
  departmentId: string;
  vendorId: string;
  amount: Rupees;
  category: string;
  description: string;
  requestedBy: string;
  /** Forecast week in which the cash would actually leave. */
  expectedWeek: number;
  status: RequestStatus;
  createdAt: ISODateTime;
}

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------

export interface ForecastWeek {
  week: number;
  startDate: ISODate;
  openingCash: Rupees;
  collections: Rupees;
  payables: Rupees;
  payroll: Rupees;
  recurring: Rupees;
  /** Approved-but-unpaid commitments landing in this week. */
  reservations: Rupees;
  netChange: Rupees;
  closingCash: Rupees;
  belowThreshold: boolean;
}

export interface Forecast {
  generatedAt: ISODateTime;
  weeks: ForecastWeek[];
  threshold: Rupees;
  projectedMinimum: Rupees;
  projectedMinimumWeek: number;
  /** Earliest week where projected cash falls under the threshold. */
  breachWeek: number | null;
  /** Shortfall at the worst point (the trough); 0 when there is no breach. */
  breachGap: Rupees;
  /**
   * Shortfall in the FIRST breaching week; 0 when there is no breach.
   *
   * Distinct from `breachGap`: the first week to cross the line is usually not
   * the deepest one, and quoting the trough figure against the breach week is
   * how a dashboard ends up contradicting its own chart.
   */
  breachWeekShortfall: Rupees;
  endingCash: Rupees;
  /** projectedMinimum - threshold. The agent's spendable authority. */
  headroom: Rupees;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type DecisionOutcome = "APPROVED" | "ESCALATED" | "REJECTED";

export type RuleId =
  | "max_autonomous_amount"
  | "min_cash_threshold"
  | "budget_overage"
  | "require_vendor_history"
  | "anomaly_multiplier"
  | "headroom_check"
  | "aggregate_authority";

export interface RuleEvaluation {
  rule: RuleId;
  passed: boolean;
  /** hard => REJECT on failure. soft => ESCALATE on failure. */
  severity: "hard" | "soft";
  detail: string;
}

/**
 * Why the engine landed where it did. Maps 1:1 to the precedence ladder in
 * the spec, so the UI and narration never have to re-derive it.
 */
export type ReasonCode =
  | "within_authority"
  | "hard_rule_violation"
  | "exceeds_authority"
  | "insufficient_headroom"
  | "anomalous_request";

export interface Decision {
  id: string;
  requestId: string;
  outcome: DecisionOutcome;
  reasonCode: ReasonCode;
  rules: RuleEvaluation[];
  dataUsed: string[];
  headroomBefore: Rupees;
  headroomAfter: Rupees;
  projectedMinimumBefore: Rupees;
  projectedMinimumAfter: Rupees;
  /** Populated asynchronously by the LLM; null until then. */
  narration: string | null;
  /** Deterministic fallback, always present. Demo works with zero LLM access. */
  fallbackNarration: string;
  createdAt: ISODateTime;
}

export interface Reservation {
  id: string;
  requestId: string;
  amount: Rupees;
  week: number;
  createdAt: ISODateTime;
  releasedAt: ISODateTime | null;
}

// ---------------------------------------------------------------------------
// Collections (autonomous cash defense)
// ---------------------------------------------------------------------------

export interface CollectionCandidate {
  invoice: Invoice;
  daysOverdue: number;
  /** Forecast week the money would realistically land in if chased now. */
  expectedArrivalWeek: number;
  /** Chasing money that arrives after the breach is worthless. */
  landsBeforeBreach: boolean;
  score: number;
  rationale: string;
}

export interface CollectionPlan {
  breachWeek: number | null;
  gap: Rupees;
  targets: CollectionCandidate[];
  totalChased: Rupees;
  skipped: Array<{ invoiceId: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

export type ActivityType =
  | "forecast_updated"
  | "breach_detected"
  | "breach_cleared"
  | "email_sent"
  | "reply_parsed"
  | "commitment_recorded"
  | "decision"
  | "shock_applied"
  | "system";

export interface ActivityEntry {
  id: string;
  type: ActivityType;
  /** Whether a human triggered this, or the agent did it on its own. */
  actor: "agent" | "human";
  summary: string;
  detail?: Record<string, unknown>;
  createdAt: ISODateTime;
}

// ---------------------------------------------------------------------------
// Counterfactual replay
// ---------------------------------------------------------------------------

export interface HistoricalRequest {
  id: string;
  departmentId: string;
  vendorId: string;
  amount: Rupees;
  category: string;
  humanDecision: "approved" | "rejected";
  /** Ground truth: did this spend end up breaching the department budget? */
  wentOverBudget: boolean;
  turnaroundDays: number;
  decidedAt: ISODate;
}

export interface ReplayResult {
  total: number;
  agreed: number;
  flagged: number;
  flaggedThatWentOverBudget: number;
  averageHumanTurnaroundDays: number;
  rows: Array<{
    request: HistoricalRequest;
    agentOutcome: DecisionOutcome;
    agreed: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Aggregate state
// ---------------------------------------------------------------------------

export interface LedgerState {
  company: Company;
  departments: Department[];
  vendors: Vendor[];
  categoryStats: CategoryStat[];
  invoices: Invoice[];
  payables: Payable[];
  recurring: RecurringCost[];
  requests: SpendRequest[];
  decisions: Decision[];
  reservations: Reservation[];
  activity: ActivityEntry[];
  historical: HistoricalRequest[];
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export interface EmailMessage {
  to: string;
  toName: string;
  subject: string;
  body: string;
}

export interface EmailSendResult {
  provider: string;
  ok: boolean;
  id?: string;
  error?: string;
  /** True when rendered to the activity log rather than actually transmitted. */
  simulated: boolean;
}

export interface EmailAdapter {
  readonly provider: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export interface LLMAdapter {
  readonly provider: string;
  /** Returns null on any failure — callers must fall back, never throw. */
  complete(system: string, user: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// API contract (GET /api/state)
// ---------------------------------------------------------------------------

/** A request awaiting the CFO, joined with the decision that escalated it. */
export interface EscalationView {
  request: SpendRequest;
  decision: Decision;
  departmentName: string;
  vendorName: string;
}

/** A decision joined with display names, for the audit trail. */
export interface DecisionView {
  decision: Decision;
  request: SpendRequest;
  departmentName: string;
  vendorName: string;
}

/** Sent email, retained so the demo can show exactly what the agent wrote. */
export interface SentEmail {
  id: string;
  invoiceId: string;
  message: EmailMessage;
  result: EmailSendResult;
  sentAt: ISODateTime;
}

/** Everything the single-screen UI renders. One poll, one payload. */
export interface DashboardState {
  company: Company;
  forecast: Forecast;
  departments: Department[];
  invoices: Invoice[];
  activity: ActivityEntry[];
  decisions: DecisionView[];
  escalations: EscalationView[];
  emails: SentEmail[];
  /** Total currently reserved against headroom by approved-unpaid requests. */
  reservedTotal: Rupees;
  replay: ReplayResult | null;
}
