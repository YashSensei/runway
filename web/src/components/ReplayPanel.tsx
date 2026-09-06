import type { ReplayResult } from "@shared/types";
import { lakh, plural } from "../format";
import { Panel } from "./Panel";

/** Disagreement rows past this collapse into "+N more". */
const ROW_CAP = 6;

/**
 * Counterfactual replay of the historical request book through the live
 * engine. Collapsed to a single strip until it has been run.
 */
export function ReplayPanel({ replay }: { replay: ReplayResult | null }) {
  if (replay === null) {
    // One 48px strip: title, message and status on a single line.
    return (
      <section className="panel panel-strip">
        <div className="panel-head">
          <span className="panel-title">Counterfactual Replay</span>
          <span className="strip-msg">
            Not run — press <span className="key">d</span> → replay to score the agent
            against the historical decision book.
          </span>
          <span className="panel-right">
            <span className="panel-note">not run</span>
          </span>
        </div>
      </section>
    );
  }

  const rows = replay.rows ?? [];
  const fasterCount = Math.max(0, replay.total - replay.flagged);

  // The agreements are the boring rows. Only the disagreements say anything.
  const disagreements = rows.filter((r) => !r.agreed);
  const shown = disagreements.slice(0, ROW_CAP);
  const hidden = disagreements.length - shown.length;

  return (
    <Panel
      title="Counterfactual replay"
      right={
        <span className="panel-note">
          {plural(replay.total, "historical request")} · avg human turnaround{" "}
          {formatDays(replay.averageHumanTurnaroundDays)}
        </span>
      }
    >
      <div className="replay">
        <div className="replay-figures">
          <Fig value={replay.total} label="replayed" tone="var(--text)" />
          <Fig value={replay.agreed} label="agreed with human" tone="var(--ok)" />
          <Fig value={replay.flagged} label="flagged for review" tone="var(--warn)" />
          <Fig
            value={replay.flaggedThatWentOverBudget}
            label="flagged · went over budget"
            tone="var(--danger)"
          />
        </div>

        <div className="replay-side">
          <p className="replay-caption">
            Real engine, synthetic fixture — a demonstration, not a validation.
          </p>
          <p className="replay-note">
            Of the <b>{replay.flagged}</b> requests the agent would have handed back,{" "}
            <b>{replay.flaggedThatWentOverBudget}</b> subsequently exceeded their department
            budget. The remaining <b>{fasterCount}</b> would have been decided immediately.
          </p>
        </div>
      </div>

      <div className="tbl replay-tbl">
        <div className="tbl-head rep-row" aria-hidden="true">
          <span>
            {disagreements.length === 0
              ? "agent agreed with every historical decision"
              : plural(disagreements.length, "disagreement")}
          </span>
          <span className="tbl-right">amount</span>
          <span>category</span>
          <span>human</span>
          <span>agent</span>
          <span>outcome</span>
        </div>
        {shown.map((row) => (
          <div className="tbl-row rep-row" key={row.request.id}>
            <span className="mono tbl-dim">{row.request.id}</span>
            <span className="mono tbl-right">{lakh(row.request.amount)}</span>
            <span className="tbl-ellipsis">{row.request.category.replace(/_/g, " ")}</span>
            <span className="tbl-dim">{row.request.humanDecision}</span>
            <span>
              <span className={`outcome outcome-${row.agentOutcome}`}>{row.agentOutcome}</span>
            </span>
            <span>
              {row.request.wentOverBudget ? (
                <span className="outcome outcome-REJECTED">went over budget</span>
              ) : (
                <span className="tbl-dim">stayed within budget</span>
              )}
            </span>
          </div>
        ))}
        {hidden > 0 ? (
          <div className="more-row">+{hidden} more disagreements</div>
        ) : null}
      </div>
    </Panel>
  );
}

function Fig({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <div className="replay-fig">
      <div className="replay-fig-value" style={{ color: tone }}>
        {Number.isFinite(value) ? value : "—"}
      </div>
      <div className="replay-fig-label">{label}</div>
    </div>
  );
}

function formatDays(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(1)} days` : "—";
}
