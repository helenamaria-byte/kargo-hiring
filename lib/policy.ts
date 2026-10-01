// Scoring policy: turns the two raw AI runs into one score per criterion. Pure code, no AI — so Arjun can
// change strictness and see the ranking update instantly.

export type RawRun = {
  score: number | null; // the model's own 1–5 (or null: work history says nothing)
  quote: string;
  source: 'work_history' | 'summary' | 'other' | 'none';
  line: number | null; // CV line the quote was found in
  verified: boolean; // quote really is in the CV
  number: boolean; // evidence contains a volume, timeframe or adoption number
  reason: string;
  probe: string;
};

export type Policy = {
  preset: 'strict' | 'balanced' | 'lenient' | 'custom';
  combine: 'lower' | 'average'; // how the two runs become one score
  numberRule: 'four' | 'five' | 'off'; // which scores need a number in the evidence
  lineReuse: number; // how many criteria one CV line may back (scores of 2+)
  summaryMax: number; // highest score a summary/profile-only claim can earn
};

export const PRESETS: Record<'strict' | 'balanced' | 'lenient', Policy> = {
  strict: { preset: 'strict', combine: 'lower', numberRule: 'four', lineReuse: 1, summaryMax: 1 },
  balanced: { preset: 'balanced', combine: 'average', numberRule: 'five', lineReuse: 2, summaryMax: 2 },
  lenient: { preset: 'lenient', combine: 'average', numberRule: 'off', lineReuse: 99, summaryMax: 3 },
};

export type Applied = { score: number | null; quote: string | null; verified: boolean | null; reason: string; probe: string | null; note: string | null };

// One run, all criteria of one role: apply the summary cap, the number rule and the line-reuse limit.
export function applyRun(runs: { id: number; weight: number; name: string; run: RawRun | undefined }[], p: Policy): Map<number, Applied> {
  const out = new Map<number, Applied>();
  for (const { id, run } of runs) {
    if (!run || run.score === null || !Number.isFinite(run.score)) {
      out.set(id, { score: null, quote: null, verified: null, reason: run?.reason ?? 'No assessment returned.', probe: run?.probe || null, note: null });
      continue;
    }
    let s = Math.max(1, Math.min(5, Math.round(run.score)));
    let note: string | null = null;
    if (s > p.summaryMax && run.source !== 'work_history') { s = p.summaryMax; note = `capped at ${s}: only a summary or profile claim supports it`; }
    if (p.numberRule === 'four' && s >= 4 && !run.number) { s = 3; note = 'capped at 3: no number in the evidence'; }
    if (p.numberRule === 'five' && s === 5 && !run.number) { s = 4; note = 'capped at 4: a 5 needs a number in the evidence'; }
    out.set(id, { score: s, quote: run.quote || null, verified: run.verified, reason: run.reason, probe: null, note });
  }
  // A CV line may back at most `lineReuse` criteria that earn credit; extra uses fall back to 1.
  const byLine = new Map<number, number[]>();
  for (const { id, run } of runs) {
    const a = out.get(id)!;
    if (run?.line != null && a.score !== null && a.score >= 2) byLine.set(run.line, [...(byLine.get(run.line) ?? []), id]);
  }
  const weight = (id: number) => runs.find((r) => r.id === id)!.weight;
  for (const ids of byLine.values()) {
    if (ids.length <= p.lineReuse) continue;
    const ranked = [...ids].sort((a, b) => out.get(b)!.score! * weight(b) - out.get(a)!.score! * weight(a));
    const kept = runs.find((r) => r.id === ranked[0])!.name;
    for (const id of ranked.slice(p.lineReuse)) {
      const a = out.get(id)!;
      out.set(id, { ...a, score: 1, note: `no credit: its evidence line already backs “${kept}”`, probe: `Ask for a separate example for this criterion.` });
    }
  }
  return out;
}

// Two applied runs → final score. A run without evidence counts as 1 (no credit) so a disagreement can
// never empty a criterion and lift the total. Inconsistent = the runs differ by more than 1.
export function combine(a: Applied, b: Applied, p: Policy): Applied & { inconsistent: boolean } {
  if (a.score === null && b.score === null) return { ...a, probe: a.probe || b.probe, inconsistent: false };
  const x = a.score ?? 1, y = b.score ?? 1;
  const inconsistent = Math.abs(x - y) > 1;
  const best = (a.score ?? 0) >= (b.score ?? 0) ? a : b; // evidence comes from the run that found most
  const low = x <= y ? a : b;
  if (p.combine === 'lower') {
    const pick = low.score === null ? best : low;
    return { ...pick, score: Math.min(x, y), inconsistent };
  }
  return { ...best, score: Math.round(((x + y) / 2) * 2) / 2, inconsistent };
}

export const policyLabel = (p: Policy) =>
  `${p.combine === 'lower' ? 'lower of two runs' : 'average of two runs'} · ${p.numberRule === 'four' ? '4–5 need a number' : p.numberRule === 'five' ? '5 needs a number' : 'no number rule'} · one line backs ${p.lineReuse >= 99 ? 'any number of' : p.lineReuse} criteri${p.lineReuse === 1 ? 'on' : 'a'} · summary claims up to ${p.summaryMax}`;
