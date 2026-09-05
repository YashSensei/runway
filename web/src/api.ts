/**
 * The entire client/server surface. One GET for state, one POST for demo
 * actions. Nothing else — the UI is a pure function of `DashboardState`.
 */

import { useEffect, useRef, useState } from "react";
import type { DashboardState } from "@shared/types";
import { mockState } from "./mock";

const STATE_URL = "/api/state";
const DEFAULT_POLL_MS = 500;

export interface DashboardHandle {
  /** Never null — falls back to the fixture so the UI is always renderable. */
  state: DashboardState;
  /** True while the fixture is standing in for an unreachable backend. */
  usingMock: boolean;
  /** Last transport error, cleared on the next successful poll. */
  error: string | null;
  /** True until the first poll resolves either way. */
  loading: boolean;
  /** epoch ms of the last successful poll. */
  lastUpdated: number | null;
}

/**
 * Polls `GET /api/state`. Re-renders only when the payload actually changes,
 * so a 500ms poll does not thrash the chart animation.
 */
export function useDashboardState(pollMs = DEFAULT_POLL_MS): DashboardHandle {
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const lastPayload = useRef<string>("");
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function poll(): Promise<void> {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const res = await fetch(STATE_URL, {
          headers: { accept: "application/json" },
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const text = await res.text();
        if (cancelled) return;

        if (text !== lastPayload.current) {
          lastPayload.current = text;
          setState(JSON.parse(text) as DashboardState);
        }
        setError(null);
        setLastUpdated(Date.now());
      } catch (err) {
        if (cancelled) return;
        lastPayload.current = "";
        setState(null);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlight.current = false;
        if (!cancelled) setLoading(false);
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), pollMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollMs]);

  return {
    state: state ?? mockState,
    usingMock: state === null,
    error,
    loading,
    lastUpdated,
  };
}

export interface DemoResponse {
  action: string;
  status: number;
  ok: boolean;
  detail: string;
}

/**
 * The CFO acting on an escalation.
 *
 * Approving commits the reservation the agent declined to make, so the
 * forecast and headroom move on the very next poll.
 */
export async function resolveEscalation(
  requestId: string,
  action: "approve" | "reject" | "defer",
): Promise<boolean> {
  try {
    const res = await fetch(`/api/escalations/${requestId}/${action}`, { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}

/** POSTs to `/api/demo/<action>` and reports the response status. */
export async function postDemo(action: string): Promise<DemoResponse> {
  try {
    const res = await fetch(`/api/demo/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return {
      action,
      status: res.status,
      ok: res.ok,
      detail: res.ok ? "ok" : res.statusText || "error",
    };
  } catch (err) {
    return {
      action,
      status: 0,
      ok: false,
      detail: err instanceof Error ? err.message : "no backend",
    };
  }
}
