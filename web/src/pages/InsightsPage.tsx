/**
 * Insights — the counterfactual replay, presented honestly.
 *
 * Same engine, run over the fixture's prior-quarter request book. The page
 * shows the headline figures, the confusion matrix (with its empty half
 * labelled as empty), which rules did the flagging, the disagreement rows,
 * and — verbatim in spirit from the README — what none of it proves.
 */

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { DecisionOutcome, ReplayResult, RuleId } from "@shared/types";
import { postDemo } from "../api";
import { Empty, Panel } from "../components/Panel";
import { lakh, plural, ruleLabel } from "../format";
import type { PageProps } from "./types";

type ReplayRow = ReplayResult["rows"][number];

const CAPTION = "Real engine, synthetic fixture — a demonstration, not a validation.";

const DISAGREE_COLS =
  "92px minmax(110px, 1fr) minmax(120px, 1.2fr) 84px 84px 108px minmax(180px, 1.6fr) 110px";

export default function InsightsPage(props: PageProps) {
  const { state } = props;
  const replay = state.replay ?? null;

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  async function runReplay() {
    if (running) return;
    setRunning(true);
    setRunError(null);
    const res = await postDemo("replay");
    setRunning(false);
    if (!res.ok) setRunError(`${res.detail}${res.status ? ` (HTTP ${res.status})` : ""}`);
  }

  const runButton = (
    <button
      type="button"
      className={`btn btn-sm ${running ? "btn-pending" : "btn-why"}`}
      disabled={running}
      onClick={() => void runReplay()}
      title="POST /api/demo/replay — runs the live rule set over the historical fixture"
    >
      {running ? "Running…" : replay === null ? "Run replay" : "Run again"}
    </button>
  );

  if (replay === null) {
    return (
      <div className="page">
        <Panel title="Counterfactual replay" right={runButton}>
          <p className="replay-caption">{CAPTION}</p>
          <p className="replay-note" style={{ marginTop: 8, maxWidth: "80ch" }}>
            The replay runs the <b>live rule set</b> over the 47 prior-quarter requests in the
            fixture and produces a per-row comparison against what the humans decided. The
            numbers it prints are computed, not typed — but the fixture was written to produce
            them, so treat the result as proof that the engine can be pointed at historical data
            and made to explain itself, not as evidence that its judgement is good.
          </p>
          <p className="replay-note mt-2">
            Not run yet. Press <span className="key">d</span> → replay in the demo controls, or
            use the button above.
          </p>
          {runError !== null ? (
            <div className="inline-alert mt-2 mb-0" role="alert">
              <span className="inline-alert-title">Replay failed</span>
              <span className="inline-alert-body">{runError}</span>
            </div>
          ) : null}
        </Panel>
        <HonestyPanel />
      </div>
    );
  }

  return <ReplayView replay={replay} state={state} runButton={runButton} runError={runError} />;
}

// ---------------------------------------------------------------------------

function ReplayView({
  replay,
  state,
  runButton,
  runError,
}: {
  replay: ReplayResult;
  state: PageProps["state"];
  runButton: ReactNode;
  runError: string | null;
}) {
  const rows = replay.rows ?? [];
  const departments = state.departments ?? [];
  const vendors = state.vendors ?? [];

  const deptName = (id: string) => departments.find((d) => d.id === id)?.name ?? id;
  const vendorName = (id: string) => vendors.find((v) => v.id === id)?.name ?? id;

  // Confusion matrix, filled from rows rather than the summary counters so the
  // four cells always add up to what is actually on screen.
  const matrix = useMemo(() => {
    const m = { aa: 0, af: 0, ra: 0, rf: 0 };
    for (const r of rows) {
      const agentApproved = r.agentOutcome === "APPROVED";
      if (r.request.humanDecision === "approved") {
        if (agentApproved) m.aa += 1;
        else m.af += 1;
      } else if (agentApproved) {
        m.ra += 1;
      } else {
        m.rf += 1;
      }
    }
    return m;
  }, [rows]);
  const humanRejections = matrix.ra + matrix.rf;

  // Per-rule attribution across the flagged rows. A row failing two rules is
  // counted under both, so the bars can sum to more than the flagged count.
  const attribution = useMemo(() => {
    const counts = new Map<RuleId, number>();
    let flaggedRows = 0;
    for (const r of rows) {
      if (r.agentOutcome === "APPROVED") continue;
      flaggedRows += 1;
      for (const rule of r.failedRules ?? []) counts.set(rule, (counts.get(rule) ?? 0) + 1);
    }
    const list = [...counts.entries()]
      .map(([rule, count]) => ({ rule, count }))
      .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
    return { list, flaggedRows, max: list[0]?.count ?? 0 };
  }, [rows]);

  const disagreements = useMemo(
    () =>
      rows
        .filter((r) => !r.agreed)
        .sort(
          (a, b) =>
            outcomeRank(a.agentOutcome) - outcomeRank(b.agentOutcome) ||
            b.request.amount - a.request.amount ||
            a.request.id.localeCompare(b.request.id),
        ),
    [rows],
  );

  const turnaround = Number.isFinite(replay.averageHumanTurnaroundDays)
    ? `${replay.averageHumanTurnaroundDays.toFixed(1)} days`
    : "—";

  return (
    <div className="page">
      {/* 1. Headline figures */}
      <Panel
        title="Counterfactual replay"
        right={
          <>
            <span className="panel-note">{plural(replay.total, "historical request")}</span>
            {runButton}
          </>
        }
      >
        {runError !== null ? (
          <div className="inline-alert" role="alert">
            <span className="inline-alert-title">Replay failed</span>
            <span className="inline-alert-body">{runError} — showing the previous run.</span>
          </div>
        ) : null}
        <div className="replay-figures" style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}>
          <Fig value={String(replay.total)} label="replayed" tone="c-1" />
          <Fig value={String(replay.agreed)} label="agreed with human" tone="c-ok" />
          <Fig value={String(replay.flagged)} label="flagged for review" tone="c-warn" />
          <Fig
            value={String(replay.flaggedThatWentOverBudget)}
            label="flagged · went over budget (hand-set label)"
            tone="c-danger"
          />
          <Fig
            value={
              <>
                {turnaround}
                <span className="c-3 fs-3 mx-2">vs</span>
                <span className="c-accent">&lt; 1s</span>
              </>
            }
            label="avg human turnaround vs agent (fixture figure)"
            tone="c-1"
          />
        </div>
        <p className="replay-caption mt-3">
          {CAPTION}
        </p>
      </Panel>

      <div className="cols-2">
        {/* 2. Confusion matrix */}
        <Panel
          title="Confusion matrix"
          right={
            <span className="panel-note">
              {humanRejections === 0 ? "bottom row empty — fixture has no human rejections" : `${humanRejections} human rejections`}
            </span>
          }
        >
          <div className="matrix">
            <Axis>human ↓ · agent →</Axis>
            <Axis>agent approved</Axis>
            <Axis>agent flagged (escalated or rejected)</Axis>

            <Axis>human approved</Axis>
            <Cell value={matrix.aa} caption="co-approved — the only measurable agreement" tone="c-ok" />
            <Cell value={matrix.af} caption="agent would have handed back a spend a human waved through" tone="c-warn" />

            <Axis>human rejected</Axis>
            <Cell value={matrix.ra} caption="agent approved a spend a human refused (false negative)" tone="c-danger" />
            <Cell value={matrix.rf} caption="both said no" tone="c-1" />
          </div>
          <p className="replay-note mt-2">
            {humanRejections === 0 ? (
              <>
                All {replay.total} rows are <b>humanDecision: &quot;approved&quot;</b>. The bottom row
                is empty because the fixture contains no human rejections, not because the agent
                never misses one. There is no measurable false-negative rate here.
              </>
            ) : (
              <>
                {humanRejections} of {replay.total} rows carry a human rejection, so both halves
                of the matrix are populated.
              </>
            )}
          </p>
        </Panel>

        {/* 3. Per-rule attribution */}
        <Panel
          title="Which rules did the flagging"
          right={
            <span className="panel-note">
              {plural(attribution.flaggedRows, "flagged row")} · a row failing two rules counts under both
            </span>
          }
        >
          {attribution.list.length === 0 ? (
            <Empty>No rule failures — the agent approved every historical request</Empty>
          ) : (
            <div className="stack-2">
              {attribution.list.map((a) => {
                const pct = attribution.max > 0 ? (a.count / attribution.max) * 100 : 0;
                return (
                  <div key={a.rule}>
                    <div className="dept-line">
                      <span className="dept-name">
                        {ruleLabel(a.rule)}{" "}
                        <span className="mono c-3 fs-1">
                          {a.rule}
                        </span>
                      </span>
                      <span className="dept-figures">
                        <span className="mono c-1">
                          {a.count}
                        </span>{" "}
                        of {attribution.flaggedRows}
                      </span>
                    </div>
                    <div
                      className="bar bar-lg"
                      role="img"
                      aria-label={`${ruleLabel(a.rule)}: ${a.count} of ${attribution.flaggedRows} flagged rows`}
                    >
                      <div className="bar-fill bar-fill-warn" style={{ width: `${pct.toFixed(1)}%` }} />
                    </div>
                  </div>
                );
              })}
              <p className="replay-note mt-1">
                Cash rules (<span className="mono">min_cash_threshold</span>,{" "}
                <span className="mono">headroom_check</span>) are neutralised in replay — the
                historical cash position is not reconstructable. The budget rule is not
                neutralised; see below.
              </p>
            </div>
          )}
        </Panel>
      </div>

      {/* 4. Disagreement table */}
      <Panel
        title="Disagreements"
        bodyClassName="panel-body-flush"
        right={
          <span className="panel-note">
            {disagreements.length === 0
              ? "agent agreed with every historical decision"
              : `${plural(disagreements.length, "row")} where the agent and the human differed`}
          </span>
        }
      >
        {disagreements.length === 0 ? (
          <Empty>No disagreements to attribute</Empty>
        ) : (
          <div className="tbl scroll-x">
            <div className="tbl-head" style={{ gridTemplateColumns: DISAGREE_COLS }} aria-hidden="true">
              <span>request</span>
              <span>department</span>
              <span>vendor</span>
              <span className="tbl-right">amount</span>
              <span>human</span>
              <span>agent</span>
              <span>failed rules</span>
              <span>over budget</span>
            </div>
            {disagreements.map((r) => (
              <DisagreementRow key={r.request.id} row={r} deptName={deptName} vendorName={vendorName} />
            ))}
          </div>
        )}
      </Panel>

      {/* 5. What this does not show */}
      <HonestyPanel />
    </div>
  );
}

function DisagreementRow({
  row,
  deptName,
  vendorName,
}: {
  row: ReplayRow;
  deptName: (id: string) => string;
  vendorName: (id: string) => string;
}) {
  const failed = row.failedRules ?? [];
  return (
    <div className="tbl-row" style={{ gridTemplateColumns: DISAGREE_COLS }}>
      <span className="mono tbl-dim">{row.request.id}</span>
      <span className="tbl-ellipsis">{deptName(row.request.departmentId)}</span>
      <span className="tbl-ellipsis">{vendorName(row.request.vendorId)}</span>
      <span className="mono tbl-right">{lakh(row.request.amount)}</span>
      <span className="tbl-dim">{row.request.humanDecision}</span>
      <span>
        <span className={`outcome outcome-${row.agentOutcome}`}>{row.agentOutcome}</span>
      </span>
      <span className="chip-row" style={{ justifyContent: "flex-start" }}>
        {failed.length === 0 ? (
          <span className="tbl-dim">none recorded</span>
        ) : (
          failed.map((rule) => (
            <span className="chip" key={rule} title={rule}>
              {ruleLabel(rule)}
            </span>
          ))
        )}
      </span>
      <span>
        {row.request.wentOverBudget ? (
          <span className="chip chip-danger">yes</span>
        ) : (
          <span className="tbl-dim">no</span>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------

function HonestyPanel() {
  return (
    <Panel
      title="What this does not show"
      right={<span className="panel-note">all of it checkable in src/db/seed.ts</span>}
    >
      <ul className="ul stack-2 c-1">
        <li>
          <b>There are no human rejections.</b> All 47 rows are{" "}
          <span className="mono">humanDecision: &quot;approved&quot;</span>. &quot;Agreement&quot; can
          therefore only ever mean co-approval, and half the confusion matrix — the cases where a
          human said no — does not exist. There is no measurable false-negative rate.
        </li>
        <li>
          <b>Recall is 100% by construction.</b> The six rows the engine flags are exactly the six
          the fixture&apos;s own comment calls &quot;the six the agent should catch&quot;. They were
          written to exceed 2× their category average, and every one also exceeds the ₹5L
          authority ceiling, so they would be flagged on amount alone even with the anomaly rule
          switched off.
        </li>
        <li>
          <b>
            <span className="mono">wentOverBudget</span> is a hand-typed boolean.
          </b>{" "}
          It is not derived from any budget computation and has no causal link to one. The
          &quot;4 of 6&quot; figure is the four rows labelled <span className="mono">true</span> being
          counted back out.
        </li>
        <li>
          <b>The budget rule is evaluated against a seeded budget position, not a reconstructed
          historical one.</b>{" "}
          The replay neutralises the cash rules because the historical cash position is not
          reconstructable, but <span className="mono">budget_overage</span> is still evaluated
          against each department&apos;s seeded <span className="mono">periodSpend</span> for all
          47 prior-quarter rows — the same class of problem. Three of the six flags are REJECTs
          produced this way.
        </li>
        <li>
          <b>The human turnaround figure is a fixture.</b> The reported average is the mean of a
          hand-set <span className="mono">turnaroundDays</span> field. &quot;&lt; 1s&quot; for the agent
          is real; the comparison is not.
        </li>
      </ul>
      <p className="replay-note mt-3">
        <b>Why it is still here:</b> it is the same engine, it runs over data it did not decide,
        and every row opens to the rules that produced the outcome. That is the shape of a real
        validation harness. It is not a validation.
      </p>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

function Fig({ value, label, tone }: { value: ReactNode; label: string; tone: string }) {
  return (
    <div className="replay-fig">
      <div className={`replay-fig-value nowrap ${tone}`}>
        {value}
      </div>
      <div className="replay-fig-label">{label}</div>
    </div>
  );
}

function Axis({ children }: { children: ReactNode }) {
  return (
    <div className="stat-label matrix-axis">
      {children}
    </div>
  );
}

function Cell({ value, caption, tone }: { value: number; caption: string; tone: string }) {
  const empty = value === 0;
  return (
    <div className="replay-fig" style={{ minHeight: 78 }}>
      <div className={`replay-fig-value ${empty ? "c-3" : tone}`}>
        {empty ? "0 — empty" : value}
      </div>
      <div className="replay-fig-label fs-1">
        {empty ? `no rows in this cell · ${caption}` : caption}
      </div>
    </div>
  );
}

function outcomeRank(o: DecisionOutcome): number {
  switch (o) {
    case "REJECTED":
      return 0;
    case "ESCALATED":
      return 1;
    default:
      return 2;
  }
}
