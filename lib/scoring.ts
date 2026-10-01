// All arithmetic and ranking lives here, in code. The AI only ever returns per-criterion 1–5 scores.

export type Role = 'PM' | 'SPM';
export type CriterionScore = { name: string; weight: number; score: number | null };

// sum(score × weight) / 5 → 0–100. Nulls are dropped and the remaining weights re-normalised to 100.
export function weightedTotal(items: CriterionScore[]): { total: number | null; scoredWeight: number } {
  const scored = items.filter((i) => i.score !== null);
  const scoredWeight = scored.reduce((s, i) => s + i.weight, 0);
  if (!scoredWeight) return { total: null, scoredWeight: 0 };
  const raw = scored.reduce((s, i) => s + (i.score as number) * i.weight, 0);
  const total = (raw / 5) * (100 / scoredWeight);
  return { total: Math.round(total * 10) / 10, scoredWeight };
}

const isOps = (name: string) => /did the operations work themselves/i.test(name);

// 4+ on every criterion except "Did the operations work themselves", and not 4+ on that one.
export function isStrongOutsider(items: CriterionScore[]): boolean {
  const ops = items.find((i) => isOps(i.name));
  const others = items.filter((i) => !isOps(i.name));
  if (!ops || others.length === 0) return false;
  return others.every((i) => i.score !== null && i.score >= 4) && !(ops.score !== null && ops.score >= 4);
}

export type Rankable = { id: number; total: number | null; scoredWeight: number; ops?: number | null };

// Highest total first. Ties go to the higher "Did the operations work themselves" score, then to more
// evidenced weight, then to the earlier upload.
export function rank<T extends Rankable>(rows: T[]): (T & { rank: number })[] {
  return [...rows]
    .sort((a, b) => {
      if (a.total === null && b.total === null) return a.id - b.id;
      if (a.total === null) return 1;
      if (b.total === null) return -1;
      return b.total - a.total || (b.ops ?? 0) - (a.ops ?? 0) || b.scoredWeight - a.scoredWeight || a.id - b.id;
    })
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

export const TOP_N = 5;
// Invites go to the top 5 per role AND only to those at or above this weighted score.
export const SHORTLIST_MIN = 75;
// Below this share of rubric weight backed by evidence, a total is flagged as resting on thin evidence.
export const THIN_EVIDENCE_PCT = 60;

// Two scoring runs → one score per criterion. Uses the lower score; a gap of more than 1, or one run
// finding evidence the other did not, marks the criterion inconsistent (and keeps no score for the latter).
export function reconcile(a: number | null, b: number | null): { score: number | null; from: 0 | 1; inconsistent: boolean } {
  if (a === null && b === null) return { score: null, from: 0, inconsistent: false };
  if (a === null || b === null) return { score: null, from: a === null ? 0 : 1, inconsistent: true };
  return { score: Math.min(a, b), from: a <= b ? 0 : 1, inconsistent: Math.abs(a - b) > 1 };
}
