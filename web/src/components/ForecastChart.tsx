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
import { lakh, lakhSigned, rupees, shortDate, toLakhs } from "../format";

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
}

const OK = "#38b48b";
const DANGER = "#d9494f";
const AXIS = "#626f80";
const GRID = "#161d27";

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
  const domainMin = Math.max(0, Math.floor(lo - pad));
  const domainMax = Math.ceil(hi + pad);

  // Where the threshold sits as a 0..1 fraction from the top of the plot.
  // Both gradients switch colour exactly on that line.
  const span = domainMax - domainMin || 1;
  const cut = clamp01((domainMax - thresholdL) / span);

  const breachRows = rows.filter((r) => r.below);
  const breachFrom = breachRows[0]?.week;
  const breachTo = breachRows[breachRows.length - 1]?.week;

  const lastWeek = rows[rows.length - 1]?.week ?? 13;

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
          <span style={{ color: AXIS }}>
            <i className="swatch-sq" /> threshold {lakh(forecast.threshold)}
          </span>
        </div>
        <span className="panel-note">
          min {lakh(forecast.projectedMinimum)} · week{" "}
          {forecast.projectedMinimumWeek}
        </span>
      </div>

      <div className="chart-wrap">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 8, right: 20, bottom: 4, left: 4 }}>
            <defs>
              <linearGradient id="rw-stroke" x1="0" y1="0" x2="0" y2="1">
                <stop offset={cut} stopColor={OK} />
                <stop offset={cut} stopColor={DANGER} />
              </linearGradient>
              <linearGradient id="rw-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset={0} stopColor={OK} stopOpacity={0.3} />
                <stop offset={cut} stopColor={OK} stopOpacity={0.03} />
                <stop offset={cut} stopColor={DANGER} stopOpacity={0.06} />
                <stop offset={1} stopColor={DANGER} stopOpacity={0.3} />
              </linearGradient>
            </defs>

            <CartesianGrid stroke={GRID} vertical={false} />

            {breachFrom !== undefined && breachTo !== undefined ? (
              <ReferenceArea
                x1={breachFrom - 0.5}
                x2={breachTo + 0.5}
                fill={DANGER}
                fillOpacity={0.07}
                stroke={DANGER}
                strokeOpacity={0.22}
                strokeDasharray="2 3"
                ifOverflow="extendDomain"
              />
            ) : null}

            <XAxis
              dataKey="week"
              type="number"
              domain={[1, lastWeek]}
              ticks={rows.map((r) => r.week)}
              tickFormatter={(v: number) => `W${v}`}
              tick={{ fill: AXIS, fontSize: 11, fontFamily: "ui-monospace, monospace" }}
              axisLine={{ stroke: "#222c38" }}
              tickLine={false}
              tickMargin={8}
            />
            <YAxis
              domain={[domainMin, domainMax]}
              width={54}
              tickFormatter={(v: number) => `${v}L`}
              tick={{ fill: AXIS, fontSize: 11, fontFamily: "ui-monospace, monospace" }}
              axisLine={false}
              tickLine={false}
            />

            <ReferenceLine
              y={thresholdL}
              stroke={DANGER}
              strokeDasharray="5 4"
              strokeOpacity={0.85}
              label={{
                value: `SAFETY THRESHOLD ${lakh(forecast.threshold)}`,
                position: "insideTopRight",
                fill: DANGER,
                fontSize: 10.5,
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

function renderDot(props: DotRenderProps) {
  const { cx, cy, payload } = props;
  if (cx === undefined || cy === undefined || payload === undefined) {
    return <circle r={0} cx={0} cy={0} />;
  }
  const below = payload.below;
  return (
    <circle
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
