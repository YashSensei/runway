/**
 * Generic Runway task runner: POST a body to an endpoint, poll the task,
 * download the first output.
 *
 *   node runway-task.cjs <endpoint> '<json body>' <outfile>
 *   e.g. node runway-task.cjs sound_effect '{"model":"eleven_text_to_sound_v2","promptText":"..."}' out/ambient.mp3
 *
 * Needs RUNWAYML_API_SECRET in the environment. Exits non-zero on failure.
 */
const fs = require("node:fs");

const KEY = process.env.RUNWAYML_API_SECRET;
if (!KEY) { console.error("RUNWAYML_API_SECRET is not set"); process.exit(1); }
const API = "https://api.dev.runwayml.com/v1";
const H = { Authorization: `Bearer ${KEY}`, "X-Runway-Version": "2024-11-06", "Content-Type": "application/json" };
const [endpoint, bodyJson, outfile] = process.argv.slice(2);
if (!endpoint || !bodyJson || !outfile) { console.error("usage: runway-task.cjs <endpoint> '<json>' <outfile>"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const create = await fetch(`${API}/${endpoint}`, { method: "POST", headers: H, body: bodyJson });
  const created = await create.json();
  if (!create.ok) { console.error(`create failed ${create.status}:`, JSON.stringify(created)); process.exit(2); }
  process.stdout.write(`${endpoint} task ${created.id} `);
  for (let i = 0; i < 180; i++) {
    await sleep(4000);
    const t = await (await fetch(`${API}/tasks/${created.id}`, { headers: H })).json();
    process.stdout.write(".");
    if (t.status === "SUCCEEDED") {
      const url = Array.isArray(t.output) ? t.output[0] : t.output;
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      fs.writeFileSync(outfile, buf);
      console.log(`\nsaved ${outfile} (${(buf.length / 1e6).toFixed(2)} MB)`);
      return;
    }
    if (t.status === "FAILED" || t.status === "CANCELLED") { console.error("\ntask ended:", JSON.stringify(t)); process.exit(3); }
  }
  console.error("\ntimed out"); process.exit(4);
}
main().catch((e) => { console.error(e); process.exit(1); });
