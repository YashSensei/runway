/**
 * Collect — the receivables desk.
 *
 * Ageing header, the agent's last collection plan (ranked / chosen / skipped),
 * the full receivables table with manual chase and simulated replies, an
 * inline invoice timeline, and a per-customer reliability strip. Everything
 * is derived from `DashboardState`; writes go through `../api` and land on
 * the next poll.
 */

import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ActivityEntry, CollectionPlan, Invoice, ISODate, SentEmail } from "@shared/types";
import { chaseInvoice, injectReply } from "../api";
import { Empty, Panel } from "../components/Panel";
import { lakh, plural, rupees, shortDate, stamp, clock } from "../format";
import {
  ageingBucket,
  ageingTiles,
  bucketLabel,
  daysOverdue,
  expectedArrivalDate,
  groupByCustomer,
  horizonEnd,
  isAwaitingReply,
  isCommitted,
  outstanding,
  residual,
  residualArrivalDate,
  toneFromSubject,
  weekOf,
  withinHorizon,
} from "../lib/collectHelpers";
import type { AgeingBucket } from "../lib/collectHelpers";
import type { PageProps } from "./types";

const DEFAULT_REPLY_DATE = "2026-09-25";

type Filter = "all" | "overdue" | "chased" | "committed" | "sensitive";
type SortKey = "story" | "amount" | "overdue" | "week";
type SortDir = "asc" | "desc";

const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "overdue", label: "Overdue" },
  { id: "chased", label: "Chased" },
  { id: "committed", label: "Committed" },
  { id: "sensitive", label: "Sensitive" },
];

/** One receivable with everything the table and drawer need, computed once. */
interface Row {
  inv: Invoice;
  overdue: number;
  bucket: AgeingBucket;
  outstanding: number;
  residual: number;
  arrivalDate: ISODate;
  /** null => beyond the horizon, not counted by the forecast. */
  week: number | null;
  /** null when there is no breach to compare against. */
  beforeBreach: boolean | null;
  story: boolean;
}

const TABLE_COLS =
  "minmax(150px, 1.4fr) 90px 84px 92px 96px 132px 150px 104px 78px 190px";
const PLAN_COLS = "28px 90px minmax(120px, 1.1fr) 84px 72px 84px 128px 60px minmax(200px, 2fr)";
const SKIP_COLS = "90px minmax(120px, 1fr) minmax(200px, 3fr)";
const CUSTOMER_COLS = "minmax(160px, 1.4fr) 84px 96px 100px 84px 110px";

export default function CollectPage(props: PageProps) {
  const { state } = props;
  const invoices = state.invoices ?? [];
  const emails = state.emails ?? [];
  const activity = state.activity ?? [];
  const today = state.today;
  const anchor = state.company.anchorDate;
  const horizon = state.company.forecastHorizonWeeks;
  const breachWeek = state.forecast?.breachWeek ?? null;

  const [filter, setFilter] = useState<Filter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("story");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [openId, setOpenId] = useState<string | null>(null);

  // Chase state. A Set in a ref-free useState is fine here: one click, one id.
  const [pending, setPending] = useState<readonly string[]>([]);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [chaseError, setChaseError] = useState<{ id: string; error: string } | null>(null);

  // Simulated reply form.
  const formRef = useRef<HTMLDivElement | null>(null);
  const [replyInvoiceId, setReplyInvoiceId] = useState<string>("");
  const [replyAmount, setReplyAmount] = useState<string>("");
  const [replyDate, setReplyDate] = useState<string>(DEFAULT_REPLY_DATE);
  const [replyPending, setReplyPending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replyResult, setReplyResult] = useState<{ invoiceId: string; recovered: number } | null>(
    null,
  );

  const rows = useMemo<Row[]>(() => {
    return invoices
      .filter((inv) => inv.status !== "paid")
      .map((inv) => {
        const overdue = daysOverdue(inv.dueDate, today);
        const arrivalDate = expectedArrivalDate(inv);
        const week = weekOf(arrivalDate, anchor, horizon);
        const beforeBreach =
          breachWeek === null ? null : week !== null && week <= breachWeek;
        return {
          inv,
          overdue,
          bucket: ageingBucket(overdue),
          outstanding: outstanding(inv),
          residual: residual(inv),
          arrivalDate,
          week,
          beforeBreach,
          story: inv.chasedAt !== null || isCommitted(inv),
        };
      });
  }, [invoices, today, anchor, horizon, breachWeek]);

  const visible = useMemo(() => {
    const filtered = rows.filter((r) => {
      switch (filter) {
        case "overdue":
          return r.overdue > 0;
        case "chased":
          return r.inv.chasedAt !== null;
        case "committed":
          return isCommitted(r.inv);
        case "sensitive":
          return r.inv.sensitive === true;
        default:
          return true;
      }
    });
    const dir = sortDir === "asc" ? 1 : -1;
    const weekVal = (r: Row) => (r.week === null ? horizon + 1 : r.week);
    return filtered.sort((a, b) => {
      if (sortKey === "story") {
        return (
          Number(b.story) - Number(a.story) ||
          b.overdue - a.overdue ||
          b.outstanding - a.outstanding ||
          a.inv.id.localeCompare(b.inv.id)
        );
      }
      let d = 0;
      if (sortKey === "amount") d = a.inv.amount - b.inv.amount;
      else if (sortKey === "overdue") d = a.overdue - b.overdue;
      else d = weekVal(a) - weekVal(b);
      return d * dir || a.inv.id.localeCompare(b.inv.id);
    });
  }, [rows, filter, sortKey, sortDir, horizon]);

  const tiles = useMemo(() => ageingTiles(invoices, today), [invoices, today]);
  const totalOutstanding = rows.reduce((s, r) => s + r.outstanding, 0);
  const totalCommitted = rows.reduce(
    (s, r) => s + (isCommitted(r.inv) ? r.inv.committedAmount ?? 0 : 0),
    0,
  );
  const awaitingReply = rows.filter((r) => isAwaitingReply(r.inv)).length;

  const customers = useMemo(() => groupByCustomer(invoices), [invoices]);

  // Invoices a reply can still be simulated against: the engine refuses
  // anything already committed, so the select only offers open / overdue.
  const replyEligible = useMemo(
    () =>
      rows
        .filter((r) => !isCommitted(r.inv))
        .sort(
          (a, b) =>
            Number(b.inv.chasedAt !== null) - Number(a.inv.chasedAt !== null) ||
            b.overdue - a.overdue ||
            a.inv.id.localeCompare(b.inv.id),
        ),
    [rows],
  );
  const replyTarget =
    replyEligible.find((r) => r.inv.id === replyInvoiceId) ?? replyEligible[0] ?? null;
  const replyDefaultAmount = replyTarget ? replyTarget.outstanding : 0;
  const replyAmountValue = replyAmount === "" ? String(replyDefaultAmount) : replyAmount;
  const replyAmountNum = Number(replyAmountValue);
  const replyDateOk = withinHorizon(replyDate, anchor, horizon);
  const replyAmountOk =
    Number.isFinite(replyAmountNum) &&
    replyAmountNum > 0 &&
    replyTarget !== null &&
    replyAmountNum <= replyTarget.outstanding;

  function sortBy(key: Exclude<SortKey, "story">) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function sortMark(key: SortKey): string {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ↑" : " ↓";
  }

  async function chase(inv: Invoice) {
    if (pending.includes(inv.id)) return;
    if (inv.sensitive && confirmId !== inv.id) {
      setConfirmId(inv.id);
      return;
    }
    setConfirmId(null);
    setChaseError(null);
    setPending((p) => [...p, inv.id]);
    const result = await chaseInvoice(inv.id);
    setPending((p) => p.filter((id) => id !== inv.id));
    if (!result.ok) {
      setChaseError({ id: inv.id, error: result.error ?? `HTTP ${result.status}` });
    }
  }

  function openReplyFor(inv: Invoice) {
    setReplyInvoiceId(inv.id);
    setReplyAmount("");
    setReplyError(null);
    setReplyResult(null);
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function submitReply() {
    if (!replyTarget || replyPending) return;
    if (!replyAmountOk) {
      setReplyError(
        `Amount must be between ₹1 and the outstanding ${rupees(replyTarget.outstanding)}.`,
      );
      return;
    }
    if (!replyDateOk) {
      setReplyError(
        `Date must fall inside the forecast horizon: ${anchor} to ${horizonEnd(anchor, horizon)}.`,
      );
      return;
    }
    setReplyPending(true);
    setReplyError(null);
    setReplyResult(null);
    const result = await injectReply({
      invoiceId: replyTarget.inv.id,
      amount: Math.trunc(replyAmountNum),
      date: replyDate,
    });
    setReplyPending(false);
    if (!result.ok) {
      setReplyError(result.error ?? `HTTP ${result.status}`);
      return;
    }
    setReplyResult({
      invoiceId: replyTarget.inv.id,
      recovered: result.data?.recovered ?? Math.trunc(replyAmountNum),
    });
    setReplyAmount("");
  }

  // Activity produced by the last simulated reply: the parsed reply itself,
  // then whatever the forecast did about it. All server-clocked.
  const replyActivity = useMemo<ActivityEntry[]>(() => {
    if (replyResult === null) return [];
    const parsed = [...activity]
      .filter(
        (a) => a.type === "reply_parsed" && detailInvoiceId(a) === replyResult.invoiceId,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!parsed) return [];
    return activity
      .filter(
        (a) =>
          a.createdAt >= parsed.createdAt &&
          (a.type === "reply_parsed" ||
            a.type === "commitment_recorded" ||
            a.type === "breach_cleared"),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, 4);
  }, [activity, replyResult]);

  return (
    <div className="page">
      {/* 1. Ageing header */}
      <div className="stats" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
        {tiles.map((t) => (
          <div className={`stat ${tileTone(t.bucket, t.count)}`} key={t.bucket}>
            <span className="stat-label">{bucketLabel(t.bucket)}</span>
            <span className="stat-value">{lakh(t.amount)}</span>
            <span className="stat-exact">
              {plural(t.count, "invoice")} · {rupees(t.amount)} outstanding
            </span>
          </div>
        ))}
      </div>
      <div
        className="mono"
        style={{
          display: "flex",
          gap: 18,
          flexWrap: "wrap",
          fontSize: 12.5,
          color: "var(--text-2)",
          padding: "0 2px",
        }}
      >
        <span>
          outstanding <b style={{ color: "var(--text)" }}>{lakh(totalOutstanding)}</b>{" "}
          <span style={{ color: "var(--text-3)" }}>({rupees(totalOutstanding)})</span>
        </span>
        <span>·</span>
        <span>
          committed <b style={{ color: "var(--ok)" }}>{lakh(totalCommitted)}</b>
        </span>
        <span>·</span>
        <span>
          chased, awaiting reply <b style={{ color: "var(--text)" }}>{awaitingReply}</b>
        </span>
        <span>·</span>
        <span style={{ color: "var(--text-3)" }}>
          ageing as of {shortDate(today)} (engine clock) · {plural(rows.length, "open invoice")}
        </span>
      </div>

      {/* 2. Collection plan */}
      <PlanPanel
        plan={state.lastCollectionPlan ?? null}
        invoices={invoices}
        onOpenInvoice={(id) => setOpenId(id)}
      />

      {/* 3. Receivables table */}
      <Panel
        title="Receivables"
        bodyClassName="panel-body-flush"
        right={
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`btn btn-sm ${filter === f.id ? "btn-why" : "btn-ghost"}`}
                onClick={() => setFilter(f.id)}
                aria-pressed={filter === f.id}
              >
                {f.label}
              </button>
            ))}
            {sortKey !== "story" ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setSortKey("story")}
                title="Back to the default order: chased and committed first, then days overdue"
              >
                Reset sort
              </button>
            ) : null}
            <span className="panel-note">{plural(visible.length, "row")}</span>
          </span>
        }
      >
        {chaseError !== null ? (
          <div className="inline-alert" role="alert" style={{ margin: 10 }}>
            <span className="inline-alert-title">Chase failed</span>
            <span className="inline-alert-body">
              <span className="mono">{chaseError.id}</span> — {chaseError.error}. Nothing was
              sent.
            </span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setChaseError(null)}>
              Dismiss
            </button>
          </div>
        ) : null}

        {visible.length === 0 ? (
          <Empty>
            {rows.length === 0 ? "Nothing outstanding" : `No invoices match “${filterLabel(filter)}”`}
          </Empty>
        ) : (
          <div className="tbl" style={{ overflowX: "auto" }}>
            <div className="tbl-head" style={{ gridTemplateColumns: TABLE_COLS }} aria-hidden="true">
              <span>customer</span>
              <span>invoice</span>
              <SortHead label="amount" active={sortKey === "amount"} mark={sortMark("amount")} onClick={() => sortBy("amount")} right />
              <span className="tbl-right">outstanding</span>
              <span>due</span>
              <SortHead label="days overdue" active={sortKey === "overdue"} mark={sortMark("overdue")} onClick={() => sortBy("overdue")} />
              <SortHead label="arrival week" active={sortKey === "week"} mark={sortMark("week")} onClick={() => sortBy("week")} />
              <span>status</span>
              <span>chased</span>
              <span>actions</span>
            </div>

            {visible.map((r) => {
              const isOpen = openId === r.inv.id;
              const isPending = pending.includes(r.inv.id);
              const confirming = confirmId === r.inv.id;
              const chaseDisabled = isPending || r.outstanding === 0;
              return (
                <div key={r.inv.id}>
                  <div
                    className="tbl-row"
                    role="button"
                    tabIndex={0}
                    aria-expanded={isOpen}
                    style={{
                      gridTemplateColumns: TABLE_COLS,
                      cursor: "pointer",
                      background: isOpen ? "var(--bg-raised)" : undefined,
                    }}
                    onClick={() => setOpenId(isOpen ? null : r.inv.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpenId(isOpen ? null : r.inv.id);
                      }
                    }}
                  >
                    <span className="tbl-ellipsis">
                      {r.inv.customer}
                      {r.inv.sensitive ? <span className="rule-sev">sensitive</span> : null}
                    </span>
                    <span className="mono tbl-dim">{r.inv.id}</span>
                    <span className="mono tbl-right">{lakh(r.inv.amount)}</span>
                    <span className="mono tbl-right" style={{ color: r.outstanding === 0 ? "var(--text-3)" : undefined }}>
                      {lakh(r.outstanding)}
                    </span>
                    <span className="mono tbl-dim inv-due">{shortDate(r.inv.dueDate)}</span>
                    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                      <span className="mono" style={{ minWidth: 26, textAlign: "right" }}>
                        {r.overdue}
                      </span>
                      <span className="chip">{r.bucket === "current" ? "current" : `${r.bucket}d`}</span>
                    </span>
                    <span className="mono" style={{ fontSize: 12 }}>
                      {r.week === null ? (
                        <span className="tbl-dim">beyond horizon</span>
                      ) : (
                        <>wk {r.week}</>
                      )}
                      {r.beforeBreach === null ? null : (
                        <span
                          style={{
                            marginLeft: 6,
                            color: r.beforeBreach ? "var(--ok)" : "var(--danger)",
                          }}
                        >
                          {r.beforeBreach ? "before breach" : "after breach"}
                        </span>
                      )}
                    </span>
                    <span>
                      <StatusChip inv={r.inv} />
                    </span>
                    <span className="mono tbl-dim" style={{ fontSize: 12 }}>
                      {r.inv.chasedAt !== null ? clock(r.inv.chasedAt) : "—"}
                    </span>
                    <span
                      style={{ display: "inline-flex", gap: 6, alignItems: "center" }}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      {confirming ? (
                        <>
                          <button
                            type="button"
                            className="btn btn-sm btn-reject"
                            onClick={() => void chase(r.inv)}
                            disabled={chaseDisabled}
                            title="This account is relationship-sensitive. The agent held it for you; this sends the chase in your name."
                          >
                            Confirm chase
                          </button>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmId(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className={`btn btn-sm ${isPending ? "btn-pending" : ""}`}
                            onClick={() => void chase(r.inv)}
                            disabled={chaseDisabled}
                            title={
                              r.outstanding === 0
                                ? "Fully committed — nothing left to chase"
                                : r.inv.sensitive
                                  ? "Sensitive account: the agent never auto-chases this. You can."
                                  : "Send a collection email now, using the agent's tone ladder"
                            }
                          >
                            {isPending ? "Sending…" : r.inv.sensitive ? "Chase (sensitive)" : "Chase now"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => openReplyFor(r.inv)}
                            disabled={isCommitted(r.inv)}
                            title={
                              isCommitted(r.inv)
                                ? "Already committed — the engine accepts one reply per invoice"
                                : "Pre-fill the reply form for this invoice"
                            }
                          >
                            Simulate reply
                          </button>
                        </>
                      )}
                    </span>
                  </div>

                  {isOpen ? (
                    <InvoiceDrawer
                      row={r}
                      emails={emails}
                      activity={activity}
                      anchor={anchor}
                      horizon={horizon}
                      breachWeek={breachWeek}
                      today={today}
                      openEmail={props.openEmail}
                      onClose={() => setOpenId(null)}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {/* 5 + 6. Simulate reply and customer reliability */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(320px, 5fr) minmax(0, 7fr)",
          gap: "var(--gap)",
          alignItems: "start",
        }}
      >
        <div ref={formRef}>
          <Panel
            title="Simulate customer reply"
            right={<span className="panel-note">demo input · real engine effect</span>}
          >
            {replyEligible.length === 0 ? (
              <Empty>Every open invoice already carries a commitment</Empty>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                <label>
                  <span className="field-label">Invoice (chased first)</span>
                  <select
                    className="field"
                    value={replyTarget?.inv.id ?? ""}
                    onChange={(e) => {
                      setReplyInvoiceId(e.target.value);
                      setReplyAmount("");
                      setReplyError(null);
                      setReplyResult(null);
                    }}
                  >
                    {replyEligible.map((r) => (
                      <option key={r.inv.id} value={r.inv.id}>
                        {r.inv.id} · {r.inv.customer} · {lakh(r.outstanding)}
                        {r.inv.chasedAt !== null ? " · chased" : ""}
                        {r.inv.sensitive ? " · sensitive" : ""}
                      </option>
                    ))}
                  </select>
                </label>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <label>
                    <span className="field-label">Amount (₹, partial allowed)</span>
                    <input
                      className="field"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={replyTarget?.outstanding ?? undefined}
                      step={1}
                      value={replyAmountValue}
                      onChange={(e) => {
                        setReplyAmount(e.target.value);
                        setReplyError(null);
                      }}
                    />
                  </label>
                  <label>
                    <span className="field-label">Commit date</span>
                    <input
                      className="field"
                      type="date"
                      value={replyDate}
                      min={anchor}
                      max={horizonEnd(anchor, horizon)}
                      onChange={(e) => {
                        setReplyDate(e.target.value);
                        setReplyError(null);
                      }}
                    />
                  </label>
                </div>

                {replyTarget !== null ? (
                  <p className="replay-note" style={{ fontSize: 12.5 }}>
                    {replyAmountOk && replyAmountNum < replyTarget.outstanding ? (
                      <>
                        <b>{lakh(replyAmountNum)}</b> will be committed for{" "}
                        <b>{replyDateOk ? shortDate(replyDate) : replyDate}</b>;{" "}
                        <b>{lakh(replyTarget.outstanding - Math.trunc(replyAmountNum))}</b> stays on
                        the customer&apos;s normal timeline (
                        {shortDate(residualArrivalDate(replyTarget.inv))},{" "}
                        {weekText(weekOf(residualArrivalDate(replyTarget.inv), anchor, horizon), horizon)}
                        ).
                      </>
                    ) : replyAmountOk ? (
                      <>
                        The full outstanding <b>{lakh(replyTarget.outstanding)}</b> will be committed
                        for <b>{replyDateOk ? shortDate(replyDate) : replyDate}</b> —{" "}
                        {weekText(weekOf(replyDate, anchor, horizon), horizon)}
                        {breachWeek !== null ? (
                          <>
                            ,{" "}
                            {landsText(weekOf(replyDate, anchor, horizon), breachWeek)}
                          </>
                        ) : null}
                        .
                      </>
                    ) : (
                      <>
                        Amount must be between ₹1 and {rupees(replyTarget.outstanding)}.
                      </>
                    )}
                    {!replyDateOk ? (
                      <span style={{ color: "var(--danger)" }}>
                        {" "}
                        Date is outside the horizon ({anchor} to {horizonEnd(anchor, horizon)}).
                      </span>
                    ) : null}
                  </p>
                ) : null}

                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    type="button"
                    className={`btn ${replyPending ? "btn-pending" : "btn-approve"}`}
                    style={{ padding: "7px 14px" }}
                    disabled={replyPending || !replyTarget || !replyAmountOk || !replyDateOk}
                    onClick={() => void submitReply()}
                  >
                    {replyPending ? "Recording…" : "Record reply"}
                  </button>
                  <span className="panel-note">
                    POST /api/demo/inject-reply · commits, re-forecasts, logs
                  </span>
                </div>

                {replyError !== null ? (
                  <div className="inline-alert" role="alert" style={{ marginBottom: 0 }}>
                    <span className="inline-alert-title">Not recorded</span>
                    <span className="inline-alert-body">{replyError}</span>
                  </div>
                ) : null}

                {replyResult !== null ? (
                  <div className="principle" style={{ marginTop: 0 }}>
                    Recovered <b className="mono">{lakh(replyResult.recovered)}</b> (
                    <span className="mono">{rupees(replyResult.recovered)}</span>) against{" "}
                    <span className="mono">{replyResult.invoiceId}</span>.
                    {replyActivity.length === 0 ? (
                      <div className="panel-note" style={{ marginTop: 6 }}>
                        waiting for the activity log to catch up…
                      </div>
                    ) : (
                      <dl className="kv kv-tight" style={{ marginTop: 8 }}>
                        {replyActivity.map((a) => (
                          <ActivityKv key={a.id} entry={a} />
                        ))}
                      </dl>
                    )}
                  </div>
                ) : null}
              </div>
            )}
          </Panel>
        </div>

        <Panel
          title="Customer reliability"
          bodyClassName="panel-body-flush"
          right={<span className="panel-note">{plural(customers.length, "customer")} · open ₹ desc</span>}
        >
          {customers.length === 0 ? (
            <Empty>No open receivables</Empty>
          ) : (
            <div className="tbl">
              <div className="tbl-head" style={{ gridTemplateColumns: CUSTOMER_COLS }} aria-hidden="true">
                <span>customer</span>
                <span className="tbl-right">invoices</span>
                <span className="tbl-right">avg lag</span>
                <span className="tbl-right">open</span>
                <span className="tbl-right">chased</span>
                <span className="tbl-right">committed</span>
              </div>
              {customers.map((c) => (
                <div className="tbl-row" key={c.customer} style={{ gridTemplateColumns: CUSTOMER_COLS }}>
                  <span className="tbl-ellipsis">
                    {c.customer}
                    {c.sensitive ? <span className="rule-sev">sensitive</span> : null}
                  </span>
                  <span className="mono tbl-right">{c.invoiceCount}</span>
                  <span
                    className="mono tbl-right"
                    style={{ color: c.avgLagDays > 30 ? "var(--warn)" : undefined }}
                    title={c.avgLagDays > 30 ? "Historically slow payer" : "Pays close to terms"}
                  >
                    {c.avgLagDays}d{c.avgLagDays > 30 ? " slow" : ""}
                  </span>
                  <span className="mono tbl-right">{lakh(c.openAmount)}</span>
                  <span className="mono tbl-right">
                    {c.chasedCount}/{c.invoiceCount}
                  </span>
                  <span className="mono tbl-right" style={{ color: c.committedAmount > 0 ? "var(--ok)" : "var(--text-3)" }}>
                    {c.committedAmount > 0 ? lakh(c.committedAmount) : "—"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collection plan
// ---------------------------------------------------------------------------

function PlanPanel({
  plan,
  invoices,
  onOpenInvoice,
}: {
  plan: CollectionPlan | null;
  invoices: readonly Invoice[];
  onOpenInvoice: (id: string) => void;
}) {
  const targets = plan?.targets ?? [];
  const skipped = plan?.skipped ?? [];
  const byId = new Map(invoices.map((i) => [i.id, i] as const));

  return (
    <Panel
      title="Last defence — what the agent ranked, chose and skipped"
      bodyClassName="panel-body-flush"
      right={
        plan === null ? (
          <span className="panel-note">not run</span>
        ) : plan.breachWeek === null ? (
          <span className="badge badge-ok">
            <i className="dot" />
            no breach at last run
          </span>
        ) : (
          <span className="panel-note">
            breach <b style={{ color: "var(--danger)" }}>week {plan.breachWeek}</b> · gap{" "}
            <b style={{ color: "var(--danger)" }}>{lakh(plan.gap)}</b> · chased{" "}
            <b style={{ color: "var(--agent)" }}>{lakh(plan.totalChased)}</b> across{" "}
            {plural(targets.length, "account")} · skipped {skipped.length}
          </span>
        )
      }
    >
      {plan === null ? (
        <Empty>No defence has run yet</Empty>
      ) : (
        <>
          <div className="more-row" style={{ paddingTop: 10 }}>
            chosen · ranked by score (timing 40% · size 30% · age 20% · reliability 10%)
          </div>
          {targets.length === 0 ? (
            <Empty>
              {plan.breachWeek === null
                ? "No breach, so nothing was chased — the agent does not chase for sport"
                : "Breach present but no eligible target"}
            </Empty>
          ) : (
            <div className="tbl" style={{ overflowX: "auto" }}>
              <div className="tbl-head" style={{ gridTemplateColumns: PLAN_COLS }} aria-hidden="true">
                <span>#</span>
                <span>invoice</span>
                <span>customer</span>
                <span className="tbl-right">amount</span>
                <span className="tbl-right">overdue</span>
                <span>arrival</span>
                <span>before breach</span>
                <span className="tbl-right">score</span>
                <span>rationale</span>
              </div>
              {targets.map((t, i) => (
                <button
                  type="button"
                  className="tbl-row"
                  key={t.invoice.id}
                  style={{ gridTemplateColumns: PLAN_COLS }}
                  onClick={() => onOpenInvoice(t.invoice.id)}
                  title="Open this invoice in the receivables table"
                >
                  <span className="mono tbl-dim">{i + 1}</span>
                  <span className="mono">{t.invoice.id}</span>
                  <span className="tbl-ellipsis">
                    {t.invoice.customer}
                    {t.invoice.sensitive ? <span className="rule-sev">sensitive</span> : null}
                  </span>
                  <span className="mono tbl-right">{lakh(t.invoice.amount)}</span>
                  <span className="mono tbl-right">{t.daysOverdue}d</span>
                  <span className="mono">wk {t.expectedArrivalWeek}</span>
                  <span className="mono" style={{ color: t.landsBeforeBreach ? "var(--ok)" : "var(--danger)" }}>
                    {t.landsBeforeBreach ? "yes — in time" : "no — too late"}
                  </span>
                  <span className="mono tbl-right">{t.score.toFixed(2)}</span>
                  <span className="tbl-ellipsis" title={t.rationale} style={{ color: "var(--text-2)" }}>
                    {t.rationale}
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="more-row" style={{ paddingTop: 12 }}>skipped · with the reason it gave</div>
          {skipped.length === 0 ? (
            <Empty>Nothing was skipped</Empty>
          ) : (
            <div className="tbl">
              <div className="tbl-head" style={{ gridTemplateColumns: SKIP_COLS }} aria-hidden="true">
                <span>invoice</span>
                <span>customer</span>
                <span>reason</span>
              </div>
              {skipped.map((s, i) => {
                const inv = byId.get(s.invoiceId);
                const sensitive = /sensitive/i.test(s.reason) || inv?.sensitive === true;
                return (
                  <button
                    type="button"
                    className="tbl-row"
                    key={`${s.invoiceId}-${i}`}
                    style={{ gridTemplateColumns: SKIP_COLS }}
                    onClick={() => onOpenInvoice(s.invoiceId)}
                  >
                    <span className="mono">{s.invoiceId}</span>
                    <span className="tbl-ellipsis">
                      {inv?.customer ?? <span className="tbl-dim">—</span>}
                      {sensitive ? <span className="rule-sev">sensitive</span> : null}
                    </span>
                    <span style={{ color: sensitive ? "var(--warn)" : "var(--text-2)" }}>{s.reason}</span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Invoice drawer — inline expansion beneath the row
// ---------------------------------------------------------------------------

function InvoiceDrawer({
  row,
  emails,
  activity,
  anchor,
  horizon,
  breachWeek,
  today,
  openEmail,
  onClose,
}: {
  row: Row;
  emails: readonly SentEmail[];
  activity: readonly ActivityEntry[];
  anchor: ISODate;
  horizon: number;
  breachWeek: number | null;
  today: ISODate;
  openEmail: (emailId: string) => void;
  onClose: () => void;
}) {
  const { inv } = row;
  const chases = emails
    .filter((e) => e.invoiceId === inv.id)
    .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  const replies = activity
    .filter((a) => a.type === "reply_parsed" && detailInvoiceId(a) === inv.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const committed = isCommitted(inv);
  const committedWeek = inv.committedDate ? weekOf(inv.committedDate, anchor, horizon) : null;
  const residualWeek = row.residual > 0 ? weekOf(residualArrivalDate(inv), anchor, horizon) : null;
  // `daysOverdue(a, b)` is max(0, b − a); swapped it counts days until due.
  const dueIn = daysOverdue(today, inv.dueDate);

  return (
    <div
      style={{
        borderBottom: "1px solid var(--line)",
        borderLeft: "2px solid var(--agent)",
        background: "var(--bg-inset)",
        padding: "12px 16px 14px",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
        <span className="audit-section-title" style={{ marginBottom: 0 }}>
          Invoice {inv.id} · {inv.customer}
        </span>
        <span className="mono" style={{ fontSize: 12, color: "var(--text-2)" }}>
          {lakh(inv.amount)} · {rupees(inv.amount)} · {inv.customerEmail}
        </span>
        <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: "auto" }} onClick={onClose}>
          Close
        </button>
      </div>

      <div>
        <Step n={1} done label={`Issued · ${shortDate(inv.issuedDate)}`}>
          Terms ran to {shortDate(inv.dueDate)} ({daysOverdue(inv.issuedDate, inv.dueDate)} days).
        </Step>

        <Step n={2} done={row.overdue > 0} label={`Due · ${shortDate(inv.dueDate)}`}>
          {row.overdue > 0 ? (
            <>
              <b style={{ color: "var(--danger)" }}>{row.overdue} days overdue</b> — ageing bucket{" "}
              {bucketLabel(row.bucket)}. Customer historically runs {inv.customerAvgLagDays} days late.
            </>
          ) : (
            <>
              Not yet due — {dueIn === 0 ? "due today" : `${dueIn} days to go`}. Customer historically runs{" "}
              {inv.customerAvgLagDays} days late.
            </>
          )}
        </Step>

        <Step n={3} done={inv.chasedAt !== null} label={inv.chasedAt !== null ? `Chased · ${clock(inv.chasedAt)}` : "Chased"}>
          {chases.length === 0 ? (
            inv.chasedAt !== null ? (
              <span className="tbl-dim">Marked chased at {stamp(inv.chasedAt)}; the email is not in this state payload.</span>
            ) : inv.sensitive ? (
              <span style={{ color: "var(--warn)" }}>
                Not chased — relationship-sensitive; the agent holds these for you.
              </span>
            ) : (
              <span className="tbl-dim">Not chased.</span>
            )
          ) : (
            <span style={{ display: "grid", gap: 4 }}>
              {chases.map((e) => {
                const tone = toneFromSubject(e.message.subject);
                return (
                  <span key={e.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span className="mono tbl-dim" style={{ fontSize: 11.5 }}>
                      {stamp(e.sentAt)}
                    </span>
                    <span className={`log-chip ${toneChipClass(tone)}`}>{tone ?? "unknown tone"}</span>
                    <span className={`log-chip ${e.result.simulated ? "log-chip-warn" : "log-chip-ok"}`}>
                      {e.result.simulated ? "simulated" : e.result.ok ? "transmitted" : "failed"}
                    </span>
                    <span className="tbl-ellipsis" style={{ maxWidth: 420 }} title={e.message.subject}>
                      {e.message.subject}
                    </span>
                    <button type="button" className="btn btn-sm btn-why" onClick={() => openEmail(e.id)}>
                      Open email
                    </button>
                  </span>
                );
              })}
            </span>
          )}
        </Step>

        <Step n={4} done={replies.length > 0} label="Reply">
          {replies.length === 0 ? (
            <span className="tbl-dim">
              {inv.chasedAt !== null && !committed ? "Awaiting reply." : "No reply recorded."}
            </span>
          ) : (
            <span style={{ display: "grid", gap: 3 }}>
              {replies.map((a) => (
                <span key={a.id}>
                  <span className="mono tbl-dim" style={{ fontSize: 11.5, marginRight: 8 }}>
                    {stamp(a.createdAt)}
                  </span>
                  {a.summary}
                </span>
              ))}
            </span>
          )}
        </Step>

        <Step n={5} done={committed} label="Committed">
          {committed ? (
            <>
              <b style={{ color: "var(--ok)" }}>{lakh(inv.committedAmount ?? 0)}</b> (
              <span className="mono">{rupees(inv.committedAmount ?? 0)}</span>) for{" "}
              <b>{inv.committedDate ? shortDate(inv.committedDate) : "—"}</b>
              {(inv.committedAmount ?? 0) < inv.amount ? " — a partial commitment" : " — in full"}.
            </>
          ) : (
            <span className="tbl-dim">No commitment yet.</span>
          )}
        </Step>

        <Step n={6} done label="Forecast effect">
          {committed ? (
            <>
              Committed {lakh(inv.committedAmount ?? 0)} lands{" "}
              <b>{weekText(committedWeek, horizon)}</b>
              {breachWeek !== null ? <> — {landsText(committedWeek, breachWeek)}</> : " — no breach in the current forecast"}.
            </>
          ) : (
            <>
              Expected on the customer&apos;s normal timeline: {shortDate(row.arrivalDate)},{" "}
              <b>{weekText(row.week, horizon)}</b>
              {breachWeek !== null ? <> — {landsText(row.week, breachWeek)}</> : " — no breach in the current forecast"}.
            </>
          )}
          {row.residual > 0 ? (
            <div style={{ marginTop: 4, color: "var(--warn)" }}>
              <b className="mono">{lakh(row.residual)}</b> still outstanding, expected{" "}
              {weekText(residualWeek, horizon)} ({shortDate(residualArrivalDate(inv))}) — still chaseable.
            </div>
          ) : null}
        </Step>
      </div>
    </div>
  );
}

function Step({
  n,
  done,
  label,
  children,
}: {
  n: number;
  done: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={`rule ${done ? "rule-pass" : ""}`}>
      <span className="rule-mark">{n}</span>
      <span className="rule-name" style={{ color: done ? "var(--text)" : undefined }}>
        {label}
        {!done ? <span className="rule-sev">pending</span> : null}
      </span>
      <span className="rule-detail" style={{ fontFamily: "var(--sans)", fontSize: 12.5 }}>
        {children}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function SortHead({
  label,
  active,
  mark,
  onClick,
  right,
}: {
  label: string;
  active: boolean;
  mark: string;
  onClick: () => void;
  right?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={right ? "tbl-right" : undefined}
      style={{
        font: "inherit",
        letterSpacing: "inherit",
        textTransform: "inherit",
        color: active ? "var(--agent)" : "inherit",
        padding: 0,
        textAlign: right ? "right" : "left",
        whiteSpace: "nowrap",
      }}
      title={`Sort by ${label}`}
    >
      {label}
      {mark}
    </button>
  );
}

function StatusChip({ inv }: { inv: Invoice }) {
  if (isCommitted(inv)) {
    const partial = (inv.committedAmount ?? 0) < inv.amount;
    return <span className="log-chip log-chip-ok">{partial ? "part committed" : "committed"}</span>;
  }
  if (inv.status === "overdue") return <span className="log-chip log-chip-danger">overdue</span>;
  if (inv.status === "paid") return <span className="log-chip">paid</span>;
  return <span className="log-chip">open</span>;
}

function ActivityKv({ entry }: { entry: ActivityEntry }) {
  return (
    <>
      <dt>
        {clock(entry.createdAt)} · {entry.type.replace(/_/g, " ")}
      </dt>
      <dd style={{ textAlign: "left", whiteSpace: "normal", fontFamily: "var(--sans)" }}>{entry.summary}</dd>
    </>
  );
}

function tileTone(bucket: AgeingBucket, count: number): string {
  if (count === 0) return "stat-neutral";
  switch (bucket) {
    case "90+":
      return "stat-danger";
    case "61-90":
    case "31-60":
      return "stat-warn";
    default:
      return "stat-neutral";
  }
}

function filterLabel(f: Filter): string {
  return FILTERS.find((x) => x.id === f)?.label ?? f;
}

function toneChipClass(tone: ReturnType<typeof toneFromSubject>): string {
  switch (tone) {
    case "gentle":
      return "log-chip-ok";
    case "firm":
      return "log-chip-warn";
    case "urgent":
      return "log-chip-danger";
    default:
      return "";
  }
}

function detailInvoiceId(entry: ActivityEntry): string | null {
  const v = entry.detail?.invoiceId;
  return typeof v === "string" ? v : null;
}

function weekText(week: number | null, horizon: number): string {
  return week === null ? `beyond the ${horizon}-week horizon, not counted` : `week ${week}`;
}

function landsText(week: number | null, breachWeek: number): string {
  if (week === null) return `after the week ${breachWeek} breach`;
  return week <= breachWeek ? `before the week ${breachWeek} breach` : `after the week ${breachWeek} breach`;
}
