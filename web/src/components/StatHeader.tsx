import type { ReactNode } from "react";
import type {
  BreachCleared,
  DashboardState,
  Forecast,
  ForecastWeek,
  Rupees,
} from "@shared/types";
import { hasWeek, lakh, rupees, shortDate, weekLabel } from "../format";
import { RollingNumber } from "./RollingNumber";

type Tone = "ok" | "warn" | "danger" | "neutral";

export function StatHeader({ state }: { state: DashboardState }) {
  const { company, forecast, reservedTotal, lastBreachCleared } = state;

  // The trough. `projectedMinimumWeek` is 0 until the first fold, in which
  // case there is no week to name.
  const troughWeek = forecast.projectedMinimumWeek;
  const trough = hasWeek(troughWeek)
    ? forecast.weeks.find((w) => w.week === troughWeek)
    : undefined;

  // The FIRST week under the floor. A different week from the trough, with a
  // different (smaller) shortfall — conflating the two misstates the figure.
  const breachWeekNo = forecast.breachWeek;
  const breachWeek =
    breachWeekNo !== null ? forecast.weeks.find((w) => w.week === breachWeekNo) : undefined;
  const shortfall = breachWeekShortfall(forecast, breachWeek);
  const troughIsBreachWeek = breachWeekNo !== null && troughWeek === breachWeekNo;

  const headroomTone = toneForHeadroom(forecast.headroom, forecast.threshold);
  const minTone: Tone = forecast.projectedMinimum < forecast.threshold ? "danger" : "ok";

  // "Available headroom: −₹5.6L" is incoherent. Below zero it is a deficit,
  // named as one, in absolute terms, with a word as well as a colour.
  const deficit = forecast.headroom < 0;
  const headroomAbs = Math.abs(forecast.headroom);

  return (
    <>
      <div className="stats">
        <Stat
          label="Current Cash"
          value={<RollingNumber value={company.currentCash} format={(v) => lakh(v)} />}
          exact={rupees(company.currentCash)}
          tone="neutral"
          foot={`${company.name} · ${company.forecastHorizonWeeks}-week horizon`}
        />
        <Stat
          label="Projected Minimum"
          value={<RollingNumber value={forecast.projectedMinimum} format={(v) => lakh(v)} />}
          exact={rupees(forecast.projectedMinimum)}
          tone={minTone}
          foot={
            trough
              ? `${weekLabel(troughWeek, true)} · ${shortDate(trough.startDate)}`
              : hasWeek(troughWeek)
                ? weekLabel(troughWeek, true)
                : "Lowest point across the horizon"
          }
        />
        <Stat
          label="Safety Threshold"
          value={<RollingNumber value={forecast.threshold} format={(v) => lakh(v)} />}
          exact={rupees(forecast.threshold)}
          tone="neutral"
          foot="Floor set by CFO policy · never breached knowingly"
        />
        <Stat
          label={deficit ? "Headroom Deficit" : "Available Headroom"}
          value={
            deficit ? (
              <>
                <RollingNumber value={headroomAbs} format={(v) => lakh(v)} />
                <span className="stat-suffix">short</span>
              </>
            ) : (
              <RollingNumber value={forecast.headroom} format={(v) => lakh(v)} />
            )
          }
          exact={deficit ? `${rupees(headroomAbs)} below the floor` : rupees(forecast.headroom)}
          tone={headroomTone}
          foot={
            deficit
              ? `No autonomous spend authority · ${rupees(reservedTotal)} already reserved`
              : `${rupees(reservedTotal)} reserved · ceiling ${lakh(
                  company.rules.maxAutonomousAmount,
                )} per request`
          }
        />
      </div>

      {breachWeekNo !== null ? (
        <div className="breach" role="alert">
          <span className="breach-icon">
            <WarningIcon />
          </span>
          <span className="breach-title">Projected Breach</span>
          <span className="breach-rule" />
          <span className="breach-body">
            Cash first drops below the floor in{" "}
            <span className="mono">{weekLabel(breachWeekNo)}</span>
            {breachWeek ? (
              <>
                {" "}
                (<span className="mono">{shortDate(breachWeek.startDate)}</span>)
              </>
            ) : null}
            , <span className="mono">{lakh(shortfall)}</span> short.{" "}
            {troughIsBreachWeek ? (
              <>
                That is also the worst point, closing at{" "}
                <span className="mono">{lakh(forecast.projectedMinimum)}</span> against the{" "}
                <span className="mono">{lakh(forecast.threshold)}</span> safety threshold.
              </>
            ) : (
              <>
                Worst point is {weekLabel(troughWeek)}
                {trough ? (
                  <>
                    {" "}
                    (<span className="mono">{shortDate(trough.startDate)}</span>)
                  </>
                ) : null}{" "}
                at <span className="mono">{lakh(forecast.projectedMinimum)}</span> —{" "}
                <span className="mono">{lakh(forecast.breachGap)}</span> below the{" "}
                <span className="mono">{lakh(forecast.threshold)}</span> safety threshold.
              </>
            )}{" "}
            Autonomous spend authority is suspended.
          </span>
        </div>
      ) : lastBreachCleared !== null ? (
        <div className="clear-banner clear-banner-recovered" title={recoveryTitle(lastBreachCleared)}>
          <CheckIcon />
          <span>
            <b>Breach cleared.</b> Agent recovered{" "}
            <span className="mono">{lakh(lastBreachCleared.recovered)}</span>
            {lastBreachCleared.customers.length > 0 ? (
              <> from {joinNames(lastBreachCleared.customers)}</>
            ) : null}
            ; projected minimum <span className="mono">{lakh(lastBreachCleared.before)}</span> →{" "}
            <span className="mono">{lakh(lastBreachCleared.after)}</span>.
            {" "}Now {lakh(forecast.projectedMinimum)}
            {hasWeek(troughWeek) ? ` in ${weekLabel(troughWeek)}` : ""},{" "}
            {lakh(Math.abs(forecast.headroom))} {forecast.headroom < 0 ? "below" : "above"} the
            floor.
          </span>
        </div>
      ) : (
        <div className="clear-banner">
          <CheckIcon />
          <span>
            No breach across the {company.forecastHorizonWeeks}-week horizon. Projected minimum{" "}
            {lakh(forecast.projectedMinimum)}
            {hasWeek(troughWeek) ? ` in ${weekLabel(troughWeek)}` : ""},{" "}
            {lakh(Math.abs(forecast.headroom))} {forecast.headroom < 0 ? "below" : "above"} the
            floor.
          </span>
        </div>
      )}
    </>
  );
}

/** "Acme", "Acme and Northwind", "Acme, Northwind and Kestrel". */
export function joinNames(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0] ?? "";
  const head = names.slice(0, -1).join(", ");
  return `${head} and ${names[names.length - 1] ?? ""}`;
}

function recoveryTitle(c: BreachCleared): string {
  return `Cleared ${c.at} · recovered ${rupees(c.recovered)} · projected minimum ${rupees(
    c.before,
  )} → ${rupees(c.after)}`;
}

/**
 * How far below the floor the FIRST breaching week closes.
 *
 * `Forecast.breachWeekShortfall` is the authoritative field; it is derived
 * here from the same week's closing balance when the payload predates it, so
 * the banner can never print `undefined` or silently fall back to the
 * trough's (larger) `breachGap`.
 */
function breachWeekShortfall(forecast: Forecast, breachWeek: ForecastWeek | undefined): Rupees {
  const declared = (forecast as Forecast & { breachWeekShortfall?: Rupees }).breachWeekShortfall;
  if (typeof declared === "number" && Number.isFinite(declared)) {
    return Math.max(0, declared);
  }
  if (breachWeek === undefined) return 0;
  return Math.max(0, forecast.threshold - breachWeek.closingCash);
}

function Stat({
  label,
  value,
  exact,
  tone,
  foot,
}: {
  label: string;
  value: ReactNode;
  exact: string;
  tone: Tone;
  foot: string;
}) {
  return (
    <div className={`stat stat-${tone}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-exact">{exact}</div>
      <div className="stat-foot">{foot}</div>
    </div>
  );
}

function toneForHeadroom(headroom: number, threshold: number): Tone {
  if (headroom <= 0) return "danger";
  if (headroom < threshold * 0.15) return "warn";
  return "ok";
}

function WarningIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3.6 22 20.4H2L12 3.6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M12 10v4.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <circle cx="12" cy="17.4" r="1.05" fill="currentColor" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="m7.8 12.2 2.9 2.9 5.5-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
