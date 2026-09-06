import type { DecisionView, RuleEvaluation } from "@shared/types";
import { lakh, reasonLabel, ruleLabel, rupees, stamp } from "../format";
import { Modal } from "./Modal";

// ---------------------------------------------------------------------------
// Ordinals — "Decision 3 · Request 3" instead of UUIDs
// ---------------------------------------------------------------------------

export interface Ordinals {
  /** 1-based position of each decision id, oldest = 1. */
  decision: Map<string, number>;
  /** 1-based position of each request id, oldest = 1. */
  request: Map<string, number>;
}

/** Stable numbering across every page: oldest decision is Decision 1. */
export function decisionOrdinals(decisions: readonly DecisionView[]): Ordinals {
  const byDecision = [...decisions].sort(
    (a, b) =>
      Date.parse(a.decision.createdAt) - Date.parse(b.decision.createdAt) ||
      a.decision.id.localeCompare(b.decision.id),
  );
  const decision = new Map<string, number>();
  byDecision.forEach((v, i) => decision.set(v.decision.id, i + 1));

  const seen = new Map<string, DecisionView>();
  for (const v of decisions) {
    if (!seen.has(v.request.id)) seen.set(v.request.id, v);
  }
  const byRequest = [...seen.values()].sort(
    (a, b) =>
      Date.parse(a.request.createdAt) - Date.parse(b.request.createdAt) ||
      a.request.id.localeCompare(b.request.id),
  );
  const request = new Map<string, number>();
  byRequest.forEach((v, i) => request.set(v.request.id, i + 1));

  return { decision, request };
}

export function decisionLabel(ord: Ordinals, view: DecisionView): string {
  const d = ord.decision.get(view.decision.id);
  const r = ord.request.get(view.request.id);
  return `Decision ${d ?? "?"} · Request ${r ?? "?"}`;
}

// ---------------------------------------------------------------------------
// Record body — shared by the modal and the Audit page
// ---------------------------------------------------------------------------

interface RecordProps {
  view: DecisionView;
  /** Every decision, for ordinals and for resolving `supersedes`. */
  decisions: readonly DecisionView[];
  /** Follow the "re-evaluation of Decision N" link. */
  onOpenDecision?: (decisionId: string) => void;
}

/**
 * The audit record from PRD §12, rendered verbatim in structure:
 * headline, rules applied, data used, state change, narration, action.
 */
export function DecisionRecord({ view, decisions, onOpenDecision }: RecordProps) {
  const { decision, request, departmentName, vendorName } = view;
  const ord = decisionOrdinals(decisions);
  const isOverride = decision.actor === "cfo";
  const superseded =
    decision.supersedes !== undefined
      ? decisions.find((d) => d.decision.id === decision.supersedes) ?? null
      : null;
  const supersededN =
    decision.supersedes !== undefined ? ord.decision.get(decision.supersedes) : undefined;

  return (
    <>
      <div className="audit-headline">
        <span className={`audit-outcome audit-outcome-${decision.outcome}`}>
          {decision.outcome}
        </span>
        <span className="audit-sep">·</span>
        <span className="audit-amount">{rupees(request.amount)}</span>
        <span className="audit-sep">·</span>
        <span className="audit-amount">{lakh(request.amount)}</span>
        <span className="audit-sep">·</span>
        <span className="audit-context">
          {departmentName} · {vendorName} · {stamp(decision.createdAt)}
        </span>
        {isOverride ? <span className="chip chip-override">CFO override</span> : null}
        {!isOverride ? <span className="tag-agent">AGENT</span> : null}
      </div>

      {isOverride ? (
        <div className="override-box">
          <div className="audit-section-title">CFO override</div>
          <div>
            {decision.note !== undefined && decision.note.trim() !== ""
              ? decision.note
              : "No note recorded with this override."}
          </div>
          {superseded !== null || supersededN !== undefined ? (
            <div className="override-link">
              re-evaluation of{" "}
              {onOpenDecision !== undefined && decision.supersedes !== undefined ? (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => onOpenDecision(decision.supersedes ?? "")}
                >
                  Decision {supersededN ?? "?"}
                </button>
              ) : (
                <span>Decision {supersededN ?? "?"}</span>
              )}
              {superseded !== null ? (
                <>
                  {" "}
                  — agent {superseded.decision.outcome.toLowerCase()} on{" "}
                  {reasonLabel(superseded.decision.reasonCode).toLowerCase()}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : decision.supersedes !== undefined ? (
        <div className="override-link" style={{ marginTop: 8 }}>
          re-evaluation of{" "}
          {onOpenDecision !== undefined ? (
            <button
              type="button"
              className="link-btn"
              onClick={() => onOpenDecision(decision.supersedes ?? "")}
            >
              Decision {supersededN ?? "?"}
            </button>
          ) : (
            <span>Decision {supersededN ?? "?"}</span>
          )}
        </div>
      ) : null}

      <div className="audit-context" style={{ marginTop: 10 }}>
        <span className="mono">{request.description}</span>
        <br />
        Reason code:{" "}
        <span className="mono">
          {decision.reasonCode} — {reasonLabel(decision.reasonCode)}
        </span>
        {" · "}Requested by <span className="mono">{request.requestedBy}</span>
        {" · "}Cash leaves in week <span className="mono">{request.expectedWeek}</span>
      </div>

      <section className="audit-section">
        <div className="audit-section-title">Rules Applied</div>
        {decision.rules.length === 0 ? (
          <div className="audit-context">No rules were evaluated for this decision.</div>
        ) : (
          decision.rules.map((rule) => <RuleRow key={rule.rule} rule={rule} />)
        )}
      </section>

      <section className="audit-section">
        <div className="audit-section-title">Data Used</div>
        {decision.dataUsed.length === 0 ? (
          <div className="audit-context">No data sources recorded.</div>
        ) : (
          <ul className="data-list">
            {decision.dataUsed.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="audit-section">
        <div className="audit-section-title">State Change</div>
        <div className="state-change">
          <StateCell label="Headroom" before={decision.headroomBefore} after={decision.headroomAfter} />
          <StateCell
            label="Projected Minimum"
            before={decision.projectedMinimumBefore}
            after={decision.projectedMinimumAfter}
          />
        </div>
      </section>

      <section className="audit-section">
        <div className="audit-section-title">
          Narration {decision.narration === null ? "(deterministic)" : "(model)"}
        </div>
        <div className="narration-box">{decision.narration ?? decision.fallbackNarration}</div>
      </section>

      <section className="audit-section">
        <div className="audit-section-title">Action</div>
        <div className="audit-action">{actionLine(view)}</div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Modal wrapper
// ---------------------------------------------------------------------------

interface Props {
  view: DecisionView;
  decisions: readonly DecisionView[];
  onClose: () => void;
  onOpenDecision?: (decisionId: string) => void;
}

export function DecisionDetail({ view, decisions, onClose, onOpenDecision }: Props) {
  const ord = decisionOrdinals(decisions);
  return (
    <Modal
      title="Audit Record"
      onClose={onClose}
      headerExtra={
        <span className="panel-note" title={`${view.decision.id} · ${view.request.id}`}>
          {decisionLabel(ord, view)}
        </span>
      }
    >
      <DecisionRecord view={view} decisions={decisions} onOpenDecision={onOpenDecision} />
    </Modal>
  );
}

function RuleRow({ rule }: { rule: RuleEvaluation }) {
  return (
    <div className={`rule ${rule.passed ? "rule-pass" : "rule-fail"}`}>
      <span className="rule-mark">{rule.passed ? "✓" : "✕"}</span>
      <span className="rule-name">
        {ruleLabel(rule.rule)}
        {rule.passed ? null : (
          <span className="rule-sev">
            {rule.severity === "hard" ? "hard · reject" : "soft · escalate"}
          </span>
        )}
      </span>
      <span className="rule-detail">{rule.detail}</span>
    </div>
  );
}

function StateCell({ label, before, after }: { label: string; before: number; after: number }) {
  const delta = after - before;
  const dir = delta > 0 ? "state-after-up" : delta < 0 ? "state-after-down" : "state-after-flat";

  return (
    <div className="state-cell">
      <div className="state-label">{label}</div>
      <div className="state-flow">
        <span className="state-before">{lakh(before)}</span>
        <span className="state-arrow">→</span>
        <span className={dir}>{lakh(after)}</span>
      </div>
      <div className="state-delta">
        {delta === 0 ? "no change" : `${delta > 0 ? "+" : "-"}${rupees(Math.abs(delta))}`}
      </div>
    </div>
  );
}

function actionLine(view: DecisionView): string {
  const { decision, request, departmentName } = view;
  if (decision.actor === "cfo") {
    switch (decision.outcome) {
      case "APPROVED":
        return `Approved by the CFO, overriding the agent's escalation. ${rupees(
          request.amount,
        )} reserved against week ${request.expectedWeek}. Requester notified.`;
      case "REJECTED":
        return `Rejected by the CFO. No cash reserved. ${departmentName} notified.`;
      default:
        return `Deferred by the CFO. No cash reserved; the request will be re-evaluated against a later forecast.`;
    }
  }
  switch (decision.outcome) {
    case "APPROVED":
      return `Auto-approved. ${rupees(request.amount)} reserved against week ${
        request.expectedWeek
      }. Requester notified.`;
    case "ESCALATED":
      return `Handed back to the CFO. No cash reserved, no commitment made. ${departmentName} notified that the request is pending review.`;
    case "REJECTED":
      return `Rejected under a hard rule. No cash reserved. ${departmentName} notified with the failing rule.`;
    default:
      return "No action recorded.";
  }
}
