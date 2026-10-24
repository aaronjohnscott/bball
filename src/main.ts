import './style.css';
import { keepAwake, onEachFrame, openCamera, openVideoFile, stopCamera } from './camera';
import { Detector, MODELS, type DetectionFrame, type ModelName } from './detector';
import { ShotJudge } from './judge';
import { drawOverlay, fit, pathSvg } from './overlay';
import {
  aiAccuracy,
  deleteSession,
  deleteShot,
  getSession,
  listSessions,
  newId,
  saveSession,
  saveShot,
  shotsFor,
  summarize,
  type SessionRecord,
  type ShotRecord,
} from './store';
import { BallTracker } from './tracker';
import type { BallDetection, BallPoint, Box, ShotCall } from './types';
import { announce, setVoice, unlockVoice } from './voice';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const video = $<HTMLVideoElement>('video');
const canvas = $<HTMLCanvasElement>('overlay');
const screens = ['home', 'stage', 'summary', 'history'] as const;

/** Rim box height as a share of its width: a rim seen from the side is a flat oval. */
const RIM_OVAL = 0.35;
const TRAIL_MS = 1500;
const TEST_FPS = 30;

type Source = 'camera' | 'file';

const state = {
  source: 'camera' as Source,
  file: null as File | null,
  phase: 'setup' as 'setup' | 'live',
  rimCenter: null as { x: number; y: number } | null,
  rimSize: 0.07,
  rim: null as Box | null,
  aspect: 16 / 9,
  tracker: new BallTracker({ aspect: 16 / 9 }),
  judge: null as ShotJudge | null,
  session: null as SessionRecord | null,
  shots: [] as ShotRecord[],
  detections: [] as BallDetection[],
  ball: null as BallPoint | null,
  trail: [] as BallPoint[],
  lastT: -Infinity,
  t0: 0,
  inFlight: false,
  running: false,
  debug: true,
  stopFrames: null as (() => void) | null,
  detFrames: 0,
  detMsSum: 0,
  detClock: performance.now(),
};

let detector: Detector | null = null;
let detectorReady: Promise<void> | null = null;

function show(name: (typeof screens)[number]): void {
  for (const s of screens) $(s).hidden = s !== name;
}

const modelSelect = $<HTMLSelectElement>('model-select');
try {
  const saved = localStorage.getItem('hoops-model');
  if (saved && saved in MODELS) modelSelect.value = saved;
} catch {
  // Storage blocked: keep the default model.
}
modelSelect.addEventListener('change', () => {
  try {
    localStorage.setItem('hoops-model', modelSelect.value);
  } catch {
    // Not remembered this time; still used now.
  }
  void getDetector().catch(() => {});
});

function getDetector(): Promise<Detector> {
  const model = modelSelect.value as ModelName;
  if (!detector || detector.model !== model) {
    detector?.terminate();
    detector = new Detector(model);
    detectorReady = detector.whenReady();
  }
  const d = detector;
  return detectorReady!.then(() => d);
}

// ---------- Stage: setup and live ----------

async function enterStage(source: Source, file: File | null = null): Promise<void> {
  state.source = source;
  state.file = file;
  state.phase = 'setup';
  state.rim = null;
  state.rimCenter = null;
  state.judge = null;
  state.session = null;
  state.shots = [];
  resetTracking();
  $('setup-ui').hidden = false;
  $('live-ui').hidden = true;
  $<HTMLButtonElement>('btn-start').disabled = true;
  $('test-controls').hidden = source !== 'file';
  $('setup-msg').textContent = 'Loading detector…';
  show('stage');

  try {
    if (source === 'camera') await openCamera(video);
    else await openVideoFile(video, file!);
  } catch (err) {
    leaveStage();
    showError(cameraError(err));
    return;
  }
  state.aspect = video.videoWidth / video.videoHeight;
  state.tracker = new BallTracker({ aspect: state.aspect });
  state.rimSize = Number($<HTMLInputElement>('rim-size').value);
  draw();

  getDetector()
    .then((d) => {
      $('setup-msg').textContent = 'Tap the rim';
      $('det-status').textContent = d.delegate === 'GPU' ? 'GPU' : 'CPU';
      if (source === 'file') void detectOnce();
    })
    .catch((err) => {
      $('setup-msg').textContent = `Detector failed: ${(err as Error).message}`;
    });

  if (source === 'camera') startFrameLoop();
}

function cameraError(err: unknown): string {
  const e = err as DOMException;
  if (e?.name === 'NotAllowedError') return 'Camera permission was denied. Allow camera access for this site and try again.';
  if (e?.name === 'NotFoundError') return 'No camera found on this device.';
  return e?.message || String(err);
}

function showError(msg: string): void {
  $('home-error').textContent = msg;
}

function resetTracking(): void {
  state.tracker.reset();
  state.detections = [];
  state.ball = null;
  state.trail = [];
  state.lastT = -Infinity;
}

function leaveStage(): void {
  state.running = false;
  state.stopFrames?.();
  state.stopFrames = null;
  void keepAwake(false);
  video.pause();
  if (state.source === 'camera') stopCamera(video);
  else if (video.src) {
    URL.revokeObjectURL(video.src);
    video.removeAttribute('src');
    video.load();
  }
}

/** Time base for a frame: wall clock for the camera, media time for a file. */
function frameTime(mediaMs: number, nowMs: number): number {
  return state.source === 'camera' ? nowMs - state.t0 : mediaMs;
}

function startFrameLoop(): void {
  state.stopFrames?.();
  state.stopFrames = onEachFrame(video, (mediaMs, nowMs) => {
    draw();
    if (!detector?.delegate || state.inFlight) return;
    state.inFlight = true;
    const t = frameTime(mediaMs, nowMs);
    detector
      .detect(video, t, chooseRoi(t))
      .then(handleFrame)
      .finally(() => (state.inFlight = false));
  });
}

let roiTurn = 0;

/** A square crop of `side` px centered near (cx, cy) px, kept inside the frame. */
function squareRoi(cx: number, cy: number, side: number): Box {
  const W = video.videoWidth;
  const H = video.videoHeight;
  const S = Math.min(side, W, H);
  const x = Math.min(Math.max(cx - S / 2, 0), W - S);
  const y = Math.min(Math.max(cy - S / 2, 0), H - S);
  return { x: x / W, y: y / H, w: S / W, h: S / H };
}

/**
 * Which part of the frame to run the model on. The model only sees a few
 * hundred pixels, so a crop finds a far-off ball the whole frame would miss:
 * follow the ball when it's tracked, otherwise watch the rim, with a
 * whole-frame look every third frame to catch the release.
 */
function chooseRoi(t: number): Box | undefined {
  const W = video.videoWidth;
  const H = video.videoHeight;
  const p = state.tracker.predict(t);
  if (p) return squareRoi(p.x * W, p.y * H, Math.max(360, 14 * p.size * W));
  const r = state.rim;
  if (!r || ++roiTurn % 3 === 0) return undefined;
  const rw = r.w * W;
  const side = Math.max(360, 9 * rw);
  // Mostly above the rim, where shots come from.
  return squareRoi((r.x + r.w / 2) * W, r.y * H - 5.5 * rw + side / 2, side);
}

function handleFrame(frame: DetectionFrame): void {
  if (frame.t < state.lastT) resetTracking();
  state.lastT = frame.t;
  state.detections = frame.balls;
  const ball = state.tracker.update(frame.t, frame.balls);
  state.ball = ball;
  if (ball) state.trail.push(ball);
  while (state.trail.length && state.trail[0].t < frame.t - TRAIL_MS) state.trail.shift();

  state.detFrames++;
  state.detMsSum += frame.ms;
  const now = performance.now();
  if (now - state.detClock > 1000) {
    const fps = (1000 * state.detFrames) / (now - state.detClock);
    const ms = state.detMsSum / state.detFrames;
    const label = `${detector?.delegate ?? ''} ${fps.toFixed(0)} fps · ${ms.toFixed(0)} ms`;
    $('det-status').textContent = label;
    $('live-status').textContent = label;
    state.detFrames = 0;
    state.detMsSum = 0;
    state.detClock = now;
  }

  if (state.phase === 'live' && state.judge) {
    const call = state.judge.update(frame.t, ball);
    if (call) onShot(call);
  }
  draw();
}

function draw(): void {
  drawOverlay(canvas, video.videoWidth, video.videoHeight, {
    rim: state.rim,
    detections: state.detections,
    ball: state.ball,
    trail: state.trail,
    inShot: state.judge?.state === 'attempt',
    debug: state.debug,
    guide: state.phase === 'setup' ? 1 / 3 : null,
  });
}

addEventListener('resize', () => draw());

function updateRim(): void {
  const c = state.rimCenter;
  if (!c) return;
  const w = state.rimSize;
  const h = w * state.aspect * RIM_OVAL;
  state.rim = { x: c.x - w / 2, y: c.y - h / 2, w, h };
  $<HTMLButtonElement>('btn-start').disabled = false;
  $('setup-msg').textContent = 'Size the oval to the rim, then Start';
  draw();
}

canvas.addEventListener('pointerdown', (e) => {
  if (state.phase !== 'setup' || !video.videoWidth) return;
  const rect = canvas.getBoundingClientRect();
  const f = fit(rect.width, rect.height, video.videoWidth, video.videoHeight);
  const x = (e.clientX - rect.left - f.x) / f.w;
  const y = (e.clientY - rect.top - f.y) / f.h;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  state.rimCenter = { x, y };
  updateRim();
});

$<HTMLInputElement>('rim-size').addEventListener('input', (e) => {
  state.rimSize = Number((e.target as HTMLInputElement).value);
  updateRim();
});

// Test mode: scrub to a frame where the rim is clear before tapping it.
const scrub = $<HTMLInputElement>('scrub');
scrub.addEventListener('input', () => {
  if (!video.duration) return;
  video.currentTime = Number(scrub.value) * video.duration;
});
video.addEventListener('seeked', () => {
  if (state.source === 'file' && state.phase === 'setup') void detectOnce();
});

async function detectOnce(): Promise<void> {
  if (!detector?.delegate || state.inFlight) {
    draw();
    return;
  }
  state.inFlight = true;
  try {
    const t = video.currentTime * 1000;
    handleFrame(await detector.detect(video, t, chooseRoi(t)));
  } finally {
    state.inFlight = false;
  }
}

$('btn-start').addEventListener('click', async () => {
  if (!state.rim) return;
  unlockVoice();
  await keepAwake(true);
  const session: SessionRecord = {
    id: newId('p'),
    date: Date.now(),
    mode: state.source === 'camera' ? 'practice' : 'test',
    rimBox: state.rim,
    aspect: state.aspect,
    modelVersion: MODELS[detector?.model ?? (modelSelect.value as ModelName)].version,
    notes: state.file?.name ?? '',
  };
  await saveSession(session);
  state.session = session;
  state.shots = [];
  state.judge = new ShotJudge(state.rim, { aspect: state.aspect });
  state.t0 = performance.now();
  resetTracking();
  state.phase = 'live';
  state.running = true;
  $('setup-ui').hidden = true;
  $('live-ui').hidden = false;
  updateHud();
  if (state.source === 'file') void runTest();
});

async function runTest(): Promise<void> {
  await getDetector();
  const speed = $<HTMLSelectElement>('test-speed').value;
  if (speed === 'exact') {
    // Step through every frame: slower than real time, but the result never
    // depends on how fast this phone runs the model.
    video.pause();
    const end = video.duration * 1000;
    for (let t = video.currentTime * 1000; t <= end && state.running; t += 1000 / TEST_FPS) {
      await seek(t / 1000);
      if (!state.running) return;
      handleFrame(await detector!.detect(video, t, chooseRoi(t)));
      $('live-status').textContent = `Analyzing ${Math.round((100 * t) / end)}%`;
    }
    if (state.running) finishTest(end);
    return;
  }
  video.playbackRate = Number(speed);
  video.onended = () => finishTest(video.duration * 1000);
  startFrameLoop();
  await video.play();
}

function seek(sec: number): Promise<void> {
  return new Promise((resolve) => {
    video.addEventListener('seeked', () => resolve(), { once: true });
    video.currentTime = sec;
  });
}

/** Let the judge settle a shot still in the air when the video ends. */
function finishTest(endMs: number): void {
  video.onended = null;
  if (!state.running || !state.judge) return;
  for (let t = endMs; t < endMs + 6000; t += 100) {
    const call = state.judge.update(t, null);
    if (call) onShot(call);
  }
  void endSession();
}

function onShot(call: ShotCall): void {
  const session = state.session;
  if (!session) return;
  const rec: ShotRecord = {
    id: newId('s'),
    sessionId: session.id,
    startMs: call.startMs,
    endMs: call.endMs,
    result: call.result,
    callSource: 'ai',
    aiResult: call.result,
    confidence: call.confidence,
    reason: call.reason,
    path: call.path,
    zone: null,
  };
  state.shots.push(rec);
  void saveShot(rec);
  afterShotChange(rec, '');
}

function addManual(result: 'make' | 'miss'): void {
  const session = state.session;
  if (!session) return;
  const t = state.source === 'camera' ? performance.now() - state.t0 : video.currentTime * 1000;
  const rec: ShotRecord = {
    id: newId('s'),
    sessionId: session.id,
    startMs: t,
    endMs: t,
    result,
    callSource: 'manual',
    aiResult: null,
    confidence: 1,
    reason: 'manual',
    path: [],
    zone: null,
  };
  state.shots.push(rec);
  void saveShot(rec);
  afterShotChange(rec, 'Added. ');
}

function flip(rec: ShotRecord): Promise<void> {
  rec.result = rec.result === 'make' ? 'miss' : 'make';
  if (rec.callSource !== 'manual') rec.callSource = rec.result === rec.aiResult ? 'ai' : 'fixed';
  return saveShot(rec);
}

let callTimer = 0;

function afterShotChange(rec: ShotRecord, prefix: string): void {
  const s = summarize(state.shots);
  announce(rec.result, s.makes, s.shots, prefix);
  updateHud();
  const el = $('last-call');
  el.textContent = rec.result === 'make' ? 'MAKE' : 'MISS';
  el.className = `call show ${rec.result}`;
  clearTimeout(callTimer);
  callTimer = window.setTimeout(() => el.classList.remove('show'), 2500);
}

function updateHud(): void {
  const s = summarize(state.shots);
  $('score-count').textContent = `${s.makes} / ${s.shots}`;
  $('score-pct').textContent = `${s.pct}%`;
  $<HTMLButtonElement>('btn-fix').disabled = state.shots.length === 0;
}

$('btn-fix').addEventListener('click', () => {
  const last = state.shots[state.shots.length - 1];
  if (!last) return;
  void flip(last);
  afterShotChange(last, 'Fixed. ');
});
$('btn-add-make').addEventListener('click', () => addManual('make'));
$('btn-add-miss').addEventListener('click', () => addManual('miss'));
$<HTMLInputElement>('tog-debug').addEventListener('change', (e) => {
  state.debug = (e.target as HTMLInputElement).checked;
  draw();
});
$<HTMLInputElement>('tog-voice').addEventListener('change', (e) => setVoice((e.target as HTMLInputElement).checked));
$('btn-end').addEventListener('click', () => void endSession());
$('btn-cancel').addEventListener('click', () => {
  leaveStage();
  show('home');
});

async function endSession(): Promise<void> {
  const session = state.session;
  leaveStage();
  state.session = null;
  state.judge = null;
  if (!session) return show('home');
  if (state.shots.length === 0) {
    await deleteSession(session.id);
    return show('home');
  }
  await showSummary(session.id);
}

// ---------- Summary and history ----------

let summaryId: string | null = null;

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function statsHtml(shots: ShotRecord[]): string {
  const s = summarize(shots);
  const acc = aiAccuracy(s);
  const cells: [string, string][] = [
    [`${s.makes}`, 'Makes'],
    [`${s.shots}`, 'Shots'],
    [`${s.pct}%`, 'FG%'],
    [`${s.longestStreak}`, 'Longest streak'],
    [acc === null ? '–' : `${Math.round(acc * 100)}%`, `AI accuracy (${s.fixed} fixed)`],
  ];
  return cells.map(([v, k]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');
}

async function showSummary(id: string): Promise<void> {
  const session = await getSession(id);
  if (!session) return show('home');
  summaryId = id;
  const shots = await shotsFor(id);
  $('sum-date').textContent = `${new Date(session.date).toLocaleString()} · ${session.mode}${session.notes ? ` · ${session.notes}` : ''}`;
  $('sum-stats').innerHTML = statsHtml(shots);
  const list = $('sum-shots');
  list.innerHTML = '';
  shots.forEach((shot, i) => {
    const li = document.createElement('li');
    const source =
      shot.callSource === 'ai' ? `AI ${Math.round(shot.confidence * 100)}% · ${shot.reason}` : shot.callSource;
    li.innerHTML = `
      ${pathSvg(shot.path, session.rimBox, session.aspect, shot.result === 'make')}
      <div class="meta"><b>#${i + 1}</b> <span class="badge ${shot.result}">${shot.result.toUpperCase()}</span><br>${fmtTime(shot.startMs)} · ${esc(source)}</div>
      <button data-act="flip">Flip</button>
      <button data-act="del" aria-label="Delete shot">✕</button>`;
    li.querySelector<HTMLButtonElement>('[data-act=flip]')!.onclick = async () => {
      await flip(shot);
      await showSummary(id);
    };
    li.querySelector<HTMLButtonElement>('[data-act=del]')!.onclick = async () => {
      await deleteShot(shot.id);
      await showSummary(id);
    };
    list.appendChild(li);
  });
  if (!shots.length) list.innerHTML = '<li class="muted">No shots.</li>';
  show('summary');
}

$('btn-sum-home').addEventListener('click', () => show('home'));
$('btn-sum-delete').addEventListener('click', async () => {
  if (!summaryId || !confirm('Delete this session and all its shots?')) return;
  await deleteSession(summaryId);
  await showHistory();
});
$('btn-sum-export').addEventListener('click', async () => {
  if (!summaryId) return;
  const session = await getSession(summaryId);
  const shots = await shotsFor(summaryId);
  const blob = new Blob([JSON.stringify({ session, shots }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hoops-${summaryId}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

async function showHistory(): Promise<void> {
  const sessions = await listSessions();
  const list = $('hist-list');
  list.innerHTML = '';
  for (const session of sessions) {
    const s = summarize(await shotsFor(session.id));
    const li = document.createElement('li');
    li.innerHTML = `<div class="meta"><b>${s.makes} / ${s.shots}</b> · ${s.pct}% · streak ${s.longestStreak}<br>${new Date(session.date).toLocaleString()} · ${session.mode}${session.notes ? ` · ${esc(session.notes)}` : ''}</div><span class="muted">›</span>`;
    li.onclick = () => void showSummary(session.id);
    list.appendChild(li);
  }
  if (!sessions.length) list.innerHTML = '<li class="muted">No sessions yet.</li>';
  show('history');
}

$('btn-history').addEventListener('click', () => void showHistory());
$('btn-hist-home').addEventListener('click', () => show('home'));

// ---------- Home ----------

$('btn-practice').addEventListener('click', () => {
  showError('');
  void enterStage('camera');
});
$<HTMLInputElement>('file-test').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  showError('');
  void enterStage('file', file);
});

// Start loading the model right away so it's ready by the time the camera is.
void getDetector().catch(() => {});

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
