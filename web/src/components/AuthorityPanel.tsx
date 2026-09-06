import type { DashboardState } from "@shared/types";
import { lakh, percent, rupees } from "../format";
import { Panel } from "./Panel";
import { clamp01 } from "../lib/forecastMath";

/**
 * The CFO's delegated-authority policy — the thing the product actually
 * sells — plus how much of the resulting headroom the agent has already
 * consumed. Sits beside the chart so it is never below the fold.
 */
export function AuthorityPanel({ state }: { state: DashboardState }) {
  const r = state.company.rules;
  const headroom = state.forecast.headroom;
  const reserved = Math.max(0, state.reservedTotal);
  const deficit = headroom < 0;

  // Capacity is what the agent could have committed in total: what it has
  // already reserved plus what is still available. In deficit there is no
  // available part, so the bar is all consumption.
  const available = Math.max(0, headroom);
  const capacity = reserved + available;
  const consumedPct = capacity > 0 ? reserved / capacity : deficit ? 1 : 0;

  const suspended = deficit || state.forecast.breachWeek !== null;

  return (
    <Panel
      title="Delegated authority"
      tier="primary"
      className="panel-fill"
      right={
        suspended ? (
          <span className="chip chip-danger">
            <i className="dot" />
            suspended
          </span>
        ) : (
          <span className="chip chip-ok">
            <i className="dot" />
            in force
          </span>
        )
      }
    >
      <dl className="kv kv-tight">
        <dt>autonomous limit / request</dt>
        <dd>{rupees(r.maxAutonomousAmount)}</dd>

        <dt>rolling authority pool</dt>
        <dd>
          {rupees(r.rollingAuthorityPool)}
          <span className="kv-unit"> / {r.rollingWindowDays}d</span>
        </dd>

        <dt>cash safety threshold</dt>
        <dd>{rupees(r.minCashThreshold)}</dd>

        <dt>budget overage allowed</dt>
        <dd>{percent(r.maxBudgetOverage)}</dd>

        <dt>new vendors need a human</dt>
        <dd>{r.requireVendorHistory ? "yes" : "no"}</dd>

        <dt>anomaly flag at</dt>
        <dd>
          {r.anomalyMultiplier.toFixed(1)}×
          <span className="kv-unit"> category avg</span>
        </dd>
      </dl>

      <div className="headroom">
        <div className="headroom-line">
          <span className="headroom-label">
            {deficit ? "headroom deficit" : "headroom consumed"}
          </span>
          <span className="headroom-figs">
            <span className="c-1">{lakh(reserved)}</span> reserved ·{" "}
            <span className={deficit ? "c-danger" : "c-ok"}>
              {deficit ? `${lakh(Math.abs(headroom))} short` : `${lakh(available)} available`}
            </span>
            {deficit ? (
              <span className="c-danger"> · no authority</span>
            ) : (
              <> · {percent(consumedPct)}</>
            )}
          </span>
        </div>

        <div
          className="hbar"
          role="img"
          aria-label={
            deficit
              ? `Headroom deficit: ${rupees(Math.abs(headroom))} below the floor`
              : `${percent(consumedPct)} of ${rupees(capacity)} headroom consumed`
          }
        >
          <div
            className={`hbar-fill ${deficit ? "hbar-fill-danger" : consumedPct > 0.7 ? "hbar-fill-warn" : ""}`}
            style={{ width: `${Math.round(clamp01(consumedPct) * 100)}%` }}
          />
        </div>
      </div>

      <p className="principle">
        The limit is a ceiling on the agent's authority — not permission to approve.
      </p>
    </Panel>
  );
}

