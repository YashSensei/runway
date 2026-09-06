import { useCallback, useRef, useState } from "react";
import type { DashboardState } from "@shared/types";
import { resolveEscalation } from "../api";
import { EscalationCard } from "./EscalationCard";
import { Empty, Panel } from "./Panel";

interface Props {
  state: DashboardState;
  onAskWhy: (decisionId: string) => void;
  className?: string;
}

/**
 * The CFO's inbox on the Overview. Owns the double-click guard: a request with
 * a decision in flight (or already recorded and waiting for the next poll to
 * drop the card) is locked so one impatient click cannot reserve money twice.
 */
export function EscalationsPanel({ state, onAskWhy, className }: Props) {
  const { escalations } = state;
  const empty = escalations.length === 0;

  // A ref does the guarding so a double-click inside one React batch still
  // only fires once; the array only exists to drive rendering.
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

  return (
    <Panel
      title="Escalations"
      tier="primary"
      className={className ?? (empty ? "panel-auto" : "panel-fill")}
      bodyClassName={empty && actionError === null ? "panel-body-flush" : "panel-body-esc"}
      right={
        escalations.length > 0 ? (
          <span className="chip chip-danger">
            <i className="dot" />
            {escalations.length} awaiting you
          </span>
        ) : (
          <span className="chip chip-ok">
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
            onClick={() => setActionError(null)}
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
            onApprove={(v) => handleResolve(v.request.id, "approve")}
            onReject={(v) => handleResolve(v.request.id, "reject")}
            onDefer={(v) => handleResolve(v.request.id, "defer")}
          />
        ))
      )}
    </Panel>
  );
}
