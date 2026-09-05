import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TooltipProps } from "recharts";
import type { Forecast, ForecastWeek } from "@shared/types";
import { lakh, lakhSigned, rupees, shortDate, toLakhs, weekLabel } from "../format";

interface ChartRow {
  week: number;
  closing: number;
  below: boolean;
  raw: ForecastWeek;
}

interface DotRenderProps {
  cx?: number;
  cy?: number;
  payload?: ChartRow;
  /** recharts supplies this; dropping it produces a key warning per dot. */
  key?: string | number;
}

const OK = "#38b48b";
const DANGER = "#d9494f";
const AXIS = "#8794a6";
const GRID = "#161d27";

/**
 * The plot rectangle is pinned rather than measured so the gradients can use
 * `userSpaceOnUse`: object-bounding-box units resolve against each painted
 * path's own bbox, which is *not* the plot, so the colour break landed well
 * away from the threshold line. These four numbers make it exact.
 *
 * CHART_HEIGHT must equal the content box of `.chart-wrap`.
 */
const CHART_HEIGHT = 284;
const MARGIN = { top: 8, right: 20, bottom: 4, left: 4 } as const;
const X_AXIS_HEIGHT = 30;
const PLOT_TOP = MARGIN.top;
const PLOT_BOTTOM = CHART_HEIGHT - MARGIN.bottom - X_AXIS_HEIGHT;

export function ForecastChart({ forecast }: { forecast: Forecast }) {
  const rows: ChartRow[] = forecast.weeks.map((w) => ({
    week: w.week,
    closing: toLakhs(w.closingCash),
    below: w.belowThreshold,
    raw: w,
  }));

  const thresholdL = toLakhs(forecast.threshold);
  const values = rows.map((r) => r.closing);
  const lo = Math.min(thresholdL, ...values);
  const hi = Math.max(thresholdL, ...values);
  const pad = Math.max(1.5, (hi - lo) * 0.22);
  // No clamp at zero: cash genuinely can go negative under a stress scenario,
  // and clipping it drew the line straight over the X-axis labels.
  const domainMin = Math.floor(lo - pad);
  const domainMax = Math.ceil(hi + pad);

  // Where the threshold sits as a 0..1 fraction of the plot rectangle. With
  // userSpaceOnUse this is the same fraction both gradients resolve against,
  // so the colour changes exactly on the dashed line.
  const span = domainMax - domainMin || 1;
  const cut = clamp01((domainMax - thresholdL) / span);

  const hasBreach = rows.some((r) => r.below);
  const firstWeek = rows[0]?.week ?? 1;
  const lastWeek = rows[rows.length - 1]?.week ?? 13;
  const breachRuns = contiguousRuns(rows);
  const showZeroLine = domainMin < 0 && domainMax > 0;

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">13-Week Cash Forecast</span>
        <div className="chart-legend">
          <span style={{ color: OK }}>
            <i className="swatch" /> above floor
          </span>
          <span style={{ color: DANGER }}>
            <i className="swatch" /> below floor
          </span>
        </div>
        <span className="panel-note">
          min {lakh(forecast.projectedMinimum)} ·{" "}
          {weekLabel(forecast.projectedMinimumWeek)}
        </span>
      </div>

      <div className="chart-wrap">
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <AreaChart data={rows} margin={{ ...MARGIN }}>
            <defs>
              <linearGradient
                id="rw-stroke"
                gradientUnits="userSpaceOnUse"
                x1={0}
                y1={PLOT_TOP}
                x2={0}
                y2={PLOT_BOTTOM}
              >
                <stop offset={cut} stopColor={OK} />
                <stop offset={cut} stopColor={DANGER} />
              </linearGradient>
              <linearGradient
                id="rw-fill"
                gradientUnits="userSpaceOnUse"
                x1={0}
                y1={PLOT_TOP}
                x2={0}
                y2={PLOT_BOTTOM}
              >
                {hasBreach ? (
                  <>
                    <stop offset={0} stopColor={OK} stopOpacity={0.3} />
                    <stop offset={cut} stopColor={OK} stopOpacity={0.03} />
                    <stop offset={cut} stopColor={DANGER} stopOpacity={0.06} />
                    <stop offset={1} stopColor={DANGER} stopOpacity={0.3} />
                  </>
                ) : (
                  // Nothing breaches: no part of this chart may read as red.
                  <>
                    <stop offset={0} stopColor={OK} stopOpacity={0.3} />
                    <stop offset={1} stopColor={OK} stopOpacity={0.02} />
                  </>
                )}
              </linearGradient>
            </defs>

            <CartesianGrid stroke={GRID} vertical={false} />

            {/* One band per contiguous run, so a recovery week is never
                painted as if it had breached. */}
            {breachRuns.map((run) => (
              <ReferenceArea
                key={`breach-${run.from}-${run.to}`}
                x1={Math.max(firstWeek, run.from - 0.5)}
                x2={Math.min(lastWeek, run.to + 0.5)}
                fill={DANGER}
                fillOpacity={0.07}
                stroke={DANGER}
                strokeOpacity={0.22}
                strokeDasharray="2 3"
                ifOverflow="hidden"
              />
            ))}

            <XAxis
              dataKey="week"
              type="number"
              domain={[firstWeek, lastWeek]}
              height={X_AXIS_HEIGHT}
              ticks={rows.map((r) => r.week)}
              tickFormatter={(v: number) => `W${v}`}
              tick={{ fill: AXIS, fontSize: 12, fontFamily: "ui-monospace, monospace" }}
              axisLine={{ stroke: "#222c38" }}
              tickLine={false}
              tickMargin={8}
            />
            <YAxis
              domain={[domainMin, domainMax]}
              width={54}
              tickFormatter={(v: number) => `${v}L`}
              tick={{ fill: AXIS, fontSize: 12, fontFamily: "ui-monospace, monospace" }}
              axisLine={false}
              tickLine={false}
            />

            {showZeroLine ? (
              <ReferenceLine
                y={0}
                stroke="#5c6a7c"
                strokeWidth={1.4}
                ifOverflow="hidden"
                label={{
                  value: "ZERO",
                  position: "insideBottomRight",
                  fill: "#8794a6",
                  fontSize: 12,
                  fontFamily: "ui-monospace, monospace",
                  letterSpacing: 1.2,
                  dy: -4,
                }}
              />
            ) : null}

            <ReferenceLine
              y={thresholdL}
              stroke={DANGER}
              strokeDasharray="5 4"
              strokeOpacity={0.85}
              ifOverflow="hidden"
              label={{
                value: `SAFETY THRESHOLD ${lakh(forecast.threshold)}`,
                position: "insideTopRight",
                fill: DANGER,
                fontSize: 13,
                fontFamily: "ui-monospace, monospace",
                letterSpacing: 1.4,
                dy: -6,
              }}
            />

            <Tooltip
              content={<ForecastTooltip />}
              cursor={{ stroke: "#39465a", strokeWidth: 1 }}
            />

            <Area
              type="monotone"
              dataKey="closing"
              stroke="url(#rw-stroke)"
              strokeWidth={2.4}
              fill="url(#rw-fill)"
              dot={renderDot}
              activeDot={{ r: 5, strokeWidth: 2, stroke: "#0a0d12" }}
              isAnimationActive
              animationDuration={620}
              animationEasing="ease-out"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

/** Maximal runs of consecutive breaching weeks, in order. */
function contiguousRuns(rows: ChartRow[]): Array<{ from: number; to: number }> {
  const runs: Array<{ from: number; to: number }> = [];
  let from: number | null = null;
  let to = 0;

  for (const row of rows) {
    if (row.below) {
      if (from === null) from = row.week;
      to = row.week;
    } else if (from !== null) {
      runs.push({ from, to });
      from = null;
    }
  }
  if (from !== null) runs.push({ from, to });

  return runs;
}

function renderDot(props: DotRenderProps) {
  const { cx, cy, payload, key } = props;
  if (cx === undefined || cy === undefined || payload === undefined) {
    return <circle key={key} r={0} cx={0} cy={0} />;
  }
  const below = payload.below;
  return (
    <circle
      key={key}
      cx={cx}
      cy={cy}
      r={below ? 4 : 2.6}
      fill={below ? DANGER : "#0a0d12"}
      stroke={below ? "#0a0d12" : OK}
      strokeWidth={below ? 1.5 : 1.6}
    />
  );
}

function ForecastTooltip(props: TooltipProps<number, string>) {
  const { active, payload } = props;
  const first = payload && payload.length > 0 ? payload[0] : undefined;
  const row = first?.payload as ChartRow | undefined;
  if (!active || !row) return null;

  const w = row.raw;
  const outflow = w.payables + w.payroll + w.recurring + w.reservations;

  return (
    <div className="tip">
      <div className="tip-head">
        <span
          className="tip-week"
          style={{ color: w.belowThreshold ? DANGER : OK }}
        >
          Week {w.week}
        </span>
        <span className="tip-date">{shortDate(w.startDate)}</span>
      </div>

      <div className="tip-row">
        <span>opening</span>
        <b>{lakh(w.openingCash)}</b>
      </div>
      <div className="tip-row tip-row-in">
        <span>collections</span>
        <b>{lakhSigned(w.collections)}</b>
      </div>
      <div className="tip-row tip-row-out">
        <span>payables</span>
        <b>{lakhSigned(-w.payables)}</b>
      </div>
      <div className="tip-row tip-row-out">
        <span>payroll</span>
        <b>{lakhSigned(-w.payroll)}</b>
      </div>
      <div className="tip-row tip-row-out">
        <span>recurring</span>
        <b>{lakhSigned(-w.recurring)}</b>
      </div>
      <div className="tip-row tip-row-out">
        <span>reservations</span>
        <b>{lakhSigned(-w.reservations)}</b>
      </div>
      <div className="tip-row">
        <span>total outflow</span>
        <b>{lakhSigned(-outflow)}</b>
      </div>

      <div className="tip-row tip-total">
        <span>closing</span>
        <b style={{ color: w.belowThreshold ? DANGER : OK }}>
          {rupees(w.closingCash)}
        </b>
      </div>

      {w.belowThreshold ? (
        <div className="tip-flag">below safety threshold</div>
      ) : null}
    </div>
  );
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}
