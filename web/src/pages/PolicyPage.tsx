/**
 * Policy — the CFO's rulebook (suggestions.md §2.4).
 *
 * Every `CfoRules` field as a sentence with the value inline as an input. The
 * impact of a change is previewed from the live forecast before anything is
 * saved; Save sends only the fields that differ. Presets fill the inputs and
 * nothing more.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { CfoRules, DecisionView, RuleId } from "@shared/types";
import { updateRules } from "../api";
import { clock, lakh, percent, plural, ruleLabel, weekLabel } from "../format";
import { Empty, Panel } from "../components/Panel";
import {
  parseRupees,
  policyImpact,
  ruleFailures,
  rulesPatch,
} from "../lib/spendHelpers";
import type { PageProps } from "./types";

const L = 100_000;

/** Presets fill the inputs; they never save. Balanced is the seed policy. */
const PRESETS: Record<"conservative" | "balanced" | "aggressive", CfoRules> = {
  conservative: {
    maxAutonomousAmount: 3 * L,
    rollingAuthorityPool: 6 * L,
    rollingWindowDays: 30,
    minCashThreshold: 30 * L,
    maxBudgetOverage: 0.05,
    requireVendorHistory: true,
    anomalyMultiplier: 1.5,
  },
  balanced: {
    maxAutonomousAmount: 5 * L,
    rollingAuthorityPool: 10 * L,
    rollingWindowDays: 30,
    minCashThreshold: 25 * L,
    maxBudgetOverage: 0.1,
    requireVendorHistory: true,
    anomalyMultiplier: 2,
  },
  aggressive: {
    maxAutonomousAmount: 8 * L,
    rollingAuthorityPool: 20 * L,
    rollingWindowDays: 30,
    minCashThreshold: 20 * L,
    maxBudgetOverage: 0.15,
    requireVendorHistory: true,
    anomalyMultiplier: 3,
  },
};

/** The editable text behind each input. Parsed on every render; never saved raw. */
interface Draft {
  maxAutonomousAmount: string;
  rollingAuthorityPool: string;
  rollingWindowDays: string;
  minCashThreshold: string;
  maxBudgetOveragePct: string;
  requireVendorHistory: boolean;
  anomalyMultiplier: string;
}

function draftFrom(rules: CfoRules): Draft {
  return {
    maxAutonomousAmount: String(rules.maxAutonomousAmount),
    rollingAuthorityPool: String(rules.rollingAuthorityPool),
    rollingWindowDays: String(rules.rollingWindowDays),
    minCashThreshold: String(rules.minCashThreshold),
    maxBudgetOveragePct: String(Math.round(rules.maxBudgetOverage * 1000) / 10),
    requireVendorHistory: rules.requireVendorHistory,
    anomalyMultiplier: String(rules.anomalyMultiplier),
  };
}

/** Null when any field does not parse; the Save button explains which. */
function parseDraft(d: Draft): { rules: CfoRules | null; problems: string[] } {
  const problems: string[] = [];
  const maxAutonomousAmount = parseRupees(d.maxAutonomousAmount);
  if (maxAutonomousAmount === null || maxAutonomousAmount <= 0) problems.push("per-request limit must be whole rupees above zero");
  const rollingAuthorityPool = parseRupees(d.rollingAuthorityPool);
  if (rollingAuthorityPool === null || rollingAuthorityPool <= 0) problems.push("pool must be whole rupees above zero");
  const minCashThreshold = parseRupees(d.minCashThreshold);
  if (minCashThreshold === null || minCashThreshold < 0) problems.push("threshold must be whole rupees");
  const windowDays = Number(d.rollingWindowDays);
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365) problems.push("window must be 1–365 days");
  const pct = Number(d.maxBudgetOveragePct);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) problems.push("overage must be 0–100%");
  const mult = Number(d.anomalyMultiplier);
  if (!Number.isFinite(mult) || mult < 1) problems.push("anomaly multiplier must be at least 1×");
  if (
    maxAutonomousAmount !== null &&
    rollingAuthorityPool !== null &&
    rollingAuthorityPool < maxAutonomousAmount
  ) {
    problems.push("pool is smaller than the per-request limit — no single request at the limit could ever be approved");
  }

  if (problems.length > 0 || maxAutonomousAmount === null || rollingAuthorityPool === null || minCashThreshold === null) {
    return { rules: null, problems };
  }
  return {
    rules: {
      maxAutonomousAmount,
      rollingAuthorityPool,
      rollingWindowDays: windowDays,
      minCashThreshold,
      maxBudgetOverage: Math.round(pct * 10) / 1000,
      requireVendorHistory: d.requireVendorHistory,
      anomalyMultiplier: Math.round(mult * 100) / 100,
    },
    problems,
  };
}

export default function PolicyPage(props: PageProps) {
  const { state, openDecision } = props;
  const current = state.company.rules;

  const [draft, setDraft] = useState<Draft>(() => draftFrom(current));
  const [baseline, setBaseline] = useState<CfoRules>(current);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // If the rules change on the server (another operator, a preset saved from
  // another tab), re-sync the draft unless the user has unsaved edits.
  useEffect(() => {
    const same = JSON.stringify(baseline) === JSON.stringify(current);
    if (same) return;
    const parsed = parseDraft(draft).rules;
    const dirty = parsed === null || Object.keys(rulesPatch(baseline, parsed)).length > 0;
    setBaseline(current);
    if (!dirty) setDraft(draftFrom(current));
  }, [current, baseline, draft]);

  const parsed = useMemo(() => parseDraft(draft), [draft]);
  const proposed = parsed.rules;
  const patch = useMemo(() => (proposed ? rulesPatch(current, proposed) : {}), [current, proposed]);
  const changed = Object.keys(patch).length;
  const impact = useMemo(
    () => (proposed ? policyImpact(state, proposed) : null),
    [state, proposed],
  );
  const failures = useMemo(() => ruleFailures(state.decisions), [state.decisions]);

  function set<K extends keyof Draft>(key: K, value: Draft[K]): void {
    setSaved(null);
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function save(): Promise<void> {
    if (pending || changed === 0) return;
    setPending(true);
    setError(null);
    setSaved(null);
    const res = await updateRules(patch);
    setPending(false);
    if (!res.ok) {
      setError(res.error ?? `HTTP ${res.status}`);
      return;
    }
    if (res.data?.rules) {
      setBaseline(res.data.rules);
      setDraft(draftFrom(res.data.rules));
    }
    setSaved(`${plural(changed, "field")} saved · the forecast re-runs on the next poll`);
  }

  return (
    <div className="page page-cols-7-5">
      <div className="stack min0">
        <Panel
          title="Rules"
          className="panel-auto"
          right={
            <>
              <span className="panel-note">presets fill, they do not save</span>
              {(Object.keys(PRESETS) as Array<keyof typeof PRESETS>).map((k) => (
                <button
                  key={k}
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={pending}
                  onClick={() => {
                    setSaved(null);
                    setDraft(draftFrom(PRESETS[k]));
                  }}
                >
                  {k[0]?.toUpperCase()}
                  {k.slice(1)}
                </button>
              ))}
            </>
          }
        >
          <p className="principle m-0 mb-3 fs-3">
            The limit is a ceiling on the agent's authority — not permission to approve.
          </p>

          <RuleCard
            ruleIds={["max_autonomous_amount"]}
            severity="soft"
            failures={failures}
            openDecision={openDecision}
            sentence={
              <>
                The agent may approve up to{" "}
                <RupeeInput
                  value={draft.maxAutonomousAmount}
                  onChange={(v) => set("maxAutonomousAmount", v)}
                  disabled={pending}
                  label="per-request limit in rupees"
                />{" "}
                per request.
              </>
            }
            explain="Above this the agent hands the request back — it never rejects on this rule. Below it, the agent still has to clear every other rule."
          />

          <RuleCard
            ruleIds={["aggregate_authority"]}
            severity="soft"
            failures={failures}
            openDecision={openDecision}
            sentence={
              <>
                …and at most{" "}
                <RupeeInput
                  value={draft.rollingAuthorityPool}
                  onChange={(v) => set("rollingAuthorityPool", v)}
                  disabled={pending}
                  label="rolling authority pool in rupees"
                />{" "}
                per department across any{" "}
                <SmallInput
                  value={draft.rollingWindowDays}
                  onChange={(v) => set("rollingWindowDays", v)}
                  disabled={pending}
                  width={44}
                  label="rolling window in days"
                />
                -day window.
              </>
            }
            explain="A per-request ceiling alone is not a ceiling: three ₹4L requests walk past a ₹5L limit. The pool caps the total, and repeated spend to one vendor is summed against the per-request limit to catch split purchases."
          />

          <RuleCard
            ruleIds={["min_cash_threshold", "headroom_check"]}
            severity="soft"
            failures={failures}
            openDecision={openDecision}
            sentence={
              <>
                Projected cash must never fall below{" "}
                <RupeeInput
                  value={draft.minCashThreshold}
                  onChange={(v) => set("minCashThreshold", v)}
                  disabled={pending}
                  label="cash safety threshold in rupees"
                />
                .
              </>
            }
            explain="Headroom is the gap between the forecast trough and this line. Every approval consumes it; a request that would cross it is escalated even when it is inside the limit."
          />

          <RuleCard
            ruleIds={["budget_overage"]}
            severity="hard"
            failures={failures}
            openDecision={openDecision}
            sentence={
              <>
                A department may exceed its quarterly budget by at most{" "}
                <SmallInput
                  value={draft.maxBudgetOveragePct}
                  onChange={(v) => set("maxBudgetOveragePct", v)}
                  disabled={pending}
                  width={48}
                  label="budget overage in percent"
                />
                %.
              </>
            }
            explain="Hard rule. Breaking it is a policy violation, so the outcome is REJECT — not a hand-back. The request is routed to you unchanged and no cash is reserved."
          />

          <RuleCard
            ruleIds={["require_vendor_history"]}
            severity="hard"
            failures={failures}
            openDecision={openDecision}
            sentence={
              <>
                First-time vendors{" "}
                <button
                  type="button"
                  className={`btn btn-sm${draft.requireVendorHistory ? " btn-why" : " btn-ghost"}`}
                  disabled={pending}
                  aria-pressed={draft.requireVendorHistory}
                  onClick={() => set("requireVendorHistory", !draft.requireVendorHistory)}
                >
                  {draft.requireVendorHistory ? "always" : "do not"}
                </button>{" "}
                require a human.
              </>
            }
            explain={
              draft.requireVendorHistory
                ? "Hard rule. A vendor with no invoice history cannot be paid autonomously, regardless of amount."
                : "Switched off: a vendor with no history is treated like any other. The engine will still apply every other rule."
            }
          />

          <RuleCard
            ruleIds={["anomaly_multiplier"]}
            severity="soft"
            failures={failures}
            openDecision={openDecision}
            sentence={
              <>
                Flag a request above{" "}
                <SmallInput
                  value={draft.anomalyMultiplier}
                  onChange={(v) => set("anomalyMultiplier", v)}
                  disabled={pending}
                  width={48}
                  label="anomaly multiplier"
                />
                × the category's historical average.
              </>
            }
            explain="Soft rule. The amount is legal and affordable but does not match the pattern, so the agent would rather you looked at it."
          />
        </Panel>
      </div>

      <div className="stack min0">
        <Panel
          title="Impact preview"
          className="panel-auto"
          right={
            <span className="panel-note">
              {changed === 0 ? "no unsaved changes" : `${plural(changed, "field")} changed`}
            </span>
          }
        >
          {proposed === null || impact === null ? (
            <div>
              {parsed.problems.map((p) => (
                <div key={p} className="inline-alert" role="alert">
                  <span className="inline-alert-title">Fix</span>
                  <span className="inline-alert-body">{p}</span>
                </div>
              ))}
            </div>
          ) : (
            <ImpactSummary state={state} current={current} proposed={proposed} impact={impact} openDecision={openDecision} />
          )}

          <div className="row mt-3 row-wrap">
            <button
              type="button"
              className={`btn btn-approve${pending ? " btn-pending" : ""}`}
              disabled={pending || changed === 0 || proposed === null}
              onClick={() => void save()}
              style={{ minWidth: 140 }}
            >
              {pending ? "Saving…" : changed === 0 ? "Nothing to save" : `Save ${plural(changed, "field")}`}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={pending || changed === 0}
              onClick={() => {
                setSaved(null);
                setDraft(draftFrom(current));
              }}
            >
              Revert
            </button>
            {saved !== null ? (
              <span className="chip chip-ok">
                <i className="dot" />
                {saved}
              </span>
            ) : null}
          </div>

          {error !== null ? (
            <div className="inline-alert mt-3 mb-0" role="alert">
              <span className="inline-alert-title">Not saved</span>
              <span className="inline-alert-body">{error}</span>
            </div>
          ) : null}
        </Panel>

        <PrecedenceLadder />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function RuleCard({
  ruleIds,
  severity,
  sentence,
  explain,
  failures,
  openDecision,
}: {
  ruleIds: RuleId[];
  severity: "hard" | "soft";
  sentence: ReactNode;
  explain: string;
  failures: Map<RuleId, DecisionView[]>;
  openDecision: (id: string) => void;
}) {
  // Two rules can share one card (threshold + headroom); dedupe the decisions.
  const hits = useMemo(() => {
    const seen = new Set<string>();
    const out: DecisionView[] = [];
    for (const id of ruleIds) {
      for (const v of failures.get(id) ?? []) {
        if (seen.has(v.decision.id)) continue;
        seen.add(v.decision.id);
        out.push(v);
      }
    }
    return out;
  }, [ruleIds, failures]);

  const [open, setOpen] = useState(false);

  return (
    <div className="dept" style={{ padding: "10px 0 12px" }}>
      <div className="fs-3 c-1">{sentence}</div>
      <div className="row mt-1 row-wrap">
        <span className={`chip ${severity === "hard" ? "c-danger" : "c-warn"}`}>
          {severity === "hard" ? "hard · fails to REJECT" : "soft · fails to ESCALATE"}
        </span>
        {ruleIds.map((id) => (
          <span key={id} className="chip">
            {ruleLabel(id)}
          </span>
        ))}
        <button
          type="button"
          className="btn btn-sm btn-ghost ml-auto"
          disabled={hits.length === 0}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          failed {hits.length === 1 ? "once" : `${hits.length} times`} this session
          {hits.length > 0 ? (open ? " · hide" : " · show") : ""}
        </button>
      </div>
      <div className="state-delta mt-1 fs-1 c-2">
        {explain}
      </div>
      {open && hits.length > 0 ? (
        <div className="tbl mt-1">
          {hits.map((v) => (
            <button
              key={v.decision.id}
              type="button"
              className="tbl-row"
              style={{ gridTemplateColumns: "58px minmax(0, 1fr) 76px 92px", padding: "4px 0" }}
              onClick={() => openDecision(v.decision.id)}
              title={`${v.decision.id} · open audit record`}
            >
              <span className="mono tbl-dim">{clock(v.decision.createdAt)}</span>
              <span className="tbl-ellipsis">
                {v.departmentName} · {v.vendorName} · {v.request.description}
              </span>
              <span className="mono tbl-right">{lakh(v.request.amount)}</span>
              <span>
                <span className={`outcome outcome-${v.decision.outcome}`}>{v.decision.outcome}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RupeeInput({
  value,
  onChange,
  disabled,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  label: string;
}) {
  const parsed = parseRupees(value);
  return (
    <span className="row-inline row-base">
      <span className="mono c-2">
        ₹
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        inputMode="numeric"
        aria-label={label}
        aria-invalid={parsed === null}
        className="field field-inline"
        style={{ width: 118 }}
      />
      <span className="mono c-3 fs-1">
        {parsed === null ? "?" : lakh(parsed)}
      </span>
    </span>
  );
}

function SmallInput({
  value,
  onChange,
  disabled,
  width,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  width: number;
  label: string;
}) {
  const bad = !Number.isFinite(Number(value)) || value.trim() === "";
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      inputMode="decimal"
      aria-label={label}
      aria-invalid={bad}
      className="field field-inline"
      style={{ width }}
    />
  );
}

// ---------------------------------------------------------------------------

function ImpactSummary({
  state,
  current,
  proposed,
  impact,
  openDecision,
}: {
  state: PageProps["state"];
  current: CfoRules;
  proposed: CfoRules;
  impact: ReturnType<typeof policyImpact>;
  openDecision: (id: string) => void;
}) {
  const f = state.forecast;
  const thresholdChanged = proposed.minCashThreshold !== current.minCashThreshold;
  const limitChanged =
    proposed.maxAutonomousAmount !== current.maxAutonomousAmount ||
    proposed.rollingAuthorityPool !== current.rollingAuthorityPool ||
    proposed.rollingWindowDays !== current.rollingWindowDays;
  const nothing = Object.keys(rulesPatch(current, proposed)).length === 0;

  const lines: ReactNode[] = [];

  if (thresholdChanged) {
    const dir = proposed.minCashThreshold < current.minCashThreshold ? "Lowering" : "Raising";
    const breachLine =
      impact.breachBefore !== null && impact.breachAfter === null
        ? ` and clears the ${weekLabel(impact.breachBefore)} breach`
        : impact.breachBefore === null && impact.breachAfter !== null
          ? ` and creates a breach in ${weekLabel(impact.breachAfter)}`
          : impact.breachBefore !== null && impact.breachAfter !== null && impact.breachAfter !== impact.breachBefore
            ? ` and moves the breach from ${weekLabel(impact.breachBefore)} to ${weekLabel(impact.breachAfter)}`
            : impact.breachAfter !== null
              ? `; the ${weekLabel(impact.breachAfter)} breach remains`
              : "";
    lines.push(
      <p key="threshold" className="replay-note m-0">
        {dir} the safety threshold to <b className="mono">{lakh(proposed.minCashThreshold)}</b>{" "}
        {impact.headroomAfter >= 0 ? "gives" : "leaves"} the agent{" "}
        <b className="mono">{lakh(impact.headroomAfter)}</b> of headroom
        {impact.headroomAfter < 0 ? " (a deficit — no authority)" : ""}
        {breachLine}. Trough stays at <span className="mono">{lakh(f.projectedMinimum)}</span> in{" "}
        {weekLabel(f.projectedMinimumWeek)}; only the line moves.
      </p>,
    );
  }

  if (limitChanged) {
    lines.push(
      <p key="limit" className="replay-note m-0">
        Per-request ceiling <b className="mono">{lakh(proposed.maxAutonomousAmount)}</b>, pool{" "}
        <b className="mono">{lakh(proposed.rollingAuthorityPool)}</b> per department per{" "}
        <b className="mono">{proposed.rollingWindowDays}d</b>.{" "}
        {state.escalations.length === 0
          ? "No open escalations to re-test against."
          : impact.nowFits.length === 0
            ? `None of the ${plural(state.escalations.length, "open escalation")} would newly fit.`
            : `${plural(impact.nowFits.length, "open escalation")} would now be inside the agent's authority — re-evaluate to let it act.`}
      </p>,
    );
  }

  if (thresholdChanged && !limitChanged && state.escalations.length > 0) {
    lines.push(
      <p key="fits" className="replay-note m-0">
        {impact.nowFits.length === 0
          ? `None of the ${plural(state.escalations.length, "open escalation")} would newly fit.`
          : `${plural(impact.nowFits.length, "open escalation")} would now fit — re-evaluate to let the agent act.`}
      </p>,
    );
  }

  if (proposed.maxBudgetOverage !== current.maxBudgetOverage) {
    lines.push(
      <p key="overage" className="replay-note m-0">
        Budget ceiling moves to <b className="mono">{percent(1 + proposed.maxBudgetOverage)}</b> of
        quarterly budget:{" "}
        {state.departments
          .map((d) => `${d.name} ${lakh(Math.round(d.quarterlyBudget * (1 + proposed.maxBudgetOverage)) - d.periodSpend)} left`)
          .join(" · ")}
        .
      </p>,
    );
  }

  if (proposed.requireVendorHistory !== current.requireVendorHistory) {
    lines.push(
      <p key="vendor" className="replay-note m-0">
        {proposed.requireVendorHistory
          ? "First-time vendors will be rejected outright until a human approves them."
          : `First-time vendors (${plural(state.vendors.filter((v) => v.invoiceCount === 0).length, "on file")}) will be judged on amount and cash alone.`}
      </p>,
    );
  }

  if (proposed.anomalyMultiplier !== current.anomalyMultiplier) {
    lines.push(
      <p key="anomaly" className="replay-note m-0">
        Requests above <b className="mono">{proposed.anomalyMultiplier}×</b> the category average
        will be flagged. The baselines live on the server, so this cannot be previewed here.
      </p>,
    );
  }

  return (
    <div className="stack-2">
      <dl className="kv kv-tight m-0">
        <dt>projected minimum</dt>
        <dd>
          {lakh(f.projectedMinimum)} <span className="kv-unit">{weekLabel(f.projectedMinimumWeek)}</span>
        </dd>
        <dt>threshold</dt>
        <dd>
          {lakh(current.minCashThreshold)}
          {thresholdChanged ? (
            <>
              <span className="kv-unit"> → </span>
              {lakh(proposed.minCashThreshold)}
            </>
          ) : null}
        </dd>
        <dt>headroom</dt>
        <dd>
          <span className={f.headroom < 0 ? "c-danger" : "c-1"}>{lakh(f.headroom)}</span>
          {thresholdChanged ? (
            <>
              <span className="kv-unit"> → </span>
              <span className={impact.headroomAfter < 0 ? "c-danger" : "c-ok"}>
                {lakh(impact.headroomAfter)}
              </span>
            </>
          ) : null}
        </dd>
        <dt>breach week</dt>
        <dd>
          {impact.breachBefore === null ? "none" : weekLabel(impact.breachBefore)}
          {thresholdChanged ? (
            <>
              <span className="kv-unit"> → </span>
              {impact.breachAfter === null ? "none" : weekLabel(impact.breachAfter)}
            </>
          ) : null}
        </dd>
      </dl>

      {nothing ? (
        <Empty>Edit a value or pick a preset — the effect appears here before anything is saved.</Empty>
      ) : (
        lines
      )}

      {impact.nowFits.length > 0 ? (
        <div className="tbl">
          <div className="more-row py-1">
            would now fit
          </div>
          {impact.nowFits.map((v) => (
            <button
              key={v.decision.id}
              type="button"
              className="tbl-row"
              style={{ gridTemplateColumns: "minmax(0, 1fr) 76px", padding: "4px 0" }}
              onClick={() => openDecision(v.decision.id)}
            >
              <span className="tbl-ellipsis">
                {v.departmentName} · {v.vendorName} · {v.request.description}
              </span>
              <span className="mono tbl-right">{lakh(v.request.amount)}</span>
            </button>
          ))}
        </div>
      ) : null}

      {impact.noLongerFits.length > 0 ? (
        <div className="state-delta c-warn">
          {plural(impact.noLongerFits.length, "open escalation")} that fits today would no longer fit.
        </div>
      ) : null}

      <div className="state-delta">
        Computed from the last polled forecast. Cash, pool and limit rules are exact against it;
        vendor and pattern rules need server data. Preview only — nothing is saved until you press Save.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const LADDER: Array<{ n: number; test: string; outcome: "REJECTED" | "ESCALATED" | "APPROVED"; note: string }> = [
  { n: 1, test: "Any hard rule fails", outcome: "REJECTED", note: "Department budget · Vendor history. A configured policy was broken." },
  { n: 2, test: "Exceeds authority — per request or aggregate", outcome: "ESCALATED", note: "Above the ceiling, past the pool, or the shape of a split purchase." },
  { n: 3, test: "Insufficient headroom or cash threshold", outcome: "ESCALATED", note: "Authority exists; using it would cross the safety line." },
  { n: 4, test: "Anomalous against history", outcome: "ESCALATED", note: "Legal and affordable, but does not match the pattern." },
  { n: 5, test: "Otherwise", outcome: "APPROVED", note: "Reserved against the forecast week; headroom is consumed immediately." },
];

function PrecedenceLadder() {
  return (
    <Panel title="Precedence ladder" className="panel-auto" right={<span className="panel-note">first match wins</span>}>
      <ol className="list stack-1">
        {LADDER.map((step, i) => (
          <li key={step.n} className="ladder-step">
            <span className="mono ladder-n" aria-label={`step ${step.n}`}>
              {step.n}
            </span>
            <span className="min0">
              <div className="fs-2 c-1">{step.test}</div>
              <div className="state-delta mt-1">
                {step.note}
              </div>
            </span>
            <span className="ta-r">
              <span className={`outcome outcome-${step.outcome}`}>{step.outcome}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="principle">
        Rejection means a policy you configured was broken. Escalation means the agent holds the
        authority to act and has judged that it should not.
      </p>
    </Panel>
  );
}
