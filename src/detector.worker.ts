/// <reference lib="webworker" />
// Runs the object detector off the main thread so the camera view stays smooth.
import { FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision';
import type { BallDetection } from './types';

export type WorkerRequest =
  | { type: 'init'; wasmBase: string; modelUrl: string; preferGpu: boolean }
  | { type: 'detect'; id: number; t: number; frame: ImageBitmap };

export type WorkerResponse =
  | { type: 'ready'; delegate: 'GPU' | 'CPU' }
  | { type: 'error'; message: string }
  | { type: 'result'; id: number; t: number; balls: BallDetection[]; ms: number };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let detector: ObjectDetector | null = null;
let lastTs = 0;

function post(msg: WorkerResponse): void {
  ctx.postMessage(msg);
}

async function create(wasmBase: string, modelUrl: string, delegate: 'GPU' | 'CPU'): Promise<ObjectDetector> {
  // `true` picks the ES-module WASM loader, which module workers require.
  const fileset = await FilesetResolver.forVisionTasks(wasmBase, true);
  return ObjectDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: modelUrl, delegate },
    canvas: delegate === 'GPU' ? new OffscreenCanvas(1, 1) : undefined,
    runningMode: 'VIDEO',
    // The stock COCO model calls a basketball a "sports ball".
    categoryAllowlist: ['sports ball'],
    scoreThreshold: 0.15,
    maxResults: 5,
  });
}

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      if (msg.preferGpu) {
        try {
          detector = await create(msg.wasmBase, msg.modelUrl, 'GPU');
          post({ type: 'ready', delegate: 'GPU' });
          return;
        } catch (err) {
          console.warn('GPU delegate failed, using CPU', err);
        }
      }
      detector = await create(msg.wasmBase, msg.modelUrl, 'CPU');
      post({ type: 'ready', delegate: 'CPU' });
    } catch (err) {
      post({ type: 'error', message: String((err as Error)?.message ?? err) });
    }
    return;
  }

  if (msg.type === 'detect') {
    const { frame, id, t } = msg;
    if (!detector) {
      frame.close();
      return;
    }
    const started = performance.now();
    // MediaPipe needs strictly increasing timestamps, even after a video seek.
    lastTs = Math.max(lastTs + 1, Math.round(t));
    const result = detector.detectForVideo(frame, lastTs);
    const W = frame.width;
    const H = frame.height;
    frame.close();
    const balls: BallDetection[] = [];
    for (const d of result.detections) {
      const b = d.boundingBox;
      if (!b) continue;
      balls.push({
        cx: (b.originX + b.width / 2) / W,
        cy: (b.originY + b.height / 2) / H,
        w: b.width / W,
        h: b.height / H,
        score: d.categories[0]?.score ?? 0,
      });
    }
    post({ type: 'result', id, t, balls, ms: performance.now() - started });
  }
};
