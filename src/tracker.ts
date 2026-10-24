import type { BallDetection, BallPoint } from './types';

export interface TrackerConfig {
  /** Frame width / height, so distances are measured in true proportions. */
  aspect: number;
  /** Forget the track after this long without a match. */
  maxGapMs: number;
  /** Minimum detector score to start a new track. */
  startScore: number;
  /** Minimum detector score to continue an existing track. */
  keepScore: number;
  /** Boxes wider than this (fraction of frame) are not the ball. */
  maxBallSize: number;
  /** A detection that sits in one spot this long is clutter (an orange rim, a sign). */
  staticMs: number;
}

export const defaultTrackerConfig: Omit<TrackerConfig, 'aspect'> = {
  maxGapMs: 500,
  startScore: 0.35,
  keepScore: 0.15,
  maxBallSize: 0.25,
  staticMs: 1500,
};

interface Spot {
  x: number;
  y: number;
  size: number;
  firstT: number;
  lastT: number;
}

/**
 * Follows a single ball: each frame, pick the detection nearest to where the
 * ball should be given its last velocity. One ball needs nothing fancier.
 */
export class BallTracker {
  private last: BallPoint | null = null;
  private prev: BallPoint | null = null;
  private spots: Spot[] = [];
  readonly config: TrackerConfig;

  constructor(config: Partial<TrackerConfig> & { aspect: number }) {
    this.config = { ...defaultTrackerConfig, ...config };
  }

  reset(): void {
    this.dropTrack();
    this.spots = [];
  }

  private dropTrack(): void {
    this.last = null;
    this.prev = null;
  }

  /** Where the ball should be at time t, if it was seen recently. */
  predict(t: number, withinMs = 250): BallPoint | null {
    const last = this.last;
    if (!last || t - last.t > withinMs) return null;
    if (!this.prev || last.t <= this.prev.t) return { ...last, t };
    const k = (t - last.t) / (last.t - this.prev.t);
    return { t, x: last.x + (last.x - this.prev.x) * k, y: last.y + (last.y - this.prev.y) * k, size: last.size };
  }

  /** Marks detections that haven't moved for a while. */
  private findStatic(t: number, detections: BallDetection[]): Set<BallDetection> {
    const { staticMs } = this.config;
    this.spots = this.spots.filter((s) => t - s.lastT < 1000);
    const out = new Set<BallDetection>();
    for (const d of detections) {
      const spot = this.spots.find((s) => Math.abs(s.x - d.cx) < 0.5 * s.size && Math.abs(s.y - d.cy) < 0.5 * s.size);
      if (!spot) {
        this.spots.push({ x: d.cx, y: d.cy, size: d.w, firstT: t, lastT: t });
        continue;
      }
      spot.lastT = t;
      if (t - spot.firstT >= staticMs) out.add(d);
    }
    return out;
  }

  /** Returns the ball's position this frame, or null if it wasn't seen. */
  update(t: number, detections: BallDetection[]): BallPoint | null {
    const { aspect, maxGapMs, startScore, keepScore, maxBallSize } = this.config;
    const candidates = detections.filter((d) => d.w <= maxBallSize && d.score >= keepScore);
    const still = this.findStatic(t, candidates);

    if (this.last && t - this.last.t > maxGapMs) this.dropTrack();

    let chosen: BallDetection | undefined;
    if (this.last) {
      const last = this.last;
      const dt = t - last.t;
      let px = last.x;
      let py = last.y;
      let speed = 0;
      if (this.prev && last.t > this.prev.t) {
        const vx = (last.x - this.prev.x) / (last.t - this.prev.t);
        const vy = (last.y - this.prev.y) / (last.t - this.prev.t);
        px += vx * dt;
        py += vy * dt;
        speed = Math.hypot(vx * aspect, vy) * dt;
      }
      // Gate grows with speed and gap so fast shots and short dropouts still match.
      const gate = Math.max(0.06, 1.5 * speed + 3 * last.size * aspect);
      let best = Infinity;
      for (const d of candidates) {
        // Faint clutter can't hijack a moving track; a confident ball still can pass it.
        if (still.has(d) && d.score < startScore) continue;
        const dist = Math.hypot((d.cx - px) * aspect, d.cy - py);
        if (dist < gate && dist < best) {
          best = dist;
          chosen = d;
        }
      }
    }
    if (!chosen) {
      // No continuation: start fresh from the most confident detection.
      const fresh = candidates
        .filter((d) => d.score >= startScore && !still.has(d))
        .sort((a, b) => b.score - a.score)[0];
      if (fresh && !this.last) chosen = fresh;
      else if (fresh && this.last) {
        // A confident ball far from the old track: switch to it.
        this.dropTrack();
        chosen = fresh;
      }
    }
    if (!chosen) return null;

    const point: BallPoint = { t, x: chosen.cx, y: chosen.cy, size: chosen.w };
    this.prev = this.last;
    this.last = point;
    return point;
  }
}
