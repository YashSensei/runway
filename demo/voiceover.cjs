/**
 * Generates the demo's audio with Runway:
 *   out/vo/intro.mp3 and out/vo/NN.mp3   ElevenLabs speech, one clip per scene caption
 *   out/ambient.mp3                       a loopable ambient bed (eleven_text_to_sound_v2)
 *
 * Runs at most 4 tasks at a time (tier limit is 5 concurrent). Skips files
 * that already exist so a re-run only fills gaps.
 */
const fs = require("node:fs");
const path = require("node:path");

const KEY = process.env.RUNWAYML_API_SECRET;
if (!KEY) { console.error("RUNWAYML_API_SECRET is not set"); process.exit(1); }
const API = "https://api.dev.runwayml.com/v1";
const H = { Authorization: `Bearer ${KEY}`, "X-Runway-Version": "2024-11-06", "Content-Type": "application/json" };
const OUT = path.join(__dirname, "out");
const VO = path.join(OUT, "vo");
fs.mkdirSync(VO, { recursive: true });

const VOICE = process.env.VOICE ?? "James";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Captions are written for the eye; make the figures speakable. */
function speakable(text) {
  return text
    .replace(/₹([\d.]+)L\b/g, "$1 lakh rupees")
    .replace(/(\d+)-week/g, "$1 week")
    .replace(/\bCFO\b/g, "C.F.O.")
    .replace(/·/g, ",")
    .replace(/—/g, ",");
}

async function task(endpoint, body, outfile, label) {
  const create = await fetch(`${API}/${endpoint}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  const created = await create.json();
  if (!create.ok) throw new Error(`${label}: create failed ${create.status}: ${JSON.stringify(created)}`);
  for (let i = 0; i < 150; i++) {
    await sleep(3000);
    const t = await (await fetch(`${API}/tasks/${created.id}`, { headers: H })).json();
    if (t.status === "SUCCEEDED") {
      const url = Array.isArray(t.output) ? t.output[0] : t.output;
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      fs.writeFileSync(outfile, buf);
      console.log(`  ${label.padEnd(24)} ${(buf.length / 1024).toFixed(0)} KB`);
      return;
    }
    if (t.status === "FAILED" || t.status === "CANCELLED") throw new Error(`${label}: ${JSON.stringify(t)}`);
  }
  throw new Error(`${label}: timed out`);
}

async function pool(jobs, size) {
  const queue = [...jobs];
  const workers = Array.from({ length: size }, async () => {
    while (queue.length) { const j = queue.shift(); await j(); }
  });
  await Promise.all(workers);
}

async function main() {
  const scenes = JSON.parse(fs.readFileSync(path.join(OUT, "scenes.json"), "utf8"));
  const jobs = [];

  const tts = (text, file, label) => {
    if (fs.existsSync(file)) return;
    jobs.push(() => task("text_to_speech", {
      model: "eleven_multilingual_v2",
      promptText: speakable(text),
      voice: { type: "runway-preset", presetId: VOICE },
    }, file, label));
  };

  tts("Runway. An autonomous C.F.O. for startups.", path.join(VO, "intro.mp3"), "intro");
  scenes.forEach((s, i) => tts(s.caption, path.join(VO, `${String(i).padStart(2, "0")}.mp3`), `${String(i).padStart(2, "0")} ${s.name}`));

  const ambient = path.join(OUT, "ambient.mp3");
  if (!fs.existsSync(ambient)) {
    jobs.push(() => task("sound_effect", {
      model: "eleven_text_to_sound_v2",
      promptText:
        "Calm minimal ambient electronic pad for a software product demo. Slow, warm synth texture, soft and steady, " +
        "no melody, no drums, no vocals, low volume background music that loops seamlessly.",
      duration: 30,
      loop: true,
    }, ambient, "ambient bed"));
  }

  console.log(`${jobs.length} tasks, voice ${VOICE}`);
  await pool(jobs, 4);
  console.log("done");
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
