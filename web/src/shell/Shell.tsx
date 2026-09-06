import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { DashboardState } from "@shared/types";
import type { PageId, RailEntry } from "../pages/types";
import { clock, shortDate } from "../format";
import { hashFor, PAGE_IDS } from "./router";
import {
  AgentIcon,
  AuditIcon,
  CashIcon,
  CollectIcon,
  DemoIcon,
  InsightsIcon,
  OverviewIcon,
  PolicyIcon,
  SpendIcon,
} from "./icons";

interface Props {
  state: DashboardState;
  page: PageId;
  navigate: (hash: string) => void;
  usingMock: boolean;
  staleSeconds: number | null;
  lastUpdated: number | null;
  error: string | null;
  demoOpen: boolean;
  onToggleDemo: () => void;
  children: ReactNode;
}

const LABELS: Record<PageId, string> = {
  overview: "Overview",
  cash: "Cash",
  collect: "Collect",
  spend: "Spend",
  policy: "Policy",
  audit: "Audit",
  insights: "Insights",
  agent: "Agent",
};

const ICONS: Record<PageId, () => JSX.Element> = {
  overview: OverviewIcon,
  cash: CashIcon,
  collect: CollectIcon,
  spend: SpendIcon,
  policy: PolicyIcon,
  audit: AuditIcon,
  insights: InsightsIcon,
  agent: AgentIcon,
};

/** Attention badges, derived from the one polled state. */
export function buildRailEntries(state: DashboardState): RailEntry[] {
  const awaitingReply = state.invoices.filter(
    (i) => i.chasedAt !== null && i.status !== "committed" && i.status !== "paid",
  ).length;
  const breach = state.forecast.breachWeek;

  return PAGE_IDS.map((id): RailEntry => {
    switch (id) {
      case "spend":
        return { id, label: LABELS[id], badge: state.escalations.length };
      case "collect":
        return { id, label: LABELS[id], badge: awaitingReply };
      case "cash":
        return breach !== null
          ? { id, label: LABELS[id], badge: breach, danger: true }
          : { id, label: LABELS[id] };
      case "agent":
        return state.agent.autonomyEnabled
          ? { id, label: LABELS[id] }
          : { id, label: LABELS[id], danger: true };
      default:
        return { id, label: LABELS[id] };
    }
  });
}

function isTypingTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}

export function Shell({
  state,
  page,
  navigate,
  usingMock,
  staleSeconds,
  lastUpdated,
  error,
  demoOpen,
  onToggleDemo,
  children,
}: Props) {
  const entries = buildRailEntries(state);

  // Keyboard: 1–8 switch pages, d toggles the demo panel. Never while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (e.key === "d" || e.key === "D") {
        onToggleDemo();
        return;
      }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= PAGE_IDS.length) {
        const id = PAGE_IDS[n - 1];
        if (id !== undefined) navigate(hashFor(id));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, onToggleDemo]);

  return (
    <div className="shell">
      <nav className="rail" aria-label="Sections">
        <div className="rail-brand" title="Runway · Autonomous CFO">
          <span className="rail-mark">R</span>
          <span className="rail-word">Runway</span>
        </div>

        <ul className="rail-list">
          {entries.map((entry, i) => {
            const Icon = ICONS[entry.id];
            const active = entry.id === page;
            const count = entry.badge ?? 0;
            return (
              <li key={entry.id}>
                <a
                  href={hashFor(entry.id)}
                  className={`rail-item${active ? " rail-item-active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  title={`${entry.label} · press ${i + 1}`}
                >
                  <span className="rail-icon">
                    <Icon />
                  </span>
                  <span className="rail-label">{entry.label}</span>
                  <RailBadge entry={entry} count={count} />
                </a>
              </li>
            );
          })}
        </ul>

        <div className="rail-divider" />

        <button
          type="button"
          className={`rail-item rail-item-btn${demoOpen ? " rail-item-active" : ""}`}
          onClick={onToggleDemo}
          title="Demo controls · press d"
          aria-pressed={demoOpen}
        >
          <span className="rail-icon">
            <DemoIcon />
          </span>
          <span className="rail-label">Demo</span>
          <span className="rail-key">d</span>
        </button>
      </nav>

      <div className="shell-main">
        <header className="topbar">
          {/* The rail carries the wordmark; the topbar names where you are. */}
          <h1 className="topbar-page">{LABELS[page]}</h1>

          <div className="topbar-spacer" />

          <div className="topbar-meta">
            <span>
              <strong>{state.company.name}</strong>
            </span>
            <span title="The engine's frozen date. Overdue ageing is measured from here.">
              as of <strong>{shortDate(state.today)}</strong>
            </span>
            <Heartbeat state={state} />
            {usingMock ? (
              <span className="badge badge-mock">
                <i className="dot" />
                Fixture data
              </span>
            ) : (
              <span className={`badge ${staleSeconds === null ? "badge-live" : "badge-danger"}`}>
                <i className={`dot ${staleSeconds === null ? "dot-pulse" : ""}`} />
                {staleSeconds === null ? "Live · " : "Stale · "}
                {lastUpdated === null ? "—" : clock(new Date(lastUpdated).toISOString())}
              </span>
            )}
          </div>
        </header>

        {usingMock ? (
          <div className="alert-bar alert-bar-warn" role="alert">
            <span className="alert-bar-title">Dev Fixture</span>
            <span>
              This is <b>?mock</b> data for a different company. Nothing on this screen came
              from the engine.
            </span>
          </div>
        ) : null}

        {staleSeconds !== null ? (
          <div className="alert-bar alert-bar-danger" role="alert">
            <span className="alert-bar-title">Stale</span>
            <span>
              Last good data <span className="mono">{staleSeconds}s</span> ago
              {error !== null ? (
                <>
                  {" · "}
                  <span className="mono">{error}</span>
                </>
              ) : null}
            </span>
          </div>
        ) : null}

        <div className="shell-content">{children}</div>
      </div>
    </div>
  );
}

function RailBadge({ entry, count }: { entry: RailEntry; count: number }) {
  if (entry.danger) {
    if (entry.id === "cash" && count > 0) {
      return (
        <span className="rail-badge rail-badge-danger" title={`Cash breaches the floor in week ${count}`}>
          W{count}
        </span>
      );
    }
    if (count > 0) {
      return <span className="rail-badge rail-badge-danger">{count}</span>;
    }
    return (
      <span className="rail-dot" title="Attention">
        <i className="dot" />
      </span>
    );
  }
  if (count > 0) return <span className="rail-badge">{count}</span>;
  return null;
}

/** "next run in 14s", ticking locally between polls. */
function Heartbeat({ state }: { state: DashboardState }) {
  const { agent } = state;
  const now = useNow(1000);

  let text: string;
  let tone = "badge-agent";
  if (!agent.autonomyEnabled) {
    text = "agent paused";
    tone = "badge-danger";
  } else if (agent.nextAlarmAt === null) {
    text = "agent idle";
    tone = "";
  } else {
    const at = Date.parse(agent.nextAlarmAt);
    if (Number.isNaN(at)) {
      text = "agent scheduled";
    } else {
      const secs = Math.ceil((at - now) / 1000);
      text = secs <= 0 ? "agent running" : `next run in ${secs}s`;
    }
  }

  return (
    <span className={`badge ${tone}`} title={heartbeatTitle(state)}>
      <i className={`dot ${agent.autonomyEnabled ? "dot-pulse" : ""}`} />
      {text}
    </span>
  );
}

function heartbeatTitle(state: DashboardState): string {
  const a = state.agent;
  const last = a.lastRunAt === null ? "never" : clock(a.lastRunAt);
  return `Autonomy ${a.autonomyEnabled ? "on" : "off"} · every ${Math.round(a.intervalMs / 1000)}s · last run ${last}`;
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
