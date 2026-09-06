/**
 * Assembles the demo video with ffmpeg.
 *
 *   [intro: Runway hero clip, blurred and darkened, title on top]
 *   → [orchestrator: the Agent Orchestrator board that planned the build]
 *   → [walkthrough recording + lower-third captions]
 *   → [outro card]
 *
 * The orchestrator beat only appears when out/orchestrator.png exists.
 *
 * Optional audio, mixed in when present:
 *   out/vo/NN.mp3            one voice-over clip per scene (index matches scenes.json)
 *   out/vo/intro.mp3         spoken title
 *   out/vo/orchestrator.mp3  narration for the "how it was built" beat
 *   out/ambient.mp3          ambient bed, looped under everything at low level
 *
 * Output: out/runway-demo.mp4
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const ffmpeg = require("ffmpeg-static");

const OUT = path.join(__dirname, "out");
const FONT = "C\\:/Windows/Fonts/segoeui.ttf";
const FONT_B = "C\\:/Windows/Fonts/segoeuib.ttf";
const W = 1920, H = 1080, FPS = 30;
const XF = 0.6; // crossfade seconds
const INTRO_S = 5;
const ORCH_S = 8; // the "how it was built" beat
const OUTRO_S = 4;

function run(args, quiet = false) {
  if (!quiet) process.stdout.write(`ffmpeg ${args.slice(0, 4).join(" ")} ...\n`);
  return execFileSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: quiet ? "pipe" : "inherit", cwd: OUT });
}

function textFile(name, text) {
  const p = path.join(OUT, `${name}.txt`);
  fs.writeFileSync(p, text, "utf8");
  return `${name}.txt`;
}

function duration(file) {
  try { execFileSync(ffmpeg, ["-i", file], { cwd: OUT, stdio: "pipe" }); } catch (e) {
    const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(e.stderr.toString());
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  throw new Error(`cannot read duration of ${file}`);
}

const exists = (f) => fs.existsSync(path.join(OUT, f));

// ---------------------------------------------------------------------------
// 1. Walkthrough: webm → mp4 with lower-third captions per scene
// ---------------------------------------------------------------------------
const scenes = JSON.parse(fs.readFileSync(path.join(OUT, "scenes.json"), "utf8"));
const captionFilters = scenes.map((s, i) => {
  const tf = textFile(`cap-${String(i).padStart(2, "0")}`, s.caption);
  const a = `if(lt(t,${s.start}+0.3),(t-${s.start})/0.3,if(gt(t,${s.end}-0.3),(${s.end}-t)/0.3,1))`;
  return (
    `drawtext=fontfile='${FONT}':textfile='${tf}':fontsize=34:fontcolor=white:` +
    `alpha='${a}':box=1:boxcolor=0x131417@0.82:boxborderw=22:` +
    `x=(w-text_w)/2:y=h-150:enable='between(t,${s.start},${s.end})'`
  );
});
run([
  "-i", "walkthrough.webm",
  "-vf", `scale=${W}:${H}:flags=lanczos,fps=${FPS},format=yuv420p,${captionFilters.join(",")}`,
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-an",
  "walkthrough.mp4",
]);

// ---------------------------------------------------------------------------
// 2. Title cards
// ---------------------------------------------------------------------------
function titleFilters(name, lines, seconds) {
  const [title, sub, sub2] = lines;
  const t1 = textFile(`${name}-1`, title);
  const t2 = textFile(`${name}-2`, sub ?? "");
  const t3 = textFile(`${name}-3`, sub2 ?? "");
  return [
    `drawtext=fontfile='${FONT_B}':textfile='${t1}':fontsize=104:fontcolor=0xe6e6e9:x=(w-text_w)/2:y=(h-text_h)/2-70`,
    sub ? `drawtext=fontfile='${FONT}':textfile='${t2}':fontsize=38:fontcolor=0xd4d4d8:x=(w-text_w)/2:y=(h-text_h)/2+50` : null,
    sub2 ? `drawtext=fontfile='${FONT}':textfile='${t3}':fontsize=26:fontcolor=0xa1a1aa:x=(w-text_w)/2:y=(h-text_h)/2+120` : null,
    `drawbox=x=(iw-120)/2:y=ih/2-168:w=120:h=4:color=0x8b93ff@1:t=fill`,
    `fade=t=in:st=0:d=0.5,fade=t=out:st=${seconds - 0.5}:d=0.5`,
  ].filter(Boolean).join(",");
}

// Intro: the Runway-generated hero clip as a soft backdrop when it exists.
// Image-to-video garbles UI text, so it is blurred and dimmed to a texture;
// the slow camera drift is what it contributes.
if (exists("runway-hero.mp4")) {
  const heroDur = duration("runway-hero.mp4");
  const secs = Math.min(INTRO_S, heroDur);
  run([
    "-i", "runway-hero.mp4",
    "-vf",
    `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},` +
      `boxblur=luma_radius=7:luma_power=2,eq=brightness=-0.06:saturation=0.9,` +
      `drawbox=x=0:y=0:w=iw:h=ih:color=0x131417@0.28:t=fill,` +
      titleFilters("intro", ["Runway", "An autonomous CFO for startups", "It forecasts cash, collects what it is owed, and decides what you can safely spend."], secs),
    "-t", String(secs), "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-an",
    "intro.mp4",
  ]);
} else {
  run([
    "-f", "lavfi", "-i", `color=c=0x131417:s=${W}x${H}:r=${FPS}:d=${INTRO_S}`,
    "-vf", titleFilters("intro", ["Runway", "An autonomous CFO for startups", "It forecasts cash, collects what it is owed, and decides what you can safely spend."], INTRO_S),
    "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-an", "intro.mp4",
  ]);
}
run([
  "-f", "lavfi", "-i", `color=c=0x131417:s=${W}x${H}:r=${FPS}:d=${OUTRO_S}`,
  "-vf", titleFilters("outro", ["Runway", "One agent, both sides of the cash equation", "Cloudflare Workers · Durable Objects · deterministic engine, no model in the decision path"], OUTRO_S),
  "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-an", "outro.mp4",
]);

// The "how it was built" beat: the Agent Orchestrator board that planned this
// build as parallel tasks. A still, framed on the product background, with an
// eyebrow line, a lower-third caption, and a gentle fade. Static on purpose —
// a push-in would make the board text unreadable.
const ORCH_CAPTION =
  "The whole build — engine, adapters, UI — was planned and shipped as parallel tasks in Agent Orchestrator.";
if (exists("orchestrator.png")) {
  const eyebrow = textFile("orch-eyebrow", "How Runway was built");
  const cap = textFile("orch-cap", ORCH_CAPTION);
  run([
    "-loop", "1", "-t", String(ORCH_S), "-i", "orchestrator.png",
    "-vf",
    `scale=${W - 160}:${H - 200}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x131417,fps=${FPS},format=yuv420p,` +
      `drawtext=fontfile='${FONT}':textfile='${eyebrow}':fontsize=30:fontcolor=0x8b93ff:x=(w-text_w)/2:y=46,` +
      `drawtext=fontfile='${FONT}':textfile='${cap}':fontsize=34:fontcolor=white:box=1:boxcolor=0x131417@0.82:boxborderw=22:x=(w-text_w)/2:y=h-118,` +
      `fade=t=in:st=0:d=0.5,fade=t=out:st=${ORCH_S - 0.5}:d=0.5`,
    "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-an", "orchestrator.mp4",
  ]);
}

// ---------------------------------------------------------------------------
// 3. Video: crossfade the segments
// ---------------------------------------------------------------------------
const segments = ["intro.mp4", ...(exists("orchestrator.mp4") ? ["orchestrator.mp4"] : []), "walkthrough.mp4", "outro.mp4"];
const durs = segments.map(duration);
// Start time of each segment on the crossfaded timeline.
const segStart = durs.map((_, i) => durs.slice(0, i).reduce((a, b) => a + b, 0) - i * XF);
const orchIdx = segments.indexOf("orchestrator.mp4");
const walkIdx = segments.indexOf("walkthrough.mp4");
const norm = segments.map((_, i) => `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x131417,fps=${FPS},format=yuv420p,setpts=PTS-STARTPTS[v${i}]`);
let chain = "", prev = "v0", offset = 0;
for (let i = 1; i < segments.length; i++) {
  offset += durs[i - 1] - XF;
  const out = i === segments.length - 1 ? "vout" : `x${i}`;
  chain += `[${prev}][v${i}]xfade=transition=fade:duration=${XF}:offset=${offset.toFixed(3)}[${out}];`;
  prev = out;
}
const total = durs.reduce((a, b) => a + b, 0) - XF * (segments.length - 1);
run([
  ...segments.flatMap((f) => ["-i", f]),
  "-filter_complex", norm.join(";") + ";" + chain.replace(/;$/, ""),
  "-map", "[vout]", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-an",
  "video.mp4",
]);

// ---------------------------------------------------------------------------
// 4. Audio: voice-over per scene + ambient bed, then mux
// ---------------------------------------------------------------------------
const walkOffset = segStart[walkIdx]; // where the walkthrough starts on the final timeline
const audioInputs = [];
const audioFilters = [];
const mixLabels = [];
// video.mp4 is input 0 in the mux command, so audio inputs start at 1.
let idx = 1;

function addVo(file, at, windowSecs) {
  const d = duration(file);
  // Speak a little faster rather than spill into the next scene.
  const budget = Math.max(1, windowSecs - 0.4);
  const tempo = d > budget ? Math.min(1.3, d / budget) : 1;
  audioInputs.push("-i", file);
  audioFilters.push(
    `[${idx}:a]atempo=${tempo.toFixed(3)},adelay=${Math.round(at * 1000)}|${Math.round(at * 1000)},volume=1.35[a${idx}]`,
  );
  mixLabels.push(`[a${idx}]`);
  idx++;
  return { d, tempo };
}

if (exists("vo/intro.mp3")) addVo("vo/intro.mp3", segStart[0] + 0.6, durs[0] - 0.8);
if (orchIdx >= 0 && exists("vo/orchestrator.mp3")) {
  const { d, tempo } = addVo("vo/orchestrator.mp3", segStart[orchIdx] + 0.4, durs[orchIdx]);
  console.log(`vo orchestrator          ${d.toFixed(1)}s in a ${durs[orchIdx].toFixed(1)}s window${tempo > 1 ? ` (tempo ×${tempo.toFixed(2)})` : ""}`);
}
scenes.forEach((s, i) => {
  const f = `vo/${String(i).padStart(2, "0")}.mp3`;
  if (!exists(f)) return;
  const next = scenes[i + 1];
  const windowSecs = (next ? next.start : s.end) - s.start;
  const { d, tempo } = addVo(f, walkOffset + s.start + 0.25, windowSecs);
  console.log(`vo ${String(i).padStart(2, "0")} ${s.name.padEnd(20)} ${d.toFixed(1)}s in a ${windowSecs.toFixed(1)}s window${tempo > 1 ? ` (tempo ×${tempo.toFixed(2)})` : ""}`);
});

if (exists("ambient.mp3")) {
  audioInputs.push("-stream_loop", "-1", "-i", "ambient.mp3");
  audioFilters.push(
    `[${idx}:a]atrim=0:${total.toFixed(2)},volume=1.000,afade=t=in:st=0:d=1.5,afade=t=out:st=${(total - 2.5).toFixed(2)}:d=2.5[amb]`,
  );
  mixLabels.push("[amb]");
  idx++;
}

if (mixLabels.length > 0) {
  const mix = `${audioFilters.join(";")};${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=longest:normalize=0,alimiter=limit=0.95[aout]`;
  run([
    "-i", "video.mp4", ...audioInputs,
    "-filter_complex", mix,
    "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
    "-movflags", "+faststart", "runway-demo.mp4",
  ]);
} else {
  fs.copyFileSync(path.join(OUT, "video.mp4"), path.join(OUT, "runway-demo.mp4"));
}

console.log(`\nout/runway-demo.mp4  ≈ ${total.toFixed(1)}s  audio: ${mixLabels.length > 0 ? `${mixLabels.length} tracks` : "none"}`);
