import { emailMode, emailOverride, ROLE_TITLE, type EmailMode } from './config';
import { rankings, type Flag } from './pipeline';
import { policyLabel, type Policy } from './policy';
import { loadSettings, type Shortlist } from './settings';
import type { Role } from './scoring';
import { db, q } from './supabase';

export type Criterion = { name: string; weight: number; score: number | null; evidence: string | null; verified: boolean | null; reason: string; probe: string | null };
export type Row = {
  id: number; order: number; name: string; total: number | null; ops: number | null; scoredWeight: number; roleApplied: Role;
  topCriterion: string | null; base: 'ready' | 'sent' | 'processing' | 'error'; duplicate: boolean; decision: 'invite' | 'reject' | null;
  sentAt: string | null; flags: Flag[]; criteria: Criterion[]; brief: string | null;
  draft: { type: 'invite' | 'rejection' | null; subject: string; body: string; edited: boolean } | null;
  email: string | null; phone: string | null; fileName: string; errorMessage: string | null;
};
export type ReviewData = {
  role: Role; rows: Row[]; criteria: string[]; policy: Policy; policyText: string; shortlist: Shortlist;
  mode: EmailMode; testTo: string | null;
};

// Everything the review page needs; grouping (Invite / Needs your eye / Not moving forward) happens in
// the browser so the threshold and invite count can be dragged live.
export async function loadReview(role: Role): Promise<ReviewData> {
  const [{ ranked, cut }, { policy, shortlist }, cands, scores, rubric, drafts, otherTotals] = await Promise.all([
    rankings(),
    loadSettings(),
    q<any[]>(db().from('candidates').select('id, file_name, role_applied, name, email, phone, status, error_message, duplicate_of, flags, sent_at, decision').eq('role_applied', role)),
    q<any[]>(db().from('scores').select('candidate_id, criterion_id, score, evidence, quote_verified, reason, probe_question').eq('role', role)),
    q<any[]>(db().from('rubric_criteria').select('*').eq('role', role).order('position')),
    q<any[]>(db().from('drafts').select('*')),
    q<any[]>(db().from('score_totals').select('candidate_id, weighted_total').eq('role', role === 'PM' ? 'SPM' : 'PM')),
  ]);
  const other: Role = role === 'PM' ? 'SPM' : 'PM';
  const order = new Map(ranked[role].map((r, i) => [r.id, { i, r }]));
  const otherTotal = new Map(otherTotals.map((t) => [t.candidate_id, t.weighted_total == null ? null : Number(t.weighted_total)]));

  const rows: Row[] = cands.map((c) => {
    const o = order.get(c.id);
    const d = drafts.find((x) => x.candidate_id === c.id);
    const flags: Flag[] = [...(c.flags ?? [])];
    const theirOther = otherTotal.get(c.id) ?? null;
    if (cut[other] !== null && cut[other]! >= shortlist.threshold && theirOther !== null && theirOther >= cut[other]!) {
      flags.push({ type: 'other_role', detail: `Would also make the ${ROLE_TITLE[other]} shortlist (${theirOther.toFixed(1)}). The email is for the role applied for.` });
    }
    const criteria: Criterion[] = rubric.map((cr) => {
      const s = scores.find((x) => x.candidate_id === c.id && x.criterion_id === cr.id);
      return { name: cr.name, weight: cr.weight, score: s?.score == null ? null : Number(s.score), evidence: s?.evidence ?? null, verified: s?.quote_verified ?? null, reason: s?.reason ?? '', probe: s?.probe_question ?? null };
    });
    const best = [...criteria].filter((x) => x.score !== null).sort((a, b) => b.score! - a.score! || b.weight - a.weight)[0];
    return {
      id: c.id, order: o?.i ?? 1e6 + c.id, name: c.name ?? c.file_name, total: o?.r.total ?? null, ops: o?.r.ops ?? null, scoredWeight: o?.r.scoredWeight ?? 0,
      roleApplied: c.role_applied, topCriterion: best?.name ?? null,
      base: (c.sent_at ? 'sent' : c.status === 'error' ? 'error' : c.status === 'processing' ? 'processing' : 'ready') as Row['base'],
      duplicate: Boolean(c.duplicate_of), decision: c.decision ?? null, sentAt: c.sent_at, flags, criteria,
      brief: (role === 'PM' ? d?.brief_pm : d?.brief_spm) ?? null,
      draft: d?.email_body ? { type: d.email_type, subject: d.email_subject ?? '', body: d.email_body, edited: d.edited } : null,
      email: c.email, phone: c.phone, fileName: c.file_name, errorMessage: c.error_message,
    };
  }).sort((a, b) => a.order - b.order);

  return { role, rows, criteria: rubric.map((r) => r.name), policy, policyText: policyLabel(policy), shortlist, mode: emailMode(), testTo: emailOverride() };
}

export async function loadStats() {
  const [{ top }, cands] = await Promise.all([rankings(), q<any[]>(db().from('candidates').select('id, status, sent_at'))]);
  const sent = new Set(cands.filter((c) => c.sent_at).map((c) => c.id));
  return {
    reviewed: cands.filter((c) => c.status === 'ready' || c.status === 'sent').length,
    invitesReady: [...top.PM, ...top.SPM].filter((id) => !sent.has(id)).length,
    sent: sent.size,
  };
}
