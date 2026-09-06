import { useEffect, useRef, useState } from "react";
import type { ActivityEntry, DashboardState, DecisionView } from "@shared/types";
import { clock, lakh } from "../format";

interface Props {
  state: DashboardState;
  onOpenDecision: (decisionId: string) => void;
}

type Item =
  | { kind: "decision"; view: DecisionView; at: string; text: string }
  | { kind: "activity"; entry: ActivityEntry; at: string; text: string };

/**
 * The agent's most recent sentence, full width, hero tier. Walks back through
 * every agent-authored decision with prev/next; falls back to the latest
 * agent activity line when no decision exists yet.
 */
export function NarrativeStrip({ state, onOpenDecision }: Props) {
  const items = buildItems(state);
  const latest = items.length - 1;

  // Index into `items`, newest by default. When a new agent decision arrives
  // (length grows), jump back to the newest so the room sees it.
  const [index, setIndex] = useState(latest);
  const lastLen = useRef(items.length);
  useEffect(() => {
    if (items.length !== lastLen.current) {
      lastLen.current = items.length;
      setIndex(items.length - 1);
    }
  }, [items.length]);

  const safeIndex = Math.min(Math.max(0, index), Math.max(0, latest));
  const item = items[safeIndex];

  // Flash the strip when the newest text changes.
  const newestText = items[latest]?.text ?? "";
  const [flash, setFlash] = useState(false);
  const prevText = useRef(newestText);
  useEffect(() => {
    if (prevText.current === newestText) return;
    prevText.current = newestText;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 3000);
    return () => clearTimeout(t);
  }, [newestText]);

  if (item === undefined) {
    return (
      <section className="narrative narrative-empty" aria-label="Agent narrative">
        <span className="tag-agent">AGENT</span>
        <span className="narrative-text narrative-muted">
          Nothing narrated yet — the agent writes here the moment it acts.
        </span>
      </section>
    );
  }

  const clickable = item.kind === "decision";
  const meta =
    item.kind === "decision"
      ? `${item.view.decision.outcome} · ${item.view.departmentName} · ${lakh(item.view.request.amount)}`
      : item.entry.type.replace(/_/g, " ");

  return (
    <section
      className={`narrative${flash ? " narrative-flash" : ""}`}
      aria-label="Agent narrative"
      aria-live="polite"
    >
      <div className="narrative-head">
        <span className="tag-agent">AGENT</span>
        <span className="narrative-time mono">{clock(item.at)}</span>
        <span className="narrative-meta">{meta}</span>
        <span className="narrative-spacer" />
        {items.length > 1 ? (
          <span className="narrative-nav">
            <button
              type="button"
              className="link-btn"
              disabled={safeIndex <= 0}
              onClick={() => setIndex(safeIndex - 1)}
              aria-label="Previous agent decision"
            >
              ← prev
            </button>
            <span className="mono narrative-count">
              {safeIndex + 1} of {items.length}
            </span>
            <button
              type="button"
              className="link-btn"
              disabled={safeIndex >= latest}
              onClick={() => setIndex(safeIndex + 1)}
              aria-label="Next agent decision"
            >
              next →
            </button>
          </span>
        ) : null}
      </div>
      {clickable ? (
        <button
          type="button"
          className="narrative-text narrative-text-btn"
          onClick={() => onOpenDecision(item.view.decision.id)}
          title="Open the audit record"
        >
          {item.text}
        </button>
      ) : (
        <p className="narrative-text">{item.text}</p>
      )}
    </section>
  );
}

function buildItems(state: DashboardState): Item[] {
  const decisions = state.decisions
    .filter((d) => d.decision.actor !== "cfo")
    .sort(
      (a, b) =>
        Date.parse(a.decision.createdAt) - Date.parse(b.decision.createdAt) ||
        a.decision.id.localeCompare(b.decision.id),
    );

  if (decisions.length > 0) {
    return decisions.map((view) => ({
      kind: "decision",
      view,
      at: view.decision.createdAt,
      text: view.decision.narration ?? view.decision.fallbackNarration,
    }));
  }

  const agentActivity = state.activity
    .filter((e) => e.actor === "agent")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
  const latest = agentActivity[0];
  if (latest === undefined) return [];
  return [{ kind: "activity", entry: latest, at: latest.createdAt, text: latest.summary }];
}
