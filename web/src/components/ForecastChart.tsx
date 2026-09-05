import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
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
import { Empty, Panel } from "./Panel";

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
const PANEL_BG = "#0e131a";
const MONO = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace";

/**
 * The plot rectangle is pinned rather than measured so the gradients can use
 * `userSpaceOnUse`: object-bounding-box units resolve against each painted
 * path's own bbox, which is *not* the plot, so the colour break landed well
 * away from the threshold line. Margins and axis height are constants; the
 * overall height is measured from the wrapper so the chart fills whatever the
 * row gives it (the row height varies by viewport).
 */
const MARGIN = { top: 10, right: 16, bottom: 2, left: 0 } as const;
const X_AXIS_HEIGHT = 28;
const PLOT_TOP = MARGIN.top;

export function ForecastChart({ forecast }: { forecast: Forecast }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const height = useContentHeight(wrapRef);

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
  const pad = Math.max(1.5, (hi - lo) * 0.15);
  // No clamp at zero: cash genuinely can go negative under a stress scenario,
  // and clipping it drew the line straight over the X-axis labels.
  const scale = niceScale(lo - pad, hi + pad, 7);
  const domainMin = scale.min;
  const domainMax = scale.max;

  // Where the threshold sits as a 0..1 fraction of the plot rectangle. With
  // userSpaceOnUse this is the same fraction both gradients resolve against,
  // so the colour changes exactly on the dashed line.
  const span = domainMax - domainMin || 1;
  const cut = clamp01((domainMax - thresholdL) / span);
  const plotBottom = Math.max(PLOT_TOP + 1, height - MARGIN.bottom - X_AXIS_HEIGHT);

  const hasBreach = rows.some((r) => r.below);
  const firstWeek = rows[0]?.week ?? 1;
  const lastWeek = rows[rows.length - 1]?.week ?? 13;
  const breachRuns = contiguousRuns(rows);
  const showZeroLine = domainMin < 0 && domainMax > 0;

  return (
    <Panel
      title={`${forecast.weeks.length || 13}-Week Cash Forecast`}
      className="panel-fill"
      bodyClassName="panel-body-flush panel-body-chart"
      right={
        <>
          <span className="chart-legend">
            <span style={{ color: OK }}>
              <i className="swatch" /> above floor
            </span>
            <span style={{ color: DANGER }}>
              <i className="swatch" /> below floor
            </span>
          </span>
          <span className="panel-note">
            min {lakh(forecast.projectedMinimum)} ·{" "}
            {weekLabel(forecast.projectedMinimumWeek)}
          </span>
        </>
      }
    >
      <div className="chart-wrap" ref={wrapRef}>
        {rows.length === 0 ? (
          <Empty>No forecast weeks yet</Empty>
        ) : height > 40 ? (
          <ResponsiveContainer width="100%" height={height}>
            <AreaChart data={rows} margin={{ ...MARGIN }}>
              <defs>
                <linearGradient
                  id="rw-stroke"
                  gradientUnits="userSpaceOnUse"
                  x1={0}
                  y1={PLOT_TOP}
                  x2={0}
                  y2={plotBottom}
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
                  y2={plotBottom}
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
                tick={{ fill: AXIS, fontSize: 11.5, fontFamily: MONO }}
                axisLine={{ stroke: "#222c38" }}
                tickLine={false}
                tickMargin={7}
              />
              <YAxis
                domain={[domainMin, domainMax]}
                ticks={scale.ticks}
                width={50}
                tickFormatter={(v: number) => `${v}L`}
                tick={{ fill: AXIS, fontSize: 11.5, fontFamily: MONO }}
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
                    position: "insideBottomLeft",
                    fill: "#8794a6",
                    fontSize: 11,
                    fontFamily: MONO,
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
                label={
                  <ThresholdLabel text={`SAFETY THRESHOLD ${lakh(forecast.threshold)}`} />
                }
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
        ) : null}
      </div>
    </Panel>
  );
}

/**
 * The wrapper's content-box height, tracked live. The chart fills the row it
 * is given instead of hard-coding a height that only fits one viewport.
 */
function useContentHeight(ref: RefObject<HTMLDivElement>): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;

    const measure = () => {
      const next = Math.floor(el.clientHeight);
      setHeight((prev) => (prev === next ? prev : next));
    };

    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return height;
}

/**
 * Round tick values with a 1/2/5 step, so the axis reads 20L/30L/40L and not
 * 16L/31L/46L. The domain snaps outward to the nearest tick.
 */
function niceScale(
  lo: number,
  hi: number,
  targetTicks: number,
): { min: number; max: number; ticks: number[] } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { min: 0, max: 10, ticks: [0, 5, 10] };
  }
  const span = Math.max(hi - lo, 1);
  const rough = span / Math.max(1, targetTicks - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;

  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const count = Math.round((max - min) / step);
  const ticks: number[] = [];
  for (let i = 0; i <= count; i++) {
    ticks.push(Number((min + i * step).toFixed(6)));
  }
  return { min, max, ticks };
}

interface LabelViewBox {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/**
 * Sits just above the dashed line, flush right, on a dark pill — so the text
 * never reads as struck through. Drops below the line only when the line is
 * within a pill's height of the top of the plot.
 */
function ThresholdLabel({ text, viewBox }: { text: string; viewBox?: LabelViewBox }) {
  const x = viewBox?.x ?? 0;
  const y = viewBox?.y ?? 0;
  const width = viewBox?.width ?? 0;
  if (width <= 0) return null;

  const fontSize = 11;
  const w = Math.round(text.length * (fontSize * 0.64 + 1) + 18);
  const h = 18;
  const rx = Math.max(x + 2, x + width - w - 4);
  const above = y - h - 5;
  const ry = above < PLOT_TOP ? y + 5 : above;

  return (
    <g>
      <rect
        x={rx}
        y={ry}
        width={w}
        height={h}
        rx={3}
        fill={PANEL_BG}
        stroke={DANGER}
        strokeOpacity={0.45}
      />
      <text
        x={rx + w / 2}
        y={ry + h / 2 + 0.5}
        textAnchor="middle"
        dominantBaseline="central"
        fill={DANGER}
        fontSize={fontSize}
        fontFamily={MONO}
        fontWeight={600}
        letterSpacing={1}
      >
        {text}
      </text>
    </g>
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
