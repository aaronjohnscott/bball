import type { BallPoint, Box, PathEntry, ShotCall, ShotResult } from './types';

/**
 * Distances are in rim widths, so the rules hold at any zoom. Vertical rim
 * widths are converted with the frame aspect ratio. Times are in ms.
 */
export interface JudgeConfig {
  aspect: number;
  /** Approach zone: how far beside the rim, and how high above it, a ball counts as a shot. */
  approachSideW: number;
  approachHeightW: number;
  /** A projected arc may start a shot from this far below the rim top. */
  launchBelowW: number;
  /** Entry must cross the rim top this far inside each rim edge (fraction of rim width). */
  entryInset: number;
  /** A make exits below the rim within this distance of its edges. */
  exitSideW: number;
  /** How far below the rim box the ball must drop to settle the call. */
  exitBelowW: number;
  /** Rising this far back above the rim top undoes an entry (a rattle out). */
  bounceOutW: number;
  /** Ball this far beside the rim has left the play. */
  leaveSideW: number;
  /** Give up on a shot after this long if the ball is away from the rim. */
  maxAttemptMs: number;
  /** Hard limit even while the ball rattles on the rim. */
  maxRattleMs: number;
  /** Ball unseen this long ends the shot. */
  lostMs: number;
  /** Quiet time after a call before another shot can start. */
  cooldownMs: number;
  /** g expressed in rim widths per s² (9.81 m/s² over a 0.457 m rim). */
  gravityRimWidths: number;
  /** Falling at this fraction of free-fall speed or more means it passed behind the rim, not through the net. */
  behindRimRatio: number;
  historyMs: number;
}

export const defaultJudgeConfig: Omit<JudgeConfig, 'aspect'> = {
  approachSideW: 2,
  approachHeightW: 6,
  launchBelowW: 3,
  entryInset: 0.05,
  exitSideW: 0.4,
  exitBelowW: 0.25,
  bounceOutW: 0.4,
  leaveSideW: 3.5,
  maxAttemptMs: 3000,
  maxRattleMs: 5000,
  lostMs: 1000,
  cooldownMs: 600,
  gravityRimWidths: 21.5,
  behindRimRatio: 0.93,
  historyMs: 2500,
};

interface Attempt {
  startMs: number;
  points: BallPoint[];
  lastSeen: BallPoint;
  wasAbove: boolean;
  wasNear: boolean;
  entered: boolean;
  entryFrom: BallPoint | null;
  entryVy: number | null;
}

export type JudgePhase = 'idle' | 'attempt' | 'cooldown';

/**
 * Turns a stream of ball positions into shot calls: shot start, make or miss.
 * Feed it every frame, with null when the ball wasn't seen.
 */
export class ShotJudge {
  readonly config: JudgeConfig;
  private rim: Box;
  private history: BallPoint[] = [];
  private attempt: Attempt | null = null;
  private phase: JudgePhase = 'idle';
  private resolvedAt = 0;
  private settled = false;
  private lastSeenT = -Infinity;

  constructor(rim: Box, config: Partial<JudgeConfig> & { aspect: number }) {
    this.rim = rim;
    this.config = { ...defaultJudgeConfig, ...config };
  }

  get state(): JudgePhase {
    return this.phase;
  }

  /** Rim width in normalized y units. */
  private get ry(): number {
    return this.rim.w * this.config.aspect;
  }

  /** Gravity in normalized y units per ms². */
  private get g(): number {
    return (this.config.gravityRimWidths * this.ry) / 1e6;
  }

  setRim(rim: Box): void {
    this.rim = rim;
    this.reset();
  }

  reset(): void {
    this.history = [];
    this.attempt = null;
    this.phase = 'idle';
  }

  update(t: number, ball: BallPoint | null): ShotCall | null {
    if (ball) {
      this.history.push(ball);
      this.lastSeenT = t;
      const cutoff = t - this.config.historyMs;
      while (this.history.length && this.history[0].t < cutoff) this.history.shift();
    }

    if (this.phase === 'cooldown') {
      const rimBottom = this.rim.y + this.rim.h;
      if (ball && ball.y > rimBottom + 0.5 * this.ry) this.settled = true;
      if (t - this.lastSeenT > this.config.lostMs) this.settled = true;
      if (t - this.resolvedAt >= this.config.cooldownMs && this.settled) {
        this.phase = 'idle';
        // Don't let the end of the last shot seed the next one.
        this.history = ball ? [ball] : [];
      }
      return null;
    }

    if (this.phase === 'idle') {
      if (!ball || !this.isShotStart(ball)) return null;
      const points = this.launchPoints();
      this.attempt = {
        startMs: points[0].t,
        points: points.slice(0, -1),
        lastSeen: points.length > 1 ? points[points.length - 2] : ball,
        wasAbove: false,
        wasNear: false,
        entered: false,
        entryFrom: null,
        entryVy: null,
      };
      this.phase = 'attempt';
    }
    return this.step(t, ball);
  }

  private inApproachZone(p: BallPoint): boolean {
    const { approachSideW, approachHeightW } = this.config;
    const r = this.rim;
    return (
      p.y < r.y + 0.5 * this.ry &&
      p.y > r.y - approachHeightW * this.ry &&
      p.x > r.x - approachSideW * r.w &&
      p.x < r.x + r.w + approachSideW * r.w
    );
  }

  private velocity(a: BallPoint, b: BallPoint): { vx: number; vy: number } {
    const dt = b.t - a.t;
    // Average velocity sits at the interval's midpoint; shift vy to time b.
    return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt + (this.g * dt) / 2 };
  }

  /** Where the arc from p crosses the rim top on the way down, if it gets that high. */
  private projectedX(p: BallPoint, vx: number, vy: number): number | null {
    const g = this.g;
    const dy = this.rim.y - p.y; // negative when the rim is above the ball
    // Solve p.y + vy t + g t²/2 = rim.y for the later root.
    const disc = vy * vy + 2 * g * dy;
    if (disc < 0) return null;
    const t = (-vy + Math.sqrt(disc)) / g;
    return t > 0 ? p.x + vx * t : null;
  }

  private isShotStart(ball: BallPoint): boolean {
    const h = this.history;
    if (h.length < 2) return false;
    const prev = h[h.length - 2];
    if (ball.t - prev.t > 400 || ball.t <= prev.t) return false;
    const speed = Math.hypot((ball.x - prev.x) * this.config.aspect, ball.y - prev.y) / (ball.t - prev.t);
    const moving = speed > (0.5 * this.ry) / 1000;

    if (this.inApproachZone(ball) && moving) return true;

    // Rising ball whose projected arc comes down at the rim: catches airballs
    // that never reach the approach zone. Needs three rising points so a
    // dribble or pump fake doesn't count.
    if (h.length < 3) return false;
    const first = h[h.length - 3];
    if (!(first.y > prev.y && prev.y > ball.y)) return false;
    if (ball.y > this.rim.y + this.config.launchBelowW * this.ry) return false;
    const { vx, vy } = this.velocity(prev, ball);
    if (vy > (-2 * this.ry) / 1000) return false;
    const x = this.projectedX(ball, vx, vy);
    const { approachSideW } = this.config;
    const r = this.rim;
    return x !== null && x > r.x - approachSideW * r.w && x < r.x + r.w + approachSideW * r.w;
  }

  /** History from the start of the ball's last rise (the release) to now. */
  private launchPoints(): BallPoint[] {
    const h = this.history;
    let apex = h.length - 1;
    for (let i = h.length - 1; i >= 0; i--) if (h[i].y < h[apex].y) apex = i;
    let start = apex;
    const eps = 0.1 * this.ry;
    while (start > 0 && h[start].t - h[start - 1].t < 300 && h[start - 1].y >= h[start].y - eps) start--;
    return h.slice(start);
  }

  private finish(t: number, result: ShotResult, confidence: number, reason: string): ShotCall {
    const a = this.attempt!;
    const path: PathEntry[] = a.points.map((p) => [Math.round(p.t), round4(p.x), round4(p.y)]);
    this.attempt = null;
    this.phase = 'cooldown';
    this.resolvedAt = t;
    this.settled = false;
    return { startMs: a.startMs, endMs: t, result, confidence: round4(confidence), reason, path };
  }

  private step(t: number, ball: BallPoint | null): ShotCall | null {
    const a = this.attempt!;
    const c = this.config;
    const r = this.rim;
    const ry = this.ry;
    const rimTop = r.y;
    const rimBottom = r.y + r.h;

    if (ball) {
      const q = a.lastSeen;
      a.points.push(ball);
      a.lastSeen = ball;
      if (ball.y < rimTop) a.wasAbove = true;
      if (this.inApproachZone(ball)) a.wasNear = true;

      // Crossing the rim top from above: inside the rim is an entry.
      if (q !== ball && q.y < rimTop && ball.y >= rimTop) {
        const f = (rimTop - q.y) / (ball.y - q.y);
        const xc = q.x + f * (ball.x - q.x);
        const inset = c.entryInset * r.w;
        if (xc > r.x + inset && xc < r.x + r.w - inset) {
          a.entered = true;
          a.entryFrom = q;
          const n = a.points.length;
          const before = n >= 3 ? a.points[n - 3] : null;
          a.entryVy = before && q.t - before.t < 250 && q.t > before.t ? this.velocity(before, q).vy : null;
        }
      }
      if (a.entered && ball.y < rimTop - c.bounceOutW * ry) {
        a.entered = false;
        a.entryFrom = null;
      }

      if (ball.y > rimBottom + c.exitBelowW * ry) {
        if (a.entered) {
          const inX = ball.x > r.x - c.exitSideW * r.w && ball.x < r.x + r.w + c.exitSideW * r.w;
          return inX ? this.judgeEntry(t, ball) : this.finish(t, 'miss', 0.7, 'out-after-entry');
        }
        if (a.wasAbove) return this.finish(t, 'miss', 0.85, 'fell-outside');
        if (ball.y > q.y) return this.finish(t, 'miss', 0.7, 'short');
      }
      if (a.wasNear && (ball.x < r.x - c.leaveSideW * r.w || ball.x > r.x + r.w + c.leaveSideW * r.w)) {
        return this.finish(t, 'miss', 0.8, 'left-zone');
      }
    } else {
      const last = a.lastSeen;
      // A high arc can leave the top of the frame; keep waiting for it.
      if (t - last.t > c.lostMs && last.y > 0.06) {
        if (a.entered) return this.finish(t, 'make', 0.55, 'lost-in-net');
        // Vanished falling just above the rim, inside it: the net usually hides it.
        const prev = a.points.length > 1 ? a.points[a.points.length - 2] : last;
        const atRim =
          last.x > r.x && last.x < r.x + r.w && last.y > rimTop - 0.5 * ry && last.y < rimTop && last.y > prev.y;
        return atRim ? this.finish(t, 'make', 0.5, 'lost-at-rim') : this.finish(t, 'miss', 0.5, 'lost');
      }
    }

    const elapsed = t - a.startMs;
    const p = a.lastSeen;
    const nearRim =
      p.x > r.x - 0.6 * r.w && p.x < r.x + r.w + 0.6 * r.w && p.y > rimTop - 1.2 * ry && p.y < rimBottom + ry;
    if (elapsed > c.maxRattleMs) return this.finish(t, 'miss', 0.4, 'timeout-rattle');
    if (elapsed > c.maxAttemptMs && !nearRim) return this.finish(t, 'miss', 0.5, 'timeout');
    return null;
  }

  /** Ball went in from above and came out below: check it slowed in the net. */
  private judgeEntry(t: number, ball: BallPoint): ShotCall {
    const a = this.attempt!;
    const from = a.entryFrom!;
    const dt = ball.t - from.t;
    let confidence = 0.9;
    if (a.entryVy !== null && dt > 0) {
      const observed = (ball.y - from.y) / dt;
      const freeFall = a.entryVy + 0.5 * this.g * dt;
      const ratio = freeFall > 0 ? observed / freeFall : 0;
      if (ratio >= this.config.behindRimRatio) return this.finish(t, 'miss', 0.6, 'behind-rim');
      if (ratio > 0.8) confidence = 0.65;
    } else {
      confidence = 0.75;
    }
    if (dt > 300) confidence -= 0.1;
    return this.finish(t, 'make', confidence, 'through-rim');
  }
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
