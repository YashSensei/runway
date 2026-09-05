/**
 * The entire client/server surface. One GET for state, one POST for demo
 * actions. Nothing else — the UI is a pure function of `DashboardState`.
 */

import { useEffect, useRef, useState } from "react";
import type { DashboardState } from "@shared/types";

const STATE_URL = "/api/state";
const DEFAULT_POLL_MS = 500;

/** Data older than this is called out full-width on screen. */
export const STALE_AFTER_MS = 3_000;

/**
 * The fixture is a *different company* with different cash, a fabricated
 * escalation and a fabricated replay panel. Rendering it by accident — say
 * because one poll dropped mid-demo — is strictly worse than rendering
 * nothing, so it is opt-in (`?mock`), dev-only, and statically unreachable in
 * a production build: Vite folds `import.meta.env.DEV` to the literal `false`,
 * which lets the bundler drop the branch and `./mock` along with it.
 */
export const ALLOW_MOCK: boolean =
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("mock");

export interface DashboardHandle {
  /**
   * Null until the first successful poll. There is deliberately no fallback:
   * the caller must render an explicit "unreachable" state rather than
   * fabricated numbers.
   */
  state: DashboardState | null;
  /** True only when the dev-only fixture has been explicitly opted into. */
  usingMock: boolean;
  /** Last transport error, cleared on the next successful poll. */
  error: string | null;
  /** True until the first poll resolves either way. */
  loading: boolean;
  /** epoch ms of the last successful poll. */
  lastUpdated: number | null;
  /**
   * Whole seconds since the last good payload, or null when the data is
   * fresh. Ticks at most once a second so it never thrashes the chart.
   */
  staleSeconds: number | null;
}

/**
 * Loads the fixture lazily, and only in a dev build. In production the
 * condition is a compile-time `false`, so neither the dynamic import nor the
 * module survives tree-shaking.
 */
function useMockFallback(enabled: boolean): DashboardState | null {
  const [mock, setMock] = useState<DashboardState | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (import.meta.env.DEV && enabled) {
      void import("./mock").then((m) => {
        if (!cancelled) setMock(m.mockState);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return mock;
}

/**
 * Polls `GET /api/state`. Re-renders only when the payload actually changes,
 * so a 500ms poll does not thrash the chart animation.
 *
 * A failed poll never clears the last good state — stale-but-real beats
 * fresh-and-fake. Staleness is surfaced by age instead.
 */
export function useDashboardState(pollMs = DEFAULT_POLL_MS): DashboardHandle {
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [staleSeconds, setStaleSeconds] = useState<number | null>(null);

  const lastPayload = useRef<string>("");
  const inFlight = useRef(false);
  const lastUpdatedAt = useRef<number | null>(null);

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
        lastUpdatedAt.current = Date.now();
        setLastUpdated(lastUpdatedAt.current);
      } catch (err) {
        if (cancelled) return;
        // Deliberately does NOT touch `state`: whatever is on the projector
        // stays on the projector, and the staleness bar explains its age.
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

  // Age ticker. Returns the previous value unchanged while data is fresh, so
  // React bails out of the re-render and the chart is left alone.
  useEffect(() => {
    function evaluate(): void {
      setStaleSeconds((prev) => {
        const at = lastUpdatedAt.current;
        if (at === null) return prev === null ? prev : null;
        const ageMs = Date.now() - at;
        if (ageMs <= STALE_AFTER_MS) return prev === null ? prev : null;
        const secs = Math.max(1, Math.floor(ageMs / 1000));
        return prev === secs ? prev : secs;
      });
    }

    evaluate();
    const timer = setInterval(evaluate, 500);
    return () => clearInterval(timer);
  }, []);

  const mock = useMockFallback(ALLOW_MOCK);
  const usingMock = state === null && mock !== null;

  return {
    state: state ?? mock,
    usingMock,
    error,
    loading,
    lastUpdated,
    staleSeconds: usingMock ? null : staleSeconds,
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
 *
 * Never throws: callers treat `false` as "nothing was recorded".
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
