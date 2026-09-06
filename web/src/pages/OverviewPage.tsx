import { useEffect, useRef, useState } from "react";
import type { ActivityEntry, Department, Invoice, InvoiceStatus } from "@shared/types";
import type { PageProps } from "./types";
import { lakh, percent, plural, shortDate } from "../format";
import { StatHeader } from "../components/StatHeader";
import { NarrativeStrip } from "../components/NarrativeStrip";
import { ForecastChart } from "../components/ForecastChart";
import { ActivityLog } from "../components/ActivityLog";
import { EscalationsPanel } from "../components/EscalationsPanel";
import { AuthorityPanel } from "../components/AuthorityPanel";
import { DecisionsPanel } from "../components/DecisionsPanel";
import { ReplayPanel } from "../components/ReplayPanel";
import { Empty, Panel } from "../components/Panel";

/** Receivable rows past this collapse into a "+N more" line. */
const RECEIVABLE_ROW_CAP = 5;

/** Which board cell the agent last wrote to, for the 3s hero pulse. */
type PulseTarget = "chart" | "review" | "ledger" | "activity";

export default function OverviewPage({ state, openDecision, openEmail }: PageProps) {
  const hasEscalations = state.escalations.length > 0;
  const pulse = useAgentPulse(state.activity);

  return (
    <main className={`board${hasEscalations ? " board-escalating" : ""}`}>
      {/* Row B — stat cards; Row C — status banner. Both span 12. */}
      <StatHeader state={state} />

      {/* Row C2 — the agent's sentence. Hero tier. */}
      <NarrativeStrip state={state} onOpenDecision={openDecision} />

      {/* Row D — analytic row */}
      <div className={`cell cell-chart${pulse === "chart" ? " cell-pulse" : ""}`}>
        <ForecastChart forecast={state.forecast} ghost={state.lastHealthyForecast} />
      </div>
      <div className="cell cell-authority">
        <AuthorityPanel state={state} />
      </div>

      {/* Row E — operational row. With an escalation open, the review stack
          takes the wide slot and Activity narrows; the ledger drops a row. */}
      <div className={`cell cell-activity${pulse === "activity" ? " cell-pulse" : ""}`}>
        <ActivityLog
          entries={state.activity}
          decisions={state.decisions}
          emails={state.emails}
          onOpenDecision={(v) => openDecision(v.decision.id)}
          onOpenEmail={(e) => openEmail(e.id)}
        />
      </div>

      <div
        className={`cell cell-review stack${hasEscalations ? " stack-escalating" : ""}${
          pulse === "review" ? " cell-pulse" : ""
        }`}
      >
        <EscalationsPanel state={state} onAskWhy={openDecision} />
        <DecisionsPanel decisions={state.decisions} onOpen={openDecision} />
      </div>

      <div className={`cell cell-ledger stack${pulse === "ledger" ? " cell-pulse" : ""}`}>
        <BudgetsPanel departments={state.departments} overage={state.company.rules.maxBudgetOverage} />
        <ReceivablesPanel invoices={state.invoices} />
      </div>

      {/* Row F — replay, full width, below the fold when collapsed */}
      <div className="cell cell-replay">
        <ReplayPanel replay={state.replay} />
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------

/**
 * Newest agent activity → which panel it touched. Returns that key for 3s
 * after it changes, then null. Human actions never pulse anything.
 */
function useAgentPulse(activity: readonly ActivityEntry[]): PulseTarget | null {
  const latest = [...activity]
    .filter((e) => e.actor === "agent")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id))[0];
  const latestId = latest?.id ?? null;

  const [target, setTarget] = useState<PulseTarget | null>(null);
  const seen = useRef<string | null>(latestId);

  useEffect(() => {
    if (latestId === null || latestId === seen.current) return;
    seen.current = latestId;
    setTarget(latest ? panelFor(latest) : null);
    const t = setTimeout(() => setTarget(null), 3000);
    return () => clearTimeout(t);
    // `latest` is derived from `latestId`; tracking the id is sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestId]);

  return target;
}

function panelFor(entry: ActivityEntry): PulseTarget {
  switch (entry.type) {
    case "decision":
      return "review";
    case "email_sent":
    case "reply_parsed":
    case "commitment_recorded":
      return "ledger";
    case "forecast_updated":
    case "breach_detected":
    case "breach_cleared":
    case "shock_applied":
      return "chart";
    default:
      return "activity";
  }
}

// ---------------------------------------------------------------------------

/** Chased or committed rows are the story; they pin to the top. Then overdue,
 *  then soonest due. `paid` never appears. */
const STATUS_RANK: Record<InvoiceStatus, number> = {
  overdue: 0,
  open: 1,
  committed: 2,
  paid: 3,
};

function isHero(inv: Invoice): boolean {
  return inv.chasedAt !== null || inv.status === "committed";
}

function ReceivablesPanel({ invoices }: { invoices: Invoice[] }) {
  const outstanding = invoices.filter((i) => i.status !== "paid");

  // The panel total already excluded `paid`; the list did not. It does now.
  const expected = outstanding.reduce((sum, i) => sum + (i.committedAmount ?? i.amount), 0);

  const sorted = [...outstanding].sort(
    (a, b) =>
      Number(isHero(b)) - Number(isHero(a)) ||
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      a.dueDate.localeCompare(b.dueDate) ||
      a.id.localeCompare(b.id),
  );

  const shown = sorted.slice(0, RECEIVABLE_ROW_CAP);
  const hidden = sorted.length - shown.length;

  return (
    <Panel
      title="Receivables"
      tier="reference"
      className="panel-fill"
      bodyClassName="panel-body-flush"
      right={
        <span className="panel-note">
          <span style={{ color: "var(--text)" }}>{lakh(expected)}</span> expected · {sorted.length}{" "}
          open
        </span>
      }
    >
      {shown.length === 0 ? (
        <Empty>Nothing outstanding</Empty>
      ) : (
        <div className="tbl">
          {shown.map((inv) => {
            // The invoice is worth `amount`; a commitment is a separate,
            // possibly smaller promise. Showing the commitment as the invoice
            // contradicts the collection email one click away.
            const committed =
              typeof inv.committedAmount === "number" && inv.committedAmount !== inv.amount
                ? inv.committedAmount
                : null;

            const statusColor =
              inv.status === "overdue"
                ? "var(--danger)"
                : inv.status === "committed"
                  ? "var(--ok)"
                  : "var(--text-2)";

            return (
              <div
                className={`tbl-row inv-row${isHero(inv) ? " inv-row-hero" : ""}`}
                key={inv.id}
                title={`${inv.id} · issued ${shortDate(inv.issuedDate)} · avg lag ${inv.customerAvgLagDays}d`}
              >
                <span className="inv-name">
                  {inv.customer}
                  {inv.sensitive ? <span className="rule-sev">sensitive</span> : null}
                </span>
                <span className="mono tbl-dim inv-due">due {shortDate(inv.dueDate)}</span>
                <span className="chip-row">
                  {committed !== null ? (
                    <span className="chip" style={{ color: "var(--ok)" }}>
                      committed {lakh(committed)}
                      {inv.committedDate !== undefined ? ` · ${shortDate(inv.committedDate)}` : ""}
                    </span>
                  ) : null}
                  <span className="chip" style={{ color: statusColor }}>
                    {inv.chasedAt !== null ? "chased · " : ""}
                    {inv.status}
                  </span>
                </span>
                <span className="mono tbl-right">{lakh(inv.amount)}</span>
              </div>
            );
          })}
          {hidden > 0 ? <div className="more-row">+{hidden} more outstanding</div> : null}
        </div>
      )}
    </Panel>
  );
}

function BudgetsPanel({ departments, overage }: { departments: Department[]; overage: number }) {
  // Every bar shares one scale that reaches past the overage ceiling, so the
  // 100% mark and the ceiling tick sit at the same x in every row.
  const ceiling = 1 + Math.max(0, overage);
  const maxRatio = departments.reduce((m, d) => {
    const r = d.quarterlyBudget > 0 ? d.periodSpend / d.quarterlyBudget : 0;
    return Math.max(m, r);
  }, 0);
  const scaleMax = Math.max(ceiling, maxRatio) * 1.04;
  const pos = (ratio: number) => `${(clamp01(ratio / scaleMax) * 100).toFixed(2)}%`;

  return (
    <Panel
      title="Department budgets"
      tier="reference"
      className="panel-auto"
      right={
        <span className="panel-note">
          quarter to date · <span className="tick-key tick-key-budget" /> budget ·{" "}
          <span className="tick-key tick-key-ceiling" /> +{percent(overage)} ceiling
        </span>
      }
    >
      {departments.length === 0 ? (
        <Empty>No departments configured</Empty>
      ) : (
        departments.map((d) => {
          const ratio = d.quarterlyBudget > 0 ? d.periodSpend / d.quarterlyBudget : 0;
          const fill =
            ratio > ceiling
              ? "bar-fill-danger"
              : ratio > 1
                ? "bar-fill-warn"
                : ratio > 0.85
                  ? "bar-fill-warn"
                  : "";
          const pctColor =
            ratio > ceiling ? "var(--danger)" : ratio > 0.85 ? "var(--warn)" : "var(--text)";

          return (
            <div className="dept" key={d.id}>
              <div className="dept-line">
                <span className="dept-name">{d.name}</span>
                <span className="dept-figures">
                  <span style={{ color: "var(--text)" }}>{lakh(d.periodSpend)}</span>
                  {" / "}
                  {lakh(d.quarterlyBudget)}
                  <span className="dept-pct" style={{ color: pctColor }}>
                    {percent(ratio)}
                  </span>
                </span>
              </div>
              <div
                className="bar bar-lg"
                role="img"
                aria-label={`${d.name}: ${percent(ratio)} of quarterly budget spent`}
              >
                <div className={`bar-fill ${fill}`} style={{ width: pos(ratio) }} />
                <span className="bar-tick bar-tick-budget" style={{ left: pos(1) }} />
                <span className="bar-tick bar-tick-ceiling" style={{ left: pos(ceiling) }} />
              </div>
            </div>
          );
        })
      )}
      {departments.length > 4 ? (
        <div className="more-row">{plural(departments.length, "department")}</div>
      ) : null}
    </Panel>
  );
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
