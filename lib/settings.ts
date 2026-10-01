import { PRESETS, type Policy } from './policy';
import { db, q } from './supabase';

export type Shortlist = { threshold: number; topN: number };
export const DEFAULT_SHORTLIST: Shortlist = { threshold: 65, topN: 5 };

export async function loadSettings(): Promise<{ policy: Policy; shortlist: Shortlist }> {
  const rows = await q<{ key: string; value: any }[]>(db().from('settings').select('key, value'));
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const policy = { ...PRESETS.balanced, ...(get('scoring') ?? {}) } as Policy;
  const s = { ...DEFAULT_SHORTLIST, ...(get('shortlist') ?? {}) } as Shortlist;
  return { policy, shortlist: { threshold: clamp(s.threshold, 0, 100), topN: clamp(Math.round(s.topN), 1, 20) } };
}

export async function saveSetting(key: 'scoring' | 'shortlist', value: object) {
  await q(db().from('settings').upsert({ key, value, updated_at: new Date().toISOString() }).select('key'));
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
