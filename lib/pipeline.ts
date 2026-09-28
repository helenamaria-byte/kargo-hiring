import { ROLES, ROLE_TITLE } from './config';
import { contentHash, findDuplicate } from './dedupe';
import { generateJSON } from './gemini';
import { detectInjection } from './injection';
import { fileToText } from './parse-file';
import { extractPII, type PII } from './pii';
import {
  draftPrompt, draftSchema, draftSystem, emailSubject, scoringPrompt, scoringSchema, scoringSystem, wrapEmail,
  type Criterion, type DraftResult, type ScoreLine, type ScoringResult,
} from './prompts';
import { loadRubric } from './rubric';
import { isStrongOutsider, rank, TOP_N, weightedTotal, type Role } from './scoring';
import { db, q } from './supabase';

export type Flag = { type: string; detail: string };
type CandidateRow = {
  id: number; file_name: string; role_applied: Role; name: string | null; email: string | null; phone: string | null;
  cv_content: string | null; status: string; flags: Flag[]; duplicate_of: number | null; sent_at: string | null;
};

// Flags produced by scoring; everything else (name/email/duplicate) survives a rescore.
const SCORING_FLAGS = ['prompt_injection', 'strong_outsider'];

// ── 1. Ingest one file: parse → strip PII → dedupe → score ─────────────
export async function ingest(file: File, role: Role) {
  const [{ id }] = await q<{ id: number }[]>(
    db().from('candidates').insert({ file_name: file.name, role_applied: role, status: 'processing' }).select('id'),
  );
  try {
    const text = await fileToText(file.name, await file.arrayBuffer());
    const { pii, redacted } = extractPII(text);
    const flags: Flag[] = [];
    if (!pii.name) flags.push({ type: 'name_not_detected', detail: 'Could not find the candidate’s name in the CV — add it on the card before sending.' });
    if (!pii.email) flags.push({ type: 'email_not_detected', detail: 'No email address found in the CV — add it on the card before sending.' });
    const hash = contentHash(redacted);

    await q(db().from('candidates').update({ ...pii, cv_content: redacted, content_hash: hash, flags }).eq('id', id));

    // Compare only with earlier uploads, so of two copies the first one is scored and the second flagged.
    const earlier = await q<{ id: number; cv_content: string | null; content_hash: string | null; name: string | null }[]>(
      db().from('candidates').select('id, cv_content, content_hash, name').lt('id', id).is('duplicate_of', null).neq('status', 'error'),
    );
    const dup = findDuplicate(redacted, hash, earlier);
    if (dup) {
      const orig = earlier.find((e) => e.id === dup.id);
      flags.push({
        type: 'duplicate',
        detail: `${Math.round(dup.similarity * 100)}% identical to candidate #${dup.id}${orig?.name ? ` (${orig.name})` : ''} — not scored again.`,
      });
      await q(db().from('candidates').update({ duplicate_of: dup.id, similarity: dup.similarity, flags, status: 'ready' }).eq('id', id));
      return { id, status: 'duplicate' as const, duplicateOf: dup.id };
    }

    await score(id);
    return { id, status: 'scored' as const };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db().from('candidates').update({ status: 'error', error_message: message }).eq('id', id);
    return { id, status: 'error' as const, error: message };
  }
}

// ── 2. Score one stored candidate against both rubrics ─────────────────
const norm = (s: string) => s.toLowerCase().replace(/[“”"‘’'`]/g, '').replace(/[^a-z0-9%+]+/g, ' ').trim();

export async function score(id: number) {
  const [c] = await q<CandidateRow[]>(db().from('candidates').select('*').eq('id', id));
  if (!c?.cv_content) throw new Error('No stored CV text for this candidate — re-upload the file');
  const pii: PII = { name: c.name, email: c.email, phone: c.phone };
  const rubric = await loadRubric();
  const { lines: codeInjections, cleaned } = detectInjection(c.cv_content);

  const results = await Promise.all(
    ROLES.map(async (role) => {
      const criteria = rubric.filter((r) => r.role === role);
      const out = await generateJSON<ScoringResult>({ system: scoringSystem(role, criteria), prompt: scoringPrompt(cleaned), schema: scoringSchema, pii });
      return { role, criteria, out };
    }),
  );

  const cvNorm = norm(c.cv_content);
  const scoreRows: Record<string, unknown>[] = [];
  const totals: Record<string, unknown>[] = [];
  const flags: Flag[] = (c.flags ?? []).filter((f) => !SCORING_FLAGS.includes(f.type));
  const aiInjections = new Set<string>();

  for (const { role, criteria, out } of results) {
    // Skip our own placeholder, which the model sometimes reports back.
    out.addressed_to_ai?.forEach((t) => t?.trim() && !/^\[?text addressed to the screening system removed\]?$/i.test(t.trim()) && aiInjections.add(t.trim().slice(0, 200)));
    const items = criteria.map((cr: Criterion) => {
      const r = out.criteria?.find((x) => x.criterion_id === cr.id);
      let s = r && Number.isInteger(r.score) && r.score! >= 1 && r.score! <= 5 ? r.score : null;
      const evidence = r?.evidence_quote?.trim() || null;
      if (s !== null && !evidence) s = null; // rule 1: evidence or no score
      const probe = s === null ? r?.probe_question?.trim() || `Ask for a concrete example of: ${cr.name.toLowerCase()}.` : null;
      scoreRows.push({
        candidate_id: id, criterion_id: cr.id, role, score: s,
        evidence: s === null ? null : evidence,
        quote_verified: s === null ? null : cvNorm.includes(norm(evidence!)),
        reason: r?.reason?.trim() || (r ? '' : 'The model returned no assessment for this criterion.'),
        probe_question: probe,
      });
      return { name: cr.name, weight: cr.weight, score: s };
    });
    const { total, scoredWeight } = weightedTotal(items);
    totals.push({ candidate_id: id, role, weighted_total: total, scored_weight: scoredWeight });
    if (isStrongOutsider(items)) {
      flags.push({ type: 'strong_outsider', detail: `Strong outsider — review (${role}): 4+ on every criterion except “Did the operations work themselves”.` });
    }
  }

  const injections = [...new Set([...codeInjections, ...aiInjections])];
  if (injections.length) {
    flags.push({ type: 'prompt_injection', detail: `CV contains text addressed to the AI (ignored for scoring): ${injections.map((t) => `“${t}”`).join('; ')}` });
  }

  await q(db().from('scores').delete().eq('candidate_id', id));
  await q(db().from('scores').insert(scoreRows));
  await q(db().from('score_totals').upsert(totals));
  await q(db().from('candidates').update({ flags, status: 'processing', error_message: null }).eq('id', id));
}

// ── 3. Briefs + email drafts, driven by the code's ranking ─────────────
type Draft = { candidate_id: number; brief_pm: string | null; brief_spm: string | null; email_type: string | null; email_body: string | null };

export async function rankings() {
  const cands = await q<CandidateRow[]>(
    db().from('candidates').select('id, role_applied, status, duplicate_of, sent_at, cv_content, name, email, phone, flags, file_name').is('duplicate_of', null).neq('status', 'error'),
  );
  const totals = await q<{ candidate_id: number; role: Role; weighted_total: number | null; scored_weight: number }[]>(
    db().from('score_totals').select('*'),
  );
  const scored = new Set(totals.map((t) => t.candidate_id));
  const eligible = cands.filter((c) => scored.has(c.id));
  const top: Record<Role, Set<number>> = { PM: new Set(), SPM: new Set() };
  for (const role of ROLES) {
    const rows = eligible.map((c) => {
      const t = totals.find((x) => x.candidate_id === c.id && x.role === role);
      return { id: c.id, total: t?.weighted_total == null ? null : Number(t.weighted_total), scoredWeight: t?.scored_weight ?? 0 };
    });
    rank(rows).filter((r) => r.total !== null).slice(0, TOP_N).forEach((r) => top[role].add(r.id));
  }
  return { eligible, top };
}

export async function generateDrafts(limit = 3) {
  const { eligible, top } = await rankings();
  const drafts = await q<Draft[]>(db().from('drafts').select('candidate_id, brief_pm, brief_spm, email_type, email_body'));
  const byId = new Map(drafts.map((d) => [d.candidate_id, d]));
  const briefKey = (r: Role): 'brief_pm' | 'brief_spm' => (r === 'PM' ? 'brief_pm' : 'brief_spm');

  const work: { c: CandidateRow; emailType: 'invite' | 'rejection'; needEmail: boolean; needBriefs: Role[] }[] = [];
  for (const c of eligible) {
    if (c.sent_at || c.status === 'sent') continue;
    const d = byId.get(c.id);
    const emailType = top[c.role_applied].has(c.id) ? 'invite' : 'rejection';
    const needEmail = !d?.email_body || d.email_type !== emailType;
    const needBriefs = ROLES.filter((r) => top[r].has(c.id) && !d?.[briefKey(r)]);
    const stale = ROLES.filter((r) => !top[r].has(c.id) && d?.[briefKey(r)]);
    if (needEmail || needBriefs.length) work.push({ c, emailType, needEmail, needBriefs });
    else {
      if (stale.length) await q(db().from('drafts').update(Object.fromEntries(stale.map((r) => [briefKey(r), null]))).eq('candidate_id', c.id));
      if (c.status !== 'ready') await q(db().from('candidates').update({ status: 'ready' }).eq('id', c.id));
    }
  }

  const batch = work.slice(0, limit);
  const errors: string[] = [];
  await Promise.all(
    batch.map(async ({ c, emailType, needEmail, needBriefs }) => {
      try {
        const lines = await q<{ role: Role; score: number | null; reason: string; evidence: string | null; rubric_criteria: { name: string; weight: number; position: number } }[]>(
          db().from('scores').select('role, score, reason, evidence, rubric_criteria(name, weight, position)').eq('candidate_id', c.id),
        );
        const scores = Object.fromEntries(
          ROLES.map((r) => [r, lines.filter((l) => l.role === r).sort((a, b) => a.rubric_criteria.position - b.rubric_criteria.position)
            .map<ScoreLine>((l) => ({ name: l.rubric_criteria.name, weight: l.rubric_criteria.weight, score: l.score, reason: l.reason, evidence: l.evidence }))]),
        ) as Record<Role, ScoreLine[]>;
        const pii: PII = { name: c.name, email: c.email, phone: c.phone };
        const out = await generateJSON<DraftResult>({
          system: draftSystem(),
          prompt: draftPrompt({ cv: detectInjection(c.cv_content ?? '').cleaned, roleApplied: c.role_applied, emailType, briefRoles: needBriefs, scores }),
          schema: draftSchema,
          pii,
        });
        const d = byId.get(c.id);
        const row: Record<string, unknown> = {
          candidate_id: c.id,
          brief_pm: top.PM.has(c.id) ? (needBriefs.includes('PM') ? out.brief_pm?.trim() || null : d?.brief_pm) : null,
          brief_spm: top.SPM.has(c.id) ? (needBriefs.includes('SPM') ? out.brief_spm?.trim() || null : d?.brief_spm) : null,
          updated_at: new Date().toISOString(),
        };
        if (needEmail) {
          const body = out.email_body.replace(/\[(name|email|phone|header|profile link) removed\]/gi, '').replace(/[ \t]{2,}/g, ' ');
          Object.assign(row, { email_type: emailType, email_subject: emailSubject(emailType, c.role_applied), email_body: wrapEmail(body), edited: false });
        }
        await q(db().from('drafts').upsert(row));
        await q(db().from('candidates').update({ status: 'ready' }).eq('id', c.id));
      } catch (e) {
        errors.push(`#${c.id} ${c.file_name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );
  return { processed: batch.length - errors.length, remaining: work.length - batch.length + errors.length, errors };
}

export const roleTitle = (r: Role) => ROLE_TITLE[r];
