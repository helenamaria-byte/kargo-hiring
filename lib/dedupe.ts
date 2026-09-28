// Duplicate detection on the redacted text, so the same CV under a different name still matches.
import { createHash } from 'node:crypto';

export const NEAR_DUPLICATE_THRESHOLD = 0.8;

export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[(name|email|phone|profile link) removed\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const contentHash = (text: string) => createHash('sha256').update(normalise(text)).digest('hex');

function shingles(text: string, k = 3): Set<string> {
  const w = normalise(text).split(' ');
  const out = new Set<string>();
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(' '));
  return out;
}

export function similarity(a: string, b: string): number {
  const A = shingles(a), B = shingles(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const s of A) if (B.has(s)) inter++;
  return inter / (A.size + B.size - inter);
}

export function findDuplicate(
  text: string,
  hash: string,
  earlier: { id: number; cv_content: string | null; content_hash: string | null }[],
): { id: number; similarity: number } | null {
  let best: { id: number; similarity: number } | null = null;
  for (const e of earlier) {
    if (!e.cv_content) continue;
    const s = e.content_hash === hash ? 1 : similarity(text, e.cv_content);
    if (s >= NEAR_DUPLICATE_THRESHOLD && (!best || s > best.similarity)) best = { id: e.id, similarity: s };
  }
  return best;
}
