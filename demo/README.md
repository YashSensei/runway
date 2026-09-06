# Demo video pipeline

Produces `out/runway-demo.mp4`: a ~2 minute narrated walkthrough of the product,
recorded from the real app, with Runway-generated intro footage, voice-over and
an ambient bed, assembled with ffmpeg.

```
record.cjs        Playwright drives the live app through the demo scenes and
                  records 1920×1080 video + a still per scene + scenes.json
runway-hero.cjs   Runway gen4_turbo image-to-video on the first still → intro backdrop
voiceover.cjs     Runway text-to-speech (ElevenLabs preset voice) per caption,
                  plus a loopable ambient bed (eleven_text_to_sound_v2)
assemble.cjs      ffmpeg: captions, intro/outro cards, crossfades, audio mix
runway-task.cjs   generic "POST, poll, download" helper for any Runway endpoint
```

## Run

```bash
# 1. the app must be running
npm run build && npm run dev            # http://127.0.0.1:8787

# 2. a scratch workspace for the pipeline's own dependencies
cd demo && npm init -y && npm i playwright ffmpeg-static
#    record.cjs launches your installed Chrome (channel: "chrome"), so no
#    Playwright browser download is needed.

# 3. record, generate, assemble
export RUNWAYML_API_SECRET=key_...        # never commit this
node record.cjs                           # → out/walkthrough.webm, out/shots/, out/scenes.json
node runway-hero.cjs                      # → out/runway-hero.mp4   (optional, ~25 credits)
node voiceover.cjs                        # → out/vo/*.mp3, out/ambient.mp3
node assemble.cjs                         # → out/runway-demo.mp4
```

Every generation step is optional: `assemble.cjs` uses whatever exists in
`out/`. Without the hero clip the intro is a plain title card; without audio
files the video is silent.

## Notes

- Captions and voice-over come from the `caption` strings in `record.cjs`.
  Change the words there and re-run `record.cjs` (the scene timings are what
  the captions are keyed to) and `voiceover.cjs` (it only regenerates missing
  clips, so delete `out/vo/NN.mp3` for any line you changed).
- Scene hold times in `record.cjs` were tuned so each spoken line fits its
  scene at natural pace. `assemble.cjs` reports the fit per scene and speeds a
  clip up (max 1.3×) if it still spills over.
- Image-to-video garbles UI text, so the hero clip is only ever used blurred
  and dimmed as the intro backdrop. Do not show it at readable scale.
- `out/` is git-ignored: it holds a 10 MB recording, the generated audio and
  the final 18 MB video.
- The Runway API key is read from the environment only. If it was ever pasted
  into a chat or a shell history, rotate it.
