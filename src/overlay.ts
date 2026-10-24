import type { BallDetection, BallPoint, Box, PathEntry } from './types';

export interface OverlayState {
  rim: Box | null;
  detections: BallDetection[];
  ball: BallPoint | null;
  trail: BallPoint[];
  inShot: boolean;
  debug: boolean;
  /** Fraction of the frame from the top to draw the setup guide line, or null. */
  guide: number | null;
}

/**
 * Draws on a canvas sized to the displayed video. Coordinates come in as
 * fractions of the video frame; `fit` maps them to canvas pixels, accounting
 * for letterboxing from object-fit: contain.
 */
export function drawOverlay(canvas: HTMLCanvasElement, videoW: number, videoH: number, s: OverlayState): void {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  const f = fit(cw, ch, videoW, videoH);
  const X = (x: number) => f.x + x * f.w;
  const Y = (y: number) => f.y + y * f.h;

  if (s.guide !== null) {
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.setLineDash([8, 8]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(f.x, Y(s.guide));
    ctx.lineTo(f.x + f.w, Y(s.guide));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.fillText('Rim above this line', f.x + 10, Y(s.guide) - 8);
  }

  if (s.rim) {
    const r = s.rim;
    ctx.strokeStyle = s.inShot ? '#ffcc00' : '#ff7a1a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(X(r.x + r.w / 2), Y(r.y + r.h / 2), (r.w * f.w) / 2, (r.h * f.h) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
    if (s.debug) {
      ctx.lineWidth = 1;
      ctx.strokeRect(X(r.x), Y(r.y), r.w * f.w, r.h * f.h);
    }
  }

  if (s.debug) {
    ctx.strokeStyle = 'rgba(120,200,255,0.8)';
    ctx.lineWidth = 1.5;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(120,200,255,0.95)';
    for (const d of s.detections) {
      ctx.strokeRect(X(d.cx - d.w / 2), Y(d.cy - d.h / 2), d.w * f.w, d.h * f.h);
      ctx.fillText(d.score.toFixed(2), X(d.cx - d.w / 2), Y(d.cy - d.h / 2) - 3);
    }
  }

  if (s.trail.length > 1) {
    ctx.strokeStyle = s.inShot ? 'rgba(255,204,0,0.9)' : 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    s.trail.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
    ctx.stroke();
  }

  if (s.ball) {
    const b = s.ball;
    const half = (b.size * f.w) / 2;
    ctx.strokeStyle = '#3cff8f';
    ctx.lineWidth = 3;
    ctx.strokeRect(X(b.x) - half, Y(b.y) - half, half * 2, half * 2);
  }
}

export function fit(cw: number, ch: number, vw: number, vh: number): { x: number; y: number; w: number; h: number } {
  if (!vw || !vh) return { x: 0, y: 0, w: cw, h: ch };
  const scale = Math.min(cw / vw, ch / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

/** Small SVG of a stored shot path, for the summary list. */
export function pathSvg(path: PathEntry[], rim: Box, aspect: number, made: boolean): string {
  const W = 120;
  const H = Math.round(W / aspect);
  const rimEl = `<ellipse cx="${(rim.x + rim.w / 2) * W}" cy="${(rim.y + rim.h / 2) * H}" rx="${(rim.w * W) / 2}" ry="${Math.max(1.5, (rim.h * H) / 2)}" fill="none" stroke="#ff7a1a" stroke-width="1.5"/>`;
  const pts = path.map(([, x, y]) => `${(x * W).toFixed(1)},${(y * H).toFixed(1)}`).join(' ');
  const line = pts
    ? `<polyline points="${pts}" fill="none" stroke="${made ? '#3cff8f' : '#ff5c5c'}" stroke-width="1.5" stroke-linejoin="round"/>`
    : '';
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="path" aria-hidden="true">${rimEl}${line}</svg>`;
}
