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

/** Sentinel for a body that could not be parsed, distinct from an absent body. */
const INVALID = Symbol("invalid-json");

/**
 * Parse a request body without throwing.
 *
 * `c.req.json()` rejects on malformed input, and with no error handler Hono
 * turned that into a bare 500. A client sending bad JSON deserves a 400 and a
 * reason, not an opaque server error.
 */
async function readJson(request: Request): Promise<unknown | typeof INVALID> {
  const text = await request.text().catch(() => null);
  if (text === null || text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return INVALID;
  }
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
  const body = await readJson(c.req.raw);
  if (body === INVALID) return json({ error: "Body must be valid JSON" }, 400);
  const result = await agent(c.env).submitRequest(body as never);
  return "error" in result ? json(result, 400) : json(result);
});

app.post("/api/escalations/:requestId/:action", async (c) => {
  const action = c.req.param("action");
  if (action !== "approve" && action !== "reject" && action !== "defer") {
    return json({ error: "action must be approve, reject or defer" }, 400);
  }
  const result = await agent(c.env).resolveEscalation(c.req.param("requestId"), action);
  return result.ok ? json(result) : json(result, 409);
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
  const result = await agent(c.env).applyShockScenario();
  return json({ scene: "shock", ...result });
});

app.post("/api/demo/run-agent", async (c) => {
  return json({ ok: true, ...(await agent(c.env).defendCashPosition({ triggeredBy: "manual" })) });
});

app.post("/api/demo/inject-reply", async (c) => {
  const body = await readJson(c.req.raw);
  if (body === INVALID) return json({ error: "Body must be valid JSON" }, 400);
  const result = await agent(c.env).injectReply((body ?? {}) as never);
  return result.ok ? json(result) : json(result, 409);
});

app.post("/api/demo/request/:key", async (c) => {
  const result = (await agent(c.env).submitDemoRequest(c.req.param("key"))) as Record<string, unknown>;
  return "error" in result ? json(result, 400) : json(result);
});

app.post("/api/demo/replay", async (c) => {
  return json(await agent(c.env).runReplayScenario());
});

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
