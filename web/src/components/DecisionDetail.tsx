import type { DecisionView, RuleEvaluation } from "@shared/types";
import { lakh, reasonLabel, ruleLabel, rupees, stamp } from "../format";
import { Modal } from "./Modal";

interface Props {
  view: DecisionView;
  onClose: () => void;
}

/**
 * The audit record from PRD §12, rendered verbatim in structure:
 * headline, rules applied, data used, state change, narration, action.
 */
export function DecisionDetail({ view, onClose }: Props) {
  const { decision, request, departmentName, vendorName } = view;

  return (
    <Modal
      title="Audit Record"
      onClose={onClose}
      headerExtra={
        <span className="panel-note">
          {decision.id} · {request.id}
        </span>
      }
    >
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
      </div>

      <div className="audit-context" style={{ marginTop: 10 }}>
        <span className="mono">{request.description}</span>
        <br />
        Reason code:{" "}
        <span className="mono">
          {decision.reasonCode} — {reasonLabel(decision.reasonCode)}
        </span>
        {" · "}Requested by <span className="mono">{request.requestedBy}</span>
        {" · "}Cash leaves in week{" "}
        <span className="mono">{request.expectedWeek}</span>
      </div>

      <section className="audit-section">
        <div className="audit-section-title">Rules Applied</div>
        {decision.rules.map((rule) => (
          <RuleRow key={rule.rule} rule={rule} />
        ))}
      </section>

      <section className="audit-section">
        <div className="audit-section-title">Data Used</div>
        <ul className="data-list">
          {decision.dataUsed.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      </section>

      <section className="audit-section">
        <div className="audit-section-title">State Change</div>
        <div className="state-change">
          <StateCell
            label="Headroom"
            before={decision.headroomBefore}
            after={decision.headroomAfter}
          />
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
        <div className="narration-box">
          {decision.narration ?? decision.fallbackNarration}
        </div>
      </section>

      <section className="audit-section">
        <div className="audit-section-title">Action</div>
        <div className="audit-action">{actionLine(view)}</div>
      </section>
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

function StateCell({
  label,
  before,
  after,
}: {
  label: string;
  before: number;
  after: number;
}) {
  const delta = after - before;
  const dir =
    delta > 0 ? "state-after-up" : delta < 0 ? "state-after-down" : "state-after-flat";

  return (
    <div className="state-cell">
      <div className="state-label">{label}</div>
      <div className="state-flow">
        <span className="state-before">{lakh(before)}</span>
        <span className="state-arrow">→</span>
        <span className={dir}>{lakh(after)}</span>
      </div>
      <div className="state-delta">
        {delta === 0
          ? "no change"
          : `${delta > 0 ? "+" : "−"}${rupees(Math.abs(delta))}`}
      </div>
    </div>
  );
}

function actionLine(view: DecisionView): string {
  const { decision, request, departmentName } = view;
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
