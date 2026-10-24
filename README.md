# Hoops AI — shot tracker

A website that turns a phone on a tripod into a basketball shot tracker. The
camera feeds an object detector that finds the ball in every frame; plain
TypeScript follows the ball's flight and calls each shot a make or a miss,
then counts it and says it out loud. Everything runs in the browser on the
phone. No server, no accounts, no video uploaded anywhere.

This is version 1 of the [app plan](#plan): practice mode, one shooter.

## Using it

1. Phone in **landscape** on a tripod at the side of the court, rim in the
   upper third of the picture.
2. **Start practice**, allow the camera, tap the rim, and drag **Rim size**
   until the orange oval matches the rim. Press **Start**.
3. Shoot. Each shot is called on screen and spoken: "Make. Seven of twelve."
4. **Fix last** flips a wrong call. **+ Make / + Miss** add a shot the AI
   didn't see. These are logged, so the summary shows AI accuracy
   (1 − fixed ÷ AI-called shots).
5. **End** shows the session summary: makes, shots, FG%, longest streak, and
   every shot with the ball path the AI saw. History keeps past sessions.

**Test with a video** runs the same pipeline on a recorded clip, so you can
tune at the kitchen table. "Every frame" steps through the clip frame by frame
(slow but the same result on any device); "1×" plays it live like the camera.
Use **Export JSON** on a summary to keep the paths of bad calls.

Add it to the Home Screen (Share → Add to Home Screen) to run it full screen
and offline: the service worker caches the app, the WASM runtime and the model
after the first visit.

## How it works

```
camera frame ─► detector (Web Worker, MediaPipe) ─► ball boxes
             ─► tracker.ts  nearest-match: one ball path
             ─► judge.ts    shot start, make or miss
             ─► count, voice, IndexedDB
```

The detector is MediaPipe's stock EfficientDet (COCO "sports ball"), run on
the GPU when available. It doesn't know rims, so you tap the rim once. Pick
**Fast** (Lite0, 4.6 MB, the default) or **Accurate** (Lite2, 12 MB, slower)
on the home screen.

The model only looks at a few hundred pixels, so a ball across the court in a
full 720p frame is too small for it. After the rim tap it runs on a square
crop around the rim, and once it finds the ball it follows it with a crop
centered on the ball, with a whole-frame look every third frame to catch the
release (`chooseRoi` in `src/main.ts`).

Judge rules (`src/judge.ts`), all measured in rim widths so they work at any
zoom:

- **Shot start:** the ball is moving near or above the rim, or it's rising and
  its projected arc (real gravity, using the 18-inch rim as a ruler) comes down
  at the rim. Dribbles and pump fakes never get there.
- **Make:** the ball crosses the rim top inside the rim and comes out below it.
- **Net trap:** a ball through the net slows down; one that falls at full
  free-fall speed passed behind the rim and is a miss.
- **Rattles:** an entry that pops back up is undone; the call waits until the
  ball drops through or falls away (up to 5 s).
- **Miss:** falls below the rim outside it, leaves the area, or the shot times
  out. If the ball vanishes falling into the rim, the net hid it: make.

Each call stores its confidence and a short reason (`through-rim`,
`behind-rim`, `fell-outside`, `lost-in-net`, …) next to the path, so old
sessions can be re-judged after the rules improve.

## Development

```sh
npm install
npm run dev      # fetches the model + WASM into public/, starts Vite
npm test         # judge and tracker tests on synthetic shot paths
npm run build    # type-check and build to dist/
```

The camera needs HTTPS (or localhost). To try it on a phone during
development, run `npx vite --host` and open it through an HTTPS tunnel, or
just push to `main` and use the GitHub Pages build.

Append `?cpu` to the URL to force the CPU detector.

| File | What it does |
| --- | --- |
| `src/camera.ts` | Rear camera, video files, per-frame callback, wake lock |
| `src/detector.worker.ts` | MediaPipe object detector in a module worker |
| `src/detector.ts` | Main-thread handle on the worker |
| `src/tracker.ts` | Links detections into one ball path |
| `src/judge.ts` | Shot start, make or miss |
| `src/overlay.ts` | Rim, ball box, path drawing |
| `src/store.ts` | Sessions and shots in IndexedDB (Dexie) |
| `src/voice.ts` | Spoken calls |
| `src/main.ts` | Screens: setup, live, summary, history |
| `scripts/fetch-assets.mjs` | Copies the WASM runtime and downloads the model |

## Deploying

`.github/workflows/deploy.yml` tests, builds and publishes `dist/` to GitHub
Pages on every push to `main`. Turn it on once under **Settings → Pages →
Build and deployment → Source: GitHub Actions**. The site is then at
`https://<user>.github.io/<repo>/`.

## Plan

Version 1 (this): live tracking, automatic count and FG%, spoken calls, Fix
button with accuracy log, saved sessions and history, video test mode,
offline install.

Next: record test clips from the tripod spot and tune `defaultJudgeConfig`
against a hand count; then train a two-class ball-and-rim model (RF-DETR,
run with ONNX Runtime Web) so the rim tap goes away. Version 2 adds the shot
chart (2 vs 3), per-shot clips, and arc and release speed. Game mode comes
after: record a game, let the AI find every shot, tap which ones were his.
