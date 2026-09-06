import { useCallback, useState } from "react";
import type { ComponentType } from "react";
import { useDashboardState } from "./api";
import { Shell } from "./shell/Shell";
import { useHashRoute } from "./shell/router";
import { DecisionDetail } from "./components/DecisionDetail";
import { EmailPreview } from "./components/EmailPreview";
import { DemoControls } from "./components/DemoControls";
import type { PageId, PageProps } from "./pages/types";
import OverviewPage from "./pages/OverviewPage";
import CashPage from "./pages/CashPage";
import CollectPage from "./pages/CollectPage";
import SpendPage from "./pages/SpendPage";
import PolicyPage from "./pages/PolicyPage";
import AuditPage from "./pages/AuditPage";
import InsightsPage from "./pages/InsightsPage";
import AgentPage from "./pages/AgentPage";

/** Router table. Every page is a pure view over the one polled state. */
const PAGES: Record<PageId, ComponentType<PageProps>> = {
  overview: OverviewPage,
  cash: CashPage,
  collect: CollectPage,
  spend: SpendPage,
  policy: PolicyPage,
  audit: AuditPage,
  insights: InsightsPage,
  agent: AgentPage,
};

export default function App() {
  const { state, usingMock, loading, lastUpdated, staleSeconds, error } = useDashboardState();
  const { page, param, navigate } = useHashRoute();

  // Modals hold ids, not snapshots, so an open record keeps tracking the poll.
  const [decisionId, setDecisionId] = useState<string | null>(null);
  const [emailId, setEmailId] = useState<string | null>(null);
  const [demoOpen, setDemoOpen] = useState(false);

  const openDecision = useCallback((id: string) => setDecisionId(id), []);
  const openEmail = useCallback((id: string) => setEmailId(id), []);
  const toggleDemo = useCallback(() => setDemoOpen((v) => !v), []);

  const decisionView = state?.decisions.find((d) => d.decision.id === decisionId) ?? null;
  const emailView = state?.emails.find((e) => e.id === emailId) ?? null;

  if (state === null) {
    return loading ? (
      <div className="boot">Connecting to /api/state…</div>
    ) : (
      <BackendDown error={error} />
    );
  }

  const Page = PAGES[page];

  return (
    <Shell
      state={state}
      page={page}
      navigate={navigate}
      usingMock={usingMock}
      staleSeconds={staleSeconds}
      lastUpdated={lastUpdated}
      error={error}
      demoOpen={demoOpen}
      onToggleDemo={toggleDemo}
    >
      <Page
        state={state}
        navigate={navigate}
        param={param}
        openDecision={openDecision}
        openEmail={openEmail}
      />

      {decisionView !== null ? (
        <DecisionDetail
          view={decisionView}
          decisions={state.decisions}
          onClose={() => setDecisionId(null)}
          onOpenDecision={openDecision}
        />
      ) : null}

      {emailView !== null ? <EmailPreview email={emailView} onClose={() => setEmailId(null)} /> : null}

      <DemoControls open={demoOpen} onClose={() => setDemoOpen(false)} />
    </Shell>
  );
}

// ---------------------------------------------------------------------------

/**
 * No state, no mock, no numbers. Anything else would be inventing figures in
 * front of the room.
 */
function BackendDown({ error }: { error: string | null }) {
  return (
    <div className="fatal" role="alert">
      <div className="fatal-title">Backend Unreachable</div>
      <div className="fatal-body">
        <span className="mono">GET /api/state</span> is not responding. No figures are shown
        because none of them would be real.
      </div>
      {error !== null ? <div className="fatal-detail mono">{error}</div> : null}
      <div className="fatal-hint">Retrying every 500 ms</div>
    </div>
  );
}
