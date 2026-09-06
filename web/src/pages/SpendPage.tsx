/**
 * Spend — the approvals inbox (suggestions.md §2.3).
 *
 * Left: the escalation workspace (only while something is awaiting the CFO)
 * and the request inbox. Right: a live form that runs the real rules engine
 * as you type, the vendor directory, and department budgets.
 *
 * Every write goes through `../api` and shows up on the next poll; this page
 * never holds authoritative state.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  Decision,
  DecisionView,
  Department,
  EscalationView,
  RuleEvaluation,
  SpendRequest,
  Vendor,
} from "@shared/types";
import { reevaluateRequest, resolveEscalation, submitRequest } from "../api";
import { clock, lakh, percent, plural, reasonLabel, ruleLabel, rupees, shortDate } from "../format";
import { Empty, Panel } from "../components/Panel";
import {
  FIELD_LABEL_STYLE,
  FIELD_STYLE,
  agentApprovedViews,
  approvedForDepartment,
  clamp01,
  inferVendorCategory,
  latestPerRequest,
  parseRupees,
  preCheck,
  useWide,
  vendorWindowSpend,
} from "../lib/spendHelpers";
import type { PageProps } from "./types";

export default function SpendPage(props: PageProps) {
  const { state, openDecision } = props;
  const wide = useWide(1400);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: wide ? "minmax(0, 7fr) minmax(0, 5fr)" : "minmax(0, 1fr)",
        gap: "var(--gap)",
        alignItems: "start",
      }}
    >
      <div className="stack" style={{ minWidth: 0 }}>
        {state.escalations.length > 0 ? (
          <EscalationWorkspace
            escalations={state.escalations}
            headroom={state.forecast.headroom}
            openDecision={openDecision}
          />
        ) : null}
        <RequestInbox decisions={state.decisions} openDecision={openDecision} />
      </div>

      <div className="stack" style={{ minWidth: 0 }}>
        <NewRequestForm {...props} />
        <VendorDirectory {...props} />
        <DepartmentBudgets {...props} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Escalation workspace
// ---------------------------------------------------------------------------

function EscalationWorkspace({
  escalations,
  headroom,
  openDecision,
}: {
  escalations: EscalationView[];
  headroom: number;
  openDecision: (id: string) => void;
}) {
  return (
    <Panel
      title="Escalation workspace"
      className="panel-auto"
      bodyClassName="panel-body-esc"
      right={
        <span className="badge badge-danger">
          <i className="dot" />
          {escalations.length} awaiting you
        </span>
      }
    >
      {escalations.map((esc) => (
        <EscalationWorkCard
          key={esc.decision.id}
          escalation={esc}
          headroom={headroom}
          openDecision={openDecision}
        />
      ))}
    </Panel>
  );
}

type EscAction = "approve" | "reject" | "defer" | "reevaluate";

function EscalationWorkCard({
  escalation,
  headroom,
  openDecision,
}: {
  escalation: EscalationView;
  headroom: number;
  openDecision: (id: string) => void;
}) {
  const { request, decision, departmentName, vendorName } = escalation;
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<EscAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);

  // The card is keyed on the decision id, so a re-evaluation that leaves the
  // request escalated remounts it with fresh state.
  async function act(action: EscAction): Promise<void> {
    if (lock.current) return;
    lock.current = true;
    setPending(action);
    setError(null);

    if (action === "reevaluate") {
      const res = await reevaluateRequest(request.id);
      if (!res.ok) {
        setError(res.error ?? "Re-evaluation was not recorded.");
        lock.current = false;
        setPending(null);
      }
      // On success the poll replaces this card (new decision id) or removes it.
      return;
    }

    // `resolveEscalation` never throws. Tolerate either a boolean or an
    // ApiResult-shaped return so this page survives the helper being upgraded.
    const res: unknown = await resolveEscalation(request.id, action, note.trim() || undefined);
    const ok =
      typeof res === "boolean"
        ? res
        : typeof res === "object" && res !== null && "ok" in res
          ? Boolean((res as { ok: unknown }).ok)
          : false;
    if (ok) return; // stays locked until the poll drops the card
    const serverError =
      typeof res === "object" && res !== null && "error" in res
        ? (res as { error: unknown }).error
        : null;
    setError(
      typeof serverError === "string" && serverError
        ? serverError
        : `${action.toUpperCase()} was not recorded — the request is still open. It may already have been resolved elsewhere.`,
    );
    lock.current = false;
    setPending(null);
  }

  const busy = pending !== null;
  const landing = headroom - request.amount;
  const narration = decision.narration ?? decision.fallbackNarration;

  return (
    <article className="esc">
      <header className="esc-head">
        <span className="esc-head-title">CFO review required</span>
        <span className="chip" style={{ color: "var(--text-2)" }}>
          {reasonLabel(decision.reasonCode)}
        </span>
        <span className="esc-head-time">
          {clock(decision.createdAt)} · {decision.id}
        </span>
      </header>

      <div
        className="esc-body"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
          gap: "0 18px",
          paddingBottom: 12,
        }}
      >
        {/* Left: the request and the agent's account of it */}
        <div style={{ minWidth: 0 }}>
          <div className="esc-amount">
            <span className="esc-amount-value">{lakh(request.amount)}</span>
            <span className="esc-amount-exact">{rupees(request.amount)}</span>
          </div>
          <div className="esc-meta">
            <span className="chip">{departmentName}</span>
            <span className="chip">{vendorName}</span>
            <span className="chip">{request.category.replace(/_/g, " ")}</span>
            <span className="chip">cash leaves week {request.expectedWeek}</span>
          </div>
          <p className="esc-desc">
            {request.description} · requested by{" "}
            <span className="mono">{request.requestedBy}</span> · {request.id}
          </p>
          <div className="esc-narration">
            {narration}
            <span className="esc-narration-src">
              {decision.narration !== null ? "Narrated by model" : "Deterministic narration"} ·{" "}
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                style={{ padding: "0 4px", fontSize: 10, letterSpacing: "0.13em" }}
                onClick={() => openDecision(decision.id)}
              >
                open audit record
              </button>
            </span>
          </div>
        </div>

        {/* Right: the seven rules, the headroom bar, the CFO's controls */}
        <div style={{ minWidth: 0 }}>
          <div className="audit-section-title" style={{ marginTop: 2 }}>
            Rules applied
          </div>
          <RuleList rules={decision.rules} />

          <div className="headroom">
            <div className="headroom-line">
              <span className="headroom-label">where this lands</span>
              <span className="headroom-figs">
                headroom <span style={{ color: "var(--text)" }}>{lakh(headroom)}</span> →{" "}
                <span style={{ color: landing < 0 ? "var(--danger)" : "var(--ok)" }}>
                  {lakh(landing)}
                  {landing < 0 ? " · past zero" : " left"}
                </span>
              </span>
            </div>
            <LandingBar headroom={headroom} amount={request.amount} />
          </div>

          <label style={{ display: "block", marginTop: 12 }}>
            <span style={FIELD_LABEL_STYLE}>Note (optional, recorded on the decision)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
              rows={2}
              maxLength={500}
              placeholder="Why you are overriding, deferring, or agreeing."
              style={{ ...FIELD_STYLE, resize: "vertical", fontFamily: "var(--sans)" }}
            />
          </label>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 6,
              marginTop: 8,
            }}
            aria-busy={busy}
          >
            <ActionButton
              className="btn-approve"
              label="Approve"
              action="approve"
              pending={pending}
              onClick={() => void act("approve")}
            />
            <ActionButton
              className="btn-reject"
              label="Reject"
              action="reject"
              pending={pending}
              onClick={() => void act("reject")}
            />
            <ActionButton
              className=""
              label="Defer"
              action="defer"
              pending={pending}
              onClick={() => void act("defer")}
            />
          </div>

          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              className={`btn btn-why btn-sm${pending === "reevaluate" ? " btn-pending" : ""}`}
              disabled={busy}
              onClick={() => void act("reevaluate")}
              style={{ width: "100%" }}
            >
              {pending === "reevaluate" ? "Re-evaluating…" : "Re-evaluate against today's forecast"}
            </button>
            <div className="state-delta" style={{ marginTop: 4 }}>
              Cash may have moved since this was escalated — a collection landing or a rule change
              can turn this into an approval without you touching it.
            </div>
          </div>

          {error !== null ? (
            <div className="inline-alert" role="alert" style={{ marginTop: 10, marginBottom: 0 }}>
              <span className="inline-alert-title">Not recorded</span>
              <span className="inline-alert-body">{error}</span>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function ActionButton({
  className,
  label,
  action,
  pending,
  onClick,
}: {
  className: string;
  label: string;
  action: EscAction;
  pending: EscAction | null;
  onClick: () => void;
}) {
  const busy = pending !== null;
  const mine = pending === action;
  return (
    <button
      type="button"
      className={`btn ${className}${mine ? " btn-pending" : ""}`}
      disabled={busy}
      onClick={onClick}
    >
      {mine ? "Recording…" : label}
    </button>
  );
}

/** Pass/fail list in the audit record's own style. */
function RuleList({
  rules,
  unchecked = [],
}: {
  rules: RuleEvaluation[];
  unchecked?: readonly string[];
}) {
  if (rules.length === 0) return <Empty>No rules recorded</Empty>;
  return (
    <div>
      {rules.map((rule) => {
        const skip = unchecked.includes(rule.rule);
        return (
          <div
            key={rule.rule}
            className={`rule ${skip ? "" : rule.passed ? "rule-pass" : "rule-fail"}`}
            style={{ gridTemplateColumns: "18px 150px minmax(0, 1fr)", fontSize: 12 }}
          >
            <span className="rule-mark" style={skip ? { color: "var(--text-3)" } : undefined}>
              {skip ? "–" : rule.passed ? "✓" : "✕"}
            </span>
            <span className="rule-name">
              {ruleLabel(rule.rule)}
              <span className="rule-sev">
                {skip ? "not checked" : rule.passed ? "pass" : rule.severity === "hard" ? "fail · reject" : "fail · escalate"}
              </span>
            </span>
            <span className="rule-detail" style={{ color: skip ? "var(--text-3)" : undefined }}>
              {skip
                ? "Category baseline lives on the server — checked on submit."
                : rule.detail}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The agent's headroom as a bar, with the request drawn against it. Scale is
 * max(headroom, amount) so the request is always visible; anything past the
 * headroom tick is drawn in the danger fill (hatched, so it reads without
 * colour).
 */
function LandingBar({ headroom, amount }: { headroom: number; amount: number }) {
  const available = Math.max(0, headroom);
  const scale = Math.max(available, amount, 1);
  const inside = Math.min(amount, available);
  const over = Math.max(0, amount - available);
  const pct = (v: number) => `${(clamp01(v / scale) * 100).toFixed(2)}%`;

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ position: "relative" }}>
        <div
          className="hbar"
          role="img"
          aria-label={
            headroom <= 0
              ? `No headroom: the forecast is already ${rupees(-headroom)} below the safety line`
              : over > 0
                ? `${rupees(amount)} exceeds ${rupees(available)} of headroom by ${rupees(over)}`
                : `${rupees(amount)} of ${rupees(available)} headroom, leaving ${rupees(available - amount)}`
          }
          style={{ display: "flex", marginTop: 0 }}
        >
          <div className="hbar-fill" style={{ width: pct(inside) }} />
          {over > 0 ? <div className="hbar-fill hbar-fill-danger" style={{ width: pct(over) }} /> : null}
        </div>
        {available > 0 ? (
          <span
            className="bar-tick"
            title={`headroom ${rupees(available)}`}
            style={{ left: pct(available) }}
          />
        ) : null}
      </div>
      <div
        className="headroom-line"
        style={{ marginTop: 4, fontSize: 10.5 }}
      >
        <span className="mono">0</span>
        <span className="mono">
          {available > 0 ? `headroom ${lakh(available)}` : `deficit ${lakh(Math.abs(headroom))}`}
          {over > 0 ? ` · request ${lakh(amount)}` : ""}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Request inbox
// ---------------------------------------------------------------------------

type InboxTab = "awaiting" | "approved" | "rejected" | "deferred" | "all";

const TABS: Array<{ id: InboxTab; label: string }> = [
  { id: "awaiting", label: "Awaiting you" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "deferred", label: "Deferred" },
  { id: "all", label: "All" },
];

function tabOf(status: SpendRequest["status"]): InboxTab | null {
  switch (status) {
    case "escalated":
      return "awaiting";
    case "approved":
    case "paid":
      return "approved";
    case "rejected":
      return "rejected";
    case "cancelled":
      return "deferred";
    default:
      return null;
  }
}

const INBOX_COLUMNS = "58px minmax(0, 0.9fr) minmax(0, 1fr) 76px 92px minmax(0, 1.3fr) 54px 92px";

function RequestInbox({
  decisions,
  openDecision,
}: {
  decisions: DecisionView[];
  openDecision: (id: string) => void;
}) {
  const [tab, setTab] = useState<InboxTab>("awaiting");
  const latest = useMemo(() => latestPerRequest(decisions), [decisions]);

  const counts = useMemo(() => {
    const c: Record<InboxTab, number> = { awaiting: 0, approved: 0, rejected: 0, deferred: 0, all: latest.length };
    for (const v of latest) {
      const t = tabOf(v.request.status);
      if (t) c[t] += 1;
    }
    return c;
  }, [latest]);

  // Default to the tab that needs attention, but never yank the user off a tab.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (touched) return;
    if (counts.awaiting === 0 && tab === "awaiting") setTab("all");
  }, [counts.awaiting, tab, touched]);

  const rows = tab === "all" ? latest : latest.filter((v) => tabOf(v.request.status) === tab);

  const [reevalPending, setReevalPending] = useState<string | null>(null);
  const [reevalError, setReevalError] = useState<string | null>(null);

  async function reevaluate(requestId: string): Promise<void> {
    if (reevalPending !== null) return;
    setReevalPending(requestId);
    setReevalError(null);
    const res = await reevaluateRequest(requestId);
    if (!res.ok) setReevalError(`${requestId}: ${res.error ?? "re-evaluation was not recorded"}`);
    setReevalPending(null);
  }

  return (
    <Panel
      title="Request inbox"
      className="panel-auto"
      bodyClassName="panel-body-flush"
      right={<span className="panel-note">{plural(latest.length, "request")} · latest decision per request</span>}
    >
      <div
        style={{
          display: "flex",
          gap: 6,
          padding: "8px 14px",
          borderBottom: "1px solid var(--line)",
          flexWrap: "wrap",
        }}
        role="tablist"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`btn btn-sm${tab === t.id ? " btn-why" : " btn-ghost"}`}
            onClick={() => {
              setTouched(true);
              setTab(t.id);
            }}
          >
            {t.label} <span className="mono">{counts[t.id]}</span>
          </button>
        ))}
      </div>

      {reevalError !== null ? (
        <div className="inline-alert" role="alert" style={{ margin: 10 }}>
          <span className="inline-alert-title">Not recorded</span>
          <span className="inline-alert-body">{reevalError}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setReevalError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <Empty>{emptyLine(tab)}</Empty>
      ) : (
        <div className="tbl">
          <div className="tbl-head" style={{ gridTemplateColumns: INBOX_COLUMNS }} aria-hidden="true">
            <span>time</span>
            <span>department</span>
            <span>vendor</span>
            <span className="tbl-right">amount</span>
            <span>outcome</span>
            <span>reason</span>
            <span>actor</span>
            <span />
          </div>
          {rows.map((v) => {
            const deferred = v.request.status === "cancelled";
            const isPending = reevalPending === v.request.id;
            return (
              <div
                key={v.decision.id}
                role="button"
                tabIndex={0}
                className="tbl-row log-row-clickable"
                style={{ gridTemplateColumns: INBOX_COLUMNS, fontSize: 12 }}
                title={`${v.decision.id} · ${v.request.id} · open audit record`}
                onClick={() => openDecision(v.decision.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openDecision(v.decision.id);
                  }
                }}
              >
                <span className="mono tbl-dim">{clock(v.decision.createdAt)}</span>
                <span className="tbl-ellipsis">{v.departmentName}</span>
                <span className="tbl-ellipsis tbl-dim">{v.vendorName}</span>
                <span className="mono tbl-right">{lakh(v.request.amount)}</span>
                <span>
                  <span className={`outcome outcome-${v.decision.outcome}`}>
                    {deferred ? "DEFERRED" : v.decision.outcome}
                  </span>
                </span>
                <span className="tbl-ellipsis tbl-dim">{reasonLabel(v.decision.reasonCode)}</span>
                <span>
                  {v.decision.actor === "cfo" ? (
                    <span className="tag-human">CFO</span>
                  ) : (
                    <span className="tag-agent">Agent</span>
                  )}
                </span>
                <span style={{ textAlign: "right" }}>
                  {deferred ? (
                    <button
                      type="button"
                      className={`btn btn-sm btn-why${isPending ? " btn-pending" : ""}`}
                      disabled={reevalPending !== null}
                      onClick={(e) => {
                        e.stopPropagation();
                        void reevaluate(v.request.id);
                      }}
                      title="Run this request through the engine again against today's forecast"
                    >
                      {isPending ? "Running…" : "Re-evaluate"}
                    </button>
                  ) : v.decision.supersedes ? (
                    <span className="log-open" title={`supersedes ${v.decision.supersedes}`}>
                      +history
                    </span>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function emptyLine(tab: InboxTab): string {
  switch (tab) {
    case "awaiting":
      return "Nothing awaiting you — the agent is operating within authority.";
    case "approved":
      return "No approvals yet this session.";
    case "rejected":
      return "No rejections — no hard rule has been broken.";
    case "deferred":
      return "No deferred requests. Defer an escalation to re-run it later.";
    default:
      return "No requests yet — submit one on the right.";
  }
}

// ---------------------------------------------------------------------------
// 3. New request form with live pre-check
// ---------------------------------------------------------------------------

interface Submitted {
  decision: Decision;
  request: SpendRequest;
}

function NewRequestForm({ state, openDecision }: PageProps) {
  const departments = state.departments;
  const vendors = state.vendors;
  const horizon = Math.max(1, state.company.forecastHorizonWeeks);

  const [departmentId, setDepartmentId] = useState(departments[0]?.id ?? "");
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? "");
  const [category, setCategory] = useState("");
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [amountText, setAmountText] = useState("");
  const [week, setWeek] = useState(1);
  const [description, setDescription] = useState("");
  const [requestedBy, setRequestedBy] = useState("");

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Submitted | null>(null);

  // Keep selections valid if the department or vendor list changes underneath us.
  useEffect(() => {
    if (!departments.some((d) => d.id === departmentId)) setDepartmentId(departments[0]?.id ?? "");
  }, [departments, departmentId]);
  useEffect(() => {
    if (!vendors.some((v) => v.id === vendorId)) setVendorId(vendors[0]?.id ?? "");
  }, [vendors, vendorId]);

  // Prefill category from what the ledger has paid this vendor for, until the
  // user types their own.
  const inferred = useMemo(() => inferVendorCategory(state, vendorId), [state, vendorId]);
  useEffect(() => {
    if (!categoryTouched) setCategory(inferred ?? "");
  }, [inferred, categoryTouched]);

  const amount = parseRupees(amountText);
  const vendor = vendors.find((v) => v.id === vendorId);
  const preview = useMemo(
    () =>
      amount === null
        ? null
        : preCheck(state, { departmentId, vendorId, amount, category, expectedWeek: week }),
    [state, departmentId, vendorId, amount, category, week],
  );

  async function submit(): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    setSubmitted(null);
    const res = await submitRequest({
      idempotencyKey: crypto.randomUUID(),
      departmentId,
      vendorId,
      // Send whatever was typed; the server validator owns the message.
      amount: amount ?? Number(amountText),
      category: category.trim(),
      description: description.trim(),
      requestedBy: requestedBy.trim(),
      expectedWeek: week,
    });
    setPending(false);
    if (!res.ok || res.data === null) {
      setError(res.error ?? `HTTP ${res.status}`);
      return;
    }
    setSubmitted(res.data);
  }

  const weeks = Array.from({ length: horizon }, (_, i) => i + 1);

  return (
    <Panel
      title="New request"
      className="panel-auto"
      right={<span className="panel-note">real engine · decision in under a second</span>}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "10px 12px" }}
      >
        <Field label="Department">
          <select
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            disabled={pending || departments.length === 0}
            style={FIELD_STYLE}
          >
            {departments.length === 0 ? <option value="">No departments</option> : null}
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label={
            <>
              Vendor
              {vendor && vendor.invoiceCount === 0 ? (
                <span className="rule-sev" style={{ color: "var(--warn)" }}>
                  first-time vendor
                </span>
              ) : null}
            </>
          }
        >
          <select
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            disabled={pending || vendors.length === 0}
            style={FIELD_STYLE}
          >
            {vendors.length === 0 ? <option value="">No vendors</option> : null}
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.invoiceCount === 0 ? " (first-time)" : ""}
              </option>
            ))}
          </select>
        </Field>

        <Field label={`Category${!categoryTouched && inferred ? " · inferred from ledger" : ""}`}>
          <input
            value={category}
            onChange={(e) => {
              setCategoryTouched(true);
              setCategory(e.target.value);
            }}
            disabled={pending}
            placeholder="e.g. infrastructure"
            maxLength={120}
            style={FIELD_STYLE}
          />
        </Field>

        <Field label="Amount (whole rupees)">
          <input
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            disabled={pending}
            inputMode="numeric"
            placeholder="450000"
            style={FIELD_STYLE}
          />
          {amount !== null ? (
            <div className="state-delta" style={{ marginTop: 3 }}>
              {rupees(amount)} · {lakh(amount)}
            </div>
          ) : amountText.trim() ? (
            <div className="state-delta" style={{ marginTop: 3, color: "var(--warn)" }}>
              whole rupees only — no decimals
            </div>
          ) : null}
        </Field>

        <Field label="Cash leaves in">
          <select
            value={week}
            onChange={(e) => setWeek(Number(e.target.value))}
            disabled={pending}
            style={FIELD_STYLE}
          >
            {weeks.map((w) => {
              const fw = state.forecast.weeks.find((x) => x.week === w);
              return (
                <option key={w} value={w}>
                  week {w}
                  {fw ? ` · ${shortDate(fw.startDate)}` : ""}
                  {w === state.forecast.projectedMinimumWeek ? " · trough" : ""}
                </option>
              );
            })}
          </select>
        </Field>

        <Field label="Requested by">
          <input
            value={requestedBy}
            onChange={(e) => setRequestedBy(e.target.value)}
            disabled={pending}
            placeholder="name or email"
            maxLength={500}
            style={FIELD_STYLE}
          />
        </Field>

        <div style={{ gridColumn: "1 / -1" }}>
          <Field label="Description">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={pending}
              placeholder="What the money is for"
              maxLength={500}
              style={FIELD_STYLE}
            />
          </Field>
        </div>

        <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 10 }}>
          <button
            type="submit"
            className={`btn btn-why${pending ? " btn-pending" : ""}`}
            disabled={pending || departments.length === 0 || vendors.length === 0}
            style={{ minWidth: 160 }}
          >
            {pending ? "Deciding…" : "Submit to the engine"}
          </button>
          <span className="panel-note" style={{ whiteSpace: "normal" }}>
            Idempotent · a fresh key per submit, so a retry never double-reserves.
          </span>
        </div>
      </form>

      {error !== null ? (
        <div className="inline-alert" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
          <span className="inline-alert-title">Not accepted</span>
          <span className="inline-alert-body">{error}</span>
        </div>
      ) : null}

      {submitted !== null ? (
        <SubmittedResult result={submitted} openDecision={openDecision} />
      ) : null}

      <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <span className="audit-section-title" style={{ marginBottom: 0 }}>
            Preview — cash impact estimated
          </span>
          {preview ? (
            <>
              <span className={`outcome outcome-${preview.outcome}`}>{preview.outcome}</span>
              <span className="panel-note">{reasonLabel(preview.reasonCode)}</span>
            </>
          ) : null}
        </div>
        {preview ? (
          <>
            <RuleList rules={preview.rules} unchecked={preview.unchecked} />
            <div className="state-delta" style={{ marginTop: 6 }}>
              Runs the same rules engine on the last polled forecast; the server re-forecasts on
              submit. Headroom after: <span className="mono">{lakh(preview.headroomAfter)}</span>.
            </div>
          </>
        ) : (
          <Empty>Enter a whole-rupee amount to see which rules would pass.</Empty>
        )}
      </div>
    </Panel>
  );
}

function SubmittedResult({
  result,
  openDecision,
}: {
  result: Submitted;
  openDecision: (id: string) => void;
}) {
  const { decision, request } = result;
  return (
    <div className="esc-narration" style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
        <span className={`outcome outcome-${decision.outcome}`}>{decision.outcome}</span>
        <span className="mono" style={{ fontSize: 12.5 }}>
          {rupees(request.amount)}
        </span>
        <span className="panel-note">{reasonLabel(decision.reasonCode)}</span>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          style={{ marginLeft: "auto" }}
          onClick={() => openDecision(decision.id)}
        >
          Open audit record
        </button>
      </div>
      {decision.narration ?? decision.fallbackNarration}
      <span className="esc-narration-src">
        decision {decision.id} · request {request.id} · {clock(decision.createdAt)}
      </span>
    </div>
  );
}

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label style={{ display: "block", minWidth: 0 }}>
      <span style={FIELD_LABEL_STYLE}>{label}</span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// 4. Vendor directory
// ---------------------------------------------------------------------------

const VENDOR_COLUMNS = "minmax(0, 1.4fr) 88px 52px 72px 92px";

function VendorDirectory({ state }: PageProps) {
  const vendors: Vendor[] = state.vendors;
  const windowDays = state.company.rules.rollingWindowDays;
  return (
    <Panel
      title="Vendor directory"
      className="panel-auto"
      bodyClassName="panel-body-flush"
      right={<span className="panel-note">{plural(vendors.length, "vendor")}</span>}
    >
      {vendors.length === 0 ? (
        <Empty>No vendors on file.</Empty>
      ) : (
        <div className="tbl">
          <div className="tbl-head" style={{ gridTemplateColumns: VENDOR_COLUMNS }} aria-hidden="true">
            <span>vendor</span>
            <span>first seen</span>
            <span className="tbl-right">inv.</span>
            <span className="tbl-right">avg</span>
            <span className="tbl-right">agent · {windowDays}d</span>
          </div>
          {vendors.map((v) => {
            const spend = vendorWindowSpend(state, v.id);
            return (
              <div
                key={v.id}
                className="tbl-row"
                style={{ gridTemplateColumns: VENDOR_COLUMNS, fontSize: 12 }}
                title={`${v.id} · ${plural(spend.count, "approved request")} in the window · ${rupees(spend.total)} total`}
              >
                <span className="tbl-ellipsis">
                  {v.name}
                  {v.invoiceCount === 0 ? (
                    <span className="rule-sev" style={{ color: "var(--warn)" }}>
                      first-time
                    </span>
                  ) : null}
                </span>
                <span className="mono tbl-dim">{v.firstSeen === null ? "never" : shortDate(v.firstSeen)}</span>
                <span className="mono tbl-right">{v.invoiceCount}</span>
                <span className="mono tbl-right">{v.avgAmount > 0 ? lakh(v.avgAmount) : "—"}</span>
                <span className="mono tbl-right">{spend.autonomous > 0 ? lakh(spend.autonomous) : "—"}</span>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 5. Department budgets
// ---------------------------------------------------------------------------

function DepartmentBudgets({ state, openDecision }: PageProps) {
  const departments: Department[] = state.departments;
  const overage = Math.max(0, state.company.rules.maxBudgetOverage);
  const ceiling = 1 + overage;
  const maxRatio = departments.reduce((m, d) => {
    const r = d.quarterlyBudget > 0 ? d.periodSpend / d.quarterlyBudget : 0;
    return Math.max(m, r);
  }, 0);
  const scaleMax = Math.max(ceiling, maxRatio) * 1.04;
  const pos = (ratio: number) => `${(clamp01(ratio / scaleMax) * 100).toFixed(2)}%`;
  const agentApproved = agentApprovedViews(state.decisions).length;

  return (
    <Panel
      title="Department budgets"
      className="panel-auto"
      right={
        <span className="panel-note">
          <span className="tick-key" /> 100% · <span className="tick-key tick-key-ceiling" /> +
          {percent(overage)} ceiling · {plural(agentApproved, "agent approval")}
        </span>
      }
    >
      {departments.length === 0 ? (
        <Empty>No departments configured.</Empty>
      ) : (
        departments.map((d) => {
          const ratio = d.quarterlyBudget > 0 ? d.periodSpend / d.quarterlyBudget : 0;
          const ceilingRupees = Math.round(d.quarterlyBudget * ceiling);
          const remaining = ceilingRupees - d.periodSpend;
          const fill = ratio > ceiling ? "bar-fill-danger" : ratio > 0.85 ? "bar-fill-warn" : "";
          const pctColor = ratio > ceiling ? "var(--danger)" : ratio > 0.85 ? "var(--warn)" : "var(--text)";
          const approved = approvedForDepartment(state.decisions, d.id);

          return (
            <div className="dept" key={d.id} style={{ paddingBottom: 10 }}>
              <div className="dept-line">
                <span className="dept-name">{d.name}</span>
                <span className="dept-figures">
                  <span style={{ color: "var(--text)" }}>{lakh(d.periodSpend)}</span>
                  {" / "}
                  {lakh(d.quarterlyBudget)}
                  <span className="dept-pct" style={{ color: pctColor }}>
                    {percent(ratio)}
                  </span>
                </span>
              </div>
              <div
                className="bar bar-lg"
                role="img"
                aria-label={`${d.name}: ${percent(ratio)} of quarterly budget spent; ceiling ${rupees(ceilingRupees)}`}
              >
                <div className={`bar-fill ${fill}`} style={{ width: pos(ratio) }} />
                <span className="bar-tick" style={{ left: pos(1) }} />
                <span className="bar-tick bar-tick-ceiling" style={{ left: pos(ceiling) }} />
              </div>
              <div className="state-delta" style={{ marginTop: 5 }}>
                {remaining >= 0
                  ? `${lakh(remaining)} left under the ${lakh(ceilingRupees)} ceiling`
                  : `${lakh(-remaining)} over the ${lakh(ceilingRupees)} ceiling`}
                {" · "}
                {plural(approved.length, "approved request")} this session
              </div>
              {approved.length > 0 ? (
                <div style={{ marginTop: 4 }}>
                  {approved.map((v) => (
                    <button
                      key={v.decision.id}
                      type="button"
                      className="tbl-row"
                      style={{
                        gridTemplateColumns: "58px minmax(0, 1fr) 40px 76px",
                        padding: "3px 0",
                        fontSize: 11.5,
                        borderBottom: "none",
                      }}
                      onClick={() => openDecision(v.decision.id)}
                      title={`${v.decision.id} · open audit record`}
                    >
                      <span className="mono tbl-dim">{clock(v.decision.createdAt)}</span>
                      <span className="tbl-ellipsis tbl-dim">{v.vendorName} · {v.request.description}</span>
                      <span>
                        {v.decision.actor === "cfo" ? (
                          <span className="tag-human" style={{ fontSize: 9.5 }}>CFO</span>
                        ) : (
                          <span className="tag-agent">Agent</span>
                        )}
                      </span>
                      <span className="mono tbl-right">{lakh(v.request.amount)}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </Panel>
  );
}
