import type { EscalationView } from "@shared/types";
import { clock, lakh, reasonLabel, rupees } from "../format";

interface Props {
  escalation: EscalationView;
  /** Absent handlers render their button disabled. No calls are made here. */
  onApprove?: (view: EscalationView) => void;
  onReject?: (view: EscalationView) => void;
  onDefer?: (view: EscalationView) => void;
  onAskWhy?: (view: EscalationView) => void;
  /**
   * A decision for this request is in flight (or already recorded and waiting
   * for the next poll). Every control locks out so a second click cannot
   * reserve the money twice.
   */
  pending?: boolean;
}

export function EscalationCard({
  escalation,
  onApprove,
  onReject,
  onDefer,
  onAskWhy,
  pending = false,
}: Props) {
  const { request, decision, departmentName, vendorName } = escalation;
  const text = decision.narration ?? decision.fallbackNarration;
  const fromModel = decision.narration !== null;

  return (
    <article className="esc">
      <header className="esc-head">
        <AlertIcon />
        <span className="esc-head-title">CFO review required</span>
        <span className="esc-head-time">{clock(decision.createdAt)}</span>
      </header>

      <div className="esc-body">
        <div className="esc-amount">
          <span className="esc-amount-value">{lakh(request.amount)}</span>
          <span className="esc-amount-exact">{rupees(request.amount)}</span>
        </div>

        <div className="esc-meta">
          <span className="chip">{departmentName}</span>
          <span className="chip">{vendorName}</span>
          <span className="chip">{request.category.replace(/_/g, " ")}</span>
          <span className="chip">week {request.expectedWeek}</span>
          <span className="chip">{reasonLabel(decision.reasonCode)}</span>
        </div>

        <p className="esc-desc">
          {request.description} · requested by{" "}
          <span className="mono">{request.requestedBy}</span>
        </p>

        <div className="esc-narration">
          {text}
          <span className="esc-narration-src">
            {fromModel ? "Narrated by model" : "Deterministic narration"} ·
            decision {decision.id} · request {request.id}
          </span>
        </div>

        <div className="esc-actions" aria-busy={pending}>
          <button
            type="button"
            className={`btn btn-approve${pending ? " btn-pending" : ""}`}
            disabled={pending || !onApprove}
            onClick={() => onApprove?.(escalation)}
          >
            {pending ? "Recording…" : "Approve"}
          </button>
          <button
            type="button"
            className={`btn btn-reject${pending ? " btn-pending" : ""}`}
            disabled={pending || !onReject}
            onClick={() => onReject?.(escalation)}
          >
            {pending ? "Recording…" : "Reject"}
          </button>
          <button
            type="button"
            className={`btn${pending ? " btn-pending" : ""}`}
            disabled={pending || !onDefer}
            onClick={() => onDefer?.(escalation)}
          >
            {pending ? "Recording…" : "Defer"}
          </button>
          <button
            type="button"
            className={`btn btn-why${pending ? " btn-pending" : ""}`}
            disabled={pending || !onAskWhy}
            onClick={() => onAskWhy?.(escalation)}
          >
            {pending ? "Recording…" : "Ask why"}
          </button>
        </div>
      </div>
    </article>
  );
}

function AlertIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M12 7.4v5.4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="12" cy="16.4" r="1.1" fill="currentColor" />
    </svg>
  );
}
