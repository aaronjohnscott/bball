import type { WorkerRequest, WorkerResponse } from './detector.worker';
import type { BallDetection, Box } from './types';

export const MODELS = {
  lite0: { file: 'efficientdet_lite0.tflite', version: 'mediapipe-efficientdet_lite0-int8', label: 'Fast' },
  lite2: { file: 'efficientdet_lite2.tflite', version: 'mediapipe-efficientdet_lite2-fp16', label: 'Accurate' },
} as const;
export type ModelName = keyof typeof MODELS;

/** Side of the square the model sees, in px; crops are resized to about this. */
const CROP_PX = 448;

export interface DetectionFrame {
  t: number;
  balls: BallDetection[];
  ms: number;
}

/** Main-thread handle on the detector worker. One frame in flight at a time. */
export class Detector {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, (r: DetectionFrame) => void>();
  delegate: 'GPU' | 'CPU' | null = null;
  private ready: Promise<void>;

  readonly model: ModelName;

  constructor(model: ModelName) {
    this.model = model;
    this.worker = new Worker(new URL('./detector.worker.ts', import.meta.url), { type: 'module' });
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        if (msg.type === 'ready') {
          this.delegate = msg.delegate;
          resolve();
        } else if (msg.type === 'error') {
          reject(new Error(msg.message));
        } else if (msg.type === 'result') {
          const done = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          done?.({ t: msg.t, balls: msg.balls, ms: msg.ms });
        }
      };
      this.worker.onerror = (e) => reject(new Error(e.message || 'Detector worker failed to load'));
    });
    const base = new URL(import.meta.env.BASE_URL, location.href);
    this.send({
      type: 'init',
      wasmBase: new URL('mediapipe/wasm', base).href,
      modelUrl: new URL(`models/${MODELS[model].file}`, base).href,
      preferGpu: !/[?&]cpu\b/.test(location.search),
    });
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  get busy(): boolean {
    return this.pending.size > 0;
  }

  /**
   * Detects balls in `roi` (normalized; whole frame by default). The model
   * sees a few hundred pixels, so a far-away ball is only found in a crop.
   * Results come back in whole-frame coordinates.
   */
  async detect(video: HTMLVideoElement, t: number, roi: Box = { x: 0, y: 0, w: 1, h: 1 }): Promise<DetectionFrame> {
    const W = video.videoWidth;
    const H = video.videoHeight;
    const sx = Math.round(roi.x * W);
    const sy = Math.round(roi.y * H);
    const sw = Math.max(1, Math.round(roi.w * W));
    const sh = Math.max(1, Math.round(roi.h * H));
    const scale = Math.min(1, (CROP_PX * 1.5) / Math.max(sw, sh));
    const frame = await createImageBitmap(video, sx, sy, sw, sh, {
      resizeWidth: Math.round(sw * scale),
      resizeHeight: Math.round(sh * scale),
      resizeQuality: 'medium',
    });
    const id = this.nextId++;
    const result = await new Promise<DetectionFrame>((resolve) => {
      this.pending.set(id, resolve);
      this.send({ type: 'detect', id, t, frame }, [frame]);
    });
    const sxN = sx / W;
    const syN = sy / H;
    const swN = sw / W;
    const shN = sh / H;
    result.balls = result.balls.map((b) => ({
      cx: sxN + b.cx * swN,
      cy: syN + b.cy * shN,
      w: b.w * swN,
      h: b.h * shN,
      score: b.score,
    }));
    return result;
  }

  private send(msg: WorkerRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  terminate(): void {
    this.worker.terminate();
  }
}
