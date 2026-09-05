import { useState } from "react";
import type {
  DashboardState,
  Department,
  Invoice,
  ReplayResult,
} from "@shared/types";
import { useDashboardState } from "./api";
import { clock, lakh, percent, rupees, stamp } from "./format";
import { StatHeader } from "./components/StatHeader";
import { ForecastChart } from "./components/ForecastChart";
import { ActivityLog } from "./components/ActivityLog";
import { EscalationCard } from "./components/EscalationCard";
import { DecisionDetail } from "./components/DecisionDetail";
import { EmailPreview } from "./components/EmailPreview";
import { DemoControls } from "./components/DemoControls";

export default function App() {
  const { state, usingMock, loading, lastUpdated } = useDashboardState();

  // Modals hold ids, not snapshots, so an open record keeps tracking the poll.
  const [decisionId, setDecisionId] = useState<string | null>(null);
  const [emailId, setEmailId] = useState<string | null>(null);

  const openDecision =
    state.decisions.find((d) => d.decision.id === decisionId) ?? null;
  const openEmail = state.emails.find((e) => e.id === emailId) ?? null;

  if (loading && usingMock) {
    return <div className="boot">Loading state…</div>;
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
            <span className="badge badge-mock" title="GET /api/state unreachable">
              <i className="dot" />
              Fixture data
            </span>
          ) : (
            <span className="badge badge-live">
              <i className="dot dot-pulse" />
              Live · {lastUpdated === null ? "—" : clock(new Date(lastUpdated).toISOString())}
            </span>
          )}
        </div>
      </header>

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
          <EscalationsPanel
            state={state}
            onAskWhy={(id) => setDecisionId(id)}
          />
          <ReceivablesPanel invoices={state.invoices} />
          <BudgetsPanel departments={state.departments} />
          <AuthorityPanel state={state} />
          <ReplayPanel replay={state.replay} />
        </div>
      </div>

      {openDecision ? (
        <DecisionDetail view={openDecision} onClose={() => setDecisionId(null)} />
      ) : null}

      {openEmail ? (
        <EmailPreview email={openEmail} onClose={() => setEmailId(null)} />
      ) : null}

      <DemoControls />
    </div>
  );
}

// ---------------------------------------------------------------------------

function EscalationsPanel({
  state,
  onAskWhy,
}: {
  state: DashboardState;
  onAskWhy: (decisionId: string) => void;
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
              onAskWhy={(v) => onAskWhy(v.decision.id)}
            />
          ))
        )}
      </div>
    </section>
  );
}

function ReceivablesPanel({ invoices }: { invoices: Invoice[] }) {
  const outstanding = invoices
    .filter((i) => i.status !== "paid")
    .reduce((sum, i) => sum + (i.committedAmount ?? i.amount), 0);

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Receivables</span>
        <span className="panel-note">{lakh(outstanding)} outstanding</span>
      </div>
      <div className="panel-body" style={{ paddingTop: 4, paddingBottom: 6 }}>
        {invoices.map((inv) => (
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
                {lakh(inv.committedAmount ?? inv.amount)}
              </span>
            </div>
            <div
              className="dept-line"
              style={{ marginTop: 3, alignItems: "center" }}
            >
              <span className="dept-figures">
                {inv.id} · due {inv.dueDate} · lag {inv.customerAvgLagDays}d
              </span>
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
            </div>
          </div>
        ))}
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
                  style={{ width: `${Math.min(100, ratio * 100)}%` }}
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

          <dt>headroom remaining</dt>
          <dd
            style={{
              color:
                state.forecast.headroom <= 0 ? "var(--danger)" : "var(--ok)",
            }}
          >
            {rupees(state.forecast.headroom)}
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

  const fasterCount = replay.total - replay.flagged;

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
          <b>{replay.averageHumanTurnaroundDays.toFixed(1)} days</b>.
        </p>

        <div style={{ marginTop: 12 }}>
          {replay.rows.map((row) => (
            <div className="dept-row" key={row.request.id}>
              <div className="dept-line">
                <span className="dept-name mono" style={{ fontSize: 12 }}>
                  {row.request.id} · {lakh(row.request.amount)} ·{" "}
                  {row.request.category.replace(/_/g, " ")}
                </span>
                <span className="dept-figures">
                  <span style={{ color: "var(--text-3)" }}>
                    human {row.request.humanDecision}
                  </span>
                  {" → "}
                  <span
                    style={{
                      color: row.agreed ? "var(--ok)" : "var(--warn)",
                    }}
                  >
                    {row.agentOutcome.toLowerCase()}
                  </span>
                  {row.request.wentOverBudget ? (
                    <span style={{ color: "var(--danger)" }}> · overran</span>
                  ) : null}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
