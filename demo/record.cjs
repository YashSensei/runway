/**
 * Records the Runway demo walkthrough with Playwright.
 *
 * Drives the live app at BASE through the demo scenes, pausing on each so a
 * viewer can read it, and writes:
 *   out/walkthrough.webm      one continuous 1920x1080 recording
 *   out/shots/NN-<scene>.png  a still per scene (for Runway image-to-video)
 *   out/scenes.json           scene name + start/end seconds, for captions
 */
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const OUT = path.join(__dirname, "out");
const SHOTS = path.join(OUT, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } },
    colorScheme: "dark",
  });
  const page = await context.newPage();
  const t0 = Date.now();
  const scenes = [];
  let shot = 0;

  // Node-side, so it works before the page has navigated anywhere.
  const demo = async (action) => {
    const r = await fetch(`${BASE}/api/demo/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!r.ok) throw new Error(`demo/${action} → ${r.status}`);
    return r.status;
  };

  const settle = async (ms = 1400) => { await sleep(ms); };

  async function scene(name, caption, fn, hold = 4500) {
    const start = (Date.now() - t0) / 1000;
    await fn();
    await settle();
    shot += 1;
    await page.screenshot({ path: path.join(SHOTS, `${String(shot).padStart(2, "0")}-${name}.png`) });
    await sleep(hold);
    const end = (Date.now() - t0) / 1000;
    scenes.push({ name, caption, start: +start.toFixed(2), end: +end.toFixed(2) });
    console.log(`${name.padEnd(22)} ${start.toFixed(1)}s → ${end.toFixed(1)}s`);
  }

  await demo("reset");
  await page.goto(`${BASE}/#/overview`, { waitUntil: "load" });
  await page.waitForSelector(".stats", { timeout: 20000 });
  // Let Inter load and the first poll land before the recording "starts".
  await sleep(1800);

  await scene("overview-baseline", "Vertex Labs. 13 weeks of cash, healthy. The agent is watching.", async () => {}, 5000);

  await scene("shock", "A ₹15L receivable slips eight weeks and payroll steps up. Week 7 breaches the floor.", async () => {
    await demo("shock");
  }, 5500);

  await scene("agent-defends", "Nobody clicks anything. The agent ranks overdue invoices by whether the cash lands before week 7, and chases two.", async () => {
    await demo("run-agent");
  }, 6000);

  await scene("email", "The collection email it wrote. Tone chosen by days overdue; the figures are the only variables.", async () => {
    const row = page.locator("button.log-row-clickable", { hasText: "Collection email" }).first();
    await row.click();
    await page.waitForSelector(".modal", { timeout: 5000 });
  }, 5500);
  await page.keyboard.press("Escape");
  await settle(600);

  await scene("recovered", "Both customers commit. Projected minimum goes from ₹19.4L to ₹34.4L. Breach cleared, on its own.", async () => {
    await demo("inject-reply");
  }, 8600);

  await scene("approve-engineering", "Engineering asks for ₹3.2L. Within authority, within budget, headroom to spare. Approved in under a second.", async () => {
    await demo("request/engineering");
  }, 7800);

  await scene("approve-marketing", "Marketing asks for ₹4.5L. Approved, because the ₹15L the agent recovered is what made room for it.", async () => {
    await demo("request/marketing");
  }, 7000);

  await scene("escalate-sales", "Sales asks for ₹2.8L. Nothing wrong with the request. The first two approvals consumed the buffer, so it escalates.", async () => {
    await demo("request/sales");
  }, 8400);

  await scene("audit-record", "Every decision carries its audit record: seven rules, the data used, and what headroom did.", async () => {
    await page.locator(".btn-why").first().click();
    await page.waitForSelector(".modal", { timeout: 5000 });
  }, 6000);
  await page.keyboard.press("Escape");
  await settle(600);

  await scene("spend-page", "The approvals inbox, and a request form that runs the real engine as you type.", async () => {
    await page.goto(`${BASE}/#/spend`);
    await page.waitForSelector(".page", { timeout: 5000 });
  }, 5000);

  await scene("collect-page", "The receivables desk: ageing, the agent's ranked plan, and who it skipped and why.", async () => {
    await page.goto(`${BASE}/#/collect`);
    await page.waitForSelector(".page", { timeout: 5000 });
  }, 5000);

  await scene("policy-page", "The CFO's rulebook. The limit is a ceiling on the agent's authority, not permission to approve.", async () => {
    await page.goto(`${BASE}/#/policy`);
    await page.waitForSelector(".page", { timeout: 5000 });
  }, 5000);

  await scene("agent-page", "And the agent itself: a heartbeat every 20 seconds, a log of every run, and a switch to pause it.", async () => {
    await page.goto(`${BASE}/#/agent`);
    await page.waitForSelector(".page", { timeout: 5000 });
  }, 5500);

  await scene("overview-final", "Runway. An autonomous CFO whose own actions compound.", async () => {
    await page.goto(`${BASE}/#/overview`);
    await page.waitForSelector(".stats", { timeout: 5000 });
  }, 4500);

  const video = page.video();
  await context.close();
  const tmpPath = await video.path();
  const finalPath = path.join(OUT, "walkthrough.webm");
  fs.renameSync(tmpPath, finalPath);
  await browser.close();

  fs.writeFileSync(path.join(OUT, "scenes.json"), JSON.stringify(scenes, null, 2));
  console.log(`\nwrote ${finalPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
