/**
 * Asks Runway (gen4_turbo image-to-video) for a 5-second cinematic push-in on
 * the Overview screenshot, then saves it as out/runway-hero.mp4 so assemble.cjs
 * slots it in after the intro card.
 *
 * Needs RUNWAYML_API_SECRET in the environment and credits on the account.
 * Cost: gen4_turbo is 5 credits per second → 25 credits for this clip.
 */
const fs = require("node:fs");
const path = require("node:path");

const KEY = process.env.RUNWAYML_API_SECRET;
if (!KEY) { console.error("RUNWAYML_API_SECRET is not set"); process.exit(1); }
const API = "https://api.dev.runwayml.com/v1";
const H = { Authorization: `Bearer ${KEY}`, "X-Runway-Version": "2024-11-06", "Content-Type": "application/json" };
const OUT = path.join(__dirname, "out");
const shot = process.argv[2] ?? path.join(OUT, "shots", "01-overview-baseline.png");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const png = fs.readFileSync(shot);
  const dataUri = `data:image/png;base64,${png.toString("base64")}`;

  const create = await fetch(`${API}/image_to_video`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      model: "gen4_turbo",
      promptImage: dataUri,
      promptText:
        "Slow cinematic push-in on a dark financial dashboard interface, subtle parallax between the panels, " +
        "soft ambient light drifting across the screen, the line chart gently pulsing. Camera moves only; " +
        "keep every panel and number exactly as shown, no new text, no distortion.",
      ratio: "1584:672",
      duration: 5,
    }),
  });
  const created = await create.json();
  if (!create.ok) {
    console.error(`create failed ${create.status}:`, JSON.stringify(created));
    process.exit(2);
  }
  console.log("task", created.id);

  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    const r = await fetch(`${API}/tasks/${created.id}`, { headers: H });
    const t = await r.json();
    process.stdout.write(`  ${t.status}${t.progress !== undefined ? ` ${Math.round(t.progress * 100)}%` : ""}\n`);
    if (t.status === "SUCCEEDED") {
      const url = t.output[0];
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      const dest = path.join(OUT, "runway-hero.mp4");
      fs.writeFileSync(dest, buf);
      console.log("saved", dest, `${(buf.length / 1e6).toFixed(1)} MB`);
      return;
    }
    if (t.status === "FAILED" || t.status === "CANCELLED") {
      console.error("task ended:", JSON.stringify(t));
      process.exit(3);
    }
  }
  console.error("timed out waiting for the task");
  process.exit(4);
}

main().catch((e) => { console.error(e); process.exit(1); });
