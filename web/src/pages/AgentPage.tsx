/**
 * Agent — the operator's console (suggestions.md §2.7).
 *
 * The switch that lets it act, the heartbeat that proves it is running when
 * nobody is watching, the log of every firing including the quiet ones, and
 * the plain statement of what it may do alone, what it hands back, and what
 * it never does.
 */

import { useEffect, useRef, useState } from "react";
import type { AgentRun, CollectionPlan } from "@shared/types";
import { setAutonomy } from "../api";
import { clock, lakh, plural, rupees, stamp, weekLabel } from "../format";
import { Empty, Panel } from "../components/Panel";
import { clamp01, duration, useNow, useWide } from "../lib/spendHelpers";
import type { PageProps } from "./types";

const RUN_ROW_CAP = 40;

export default function AgentPage(props: PageProps) {
  const { state } = props;
  const wide = useWide(1400);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: wide ? "minmax(0, 5fr) minmax(0, 7fr)" : "minmax(0, 1fr)",
        gap: "var(--gap)",
        alignItems: "start",
      }}
    >
      <div className="stack" style={{ minWidth: 0 }}>
        <AutonomySwitch {...props} />
        <Heartbeat {...props} />
        <Providers {...props} />
        <Guardrails {...props} />
      </div>
      <div className="stack" style={{ minWidth: 0 }}>
        <RunLog runs={state.agent.runs} />
        <Capabilities />
        <LastPlan plan={state.lastCollectionPlan} horizonBreach={state.forecast.breachWeek} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Autonomy switch
// ---------------------------------------------------------------------------

function AutonomySwitch({ state }: PageProps) {
  const enabled = state.agent.autonomyEnabled;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Optimistic target so the switch does not flicker back before the poll lands.
  const [target, setTarget] = useState<boolean | null>(null);
  const lock = useRef(false);

  useEffect(() => {
    if (target !== null && target === enabled) setTarget(null);
  }, [enabled, target]);

  async function toggle(): Promise<void> {
    if (lock.current) return;
    lock.current = true;
    const next = !enabled;
    setPending(true);
    setError(null);
    setTarget(next);
    const res = await setAutonomy(next);
    setPending(false);
    lock.current = false;
    if (!res.ok) {
      setTarget(null);
      setError(res.error ?? `HTTP ${res.status}`);
    }
  }

  const shown = target ?? enabled;

  return (
    <Panel
      title="Autonomy"
      className="panel-auto"
      right={
        shown ? (
          <span className="badge badge-agent">
            <i className="dot dot-pulse" />
            acting
          </span>
        ) : (
          <span className="badge badge-mock">
            <i className="dot" />
            paused
          </span>
        )
      }
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <button
          type="button"
          role="switch"
          aria-checked={shown}
          aria-busy={pending}
          disabled={pending}
          onClick={() => void toggle()}
          className={`btn${pending ? " btn-pending" : shown ? " btn-why" : ""}`}
          title={shown ? "Pause the agent" : "Let the agent act"}
          style={{
            width: 132,
            height: 52,
            padding: 0,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            alignItems: "stretch",
            fontFamily: "var(--mono)",
            fontSize: 12,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            flex: "none",
          }}
        >
          <span
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: shown ? "var(--agent)" : "transparent",
              color: shown ? "var(--bg)" : "var(--text-3)",
              fontWeight: 700,
            }}
          >
            {pending ? "…" : "ON"}
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: shown ? "transparent" : "var(--line-strong)",
              color: shown ? "var(--text-3)" : "var(--text)",
              fontWeight: 700,
            }}
          >
            {pending ? "…" : "OFF"}
          </span>
        </button>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, color: "var(--text)", fontWeight: 600 }}>
            {shown ? "Acting" : "Paused"}
          </div>
          <div style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.45 }}>
            {shown
              ? "Will chase receivables on its own when the forecast breaches."
              : "Forecasts and detects, does not act."}
          </div>
        </div>
      </div>

      {error !== null ? (
        <div className="inline-alert" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
          <span className="inline-alert-title">Not changed</span>
          <span className="inline-alert-body">{error}</span>
        </div>
      ) : null}

      <p className="principle">
        Spend decisions are unaffected by this switch — the rules engine always answers. Only the
        outbound collection loop is paused.
      </p>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 2. Heartbeat
// ---------------------------------------------------------------------------

function Heartbeat({ state }: PageProps) {
  const { agent } = state;
  const now = useNow(250);
  const next = agent.nextAlarmAt === null ? null : Date.parse(agent.nextAlarmAt);
  const interval = Math.max(1, agent.intervalMs);
  const remaining = next === null || Number.isNaN(next) ? null : next - now;
  const progress = remaining === null ? 0 : clamp01(1 - remaining / interval);
  const last = agent.runs[0];

  return (
    <Panel
      title="Heartbeat"
      className="panel-auto"
      right={<span className="panel-note">every {duration(interval)}</span>}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <Ring progress={progress} idle={remaining === null} overdue={remaining !== null && remaining < 0} />
        <dl className="kv kv-tight" style={{ flex: 1, minWidth: 0 }}>
          <dt>next wake</dt>
          <dd>
            {remaining === null ? (
              <span style={{ color: "var(--warn)" }}>not scheduled</span>
            ) : remaining < 0 ? (
              <span style={{ color: "var(--warn)" }}>firing · {duration(-remaining)} late</span>
            ) : (
              `in ${duration(remaining)}`
            )}
          </dd>
          <dt>interval</dt>
          <dd>{duration(interval)}</dd>
          <dt>last run</dt>
          <dd>{last ? clock(last.at) : agent.lastRunAt ? clock(agent.lastRunAt) : "never"}</dd>
          <dt>last outcome</dt>
          <dd>{last ? <OutcomeChip run={last} /> : "—"}</dd>
        </dl>
      </div>
      <div className="state-delta" style={{ marginTop: 10 }}>
        {remaining === null
          ? "No alarm is set on the Durable Object. The loop only runs when something schedules it."
          : "The Durable Object alarm wakes the agent on its own — no browser, no cron, no human in the loop."}
      </div>
    </Panel>
  );
}

function Ring({ progress, idle, overdue }: { progress: number; idle: boolean; overdue: boolean }) {
  const size = 68;
  const stroke = 6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = c * clamp01(progress);
  const colour = idle ? "var(--text-3)" : overdue ? "var(--warn)" : "var(--agent)";
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={idle ? "No alarm scheduled" : `${Math.round(progress * 100)}% of the interval elapsed`}
      style={{ flex: "none" }}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-strong)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={colour}
        strokeWidth={stroke}
        strokeLinecap="butt"
        strokeDasharray={`${dash} ${c - dash}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dasharray 250ms linear" }}
      />
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        fill="var(--text)"
        style={{ fontFamily: "var(--mono)", fontSize: 12, fontWeight: 600 }}
      >
        {idle ? "—" : `${Math.round(progress * 100)}%`}
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 3. Run log
// ---------------------------------------------------------------------------

const RUN_COLUMNS = "62px 64px 84px 84px 68px minmax(0, 1fr)";

function RunLog({ runs }: { runs: AgentRun[] }) {
  const shown = runs.slice(0, RUN_ROW_CAP);
  const hidden = runs.length - shown.length;
  const alarms = runs.filter((r) => r.trigger === "alarm").length;

  return (
    <Panel
      title="Run Log"
      className="panel-auto"
      bodyClassName="panel-body-flush"
      right={
        <span className="panel-note">
          {plural(runs.length, "firing")} · {alarms} by alarm · proof the loop runs when nobody is watching
        </span>
      }
    >
      {shown.length === 0 ? (
        <Empty>No runs recorded yet — the first alarm has not fired.</Empty>
      ) : (
        <div className="tbl">
          <div className="tbl-head" style={{ gridTemplateColumns: RUN_COLUMNS }} aria-hidden="true">
            <span>time</span>
            <span>trigger</span>
            <span className="tbl-right">proj. min</span>
            <span className="tbl-right">headroom</span>
            <span>breach</span>
            <span>outcome</span>
          </div>
          {shown.map((run, i) => (
            <div
              key={`${run.at}-${i}`}
              className="tbl-row"
              style={{ gridTemplateColumns: RUN_COLUMNS, fontSize: 12 }}
              title={stamp(run.at)}
            >
              <span className="mono tbl-dim">{clock(run.at)}</span>
              <span>
                {run.trigger === "alarm" ? (
                  <span className="tag-agent" style={{ fontSize: 10 }}>ALARM</span>
                ) : (
                  <span className="tag-human" style={{ fontSize: 10 }}>MANUAL</span>
                )}
              </span>
              <span className="mono tbl-right">{lakh(run.projectedMinimum)}</span>
              <span className="mono tbl-right" style={{ color: run.headroom < 0 ? "var(--danger)" : undefined }}>
                {lakh(run.headroom)}
              </span>
              <span className="mono tbl-dim">{run.breachWeek === null ? "none" : `wk ${run.breachWeek}`}</span>
              <span>
                <OutcomeChip run={run} />
              </span>
            </div>
          ))}
          {hidden > 0 ? <div className="more-row">{hidden} more</div> : null}
        </div>
      )}
    </Panel>
  );
}

function OutcomeChip({ run }: { run: AgentRun }) {
  switch (run.outcome) {
    case "healthy":
      return <span className="log-chip log-chip-ok">healthy</span>;
    case "chased":
      return (
        <span className="log-chip log-chip-agent">
          chased {run.chased !== undefined ? lakh(run.chased) : ""}
        </span>
      );
    case "waiting_on_replies":
      return <span className="log-chip log-chip-warn">waiting on replies</span>;
    case "no_targets":
      return <span className="log-chip log-chip-danger">no targets</span>;
    case "disabled":
      return <span className="log-chip">disabled</span>;
    case "stale":
      return <span className="log-chip log-chip-warn">stale</span>;
    default:
      return <span className="log-chip">{String(run.outcome).replace(/_/g, " ")}</span>;
  }
}

// ---------------------------------------------------------------------------
// 4. Capabilities matrix
// ---------------------------------------------------------------------------

const CAPABILITIES: Array<{ title: string; tone: "ok" | "warn" | "danger"; items: string[] }> = [
  {
    title: "Acts alone",
    tone: "ok",
    items: [
      "Re-forecast the horizon on every wake",
      "Detect a breach of the safety threshold",
      "Rank overdue receivables by what lands before the breach",
      "Send collection emails to non-sensitive accounts",
      "Approve spend within its authority and headroom",
    ],
  },
  {
    title: "Hands back",
    tone: "warn",
    items: [
      "Relationship-sensitive accounts",
      "Requests over the per-request ceiling or the rolling pool",
      "Requests the headroom cannot absorb",
      "Amounts anomalous against the category's history",
      "First-time vendors",
    ],
  },
  {
    title: "Never",
    tone: "danger",
    items: [
      "Initiate an outbound payment",
      "Contact a sensitive account",
      "Approve a hard-rule violation",
      "Decide via a language model",
    ],
  },
];

function Capabilities() {
  return (
    <Panel title="Capabilities" className="panel-auto" right={<span className="panel-note">autonomy bounded by reversibility</span>}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 14 }}>
        {CAPABILITIES.map((col) => (
          <div key={col.title} style={{ minWidth: 0 }}>
            <span className={`log-chip log-chip-${col.tone === "ok" ? "ok" : col.tone === "warn" ? "warn" : "danger"}`}>
              {col.title}
            </span>
            <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "grid", gap: 5 }}>
              {col.items.map((item) => (
                <li
                  key={item}
                  style={{
                    fontSize: 12.5,
                    lineHeight: 1.4,
                    color: "var(--text)",
                    paddingLeft: 12,
                    position: "relative",
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="mono"
                    style={{ position: "absolute", left: 0, color: "var(--text-3)" }}
                  >
                    {col.tone === "ok" ? "+" : col.tone === "warn" ? ">" : "x"}
                  </span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="principle">
        Everything the agent does alone is reversible or a request; everything irreversible needs a
        human.
      </p>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 5. Providers
// ---------------------------------------------------------------------------

function Providers({ state }: PageProps) {
  const { emailProvider, llmProvider } = state.agent;
  const emailReal = emailProvider !== "simulated";
  const llmOff = llmProvider === "none";

  return (
    <Panel title="Providers" className="panel-auto">
      <dl className="kv kv-tight">
        <dt>email</dt>
        <dd>
          <span className={`log-chip ${emailReal ? "log-chip-agent" : ""}`}>{emailProvider}</span>
        </dd>
        <dt>narration model</dt>
        <dd>
          <span className={`log-chip ${llmOff ? "" : "log-chip-agent"}`}>{llmOff ? "none · deterministic" : llmProvider}</span>
        </dd>
      </dl>
      <div className="state-delta" style={{ marginTop: 8, lineHeight: 1.5 }}>
        {emailReal
          ? `Collection emails are transmitted through ${emailProvider}. Every send is still retained here for review.`
          : "Collection emails are rendered to the activity log, not transmitted. Same template, same timing, nothing leaves the building."}
      </div>
      <div className="state-delta" style={{ marginTop: 4, lineHeight: 1.5 }}>
        {llmOff
          ? "No language model is configured. Every narration you read is the engine's own deterministic explanation — the decision itself never depends on a model either way."
          : `${llmProvider} restates decisions the engine has already made. If it fails, the deterministic narration is shown instead; the decision is unaffected.`}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 6. Guardrails
// ---------------------------------------------------------------------------

function Guardrails({ state }: PageProps) {
  const g = state.agent.guardrails;
  return (
    <Panel title="Guardrails" className="panel-auto" right={<span className="panel-note">read-only</span>}>
      <dl className="kv kv-tight">
        <dt>cooldown</dt>
        <dd>{plural(g.cooldownDays, "day")}</dd>
        <dt>max targets per run</dt>
        <dd>{g.maxTargets}</dd>
        <dt>coverage factor</dt>
        <dd>{g.coverageFactor.toFixed(2)}×</dd>
      </dl>
      <ul style={{ margin: "8px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 4 }}>
        <li className="state-delta">
          Cooldown — a customer chased in the last {plural(g.cooldownDays, "day")} is not chased again, whatever the gap.
        </li>
        <li className="state-delta">
          Max targets — at most {g.maxTargets} emails per firing, so one bad forecast cannot carpet-bomb the customer base.
        </li>
        <li className="state-delta">
          Coverage — it stops ranking once expected recoveries reach {g.coverageFactor.toFixed(2)}× the shortfall, rather than chasing everyone.
        </li>
      </ul>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 7. Last collection plan
// ---------------------------------------------------------------------------

const PLAN_COLUMNS = "72px minmax(0, 1.1fr) 72px 56px 52px 64px 48px";

function LastPlan({ plan, horizonBreach }: { plan: CollectionPlan | null; horizonBreach: number | null }) {
  if (plan === null) {
    return (
      <Panel title="Last defence — what it chose and why" className="panel-auto" bodyClassName="panel-body-flush">
        <Empty>No collection plan yet — the agent has not had to defend the forecast.</Empty>
      </Panel>
    );
  }

  const targets = plan.targets;
  const skipped = plan.skipped;

  return (
    <Panel
      title="Last defence — what it chose and why"
      className="panel-auto"
      bodyClassName="panel-body-flush"
      right={
        <span className="panel-note">
          gap {lakh(plan.gap)} · chased {lakh(plan.totalChased)} ·{" "}
          {plan.breachWeek === null ? "no breach" : weekLabel(plan.breachWeek)}
          {horizonBreach === null && plan.breachWeek !== null ? " · since cleared" : ""}
        </span>
      }
    >
      {targets.length === 0 ? (
        <Empty>It chose nobody — every candidate was skipped (see below).</Empty>
      ) : (
        <div className="tbl">
          <div className="tbl-head" style={{ gridTemplateColumns: PLAN_COLUMNS }} aria-hidden="true">
            <span>invoice</span>
            <span>customer</span>
            <span className="tbl-right">amount</span>
            <span className="tbl-right">overdue</span>
            <span>lands</span>
            <span>before breach</span>
            <span className="tbl-right">score</span>
          </div>
          {targets.map((t, rank) => (
            <div key={t.invoice.id} style={{ borderBottom: "1px solid var(--line)" }}>
              <div
                className="tbl-row"
                style={{ gridTemplateColumns: PLAN_COLUMNS, fontSize: 12, borderBottom: "none" }}
                title={`rank ${rank + 1} · ${t.invoice.customerEmail} · due ${t.invoice.dueDate}`}
              >
                <span className="mono tbl-dim">{t.invoice.id}</span>
                <span className="tbl-ellipsis">
                  <span className="mono tbl-dim" style={{ marginRight: 6 }}>
                    #{rank + 1}
                  </span>
                  {t.invoice.customer}
                  {t.invoice.sensitive ? <span className="rule-sev">sensitive</span> : null}
                </span>
                <span className="mono tbl-right">{lakh(t.invoice.amount)}</span>
                <span className="mono tbl-right">{t.daysOverdue}d</span>
                <span className="mono tbl-dim">wk {t.expectedArrivalWeek}</span>
                <span>
                  {t.landsBeforeBreach ? (
                    <span className="log-chip log-chip-ok">yes</span>
                  ) : (
                    <span className="log-chip log-chip-warn">no</span>
                  )}
                </span>
                <span className="mono tbl-right">{t.score.toFixed(2)}</span>
              </div>
              <div className="state-delta" style={{ padding: "0 14px 7px", lineHeight: 1.45 }}>
                {t.rationale}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="more-row">
        skipped · {plural(skipped.length, "invoice")}
      </div>
      {skipped.length === 0 ? (
        <Empty>Nothing skipped.</Empty>
      ) : (
        <div className="tbl">
          {skipped.map((s) => (
            <div
              key={s.invoiceId}
              className="tbl-row"
              style={{ gridTemplateColumns: "72px minmax(0, 1fr)", fontSize: 12 }}
            >
              <span className="mono tbl-dim">{s.invoiceId}</span>
              <span className="tbl-dim">{s.reason}</span>
            </div>
          ))}
        </div>
      )}
      <div className="state-delta" style={{ padding: "8px 14px 10px" }}>
        Ranked by amount that lands before the breach, not by size. Total chased {rupees(plan.totalChased)}{" "}
        against a {rupees(plan.gap)} gap.
      </div>
    </Panel>
  );
}
