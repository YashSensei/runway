import { useEffect, useMemo, useState } from "react";
import type { DashboardState, ForecastWeek, Rupees } from "@shared/types";
import type { PageProps } from "./types";
import { hasWeek, lakh, lakhSigned, plural, rupees, shortDate, weekLabel } from "../format";
import { ForecastChart } from "../components/ForecastChart";
import { Empty, Panel } from "../components/Panel";
import {
  explainBreach,
  projectWhatIf,
  SCENARIOS,
  scenarioAvailable,
  weekBreakdown,
} from "../lib/forecastMath";
import type { Projection, ScenarioId, WeekLine, WhatIf } from "../lib/forecastMath";

const LAKH = 100_000;

export default function CashPage({ state }: PageProps) {
  const { forecast, company } = state;
  const horizon = Math.max(1, company.forecastHorizonWeeks);

  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);
  const chartHeight = useChartHeight();

  // --- What-if -------------------------------------------------------------
  const [amountText, setAmountText] = useState("");
  const [week, setWeek] = useState(() => Math.min(horizon, 4));
  const debouncedAmount = useDebounced(amountText, 300);
  const [scenarios, setScenarios] = useState<ReadonlySet<ScenarioId>>(() => new Set());

  const whatIf: WhatIf | null = useMemo(() => {
    const lakhs = Number(debouncedAmount.replace(/[,\s₹Ll]/g, ""));
    if (!Number.isFinite(lakhs) || lakhs <= 0) return null;
    return { amount: Math.round(lakhs * LAKH), week };
  }, [debouncedAmount, week]);

  const result = useMemo(
    () => projectWhatIf(state, whatIf, scenarios),
    [state, whatIf, scenarios],
  );
  const projection: Projection | null = result !== null && result.ok ? result.projection : null;
  const projectionError = result !== null && !result.ok ? result.error : null;

  const explanation = useMemo(() => explainBreach(state), [state]);
  const breakdown = useMemo(
    () => (selectedWeek === null ? null : weekBreakdown(state, selectedWeek)),
    [state, selectedWeek],
  );
  const selected = selectedWeek === null ? undefined : forecast.weeks.find((w) => w.week === selectedWeek);

  const toggleScenario = (id: ScenarioId) =>
    setScenarios((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="page page-cash">
      <div className="cash-grid">
        <div className="cash-main">
          <ForecastChart
            forecast={forecast}
            ghost={state.lastHealthyForecast}
            hypothetical={projection?.closings ?? null}
            height={chartHeight}
            onWeekClick={(w) => setSelectedWeek(w)}
          />

          <WeekTable
            forecast={forecast}
            projection={projection}
            selectedWeek={selectedWeek}
            onSelect={(w) => setSelectedWeek((prev) => (prev === w ? null : w))}
          />
        </div>

        <aside className="cash-side">
          {explanation !== null ? (
            <Panel
              title={`Why ${weekLabel(explanation.breachWeek)}?`}
              tier="primary"
              className="panel-auto"
              right={
                <span className="panel-note">
                  {lakh(explanation.drop)} drop from{" "}
                  {explanation.fromWeek === 0 ? "opening" : weekLabel(explanation.fromWeek)}
                </span>
              }
            >
              {explanation.contributors.length === 0 ? (
                <Empty>No dated outflows found between the high point and the breach.</Empty>
              ) : (
                <ol className="why-list">
                  {explanation.contributors.map((c, i) => (
                    <li key={`${c.label}-${c.week}-${i}`} className="why-row">
                      <span className="why-rank mono">{i + 1}</span>
                      <span className="why-body">
                        <span className="why-label">{c.label}</span>
                        <span className="why-detail">
                          {weekLabel(c.week)} · {c.detail}
                        </span>
                      </span>
                      <span className="mono why-amount">{lakh(c.amount)}</span>
                    </li>
                  ))}
                </ol>
              )}
              <p className="why-foot">
                Largest outflows and slipped inflows between the last high point and the first
                week under the {lakh(forecast.threshold)} floor. Shortfall that week:{" "}
                <span className="mono">{lakh(forecast.breachWeekShortfall)}</span>.
              </p>
            </Panel>
          ) : null}

          <Panel
            title="What if"
            tier="primary"
            className="panel-auto"
            right={
              projection !== null ? (
                <span className="chip chip-accent">
                  <i className="dot" />
                  hypothetical on
                </span>
              ) : (
                <span className="panel-note">client-side · never persisted</span>
              )
            }
          >
            <div className="whatif-form">
              <label className="whatif-field">
                <span className="whatif-label">approve amount (₹ lakh)</span>
                <input
                  className="field"
                  inputMode="decimal"
                  placeholder="e.g. 4.5"
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                  aria-label="Hypothetical amount in lakhs"
                />
              </label>
              <label className="whatif-field">
                <span className="whatif-label">cash leaves in</span>
                <select
                  className="field"
                  value={week}
                  onChange={(e) => setWeek(Number(e.target.value) || 1)}
                  aria-label="Hypothetical week"
                >
                  {forecast.weeks.length > 0
                    ? forecast.weeks.map((w) => (
                        <option key={w.week} value={w.week}>
                          week {w.week} · {shortDate(w.startDate)}
                        </option>
                      ))
                    : Array.from({ length: horizon }, (_, i) => (
                        <option key={i + 1} value={i + 1}>
                          week {i + 1}
                        </option>
                      ))}
                </select>
              </label>
            </div>

            <WhatIfVerdict state={state} whatIf={whatIf} projection={projection} error={projectionError} />

            <div className="scenario-list">
              <div className="audit-section-title">Scenarios</div>
              {SCENARIOS.map((s) => {
                const available = scenarioAvailable(state, s.id);
                return (
                  <label
                    key={s.id}
                    className={`scenario${available ? "" : " scenario-off"}`}
                    title={available ? s.describe : `${s.invoiceId} is not open in this ledger`}
                  >
                    <input
                      type="checkbox"
                      checked={scenarios.has(s.id)}
                      disabled={!available}
                      onChange={() => toggleScenario(s.id)}
                    />
                    <span className="scenario-label">{s.label}</span>
                    <span className="scenario-detail mono">{s.invoiceId}</span>
                  </label>
                );
              })}
              <p className="why-foot">
                Recurring costs are not in the API payload and are held at the engine's values:
                the hypothetical is computed as an exact per-week delta on the live forecast.
              </p>
            </div>
          </Panel>

          <Panel
            title={selected ? `Week ${selected.week} · ${shortDate(selected.startDate)}` : "Week detail"}
            tier="reference"
            className="panel-auto panel-drawer"
            bodyClassName="panel-body-flush"
            right={
              selected ? (
                <button type="button" className="link-btn" onClick={() => setSelectedWeek(null)}>
                  close
                </button>
              ) : undefined
            }
          >
            {selected === undefined || breakdown === null ? (
              <Empty>Click a week in the table or the chart to see what lands in it.</Empty>
            ) : (
              <WeekDrawer week={selected} lines={breakdown} />
            )}
          </Panel>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Week table
// ---------------------------------------------------------------------------

function WeekTable({
  forecast,
  projection,
  selectedWeek,
  onSelect,
}: {
  forecast: DashboardState["forecast"];
  projection: Projection | null;
  selectedWeek: number | null;
  onSelect: (week: number) => void;
}) {
  const withHyp = projection !== null;
  const below = forecast.weeks.filter((w) => w.belowThreshold).length;

  return (
    <Panel
      title="Week table"
      tier="primary"
      className="panel-auto"
      bodyClassName="panel-body-flush"
      right={
        <span className="panel-note">
          {plural(forecast.weeks.length, "week")} · floor {lakh(forecast.threshold)}
          {below > 0 ? ` · ${plural(below, "week")} below` : " · none below"}
        </span>
      }
    >
      {forecast.weeks.length === 0 ? (
        <Empty>No forecast weeks yet</Empty>
      ) : (
        <div className="tbl">
          <div className={`tbl-head wk-row${withHyp ? " wk-row-hyp" : ""}`} aria-hidden="true">
            <span>week</span>
            <span>dates</span>
            <span className="tbl-right">opening</span>
            <span className="tbl-right">collections</span>
            <span className="tbl-right">payables</span>
            <span className="tbl-right">payroll</span>
            <span className="tbl-right">recurring</span>
            <span className="tbl-right">reserved</span>
            <span className="tbl-right">closing</span>
            {withHyp ? <span className="tbl-right">what-if</span> : null}
          </div>
          {forecast.weeks.map((w, i) => {
            const hyp = projection?.closings[i];
            const hypBelow = hyp !== undefined && hyp < forecast.threshold;
            return (
              <button
                type="button"
                key={w.week}
                className={[
                  "tbl-row wk-row",
                  withHyp ? "wk-row-hyp" : "",
                  w.belowThreshold ? "wk-row-below" : "",
                  selectedWeek === w.week ? "wk-row-selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => onSelect(w.week)}
                aria-pressed={selectedWeek === w.week}
              >
                <span className="mono wk-week">W{w.week}</span>
                <span className="mono tbl-dim wk-dates">{weekRange(w)}</span>
                <span className="mono tbl-right tbl-dim">{lakh(w.openingCash)}</span>
                <span className="mono tbl-right wk-in">{w.collections === 0 ? "—" : lakhSigned(w.collections)}</span>
                <span className="mono tbl-right">{w.payables === 0 ? "—" : lakhSigned(-w.payables)}</span>
                <span className="mono tbl-right">{w.payroll === 0 ? "—" : lakhSigned(-w.payroll)}</span>
                <span className="mono tbl-right">{w.recurring === 0 ? "—" : lakhSigned(-w.recurring)}</span>
                <span className="mono tbl-right">{w.reservations === 0 ? "—" : lakhSigned(-w.reservations)}</span>
                <span className={`mono tbl-right wk-close${w.belowThreshold ? " wk-close-below" : ""}`}>
                  {lakh(w.closingCash)}
                  {w.belowThreshold ? <span className="wk-flag">below</span> : null}
                </span>
                {withHyp ? (
                  <span className={`mono tbl-right wk-hyp${hypBelow ? " wk-close-below" : ""}`}>
                    {hyp === undefined ? "—" : lakh(hyp)}
                    {hypBelow ? <span className="wk-flag">below</span> : null}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function weekRange(w: ForecastWeek): string {
  const start = shortDate(w.startDate);
  const endIso = addDaysIso(w.startDate, 6);
  return endIso === null ? start : `${start.slice(0, 6)} – ${shortDate(endIso).slice(0, 6)}`;
}

/** Local UTC day add for display only; the engine owns real bucketing. */
function addDaysIso(iso: string, days: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86_400_000;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Week drawer
// ---------------------------------------------------------------------------

function WeekDrawer({
  week,
  lines,
}: {
  week: ForecastWeek;
  lines: ReturnType<typeof weekBreakdown>;
}) {
  const inflowSum = lines.inflows.reduce((s, l) => s + l.amount, 0);
  const outflowSum = lines.outflows.reduce((s, l) => s + l.amount, 0);
  const reservedSum = lines.reservations.reduce((s, l) => s + l.amount, 0);

  return (
    <div className="drawer">
      <div className="drawer-summary">
        <span>
          opening <b className="mono">{lakh(week.openingCash)}</b>
        </span>
        <span>
          net <b className="mono">{lakhSigned(week.netChange)}</b>
        </span>
        <span>
          closing{" "}
          <b className={`mono ${week.belowThreshold ? "c-danger" : "c-ok"}`}>
            {lakh(week.closingCash)}
          </b>
          {week.belowThreshold ? <span className="wk-flag">below floor</span> : null}
        </span>
      </div>

      <DrawerSection
        title="Inflows"
        engineTotal={week.collections}
        listedTotal={inflowSum}
        lines={lines.inflows}
        emptyText="No collections expected this week."
        sign={1}
      />
      <DrawerSection
        title="Payables"
        engineTotal={week.payables + week.payroll - lines.steadyPayroll}
        listedTotal={outflowSum}
        lines={lines.outflows}
        emptyText="No dated bills this week."
        sign={-1}
      />
      <DrawerSection
        title="Reservations"
        engineTotal={week.reservations}
        listedTotal={reservedSum}
        lines={lines.reservations}
        emptyText="No approved-unpaid commitments land here."
        sign={-1}
      />

      <div className="drawer-section">
        <div className="drawer-title">
          <span>Steady costs</span>
          <span className="mono">{lakhSigned(-(lines.steadyPayroll + lines.steadyRecurring))}</span>
        </div>
        <div className="drawer-line">
          <span className="drawer-label">Payroll run-rate</span>
          <span className="drawer-detail">weekly</span>
          <span className="mono drawer-amount">{lakhSigned(-lines.steadyPayroll)}</span>
        </div>
        <div className="drawer-line">
          <span className="drawer-label">Recurring</span>
          <span className="drawer-detail">subscriptions and operations</span>
          <span className="mono drawer-amount">{lakhSigned(-lines.steadyRecurring)}</span>
        </div>
      </div>
    </div>
  );
}

function DrawerSection({
  title,
  engineTotal,
  listedTotal,
  lines,
  emptyText,
  sign,
}: {
  title: string;
  engineTotal: Rupees;
  listedTotal: Rupees;
  lines: WeekLine[];
  emptyText: string;
  sign: 1 | -1;
}) {
  const mismatch = Math.abs(engineTotal - listedTotal) > 0;
  return (
    <div className="drawer-section">
      <div className="drawer-title">
        <span>{title}</span>
        <span className="mono" title={mismatch ? `Listed ${rupees(listedTotal)} · forecast ${rupees(engineTotal)}` : undefined}>
          {engineTotal === 0 ? "—" : lakhSigned(sign * engineTotal)}
          {mismatch ? <span className="wk-flag">partial</span> : null}
        </span>
      </div>
      {lines.length === 0 ? (
        <div className="drawer-empty">{emptyText}</div>
      ) : (
        lines.map((l) => (
          <div className="drawer-line" key={l.id}>
            <span className="drawer-label">{l.label}</span>
            <span className="drawer-detail">
              {l.detail}
              {l.date !== null ? ` · ${shortDate(l.date)}` : ""}
            </span>
            <span className="mono drawer-amount">{lakhSigned(sign * l.amount)}</span>
          </div>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// What-if verdict
// ---------------------------------------------------------------------------

function WhatIfVerdict({
  state,
  whatIf,
  projection,
  error,
}: {
  state: DashboardState;
  whatIf: WhatIf | null;
  projection: Projection | null;
  error: string | null;
}) {
  const { forecast, company } = state;

  if (error !== null) {
    return (
      <div className="verdict verdict-danger">
        <span className="verdict-title">Could not compute</span>
        <span className="mono">{error}</span>
      </div>
    );
  }
  if (projection === null) {
    return (
      <div className="verdict verdict-idle">
        Live headroom <b className="mono">{lakh(forecast.headroom)}</b>
        {forecast.breachWeek !== null ? (
          <>
            {" "}
            · breach in <b className="mono">{weekLabel(forecast.breachWeek)}</b>
          </>
        ) : null}
        . Enter an amount or toggle a scenario.
      </div>
    );
  }

  const ceiling = company.rules.maxAutonomousAmount;
  const overCeiling = whatIf !== null && whatIf.amount > ceiling;
  const fits = whatIf !== null && !overCeiling && projection.headroom >= 0;

  let verdict: string;
  let tone: "ok" | "danger" | "warn";
  if (whatIf === null) {
    tone = projection.breachWeek === null ? "ok" : "danger";
    verdict = projection.breachWeek === null ? "no breach under this scenario" : `breach in ${weekLabel(projection.breachWeek)}`;
  } else if (overCeiling) {
    tone = "warn";
    verdict = `would escalate — ${lakh(whatIf.amount)} exceeds the ${lakh(ceiling)} per-request ceiling`;
  } else if (fits) {
    tone = "ok";
    verdict = `would fit — ${lakh(projection.headroom)} headroom remains`;
  } else {
    tone = "danger";
    verdict = `would escalate — insufficient headroom, ${lakh(Math.abs(projection.headroom))} short`;
  }

  return (
    <div className={`verdict verdict-${tone}`}>
      <div className="verdict-title">{verdict}</div>
      <div className="verdict-grid">
        <span>headroom</span>
        <span className="mono">
          {lakh(forecast.headroom)} → <b>{lakh(projection.headroom)}</b>
        </span>
        <span>projected minimum</span>
        <span className="mono">
          {lakh(forecast.projectedMinimum)} → <b>{lakh(projection.projectedMinimum)}</b>
          {hasWeek(projection.projectedMinimumWeek) ? ` · ${weekLabel(projection.projectedMinimumWeek)}` : ""}
        </span>
        <span>breach</span>
        <span className="mono">
          {forecast.breachWeek === null ? "none" : weekLabel(forecast.breachWeek)} →{" "}
          <b>{projection.breachWeek === null ? "none" : weekLabel(projection.breachWeek)}</b>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useDebounced(value: string, ms: number): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Chart takes ~38% of the viewport, clamped so 720p and 1080p both work. */
function useChartHeight(): number {
  const compute = () =>
    typeof window === "undefined" ? 360 : Math.min(440, Math.max(240, Math.round(window.innerHeight * 0.38)));
  const [h, setH] = useState(compute);
  useEffect(() => {
    const onResize = () => setH(compute());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return h;
}
