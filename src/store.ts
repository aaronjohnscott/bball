import Dexie, { type EntityTable } from 'dexie';
import type { Box, PathEntry, ShotResult } from './types';

export interface SessionRecord {
  id: string;
  date: number;
  mode: 'practice' | 'game' | 'test';
  /** Tapped rim area, as fractions of the frame. */
  rimBox: Box;
  aspect: number;
  modelVersion: string;
  notes: string;
}

export interface ShotRecord {
  id: string;
  sessionId: string;
  startMs: number;
  endMs: number;
  result: ShotResult;
  /** ai: the judge's call; fixed: flipped by hand; manual: added by hand. */
  callSource: 'ai' | 'fixed' | 'manual';
  /** What the judge said, kept even after a fix so accuracy can be measured. */
  aiResult: ShotResult | null;
  confidence: number;
  reason: string;
  path: PathEntry[];
  zone: '2' | '3' | 'FT' | null;
}

const db = new Dexie('hoops-ai') as Dexie & {
  sessions: EntityTable<SessionRecord, 'id'>;
  shots: EntityTable<ShotRecord, 'id'>;
};

db.version(1).stores({
  sessions: 'id, date',
  shots: 'id, sessionId, startMs',
});

export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function saveSession(s: SessionRecord): Promise<void> {
  await db.sessions.put(s);
}

export async function saveShot(s: ShotRecord): Promise<void> {
  await db.shots.put(s);
}

export async function deleteShot(id: string): Promise<void> {
  await db.shots.delete(id);
}

export async function listSessions(): Promise<SessionRecord[]> {
  return db.sessions.orderBy('date').reverse().toArray();
}

export async function getSession(id: string): Promise<SessionRecord | undefined> {
  return db.sessions.get(id);
}

export async function shotsFor(sessionId: string): Promise<ShotRecord[]> {
  return db.shots.where('sessionId').equals(sessionId).sortBy('startMs');
}

export async function deleteSession(id: string): Promise<void> {
  await db.transaction('rw', db.sessions, db.shots, async () => {
    await db.shots.where('sessionId').equals(id).delete();
    await db.sessions.delete(id);
  });
}

export interface Summary {
  makes: number;
  shots: number;
  pct: number;
  longestStreak: number;
  fixed: number;
  manual: number;
}

export function summarize(shots: Pick<ShotRecord, 'result' | 'callSource'>[]): Summary {
  let makes = 0;
  let streak = 0;
  let longestStreak = 0;
  let fixed = 0;
  let manual = 0;
  for (const s of shots) {
    if (s.result === 'make') {
      makes++;
      streak++;
      longestStreak = Math.max(longestStreak, streak);
    } else {
      streak = 0;
    }
    if (s.callSource === 'fixed') fixed++;
    if (s.callSource === 'manual') manual++;
  }
  const n = shots.length;
  return { makes, shots: n, pct: n ? Math.round((100 * makes) / n) : 0, longestStreak, fixed, manual };
}

/** Share of AI calls left standing: 1 − fixed / AI-called shots. */
export function aiAccuracy(s: Summary): number | null {
  const aiShots = s.shots - s.manual;
  return aiShots ? 1 - s.fixed / aiShots : null;
}
