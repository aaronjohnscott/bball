import { describe, expect, it } from 'vitest';
import { ShotJudge, defaultJudgeConfig } from '../src/judge';
import { BallTracker } from '../src/tracker';
import type { BallPoint, Box, ShotCall } from '../src/types';

const aspect = 16 / 9;
const rim: Box = { x: 0.6, y: 0.25, w: 0.06, h: 0.025 };
const ry = rim.w * aspect;
const g = (defaultJudgeConfig.gravityRimWidths * ry) / 1e6; // per ms²
const FRAME = 33;
const rimCx = rim.x + rim.w / 2;

type Frame = [number, BallPoint | null];

/** Free flight from (x0, y0) that reaches (x1, y1) after T ms. */
function arc(t0: number, x0: number, y0: number, x1: number, y1: number, T: number): Frame[] {
  const vx = (x1 - x0) / T;
  const vy = (y1 - y0 - 0.5 * g * T * T) / T;
  const out: Frame[] = [];
  for (let dt = 0; dt <= T; dt += FRAME) {
    out.push([t0 + dt, { t: t0 + dt, x: x0 + vx * dt, y: y0 + vy * dt + 0.5 * g * dt * dt, size: 0.03 }]);
  }
  return out;
}

/** Straight-line motion at constant velocity (units per ms). */
function line(t0: number, x0: number, y0: number, vx: number, vy: number, ms: number, gravity = 0): Frame[] {
  const out: Frame[] = [];
  for (let dt = FRAME; dt <= ms; dt += FRAME) {
    out.push([t0 + dt, { t: t0 + dt, x: x0 + vx * dt, y: y0 + vy * dt + 0.5 * gravity * dt * dt, size: 0.03 }]);
  }
  return out;
}

function hidden(t0: number, ms: number): Frame[] {
  const out: Frame[] = [];
  for (let dt = FRAME; dt <= ms; dt += FRAME) out.push([t0 + dt, null]);
  return out;
}

function lastOf(frames: Frame[]): BallPoint {
  for (let i = frames.length - 1; i >= 0; i--) if (frames[i][1]) return frames[i][1]!;
  throw new Error('no ball');
}

function endT(frames: Frame[]): number {
  return frames[frames.length - 1][0];
}

function run(frames: Frame[], tail = 2000): ShotCall[] {
  const judge = new ShotJudge(rim, { aspect });
  const calls: ShotCall[] = [];
  for (const [t, p] of frames) {
    const c = judge.update(t, p);
    if (c) calls.push(c);
  }
  const t1 = endT(frames);
  for (let t = t1 + FRAME; t < t1 + tail; t += FRAME) {
    const c = judge.update(t, null);
    if (c) calls.push(c);
  }
  return calls;
}

/** A jump shot from the left that comes down at x, just above the rim top. */
function shotTo(x: number, t0 = 0): Frame[] {
  return arc(t0, 0.2, 0.7, x, rim.y - 0.01, 1300);
}

describe('ShotJudge', () => {
  it('calls a make when the ball drops through and slows in the net', () => {
    const flight = shotTo(rimCx);
    const p = lastOf(flight);
    const net = [...hidden(endT(flight), 66), ...line(endT(flight) + 66, rimCx, rim.y + rim.h, 0, 0.0006, 400)];
    const calls = run([...flight, ...net]);
    expect(calls).toHaveLength(1);
    expect(calls[0].result).toBe('make');
    expect(calls[0].reason).toBe('through-rim');
    expect(calls[0].startMs).toBeLessThan(100);
    expect(calls[0].path.length).toBeGreaterThan(20);
    expect(p.y).toBeLessThan(rim.y);
  });

  it('calls a miss when the ball falls past the rim at full free-fall speed', () => {
    const flight = shotTo(rimCx);
    const p = lastOf(flight);
    const vy = (p.y - flight[flight.length - 2][1]!.y) / FRAME;
    const fall = line(endT(flight), p.x, p.y, 0, vy, 500, g);
    const calls = run([...flight, ...fall]);
    expect(calls).toHaveLength(1);
    expect(calls[0].result).toBe('miss');
    expect(calls[0].reason).toBe('behind-rim');
  });

  it('calls a miss off the front rim', () => {
    const flight = shotTo(rim.x + 0.002);
    const p = lastOf(flight);
    const bounce = line(endT(flight), p.x, p.y, -0.0003, -0.0008, 900, g);
    const calls = run([...flight, ...bounce]);
    expect(calls).toHaveLength(1);
    expect(calls[0].result).toBe('miss');
  });

  it('calls an airball that falls short of the rim a miss', () => {
    const flight = arc(0, 0.2, 0.7, rim.x - 0.7 * rim.w, 0.6, 1500);
    const calls = run(flight);
    expect(calls).toHaveLength(1);
    expect(calls[0].result).toBe('miss');
  });

  it('ignores dribbling', () => {
    const frames: Frame[] = [];
    for (let i = 0; i < 10; i++) {
      frames.push(...arc(i * 600, 0.3, 0.9, 0.3, 0.9, 600).slice(i ? 1 : 0));
    }
    expect(run(frames)).toHaveLength(0);
  });

  it('holds the call through a rattle and counts it when it drops', () => {
    const flight = shotTo(rimCx + 0.3 * rim.w);
    const p = lastOf(flight);
    // Into the rim, pop back up, then fall through.
    const t1 = endT(flight);
    const pop = arc(t1 + FRAME, p.x, rim.y + 0.3 * rim.h, rimCx, rim.y - 0.01, 600);
    const q = lastOf(pop);
    const drop = line(endT(pop), rimCx, q.y, 0, 0.0005, 500);
    const calls = run([...flight, ...pop, ...drop]);
    expect(calls).toHaveLength(1);
    expect(calls[0].result).toBe('make');
  });

  it('calls a make when the net hides the ball for good after entry', () => {
    const flight = shotTo(rimCx);
    const p = lastOf(flight);
    const into = line(endT(flight), p.x, p.y, 0, 0.0003, 132);
    const calls = run([...flight, ...into, ...hidden(endT(into), 1500)]);
    expect(calls).toHaveLength(1);
    expect(calls[0].result).toBe('make');
    expect(calls[0].reason).toBe('lost-in-net');
  });

  it('calls a make when the ball vanishes falling into the rim', () => {
    const flight = shotTo(rimCx);
    const calls = run([...flight, ...hidden(endT(flight), 1500)]);
    expect(calls).toHaveLength(1);
    expect(calls[0].result).toBe('make');
    expect(calls[0].reason).toBe('lost-at-rim');
  });

  it('counts back-to-back shots separately', () => {
    const first = shotTo(rimCx);
    const p = lastOf(first);
    const fall1 = line(endT(first), rimCx, p.y, 0, 0.0005, 900);
    const rebound = line(endT(fall1), rimCx, lastOf(fall1).y, -0.0004, 0.0002, 1000);
    const second = shotTo(rim.x + 0.002, endT(rebound) + 500);
    const q = lastOf(second);
    const off = line(endT(second), q.x, q.y, -0.0003, -0.0008, 900, g);
    const calls = run([...first, ...fall1, ...rebound, ...second, ...off]);
    expect(calls.map((c) => c.result)).toEqual(['make', 'miss']);
  });
});

describe('BallTracker', () => {
  it('follows the ball and ignores a far-off low-score blob', () => {
    const tr = new BallTracker({ aspect });
    const a = tr.update(0, [{ cx: 0.3, cy: 0.6, w: 0.03, h: 0.05, score: 0.8 }]);
    expect(a?.x).toBeCloseTo(0.3);
    const b = tr.update(33, [
      { cx: 0.31, cy: 0.58, w: 0.03, h: 0.05, score: 0.3 },
      { cx: 0.9, cy: 0.1, w: 0.03, h: 0.05, score: 0.2 },
    ]);
    expect(b?.x).toBeCloseTo(0.31);
    expect(tr.update(66, [])).toBeNull();
    const c = tr.update(99, [{ cx: 0.33, cy: 0.54, w: 0.03, h: 0.05, score: 0.2 }]);
    expect(c?.x).toBeCloseTo(0.33);
  });

  it('drops boxes too big to be the ball', () => {
    const tr = new BallTracker({ aspect });
    expect(tr.update(0, [{ cx: 0.5, cy: 0.5, w: 0.4, h: 0.4, score: 0.9 }])).toBeNull();
  });
});

describe('BallTracker clutter', () => {
  it('ignores a faint detection that never moves', () => {
    const tr = new BallTracker({ aspect });
    const blob = { cx: 0.63, cy: 0.26, w: 0.03, h: 0.05, score: 0.2 };
    // A ball falls past the blob; once the blob is old, a faint track can't jump onto it.
    for (let t = 0; t < 2000; t += 33) tr.update(t, [blob]);
    tr.update(2000, [{ cx: 0.63, cy: 0.1, w: 0.03, h: 0.05, score: 0.8 }, blob]);
    tr.update(2033, [{ cx: 0.63, cy: 0.15, w: 0.03, h: 0.05, score: 0.8 }, blob]);
    expect(tr.update(2066, [blob])).toBeNull();
  });
});
