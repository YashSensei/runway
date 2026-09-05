import type { DashboardState } from "@shared/types";
import { lakh, rupees, shortDate } from "../format";

type Tone = "ok" | "warn" | "danger" | "neutral";

export function StatHeader({ state }: { state: DashboardState }) {
  const { company, forecast, reservedTotal } = state;

  const minWeek = forecast.weeks.find(
    (w) => w.week === forecast.projectedMinimumWeek,
  );

  const headroomTone = toneForHeadroom(forecast.headroom, forecast.threshold);
  const minTone: Tone =
    forecast.projectedMinimum < forecast.threshold ? "danger" : "ok";

  const breachWeek =
    forecast.breachWeek !== null
      ? forecast.weeks.find((w) => w.week === forecast.breachWeek)
      : undefined;

  return (
    <>
      <div className="stats">
        <Stat
          label="Current Cash"
          value={lakh(company.currentCash)}
          exact={rupees(company.currentCash)}
          tone="neutral"
          foot={`${company.name} · ${company.forecastHorizonWeeks}-week horizon`}
        />
        <Stat
          label="Projected Minimum"
          value={lakh(forecast.projectedMinimum)}
          exact={rupees(forecast.projectedMinimum)}
          tone={minTone}
          foot={
            minWeek
              ? `Week ${forecast.projectedMinimumWeek} · ${shortDate(minWeek.startDate)}`
              : `Week ${forecast.projectedMinimumWeek}`
          }
        />
        <Stat
          label="Safety Threshold"
          value={lakh(forecast.threshold)}
          exact={rupees(forecast.threshold)}
          tone="neutral"
          foot="Floor set by CFO policy · never breached knowingly"
        />
        <Stat
          label="Available Headroom"
          value={lakh(forecast.headroom)}
          exact={rupees(forecast.headroom)}
          tone={headroomTone}
          foot={`${rupees(reservedTotal)} reserved · ceiling ${lakh(
            company.rules.maxAutonomousAmount,
          )} per request`}
        />
      </div>

      {forecast.breachWeek !== null ? (
        <div className="breach" role="alert">
          <span className="breach-icon">
            <WarningIcon />
          </span>
          <span className="breach-title">Projected Breach</span>
          <span className="breach-rule" />
          <span className="breach-body">
            Week <span className="mono">{forecast.breachWeek}</span>
            {breachWeek ? (
              <>
                {" "}
                (<span className="mono">{shortDate(breachWeek.startDate)}</span>)
              </>
            ) : null}{" "}
            closes at <span className="mono">{lakh(forecast.projectedMinimum)}</span> —{" "}
            <span className="mono">{lakh(forecast.breachGap)}</span> below the{" "}
            <span className="mono">{lakh(forecast.threshold)}</span> safety
            threshold. Autonomous spend authority is suspended.
          </span>
        </div>
      ) : (
        <div className="clear-banner">
          <CheckIcon />
          <span>
            No breach across the {company.forecastHorizonWeeks}-week horizon.
            Projected minimum {lakh(forecast.projectedMinimum)} in week{" "}
            {forecast.projectedMinimumWeek}, {lakh(forecast.headroom)} above the
            floor.
          </span>
        </div>
      )}
    </>
  );
}

function Stat({
  label,
  value,
  exact,
  tone,
  foot,
}: {
  label: string;
  value: string;
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
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3.6 22 20.4H2L12 3.6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M12 10v4.4"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <circle cx="12" cy="17.4" r="1.05" fill="currentColor" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
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
