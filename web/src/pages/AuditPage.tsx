import { useMemo, useState } from "react";
import type { DashboardState, DecisionView, Reservation } from "@shared/types";
import type { PageProps } from "./types";
import { clock, lakh, plural, reasonLabel, rupees, stamp } from "../format";
import { DecisionRecord, decisionLabel, decisionOrdinals } from "../components/DecisionDetail";
import { Empty, Panel } from "../components/Panel";

type Actor = "agent" | "cfo";

interface Filters {
  outcome: string | null;
  reason: string | null;
  department: string | null;
  actor: Actor | null;
}

const NO_FILTERS: Filters = { outcome: null, reason: null, department: null, actor: null };

export default function AuditPage({ state, param, navigate }: PageProps) {
  const ord = useMemo(() => decisionOrdinals(state.decisions), [state.decisions]);
  const overrides = state.decisions.filter((d) => d.decision.actor === "cfo").length;
  const reservedTotal = state.reservations.reduce((s, r) => s + r.amount, 0);
  const releasedTotal = state.reservations
    .filter((r) => r.releasedAt !== null)
    .reduce((s, r) => s + r.amount, 0);
  const heldTotal = reservedTotal - releasedTotal;

  const open = param === null ? null : state.decisions.find((d) => d.decision.id === param) ?? null;

  return (
    <div className="page page-audit">
      <div className="stats stats-5">
        <HeaderStat label="Decisions" value={String(state.decisions.length)} foot="every engine and CFO decision" />
        <HeaderStat
          label="CFO Overrides"
          value={String(overrides)}
          foot={overrides === 0 ? "the agent has not been overruled" : "decisions where the CFO overruled an escalation"}
          tone={overrides > 0 ? "warn" : "neutral"}
        />
        <HeaderStat label="Reserved" value={lakh(reservedTotal)} foot={rupees(reservedTotal)} />
        <HeaderStat label="Released" value={lakh(releasedTotal)} foot={rupees(releasedTotal)} />
        <HeaderStat
          label="Held"
          value={lakh(heldTotal)}
          foot={`${plural(state.reservations.filter((r) => r.releasedAt === null).length, "open reservation")}`}
          tone={heldTotal > 0 ? "ok" : "neutral"}
        />
      </div>

      {param !== null ? (
        <Panel
          title="Audit record"
          tier="primary"
          className="panel-auto"
          right={
            <>
              {open !== null ? (
                <span className="panel-note" title={`${open.decision.id} · ${open.request.id}`}>
                  {decisionLabel(ord, open)}
                </span>
              ) : null}
              <button type="button" className="link-btn" onClick={() => navigate("#/audit")}>
                ← back to ledger
              </button>
            </>
          }
        >
          {open === null ? (
            <Empty>
              Decision <span className="mono">{param}</span> is not in this ledger.
            </Empty>
          ) : (
            <div className="audit-page-record">
              <DecisionRecord
                view={open}
                decisions={state.decisions}
                onOpenDecision={(id) => navigate(`#/audit/${id}`)}
              />
            </div>
          )}
        </Panel>
      ) : null}

      <Ledger state={state} onOpen={(id) => navigate(`#/audit/${id}`)} />

      <HeadroomLedger state={state} onOpenRequest={(id) => navigate(`#/audit/${id}`)} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function HeaderStat({
  label,
  value,
  foot,
  tone = "neutral",
}: {
  label: string;
  value: string;
  foot: string;
  tone?: "ok" | "warn" | "danger" | "neutral";
}) {
  return (
    <div className={`stat stat-${tone}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value stat-value-sm">{value}</div>
      <div className="stat-foot">{foot}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Decision ledger
// ---------------------------------------------------------------------------

function Ledger({ state, onOpen }: { state: DashboardState; onOpen: (id: string) => void }) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const ord = useMemo(() => decisionOrdinals(state.decisions), [state.decisions]);

  const ordered = useMemo(
    () =>
      [...state.decisions].sort(
        (a, b) =>
          Date.parse(b.decision.createdAt) - Date.parse(a.decision.createdAt) ||
          b.decision.id.localeCompare(a.decision.id),
      ),
    [state.decisions],
  );

  const actorOf = (v: DecisionView): Actor => (v.decision.actor === "cfo" ? "cfo" : "agent");

  const rows = ordered.filter(
    (v) =>
      (filters.outcome === null || v.decision.outcome === filters.outcome) &&
      (filters.reason === null || v.decision.reasonCode === filters.reason) &&
      (filters.department === null || v.departmentName === filters.department) &&
      (filters.actor === null || actorOf(v) === filters.actor),
  );

  const outcomes = uniq(ordered.map((v) => v.decision.outcome));
  const reasons = uniq(ordered.map((v) => v.decision.reasonCode));
  const departments = uniq(ordered.map((v) => v.departmentName));
  const actors = uniq(ordered.map(actorOf));
  const active = Object.values(filters).some((f) => f !== null);

  const exportCsv = () => {
    const header = [
      "n",
      "decision_id",
      "request_id",
      "created_at",
      "actor",
      "department",
      "vendor",
      "amount_rupees",
      "outcome",
      "reason_code",
      "headroom_before",
      "headroom_after",
      "projected_min_before",
      "projected_min_after",
      "note",
      "supersedes",
    ];
    const lines = rows.map((v) =>
      [
        ord.decision.get(v.decision.id) ?? "",
        v.decision.id,
        v.request.id,
        v.decision.createdAt,
        actorOf(v),
        v.departmentName,
        v.vendorName,
        v.request.amount,
        v.decision.outcome,
        v.decision.reasonCode,
        v.decision.headroomBefore,
        v.decision.headroomAfter,
        v.decision.projectedMinimumBefore,
        v.decision.projectedMinimumAfter,
        v.decision.note ?? "",
        v.decision.supersedes ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
    download(`runway-decisions-${state.today}.csv`, [header.join(","), ...lines].join("\r\n"));
  };

  return (
    <Panel
      title="Decision ledger"
      tier="primary"
      className="panel-auto"
      bodyClassName="panel-body-flush"
      right={
        <>
          <span className="panel-note">
            {active ? `${rows.length} of ${ordered.length}` : plural(ordered.length, "decision")} · newest first
          </span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={exportCsv}
            disabled={rows.length === 0}
            title="Download the visible rows as CSV"
          >
            Export CSV
          </button>
        </>
      }
    >
      {ordered.length > 0 ? (
        <div className="filters">
          <FilterGroup
            label="outcome"
            options={outcomes}
            value={filters.outcome}
            onChange={(v) => setFilters((f) => ({ ...f, outcome: v }))}
          />
          <FilterGroup
            label="reason"
            options={reasons}
            value={filters.reason}
            format={reasonLabel}
            onChange={(v) => setFilters((f) => ({ ...f, reason: v }))}
          />
          <FilterGroup
            label="department"
            options={departments}
            value={filters.department}
            onChange={(v) => setFilters((f) => ({ ...f, department: v }))}
          />
          <FilterGroup
            label="actor"
            options={actors}
            value={filters.actor}
            format={(a) => (a === "cfo" ? "CFO override" : "agent")}
            onChange={(v) => setFilters((f) => ({ ...f, actor: v as Actor | null }))}
          />
          {active ? (
            <button type="button" className="link-btn" onClick={() => setFilters(NO_FILTERS)}>
              clear filters
            </button>
          ) : null}
        </div>
      ) : null}

      {ordered.length === 0 ? (
        <Empty>No decisions yet — the ledger fills as requests are submitted.</Empty>
      ) : rows.length === 0 ? (
        <Empty>No decisions match these filters.</Empty>
      ) : (
        <div className="tbl">
          <div className="tbl-head ledger-row" aria-hidden="true">
            <span>#</span>
            <span>time</span>
            <span>actor</span>
            <span>department</span>
            <span>vendor</span>
            <span className="tbl-right">amount</span>
            <span>outcome</span>
            <span>reason</span>
            <span className="tbl-right">headroom</span>
          </div>
          {rows.map((v) => {
            const n = ord.decision.get(v.decision.id);
            const isOverride = v.decision.actor === "cfo";
            const supersededN =
              v.decision.supersedes !== undefined ? ord.decision.get(v.decision.supersedes) : undefined;
            return (
              <button
                key={v.decision.id}
                type="button"
                className={`tbl-row ledger-row${isOverride ? " ledger-row-override" : ""}`}
                onClick={() => onOpen(v.decision.id)}
                title={`${v.decision.id} · ${v.request.id} · open audit record`}
              >
                <span className="mono tbl-dim">{n ?? "?"}</span>
                <span className="mono tbl-dim" title={stamp(v.decision.createdAt)}>
                  {clock(v.decision.createdAt)}
                </span>
                <span>
                  {isOverride ? <span className="chip chip-override">CFO</span> : <span className="tag-agent">Agent</span>}
                </span>
                <span className="tbl-ellipsis">{v.departmentName}</span>
                <span className="tbl-ellipsis tbl-dim">{v.vendorName}</span>
                <span className="mono tbl-right">{lakh(v.request.amount)}</span>
                <span>
                  <span className={`outcome outcome-${v.decision.outcome}`}>{v.decision.outcome}</span>
                </span>
                <span className="tbl-ellipsis tbl-dim">
                  {reasonLabel(v.decision.reasonCode)}
                  {isOverride && v.decision.note ? (
                    <span className="ledger-note"> · “{v.decision.note}”</span>
                  ) : null}
                  {supersededN !== undefined ? (
                    <span className="ledger-note"> · re-evaluation of Decision {supersededN}</span>
                  ) : null}
                </span>
                <span className="mono tbl-right tbl-dim">
                  {lakh(v.decision.headroomBefore)} →{" "}
                  <span
                    style={{
                      color:
                        v.decision.headroomAfter < v.decision.headroomBefore
                          ? "var(--text)"
                          : v.decision.headroomAfter > v.decision.headroomBefore
                            ? "var(--ok)"
                            : "var(--text-2)",
                    }}
                  >
                    {lakh(v.decision.headroomAfter)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function FilterGroup({
  label,
  options,
  value,
  format,
  onChange,
}: {
  label: string;
  options: string[];
  value: string | null;
  format?: (v: string) => string;
  onChange: (v: string | null) => void;
}) {
  if (options.length <= 1) return null;
  return (
    <div className="filter-group">
      <span className="filter-label">{label}</span>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          className={`filter-chip${value === o ? " filter-chip-on" : ""}`}
          onClick={() => onChange(value === o ? null : o)}
          aria-pressed={value === o}
        >
          {format ? format(o) : o}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Headroom ledger — reservations as a bank statement
// ---------------------------------------------------------------------------

function HeadroomLedger({
  state,
  onOpenRequest,
}: {
  state: DashboardState;
  onOpenRequest: (decisionId: string) => void;
}) {
  const rows = useMemo(() => {
    const sorted = [...state.reservations].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
    );
    let running = 0;
    return sorted.map((r) => {
      if (r.releasedAt === null) running += r.amount;
      const view = state.decisions.find((d) => d.request.id === r.requestId);
      return { r, running, view };
    });
  }, [state.reservations, state.decisions]);

  const reserved = state.reservations.reduce((s, r) => s + r.amount, 0);
  const released = state.reservations.filter((r) => r.releasedAt !== null).reduce((s, r) => s + r.amount, 0);

  return (
    <Panel
      title="Headroom ledger"
      tier="reference"
      className="panel-auto"
      bodyClassName="panel-body-flush"
      right={
        <span className="panel-note">
          {plural(state.reservations.length, "reservation")} · {lakh(reserved)} reserved · {lakh(released)}{" "}
          released · {lakh(state.reservedTotal)} held now
        </span>
      }
    >
      {rows.length === 0 ? (
        <Empty>No reservations — nothing has been approved against headroom yet.</Empty>
      ) : (
        <div className="tbl">
          <div className="tbl-head res-row" aria-hidden="true">
            <span>created</span>
            <span>request</span>
            <span className="tbl-right">amount</span>
            <span>week</span>
            <span>released</span>
            <span className="tbl-right">consumed</span>
          </div>
          {rows.map(({ r, running, view }) => (
            <ReservationRow
              key={r.id}
              r={r}
              running={running}
              view={view}
              onOpen={view ? () => onOpenRequest(view.decision.id) : undefined}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

function ReservationRow({
  r,
  running,
  view,
  onOpen,
}: {
  r: Reservation;
  running: number;
  view: DecisionView | undefined;
  onOpen?: () => void;
}) {
  const inner = (
    <>
      <span className="mono tbl-dim" title={stamp(r.createdAt)}>
        {clock(r.createdAt)}
      </span>
      <span className="tbl-ellipsis">
        {view ? view.request.description : r.requestId}
        {view ? <span className="ledger-note"> · {view.departmentName}</span> : null}
      </span>
      <span className="mono tbl-right">{lakh(r.amount)}</span>
      <span className="mono tbl-dim">W{r.week}</span>
      <span className={r.releasedAt === null ? "res-held" : "tbl-dim"}>
        {r.releasedAt === null ? "held" : clock(r.releasedAt)}
      </span>
      <span className="mono tbl-right">{lakh(running)}</span>
    </>
  );
  return onOpen ? (
    <button type="button" className="tbl-row res-row" onClick={onOpen} title={`${r.id} · open decision`}>
      {inner}
    </button>
  ) : (
    <div className="tbl-row res-row" title={r.id}>
      {inner}
    </div>
  );
}

// ---------------------------------------------------------------------------

function uniq<T extends string>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function download(filename: string, text: string): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([`\uFEFF${text}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
