import { useCallback, useRef, useState } from "react";
import type {
  DashboardState,
  Department,
  Invoice,
  InvoiceStatus,
} from "@shared/types";
import { useDashboardState, resolveEscalation } from "./api";
import { clock, lakh, percent, plural, shortDate, stamp } from "./format";
import { StatHeader } from "./components/StatHeader";
import { ForecastChart } from "./components/ForecastChart";
import { ActivityLog } from "./components/ActivityLog";
import { EscalationCard } from "./components/EscalationCard";
import { DecisionDetail } from "./components/DecisionDetail";
import { EmailPreview } from "./components/EmailPreview";
import { DemoControls } from "./components/DemoControls";
import { AuthorityPanel } from "./components/AuthorityPanel";
import { DecisionsPanel } from "./components/DecisionsPanel";
import { ReplayPanel } from "./components/ReplayPanel";
import { Empty, Panel } from "./components/Panel";

/** Receivable rows past this collapse into a "+N more" line. */
const RECEIVABLE_ROW_CAP = 5;

export default function App() {
  const { state, usingMock, loading, lastUpdated, staleSeconds, error } =
    useDashboardState();

  // Modals hold ids, not snapshots, so an open record keeps tracking the poll.
  const [decisionId, setDecisionId] = useState<string | null>(null);
  const [emailId, setEmailId] = useState<string | null>(null);

  // Requests with a decision in flight, or already recorded and waiting for
  // the next poll to drop the card. A ref does the guarding so a double-click
  // inside one React batch still only fires once; the array only exists to
  // drive rendering.
  const lockedRef = useRef<Set<string>>(new Set());
  const [lockedIds, setLockedIds] = useState<readonly string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleResolve = useCallback(
    (requestId: string, action: "approve" | "reject" | "defer") => {
      if (lockedRef.current.has(requestId)) return;
      lockedRef.current.add(requestId);
      setLockedIds([...lockedRef.current]);
      setActionError(null);

      // `resolveEscalation` never throws; false means nothing was recorded.
      void resolveEscalation(requestId, action).then((ok) => {
        if (ok) return; // stays locked until the card leaves `state`
        lockedRef.current.delete(requestId);
        setLockedIds([...lockedRef.current]);
        setActionError(
          `${action.toUpperCase()} failed for ${requestId}. Nothing was recorded — the request is still open.`,
        );
      });
    },
    [],
  );

  const openDecision =
    state?.decisions.find((d) => d.decision.id === decisionId) ?? null;
  const openEmail = state?.emails.find((e) => e.id === emailId) ?? null;

  if (state === null) {
    return loading ? (
      <div className="boot">Connecting to /api/state…</div>
    ) : (
      <BackendDown error={error} />
    );
  }

  const hasEscalations = state.escalations.length > 0;

  return (
    <div className="app">
      {/* Row A — top bar */}
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">RUNWAY</span>
          <span className="brand-sub">Autonomous CFO</span>
        </div>

        <div className="topbar-spacer" />

        <div className="topbar-meta">
          <span>
            <strong>{state.company.name}</strong> · anchored{" "}
            {state.company.anchorDate}
          </span>
          <span>forecast {stamp(state.forecast.generatedAt)}</span>
          {usingMock ? (
            <span className="badge badge-mock">
              <i className="dot" />
              Fixture data
            </span>
          ) : (
            <span className={`badge ${staleSeconds === null ? "badge-live" : "badge-danger"}`}>
              <i className={`dot ${staleSeconds === null ? "dot-pulse" : ""}`} />
              {staleSeconds === null ? "Live · " : "Stale · "}
              {lastUpdated === null
                ? "—"
                : clock(new Date(lastUpdated).toISOString())}
            </span>
          )}
        </div>
      </header>

      {usingMock ? (
        <div className="alert-bar alert-bar-warn" role="alert">
          <span className="alert-bar-title">Dev Fixture</span>
          <span>
            This is <b>?mock</b> data for a different company. Nothing on this
            screen came from the engine.
          </span>
        </div>
      ) : null}

      {staleSeconds !== null ? (
        <div className="alert-bar alert-bar-danger" role="alert">
          <span className="alert-bar-title">Stale</span>
          <span>
            LAST GOOD DATA <span className="mono">{staleSeconds}s</span> AGO
            {error !== null ? (
              <>
                {" · "}
                <span className="mono">{error}</span>
              </>
            ) : null}
          </span>
        </div>
      ) : null}

      <main className="board">
        {/* Row B — stat cards; Row C — status banner. Both span 12. */}
        <StatHeader state={state} />

        {/* Row D — analytic row */}
        <div className="cell cell-chart">
          <ForecastChart forecast={state.forecast} />
        </div>
        <div className="cell cell-authority">
          <AuthorityPanel state={state} />
        </div>

        {/* Row E — operational row */}
        <div className="cell cell-activity">
          <ActivityLog
            entries={state.activity}
            decisions={state.decisions}
            emails={state.emails}
            onOpenDecision={(v) => setDecisionId(v.decision.id)}
            onOpenEmail={(e) => setEmailId(e.id)}
          />
        </div>

        <div className={`cell cell-review stack${hasEscalations ? " stack-escalating" : ""}`}>
          <EscalationsPanel
            state={state}
            lockedIds={lockedIds}
            actionError={actionError}
            onDismissError={() => setActionError(null)}
            onAskWhy={(id) => setDecisionId(id)}
            onResolve={handleResolve}
          />
          <DecisionsPanel
            decisions={state.decisions}
            onOpen={(id) => setDecisionId(id)}
          />
        </div>

        <div className="cell cell-ledger stack">
          <BudgetsPanel
            departments={state.departments}
            overage={state.company.rules.maxBudgetOverage}
          />
          <ReceivablesPanel invoices={state.invoices} />
        </div>

        {/* Row F — replay, full width, below the fold when collapsed */}
        <div className="cell cell-replay">
          <ReplayPanel replay={state.replay} />
        </div>
      </main>

      {openDecision !== null ? (
        <DecisionDetail view={openDecision} onClose={() => setDecisionId(null)} />
      ) : null}

      {openEmail !== null ? (
        <EmailPreview email={openEmail} onClose={() => setEmailId(null)} />
      ) : null}

      <DemoControls />
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * No state, no mock, no numbers. Anything else would be inventing figures in
 * front of the room.
 */
function BackendDown({ error }: { error: string | null }) {
  return (
    <div className="fatal" role="alert">
      <div className="fatal-title">Backend Unreachable</div>
      <div className="fatal-body">
        <span className="mono">GET /api/state</span> is not responding. No
        figures are shown because none of them would be real.
      </div>
      {error !== null ? <div className="fatal-detail mono">{error}</div> : null}
      <div className="fatal-hint">Retrying every 500 ms</div>
    </div>
  );
}

function EscalationsPanel({
  state,
  lockedIds,
  actionError,
  onDismissError,
  onAskWhy,
  onResolve,
}: {
  state: DashboardState;
  lockedIds: readonly string[];
  actionError: string | null;
  onDismissError: () => void;
  onAskWhy: (decisionId: string) => void;
  onResolve: (requestId: string, action: "approve" | "reject" | "defer") => void;
}) {
  const { escalations } = state;
  const empty = escalations.length === 0;

  return (
    <Panel
      title="Escalations"
      className={empty ? "panel-auto" : "panel-fill"}
      bodyClassName={empty && actionError === null ? "panel-body-flush" : "panel-body-esc"}
      right={
        escalations.length > 0 ? (
          <span className="badge badge-danger">
            <i className="dot dot-pulse" />
            {escalations.length} awaiting you
          </span>
        ) : (
          <span className="badge badge-ok">
            <i className="dot" />
            clear
          </span>
        )
      }
    >
      {actionError !== null ? (
        <div className="inline-alert" role="alert">
          <span className="inline-alert-title">Not recorded</span>
          <span className="inline-alert-body">{actionError}</span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onDismissError}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {escalations.length === 0 ? (
        <Empty>Nothing handed back — the agent is operating within authority.</Empty>
      ) : (
        escalations.map((esc) => (
          <EscalationCard
            key={esc.decision.id}
            escalation={esc}
            pending={lockedIds.includes(esc.request.id)}
            onAskWhy={(v) => onAskWhy(v.decision.id)}
            onApprove={(v) => onResolve(v.request.id, "approve")}
            onReject={(v) => onResolve(v.request.id, "reject")}
            onDefer={(v) => onResolve(v.request.id, "defer")}
          />
        ))
      )}
    </Panel>
  );
}

/** Overdue first, then soonest due. `paid` never appears. */
const STATUS_RANK: Record<InvoiceStatus, number> = {
  overdue: 0,
  open: 1,
  committed: 2,
  paid: 3,
};

function ReceivablesPanel({ invoices }: { invoices: Invoice[] }) {
  const outstanding = invoices.filter((i) => i.status !== "paid");

  // The panel total already excluded `paid`; the list did not. It does now.
  const expected = outstanding.reduce(
    (sum, i) => sum + (i.committedAmount ?? i.amount),
    0,
  );

  const sorted = [...outstanding].sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      a.dueDate.localeCompare(b.dueDate) ||
      a.id.localeCompare(b.id),
  );

  const shown = sorted.slice(0, RECEIVABLE_ROW_CAP);
  const hidden = sorted.length - shown.length;

  return (
    <Panel
      title="Receivables"
      className="panel-fill"
      bodyClassName="panel-body-flush"
      right={
        <span className="panel-note">
          <span style={{ color: "var(--text)" }}>{lakh(expected)}</span> expected ·{" "}
          {sorted.length} open
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
              typeof inv.committedAmount === "number" &&
              inv.committedAmount !== inv.amount
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
                className="tbl-row inv-row"
                key={inv.id}
                title={`${inv.id} · issued ${shortDate(inv.issuedDate)} · avg lag ${inv.customerAvgLagDays}d`}
              >
                <span className="tbl-ellipsis">
                  {inv.customer}
                  {inv.sensitive ? <span className="rule-sev">sensitive</span> : null}
                </span>
                <span className="mono tbl-dim inv-due">due {shortDate(inv.dueDate)}</span>
                <span className="chip-row">
                  {committed !== null ? (
                    <span className="chip" style={{ color: "var(--ok)" }}>
                      committed {lakh(committed)}
                      {inv.committedDate !== undefined
                        ? ` · ${shortDate(inv.committedDate)}`
                        : ""}
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
          {hidden > 0 ? (
            <div className="more-row">+{hidden} more outstanding</div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

function BudgetsPanel({
  departments,
  overage,
}: {
  departments: Department[];
  overage: number;
}) {
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
      title="Department Budgets"
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
