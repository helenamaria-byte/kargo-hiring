import { ROLES, ROLE_TITLE } from './config';
import type { Flag } from './pipeline';
import { rank, TOP_N, type Role } from './scoring';
import { db, q } from './supabase';

export type CriterionView = { name: string; weight: number; score: number | null; evidence: string | null; quoteVerified: boolean | null; reason: string; probe: string | null };
export type CardData = {
  id: number; rank: number | null; total: number | null; scoredWeight: number;
  name: string | null; email: string | null; phone: string | null; fileName: string; roleApplied: Role;
  status: string; errorMessage: string | null; sentAt: string | null; createdAt: string; canRetry: boolean;
  duplicateOf: number | null; flags: Flag[];
  criteria: CriterionView[]; brief: string | null;
  draft: { type: string | null; subject: string; body: string; edited: boolean } | null;
};

export async function loadDashboard(role: Role) {
  const [cands, scores, totals, drafts, rubric] = await Promise.all([
    q<any[]>(db().from('candidates').select('id, created_at, file_name, role_applied, name, email, phone, status, error_message, duplicate_of, flags, sent_at, cv_content')),
    q<any[]>(db().from('scores').select('candidate_id, criterion_id, score, evidence, quote_verified, reason, probe_question').eq('role', role)),
    q<any[]>(db().from('score_totals').select('*').eq('role', role)),
    q<any[]>(db().from('drafts').select('*')),
    q<any[]>(db().from('rubric_criteria').select('*').eq('role', role).order('position')),
  ]);

  const totalOf = new Map(totals.map((t) => [t.candidate_id, t]));
  const ranked = rank(
    cands.filter((c) => !c.duplicate_of && c.status !== 'error' && totalOf.has(c.id)).map((c) => ({
      id: c.id, total: totalOf.get(c.id).weighted_total == null ? null : Number(totalOf.get(c.id).weighted_total), scoredWeight: totalOf.get(c.id).scored_weight,
    })),
  );
  const rankOf = new Map(ranked.map((r) => [r.id, r]));

  // The other role's top 5, to flag candidates who fit the role they didn't apply for.
  const other: Role = role === 'PM' ? 'SPM' : 'PM';
  const otherTotals = await q<any[]>(db().from('score_totals').select('*').eq('role', other));
  const otherTop = new Set(
    rank(otherTotals.filter((t) => cands.some((c) => c.id === t.candidate_id && !c.duplicate_of && c.status !== 'error'))
      .map((t) => ({ id: t.candidate_id, total: t.weighted_total == null ? null : Number(t.weighted_total), scoredWeight: t.scored_weight })))
      .filter((r) => r.total !== null).slice(0, TOP_N).map((r) => r.id),
  );

  const cards: CardData[] = cands.map((c) => {
    const r = rankOf.get(c.id);
    const d = drafts.find((x) => x.candidate_id === c.id);
    const flags: Flag[] = [...(c.flags ?? [])];
    if (otherTop.has(c.id) && c.role_applied !== other) {
      flags.push({ type: 'other_role', detail: `Top ${TOP_N} for ${ROLE_TITLE[other]} too (applied for ${ROLE_TITLE[c.role_applied as Role]}). The draft email is for the role applied for.` });
    }
    return {
      id: c.id, rank: r?.rank ?? null, total: r?.total ?? null, scoredWeight: r?.scoredWeight ?? 0,
      name: c.name, email: c.email, phone: c.phone, fileName: c.file_name, roleApplied: c.role_applied,
      status: c.status, errorMessage: c.error_message, sentAt: c.sent_at, createdAt: c.created_at,
      canRetry: c.status === 'error' && Boolean(c.cv_content),
      duplicateOf: c.duplicate_of, flags,
      criteria: rubric.map((cr) => {
        const s = scores.find((x) => x.candidate_id === c.id && x.criterion_id === cr.id);
        return { name: cr.name, weight: cr.weight, score: s?.score ?? null, evidence: s?.evidence ?? null, quoteVerified: s?.quote_verified ?? null, reason: s?.reason ?? '', probe: s?.probe_question ?? null };
      }),
      brief: (role === 'PM' ? d?.brief_pm : d?.brief_spm) ?? null,
      draft: d?.email_body ? { type: d.email_type, subject: d.email_subject ?? '', body: d.email_body, edited: d.edited } : null,
    };
  });

  const rankedCards = cards.filter((c) => c.rank !== null).sort((a, b) => a.rank! - b.rank!);
  const unranked = cards.filter((c) => c.rank === null).sort((a, b) => b.id - a.id);
  const pendingDrafts = cards.filter((c) => c.rank !== null && c.status === 'processing').length;
  const inProgress = cards.filter((c) => c.status === 'processing' && c.rank === null && !c.duplicateOf).length;
  return { rankedCards, unranked, pendingDrafts, inProgress, counts: Object.fromEntries(ROLES.map((r) => [r, cands.filter((c) => c.role_applied === r).length])) };
}
