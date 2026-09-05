/**
 * Worker entry point.
 *
 * Thin by design: it routes, and everything that touches money is delegated to
 * the CompanyAgent Durable Object so that decisions are serialized. Static
 * assets fall through to the ASSETS binding.
 */

import { Hono } from "hono";
import { CompanyAgent, type AgentEnv } from "./agent/company-agent";

export { CompanyAgent };

interface Env extends AgentEnv {
  COMPANY_AGENT: DurableObjectNamespace<CompanyAgent>;
  ASSETS: Fetcher;
}

/** Single company for the demo; the id is what makes the DO instance stable. */
const COMPANY_ID = "vertex-labs";

const app = new Hono<{ Bindings: Env }>();

function agent(env: Env): DurableObjectStub<CompanyAgent> {
  return env.COMPANY_AGENT.get(env.COMPANY_AGENT.idFromName(COMPANY_ID));
}

/**
 * Serialize an RPC result.
 *
 * Durable Object RPC returns values intersected with `Disposable`, which does
 * not satisfy Hono's JSON constraint. Going through a plain Response keeps the
 * call sites honest instead of scattering casts.
 */
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

app.get("/api/state", async (c) => {
  return json(await agent(c.env).getDashboardState());
});

app.get("/api/health", (c) => c.json({ ok: true, service: "runway" }));

// ---------------------------------------------------------------------------
// Spend requests
// ---------------------------------------------------------------------------

app.post("/api/requests", async (c) => {
  const body = await c.req.json<{
    idempotencyKey: string;
    departmentId: string;
    vendorId: string;
    amount: number;
    category: string;
    description: string;
    requestedBy: string;
    expectedWeek: number;
  }>();
  return json(await agent(c.env).submitRequest(body));
});

app.post("/api/escalations/:requestId/:action", async (c) => {
  const action = c.req.param("action");
  if (action !== "approve" && action !== "reject" && action !== "defer") {
    return c.json({ error: "action must be approve, reject or defer" }, 400);
  }
  return json(await agent(c.env).resolveEscalation(c.req.param("requestId"), action));
});

// ---------------------------------------------------------------------------
// Demo control surface
//
// Every scene of the demo is reachable directly, so a rehearsal never has to
// replay the whole script and a live failure can be skipped past.
// ---------------------------------------------------------------------------

app.post("/api/demo/reset", async (c) => {
  await agent(c.env).reset();
  return c.json({ ok: true, scene: "baseline" });
});

app.post("/api/demo/shock", async (c) => {
  await agent(c.env).applyShockScenario();
  return c.json({ ok: true, scene: "shock" });
});

app.post("/api/demo/run-agent", async (c) => {
  return json({ ok: true, ...(await agent(c.env).defendCashPosition({ triggeredBy: "manual" })) });
});

app.post("/api/demo/inject-reply", async (c) => {
  const body = await c.req.json<{ invoiceId?: string; amount?: number; date?: string }>().catch(() => ({}));
  return json(await agent(c.env).injectReply(body));
});

app.post("/api/demo/request/:key", async (c) => {
  return json(await agent(c.env).submitDemoRequest(c.req.param("key")));
});

app.post("/api/demo/replay", async (c) => {
  return json(await agent(c.env).runReplayScenario());
});

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
