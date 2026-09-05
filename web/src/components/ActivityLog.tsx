import type {
  ActivityEntry,
  ActivityType,
  DecisionView,
  SentEmail,
} from "@shared/types";
import { activityLabel, clock, plural } from "../format";
import { Empty, Panel } from "./Panel";

type Tone = "agent" | "ok" | "warn" | "danger" | "neutral";

interface Props {
  entries: ActivityEntry[];
  decisions: DecisionView[];
  emails: SentEmail[];
  onOpenDecision: (view: DecisionView) => void;
  onOpenEmail: (email: SentEmail) => void;
}

export function ActivityLog({
  entries,
  decisions,
  emails,
  onOpenDecision,
  onOpenEmail,
}: Props) {
  const ordered = [...entries].sort(
    (a, b) =>
      Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
      b.id.localeCompare(a.id),
  );

  const agentCount = ordered.filter((e) => e.actor === "agent").length;

  return (
    <Panel
      title="Agent Activity"
      className="panel-fill"
      bodyClassName="panel-body-flush"
      right={
        <>
          <span className="badge badge-agent">
            <i className="dot dot-pulse" />
            {agentCount} autonomous
          </span>
          <span className="panel-note">
            {plural(ordered.length, "event")} · newest first
          </span>
        </>
      }
    >
      {ordered.length === 0 ? (
        <Empty>No activity recorded yet — the agent logs every action here.</Empty>
      ) : (
        <div className="log">
          {ordered.map((entry) => {
            const link = resolveLink(entry, decisions, emails);
            const tone = toneFor(entry, link);
            const clickable = link !== null;

            const open = () => {
              if (link === null) return;
              if (link.kind === "decision") onOpenDecision(link.view);
              else onOpenEmail(link.email);
            };

            return (
              <button
                key={entry.id}
                type="button"
                disabled={!clickable}
                onClick={open}
                className={[
                  "log-row",
                  entry.actor === "agent" ? "log-row-agent" : "",
                  clickable ? "log-row-clickable" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <span className="log-time">{clock(entry.createdAt)}</span>

                {/* Type is a chip in its own column — icon plus text — so it
                    can never run into the summary. */}
                <span
                  className={`log-chip log-chip-${tone}`}
                  title={activityLabel(entry.type)}
                >
                  <TypeIcon type={entry.type} link={link} />
                  <span>{chipLabel(entry.type)}</span>
                </span>

                <span className="log-summary">{entry.summary}</span>

                <span className="log-tail">
                  {clickable ? <span className="log-open">OPEN →</span> : null}
                  {entry.actor === "agent" ? (
                    <span className="tag-agent">AGENT</span>
                  ) : (
                    <span className="tag-human">HUMAN</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

/** Short chip text so the column stays narrow; the full label is the tooltip. */
const CHIP_LABELS: Partial<Record<ActivityType, string>> = {
  forecast_updated: "forecast",
  breach_detected: "breach",
  breach_cleared: "cleared",
  email_sent: "email",
  reply_parsed: "reply",
  commitment_recorded: "commit",
  decision: "decision",
  shock_applied: "shock",
  system: "system",
};

function chipLabel(type: ActivityType): string {
  return CHIP_LABELS[type] ?? activityLabel(type);
}

// ---------------------------------------------------------------------------
// Linking activity rows to their audit artefacts
// ---------------------------------------------------------------------------

type Link =
  | { kind: "decision"; view: DecisionView }
  | { kind: "email"; email: SentEmail };

function readString(
  detail: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const v = detail?.[key];
  return typeof v === "string" ? v : null;
}

function resolveLink(
  entry: ActivityEntry,
  decisions: DecisionView[],
  emails: SentEmail[],
): Link | null {
  if (entry.type === "decision") {
    const decisionId = readString(entry.detail, "decisionId");
    const requestId = readString(entry.detail, "requestId");
    const view =
      decisions.find((d) => d.decision.id === decisionId) ??
      decisions.find((d) => d.request.id === requestId) ??
      null;
    return view ? { kind: "decision", view } : null;
  }

  if (entry.type === "email_sent") {
    const emailId = readString(entry.detail, "emailId");
    const invoiceId = readString(entry.detail, "invoiceId");
    const email =
      emails.find((e) => e.id === emailId) ??
      emails.find((e) => e.invoiceId === invoiceId) ??
      null;
    return email ? { kind: "email", email } : null;
  }

  return null;
}

function toneFor(entry: ActivityEntry, link: Link | null): Tone {
  if (link?.kind === "decision") {
    const outcome = link.view.decision.outcome;
    if (outcome === "APPROVED") return "ok";
    if (outcome === "REJECTED") return "danger";
    return "warn";
  }

  switch (entry.type) {
    case "breach_detected":
      return "danger";
    case "breach_cleared":
    case "reply_parsed":
    case "commitment_recorded":
      return "ok";
    case "shock_applied":
      return "warn";
    case "forecast_updated":
    case "email_sent":
    case "decision":
      return "agent";
    default:
      return entry.actor === "agent" ? "agent" : "neutral";
  }
}

// ---------------------------------------------------------------------------
// Icons — 14px line marks, no emoji
// ---------------------------------------------------------------------------

function TypeIcon({ type, link }: { type: ActivityType; link: Link | null }) {
  if (type === "decision") {
    const outcome = link?.kind === "decision" ? link.view.decision.outcome : null;
    if (outcome === "REJECTED") return <CrossIcon />;
    if (outcome === "ESCALATED") return <EscalateIcon />;
    return <CheckIcon />;
  }

  switch (type) {
    case "forecast_updated":
      return <RefreshIcon />;
    case "breach_detected":
      return <WarningIcon />;
    case "breach_cleared":
      return <ShieldIcon />;
    case "email_sent":
      return <MailIcon />;
    case "reply_parsed":
      return <InboxIcon />;
    case "commitment_recorded":
      return <LockIcon />;
    case "shock_applied":
      return <BoltIcon />;
    default:
      return <TerminalIcon />;
  }
}

const S = {
  width: 13,
  height: 13,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function RefreshIcon() {
  return (
    <svg {...S}>
      <path d="M20 11a8 8 0 0 0-13.7-5.2L3 9" />
      <path d="M4 13a8 8 0 0 0 13.7 5.2L21 15" />
      <path d="M3 4v5h5M21 20v-5h-5" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg {...S}>
      <path d="M12 4 22 20H2L12 4Z" />
      <path d="M12 10v4" />
      <path d="M12 17.4h.01" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg {...S}>
      <path d="M12 3l7 3v6c0 4.4-3 7.7-7 9-4-1.3-7-4.6-7-9V6l7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg {...S}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg {...S}>
      <path d="M3 13h5l1.5 3h5L16 13h5" />
      <path d="M3 13 5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Z" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg {...S}>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg {...S}>
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg {...S}>
      <path d="m4 12.5 5 5L20 6.5" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg {...S}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function EscalateIcon() {
  return (
    <svg {...S}>
      <path d="M12 20V5" />
      <path d="m6 11 6-6 6 6" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg {...S}>
      <path d="m5 7 5 5-5 5" />
      <path d="M13 17h6" />
    </svg>
  );
}
