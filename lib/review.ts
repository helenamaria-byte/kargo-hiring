import { emailMode, emailOverride, ROLE_TITLE, type EmailMode } from './config';
import { rankings, type Flag } from './pipeline';
import { SHORTLIST_MIN, TOP_N, type Role } from './scoring';
import { db, q } from './supabase';

export type Group = 'invite' | 'eye' | 'no';
export type Status = 'ready' | 'sent' | 'check' | 'processing' | 'error';
export type Criterion = { name: string; weight: number; score: number | null; evidence: string | null; verified: boolean | null; reason: string; probe: string | null };
export type Row = {
  id: number; rank: number | null; name: string; total: number | null; scoredWeight: number; roleApplied: Role;
  topCriterion: string | null; status: Status; group: Group; sentAt: string | null;
  flags: Flag[]; criteria: Criterion[]; brief: string | null; action: string;
  draft: { type: 'invite' | 'rejection' | null; subject: string; body: string; edited: boolean } | null;
  email: string | null; phone: string | null; fileName: string; errorMessage: string | null;
};

// Flags that put a candidate in "Needs your eye". "Role assigned by score" is shown on the panel but is
// informational: it only says the CV didn't state a role.
const REVIEW_FLAGS = new Set([
  'strong_outsider', 'prompt_injection', 'scores_inconsistent', 'thin_evidence', 'tied_cutoff', 'other_role',
  'duplicate', 'name_not_detected', 'email_not_detected', 'name_from_file',
]);

export const FLAG_LABEL: Record<string, string> = {
  strong_outsider: 'Strong outsider', prompt_injection: 'Text addressed to AI', scores_inconsistent: 'Scores inconsistent',
  thin_evidence: 'Thin evidence', tied_cutoff: 'Tied at cut-off', other_role: 'Fits other role', duplicate: 'Duplicate',
  name_not_detected: 'Name not found', email_not_detected: 'Email not found', name_from_file: 'Name from file name',
  role_assigned: 'Role assigned by score',
};

export async function loadReview(role: Role) {
  const [{ top, cut, ranked }, cands, scores, rubric, drafts, otherTotals] = await Promise.all([
    rankings(),
    q<any[]>(db().from('candidates').select('id, file_name, role_applied, name, email, phone, status, error_message, duplicate_of, flags, sent_at')),
    q<any[]>(db().from('scores').select('candidate_id, criterion_id, score, evidence, quote_verified, reason, probe_question').eq('role', role)),
    q<any[]>(db().from('rubric_criteria').select('*').eq('role', role).order('position')),
    q<any[]>(db().from('drafts').select('*')),
    q<any[]>(db().from('score_totals').select('candidate_id, weighted_total').eq('role', role === 'PM' ? 'SPM' : 'PM')),
  ]);
  const other: Role = role === 'PM' ? 'SPM' : 'PM';
  const rankOf = new Map(ranked[role].map((r) => [r.id, r]));
  const otherTotal = new Map(otherTotals.map((t) => [t.candidate_id, t.weighted_total == null ? null : Number(t.weighted_total)]));

  const rows: Row[] = cands
    .filter((c) => c.role_applied === role)
    .map((c) => {
      const r = rankOf.get(c.id);
      const d = drafts.find((x) => x.candidate_id === c.id);
      const flags: Flag[] = [...(c.flags ?? [])];
      const total = r?.total ?? null;
      const theirOther = otherTotal.get(c.id) ?? null;
      if (cut[other] !== null && cut[other]! >= SHORTLIST_MIN && theirOther !== null && theirOther >= cut[other]!) {
        flags.push({ type: 'other_role', detail: `Would also make the ${ROLE_TITLE[other]} shortlist (${theirOther.toFixed(1)}). The email is for the role applied for.` });
      }
      if (!top[role].has(c.id) && total !== null && total === cut[role] && total >= SHORTLIST_MIN) {
        flags.push({ type: 'tied_cutoff', detail: `Tied at ${total.toFixed(1)} with the #${TOP_N} invite; left out on the tie-break (operations score, then evidence).` });
      }
      const criteria: Criterion[] = rubric.map((cr) => {
        const s = scores.find((x) => x.candidate_id === c.id && x.criterion_id === cr.id);
        return { name: cr.name, weight: cr.weight, score: s?.score ?? null, evidence: s?.evidence ?? null, verified: s?.quote_verified ?? null, reason: s?.reason ?? '', probe: s?.probe_question ?? null };
      });
      const best = [...criteria].filter((x) => x.score !== null).sort((a, b) => b.score! - a.score! || b.weight - a.weight)[0];
      const needsEye = flags.some((f) => REVIEW_FLAGS.has(f.type)) || c.status === 'error';
      const group: Group = top[role].has(c.id) ? 'invite' : needsEye ? 'eye' : 'no';
      const status: Status = c.sent_at ? 'sent' : c.status === 'error' ? 'error' : c.status === 'processing' ? 'processing' : needsEye ? 'check' : 'ready';
      const firstFlag = flags.find((f) => REVIEW_FLAGS.has(f.type));
      const action = group === 'invite' ? 'Invite to interview'
        : c.duplicate_of ? 'Duplicate CV: no email needed'
        : firstFlag ? `Look before deciding: ${FLAG_LABEL[firstFlag.type]?.toLowerCase() ?? firstFlag.type}`
        : 'Send the rejection';
      return {
        id: c.id, rank: r?.rank ?? null, name: c.name ?? c.file_name, total, scoredWeight: r?.scoredWeight ?? 0, roleApplied: c.role_applied,
        topCriterion: best?.name ?? null, status, group, sentAt: c.sent_at, flags, criteria,
        brief: (role === 'PM' ? d?.brief_pm : d?.brief_spm) ?? null, action,
        draft: d?.email_body ? { type: d.email_type, subject: d.email_subject ?? '', body: d.email_body, edited: d.edited } : null,
        email: c.email, phone: c.phone, fileName: c.file_name, errorMessage: c.error_message,
      };
    })
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.id - b.id);

  const mode: EmailMode = emailMode();
  return { rows, threshold: SHORTLIST_MIN, topN: TOP_N, mode, testTo: emailOverride() };
}

export async function loadStats() {
  const [cands, drafts] = await Promise.all([
    q<any[]>(db().from('candidates').select('id, status, sent_at, duplicate_of')),
    q<any[]>(db().from('drafts').select('candidate_id, email_type')),
  ]);
  const sent = new Set(cands.filter((c) => c.sent_at).map((c) => c.id));
  return {
    reviewed: cands.filter((c) => c.status === 'ready' || c.status === 'sent').length,
    invitesReady: drafts.filter((d) => d.email_type === 'invite' && !sent.has(d.candidate_id)).length,
    sent: sent.size,
  };
}
