/** Axis-aligned box in normalized frame coordinates (0..1), top-left origin. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One ball candidate from the detector, normalized coordinates. */
export interface BallDetection {
  cx: number;
  cy: number;
  w: number;
  h: number;
  score: number;
}

/** A tracked ball position at a moment in time (ms). */
export interface BallPoint {
  t: number;
  x: number;
  y: number;
  /** Ball box size, normalized width. */
  size: number;
}

/** Stored path entry: [timeMs, x, y], normalized. */
export type PathEntry = [number, number, number];

export type ShotResult = 'make' | 'miss';

/** What the judge emits when a shot ends. */
export interface ShotCall {
  startMs: number;
  endMs: number;
  result: ShotResult;
  confidence: number;
  /** Short machine-readable reason, kept for tuning. */
  reason: string;
  path: PathEntry[];
}
