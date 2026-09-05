import { useEffect, useState } from "react";
import { postDemo } from "../api";
import type { DemoResponse } from "../api";

/** Endpoint suffixes POSTed to `/api/demo/<action>`. */
const ACTIONS: Array<{ action: string; label: string }> = [
  { action: "reset", label: "reset" },
  { action: "shock", label: "shock" },
  { action: "run-agent", label: "run-agent" },
  { action: "inject-reply", label: "inject-reply" },
  { action: "request/engineering", label: "request/engineering" },
  { action: "request/marketing", label: "request/marketing" },
  { action: "request/sales", label: "request/sales" },
  { action: "request/new-vendor", label: "request/new-vendor" },
  { action: "replay", label: "replay" },
];

/** Hidden by default. `d` toggles it. Never visible during normal use. */
export function DemoControls() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<DemoResponse | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "d" && e.key !== "D") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      ) {
        return;
      }
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) {
    return <div className="demo-hint">press d</div>;
  }

  const run = async (action: string) => {
    setBusy(action);
    const res = await postDemo(action);
    setLast(res);
    setBusy(null);
  };

  return (
    <aside className="demo">
      <div className="demo-head">
        <span className="demo-title">Demo Controls</span>
        <button
          type="button"
          className="modal-close"
          style={{ marginLeft: "auto" }}
          onClick={() => setOpen(false)}
          aria-label="Close demo controls"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M5 5l14 14M19 5 5 19"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className="demo-list">
        {ACTIONS.map(({ action, label }) => (
          <button
            key={action}
            type="button"
            className="demo-btn"
            disabled={busy !== null}
            onClick={() => void run(action)}
          >
            <span>{label}</span>
            <span className="demo-btn-key">
              {busy === action ? "..." : "POST"}
            </span>
          </button>
        ))}
      </div>

      <div className="demo-status">
        <span>{last ? last.action : "no request yet"}</span>
        <span
          className={
            last === null ? "" : last.ok ? "demo-status-ok" : "demo-status-bad"
          }
        >
          {last === null ? "—" : `${last.status || "ERR"} ${last.detail}`}
        </span>
      </div>
    </aside>
  );
}
