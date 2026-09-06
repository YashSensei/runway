import type { DecisionOutcome, DecisionView } from "@shared/types";
import { clock, lakh, plural, reasonLabel } from "../format";
import { Empty, Panel } from "./Panel";

interface Props {
  decisions: DecisionView[];
  onOpen: (decisionId: string) => void;
}

/** The audit trail, one dense row per decision, newest first. */
export function DecisionsPanel({ decisions, onOpen }: Props) {
  const ordered = [...decisions].sort(
    (a, b) =>
      Date.parse(b.decision.createdAt) - Date.parse(a.decision.createdAt) ||
      b.decision.id.localeCompare(a.decision.id),
  );

  const counts: Record<DecisionOutcome, number> = {
    APPROVED: 0,
    ESCALATED: 0,
    REJECTED: 0,
  };
  for (const d of ordered) counts[d.decision.outcome] += 1;

  return (
    <Panel
      title="Decisions"
      tier="reference"
      className="panel-fill"
      bodyClassName="panel-body-flush"
      right={
        <>
          {ordered.length > 0 ? (
            <span className="chip-row">
              {counts.APPROVED > 0 ? (
                <span className="chip chip-ok">{counts.APPROVED} approved</span>
              ) : null}
              {counts.ESCALATED > 0 ? (
                <span className="chip chip-warn">
                  {counts.ESCALATED} escalated
                </span>
              ) : null}
              {counts.REJECTED > 0 ? (
                <span className="chip chip-danger">{counts.REJECTED} rejected</span>
              ) : null}
            </span>
          ) : null}
          <span className="panel-note">{plural(ordered.length, "decision")}</span>
        </>
      }
    >
      {ordered.length === 0 ? (
        <Empty>No decisions yet</Empty>
      ) : (
        <div className="tbl">
          <div className="tbl-head dec-row" aria-hidden="true">
            <span>time</span>
            <span>department</span>
            <span className="tbl-right">amount</span>
            <span>outcome</span>
            <span>reason</span>
          </div>
          {ordered.map((v) => (
            <button
              key={v.decision.id}
              type="button"
              className="tbl-row dec-row"
              onClick={() => onOpen(v.decision.id)}
              title={`${v.decision.id} · ${v.request.id} · open audit record`}
            >
              <span className="mono tbl-dim">{clock(v.decision.createdAt)}</span>
              <span className="tbl-ellipsis">{v.departmentName}</span>
              <span className="mono tbl-right">{lakh(v.request.amount)}</span>
              <span>
                <span className={`outcome outcome-${v.decision.outcome}`}>
                  {v.decision.outcome}
                </span>
              </span>
              <span className="tbl-ellipsis tbl-dim">
                {reasonLabel(v.decision.reasonCode)}
              </span>
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}
