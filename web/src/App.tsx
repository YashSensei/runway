import { useCallback, useRef, useState } from "react";
import type {
  DashboardState,
  Department,
  Invoice,
  InvoiceStatus,
  ReplayResult,
} from "@shared/types";
import { useDashboardState, resolveEscalation } from "./api";
import { clock, lakh, percent, rupees, shortDate, stamp } from "./format";
import { StatHeader } from "./components/StatHeader";
import { ForecastChart } from "./components/ForecastChart";
import { ActivityLog } from "./components/ActivityLog";
import { EscalationCard } from "./components/EscalationCard";
import { DecisionDetail } from "./components/DecisionDetail";
import { EmailPreview } from "./components/EmailPreview";
import { DemoControls } from "./components/DemoControls";

/** Rows past this are collapsed into a "+N more" line so nothing runs off a 720p projector. */
const RAIL_ROW_CAP = 6;

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

  return (
    <div className="app">
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

      <StatHeader state={state} />

      <div className="grid">
        <div className="col">
          <ForecastChart forecast={state.forecast} />
          <ActivityLog
            entries={state.activity}
            decisions={state.decisions}
            emails={state.emails}
            onOpenDecision={(v) => setDecisionId(v.decision.id)}
            onOpenEmail={(e) => setEmailId(e.id)}
          />
        </div>

        <div className="col">
          {actionError !== null ? (
            <div className="alert-bar alert-bar-danger" role="alert">
              <span className="alert-bar-title">Not recorded</span>
              <span>{actionError}</span>
              <button
                type="button"
                className="btn btn-sm btn-ghost alert-bar-dismiss"
                onClick={() => setActionError(null)}
              >
                Dismiss
              </button>
            </div>
          ) : null}

          <EscalationsPanel
            state={state}
            lockedIds={lockedIds}
            onAskWhy={(id) => setDecisionId(id)}
            onResolve={handleResolve}
          />
          <ReceivablesPanel invoices={state.invoices} />
          <BudgetsPanel departments={state.departments} />
          <AuthorityPanel state={state} />
          <ReplayPanel replay={state.replay} />
        </div>
      </div>

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
  onAskWhy,
  onResolve,
}: {
  state: DashboardState;
  lockedIds: readonly string[];
  onAskWhy: (decisionId: string) => void;
  onResolve: (requestId: string, action: "approve" | "reject" | "defer") => void;
}) {
  const { escalations } = state;

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Escalations</span>
        {escalations.length > 0 ? (
          <span className="badge badge-danger">
            <i className="dot dot-pulse" />
            {escalations.length} awaiting you
          </span>
        ) : (
          <span className="badge badge-ok">
            <i className="dot" />
            clear
          </span>
        )}
      </div>

      <div className="panel-body">
        {escalations.length === 0 ? (
          <div className="empty">Nothing handed back</div>
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
      </div>
    </section>
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

  const shown = sorted.slice(0, RAIL_ROW_CAP);
  const hidden = sorted.length - shown.length;

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Receivables</span>
        <span className="panel-note">
          {lakh(expected)} expected · {sorted.length} open
        </span>
      </div>
      <div className="panel-body" style={{ paddingTop: 4, paddingBottom: 6 }}>
        {shown.length === 0 ? (
          <div className="empty">Nothing outstanding</div>
        ) : (
          shown.map((inv) => {
            // The invoice is worth `amount`; a commitment is a separate,
            // possibly smaller promise. Showing the commitment as the invoice
            // contradicts the collection email one click away.
            const committed =
              typeof inv.committedAmount === "number" &&
              inv.committedAmount !== inv.amount
                ? inv.committedAmount
                : null;

            return (
              <div className="dept-row" key={inv.id}>
                <div className="dept-line">
                  <span className="dept-name">
                    {inv.customer}
                    {inv.sensitive ? (
                      <span className="rule-sev" style={{ marginLeft: 8 }}>
                        sensitive
                      </span>
                    ) : null}
                  </span>
                  <span className="dept-figures" style={{ color: "var(--text)" }}>
                    {lakh(inv.amount)}
                  </span>
                </div>
                <div
                  className="dept-line"
                  style={{ marginTop: 3, alignItems: "center" }}
                >
                  <span className="dept-figures">
                    {inv.id} · due {inv.dueDate} · lag {inv.customerAvgLagDays}d
                  </span>
                  <span className="chip-row">
                    {committed !== null ? (
                      <span className="chip" style={{ color: "var(--ok)" }}>
                        committed {lakh(committed)}
                        {inv.committedDate !== undefined
                          ? ` · ${shortDate(inv.committedDate)}`
                          : ""}
                      </span>
                    ) : null}
                    <span
                      className="chip"
                      style={{
                        color:
                          inv.status === "overdue"
                            ? "var(--danger)"
                            : inv.status === "committed"
                              ? "var(--ok)"
                              : "var(--text-2)",
                      }}
                    >
                      {inv.chasedAt !== null ? "chased · " : ""}
                      {inv.status}
                    </span>
                  </span>
                </div>
              </div>
            );
          })
        )}
        {hidden > 0 ? (
          <div className="more-row">+{hidden} more outstanding</div>
        ) : null}
      </div>
    </section>
  );
}

function BudgetsPanel({ departments }: { departments: Department[] }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Department Budgets</span>
        <span className="panel-note">quarter to date</span>
      </div>
      <div className="panel-body" style={{ paddingTop: 4, paddingBottom: 6 }}>
        {departments.map((d) => {
          const ratio = d.quarterlyBudget > 0 ? d.periodSpend / d.quarterlyBudget : 0;
          const fill =
            ratio > 1 ? "bar-fill-danger" : ratio > 0.85 ? "bar-fill-warn" : "";
          return (
            <div className="dept-row" key={d.id}>
              <div className="dept-line">
                <span className="dept-name">{d.name}</span>
                <span className="dept-figures">
                  <span style={{ color: "var(--text)" }}>
                    {lakh(d.periodSpend)}
                  </span>{" "}
                  / {lakh(d.quarterlyBudget)} · {percent(ratio)}
                </span>
              </div>
              <div className="bar">
                <div
                  className={`bar-fill ${fill}`}
                  style={{ width: `${Math.max(0, Math.min(100, ratio * 100))}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AuthorityPanel({ state }: { state: DashboardState }) {
  const r = state.company.rules;
  const headroom = state.forecast.headroom;
  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Delegated Authority</span>
        <span className="panel-note">CFO policy</span>
      </div>
      <div className="panel-body">
        <dl className="kv">
          <dt>max autonomous / request</dt>
          <dd>{rupees(r.maxAutonomousAmount)}</dd>

          <dt>min cash threshold</dt>
          <dd>{rupees(r.minCashThreshold)}</dd>

          <dt>max budget overage</dt>
          <dd>{percent(r.maxBudgetOverage)}</dd>

          <dt>vendor history required</dt>
          <dd>{r.requireVendorHistory ? "yes" : "no"}</dd>

          <dt>anomaly flag at</dt>
          <dd>{r.anomalyMultiplier.toFixed(1)}×</dd>

          <dt>reserved against headroom</dt>
          <dd>{rupees(state.reservedTotal)}</dd>

          <dt>{headroom < 0 ? "headroom deficit" : "headroom remaining"}</dt>
          <dd style={{ color: headroom <= 0 ? "var(--danger)" : "var(--ok)" }}>
            {headroom < 0
              ? `${rupees(Math.abs(headroom))} short`
              : rupees(headroom)}
          </dd>
        </dl>
      </div>
    </section>
  );
}

function ReplayPanel({ replay }: { replay: ReplayResult | null }) {
  if (replay === null) {
    return (
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Counterfactual Replay</span>
        </div>
        <div className="panel-body">
          <div className="empty">Not run</div>
        </div>
      </section>
    );
  }

  const rows = replay.rows ?? [];
  const fasterCount = replay.total - replay.flagged;

  // The agreements are the boring rows. Only the disagreements say anything.
  const disagreements = rows.filter((r) => !r.agreed);
  const shown = disagreements.slice(0, RAIL_ROW_CAP);
  const hidden = disagreements.length - shown.length;

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Counterfactual Replay</span>
        <span className="panel-note">{replay.total} historical requests</span>
      </div>
      <div className="panel-body">
        <div className="replay-figures">
          <div className="replay-fig">
            <div className="replay-fig-value" style={{ color: "var(--ok)" }}>
              {replay.agreed}
            </div>
            <div className="replay-fig-label">agreed</div>
          </div>
          <div className="replay-fig">
            <div className="replay-fig-value" style={{ color: "var(--warn)" }}>
              {replay.flagged}
            </div>
            <div className="replay-fig-label">flagged</div>
          </div>
          <div className="replay-fig">
            <div className="replay-fig-value" style={{ color: "var(--danger)" }}>
              {replay.flaggedThatWentOverBudget}
            </div>
            <div className="replay-fig-label">flagged · overran</div>
          </div>
        </div>

        <p className="replay-note" style={{ margin: 0 }}>
          Of the <b>{replay.flagged}</b> requests the agent would have handed
          back, <b>{replay.flaggedThatWentOverBudget}</b> subsequently exceeded
          their department budget. The remaining <b>{fasterCount}</b> would have
          been decided immediately, against an average human turnaround of{" "}
          <b>{formatDays(replay.averageHumanTurnaroundDays)}</b>.
        </p>

        <div style={{ marginTop: 12 }}>
          <div className="more-row" style={{ marginTop: 0, marginBottom: 4 }}>
            {disagreements.length === 0
              ? "Agent agreed with every historical decision"
              : `Disagreements (${disagreements.length})`}
          </div>

          {shown.map((row) => (
            <div className="dept-row" key={row.request.id}>
              <div className="dept-line">
                <span className="dept-name mono" style={{ fontSize: 12 }}>
                  {row.request.id} · {lakh(row.request.amount)} ·{" "}
                  {row.request.category.replace(/_/g, " ")}
                </span>
                <span className="dept-figures">
                  <span style={{ color: "var(--text-2)" }}>
                    human {row.request.humanDecision}
                  </span>
                  {" → "}
                  <span style={{ color: "var(--warn)" }}>
                    {row.agentOutcome.toLowerCase()}
                  </span>
                  {row.request.wentOverBudget ? (
                    <span style={{ color: "var(--danger)" }}> · overran</span>
                  ) : null}
                </span>
              </div>
            </div>
          ))}

          {hidden > 0 ? (
            <div className="more-row">+{hidden} more disagreements</div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function formatDays(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(1)} days` : "—";
}
