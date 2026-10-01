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
import { formatSegments, hasNumber, locate, segmentCv } from './evidence';
import { applyRun, combine, type RawRun } from './policy';
import { loadSettings } from './settings';
import { isStrongOutsider, rank, THIN_EVIDENCE_PCT, weightedTotal, type Role } from './scoring';
import { db, q } from './supabase';

export type Flag = { type: string; detail: string };
type CandidateRow = {
  id: number; file_name: string; role_applied: Role; name: string | null; email: string | null; phone: string | null;
  cv_content: string | null; status: string; flags: Flag[]; duplicate_of: number | null; sent_at: string | null;
};

// Flags produced by scoring; everything else (name/email/duplicate) survives a rescore.
const SCORING_FLAGS = ['prompt_injection', 'strong_outsider', 'scores_inconsistent', 'thin_evidence'];

// ── 1. Ingest one file: parse → strip PII → dedupe → score ─────────────
export async function ingest(file: File, role: Role) {
  const [{ id }] = await q<{ id: number }[]>(
    db().from('candidates').insert({ file_name: file.name, role_applied: role, status: 'processing' }).select('id'),
  );
  try {
    const text = await fileToText(file.name, await file.arrayBuffer());
    const { pii, redacted, nameSource } = extractPII(text, file.name);
    const flags: Flag[] = [];
    if (!pii.name) flags.push({ type: 'name_not_detected', detail: 'Could not find the candidate’s name in the CV — add it on the card before sending.' });
    if (nameSource === 'file') flags.push({ type: 'name_from_file', detail: `Name taken from the file name (“${file.name}”) because the CV text has none — check it before sending.` });
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

// ── 2. Score one stored candidate ───────────────────────────────────────
// Two independent AI runs (temperature 0), each scoring both rubrics in one request. The raw runs are
// stored per criterion; lib/policy.ts then turns them into scores under the current strictness settings.
export async function score(id: number) {
  const [c] = await q<CandidateRow[]>(db().from('candidates').select('*').eq('id', id));
  if (!c?.cv_content) throw new Error('No stored CV text for this candidate — re-upload the file');
  const pii: PII = { name: c.name, email: c.email, phone: c.phone };
  const rubric = await loadRubric();
  const { lines: codeInjections, cleaned } = detectInjection(c.cv_content);
  const segs = segmentCv(cleaned);
  const call = () => generateJSON<ScoringResult>({ system: scoringSystem(rubric), prompt: scoringPrompt(formatSegments(segs)), schema: scoringSchema, pii, temperature: 0 });
  const runs = await Promise.all([call(), call()]);

  const aiInjections = new Set<string>();
  for (const out of runs) {
    out.addressed_to_ai?.forEach((t) => t?.trim() && !/^\[?text addressed to the screening system removed\]?$/i.test(t.trim()) && aiInjections.add(t.trim().slice(0, 200)));
  }
  const toRaw = (out: ScoringResult, cid: number): RawRun | null => {
    const r = out.criteria?.find((x) => x.criterion_id === cid);
    if (!r) return null;
    const quote = r.evidence_quote?.trim() ?? '';
    const valid = Number.isInteger(r.score) && r.score! >= 1 && r.score! <= 5 && quote;
    const seg = quote ? locate(segs, r.evidence_line, quote) : null;
    return {
      score: valid ? r.score : null, quote, source: seg?.section === 'summary' ? 'summary' : r.evidence_source ?? 'other',
      line: seg?.id ?? null, verified: Boolean(seg), number: hasNumber(quote), reason: r.reason?.trim() ?? '', probe: r.probe_question?.trim() ?? '',
    };
  };
  const rows = rubric.map((cr) => ({ candidate_id: id, criterion_id: cr.id, role: cr.role, runs: runs.map((o) => toRaw(o, cr.id)) }));
  await q(db().from('scores').delete().eq('candidate_id', id));
  await q(db().from('scores').insert(rows.map((r) => ({ ...r, score: null, reason: '' }))));

  const flags: Flag[] = (c.flags ?? []).filter((f) => f.type !== 'prompt_injection');
  const injections = [...new Set([...codeInjections, ...aiInjections])];
  if (injections.length) flags.push({ type: 'prompt_injection', detail: `CV contains text addressed to the AI (ignored for scoring): ${injections.map((t) => `“${t}”`).join('; ')}` });
  await q(db().from('candidates').update({ flags, error_message: null, ...(c.sent_at ? {} : { status: 'processing' }) }).eq('id', id));
  await recompute([id]);
}

// Applies the current strictness settings to stored raw runs — no AI calls. Writes final scores, totals
// and the scoring flags. With no ids, recomputes every candidate (used when Arjun changes strictness).
export async function recompute(ids?: number[]) {
  const { policy } = await loadSettings();
  const rubric = await loadRubric();
  let sq = db().from('scores').select('candidate_id, criterion_id, role, runs');
  if (ids) sq = sq.in('candidate_id', ids);
  const stored = await q<{ candidate_id: number; criterion_id: number; role: Role; runs: (RawRun | null)[] | null }[]>(sq);
  const candIds = ids ?? [...new Set(stored.map((s) => s.candidate_id))];
  const cands = await q<{ id: number; flags: Flag[] }[]>(db().from('candidates').select('id, flags').in('id', candIds));

  const scoreRows: Record<string, unknown>[] = [];
  const totalRows: Record<string, unknown>[] = [];
  for (const c of cands) {
    const mine = stored.filter((s) => s.candidate_id === c.id);
    if (!mine.length || mine.every((s) => !s.runs)) continue; // scored before raw runs were kept
    const flags = (c.flags ?? []).filter((f) => !SCORING_FLAGS.includes(f.type) || f.type === 'prompt_injection');
    const inconsistent: string[] = [];
    for (const role of ROLES) {
      const crit = rubric.filter((r) => r.role === role);
      const runOf = (k: 0 | 1) => applyRun(crit.map((cr) => ({ id: cr.id, weight: cr.weight, name: cr.name, run: mine.find((s) => s.criterion_id === cr.id)?.runs?.[k] ?? undefined })), policy);
      const [a, b] = [runOf(0), runOf(1)];
      const items = crit.map((cr) => {
        const f = combine(a.get(cr.id)!, b.get(cr.id)!, policy);
        if (f.inconsistent) inconsistent.push(`${role} “${cr.name}” (${a.get(cr.id)!.score ?? '—'} vs ${b.get(cr.id)!.score ?? '—'})`);
        const reason = [f.note ? `${f.note[0].toUpperCase()}${f.note.slice(1)}.` : '', f.reason].filter(Boolean).join(' ');
        scoreRows.push({
          candidate_id: c.id, criterion_id: cr.id, role, score: f.score,
          evidence: f.score === null ? null : f.quote, quote_verified: f.score === null ? null : f.verified,
          reason, probe_question: f.score === null ? f.probe || `Ask for a concrete example of: ${cr.name.toLowerCase()}.` : f.probe,
        });
        return { name: cr.name, weight: cr.weight, score: f.score };
      });
      const { total, scoredWeight } = weightedTotal(items);
      totalRows.push({ candidate_id: c.id, role, weighted_total: total, scored_weight: scoredWeight });
      if (isStrongOutsider(items)) flags.push({ type: 'strong_outsider', detail: `Strong outsider — review (${role}): 4+ on every criterion except “Did the operations work themselves”.` });
      if (total !== null && scoredWeight < THIN_EVIDENCE_PCT) flags.push({ type: 'thin_evidence', detail: `${role} score rests on only ${scoredWeight}% of the rubric weight; the rest had no work-history evidence.` });
    }
    if (inconsistent.length) flags.push({ type: 'scores_inconsistent', detail: `The two scoring runs differed by more than 1 on ${inconsistent.join('; ')}.` });
    await q(db().from('candidates').update({ flags }).eq('id', c.id));
  }
  for (let i = 0; i < scoreRows.length; i += 500) await q(db().from('scores').upsert(scoreRows.slice(i, i + 500), { onConflict: 'candidate_id,criterion_id' }));
  if (totalRows.length) await q(db().from('score_totals').upsert(totalRows));
  return { candidates: cands.length };
}

// ── 3. Briefs + email drafts, driven by the code's ranking ─────────────
type Draft = { candidate_id: number; brief_pm: string | null; brief_spm: string | null; email_type: string | null; email_body: string | null; edited: boolean };
export type RankedRow = { id: number; total: number | null; scoredWeight: number; ops: number | null; rank: number };

// Each role is ranked among the people who applied for it. Invites go to the top N of those at or above
// the threshold (both set by Arjun), skipping anyone he marked "reject" and always including anyone he
// marked "invite". Ties are broken by the operations score.
export async function rankings() {
  const { shortlist } = await loadSettings();
  const cands = await q<(CandidateRow & { decision: 'invite' | 'reject' | null })[]>(
    db().from('candidates').select('id, role_applied, status, duplicate_of, sent_at, cv_content, name, email, phone, flags, file_name, decision').is('duplicate_of', null).neq('status', 'error'),
  );
  const totals = await q<{ candidate_id: number; role: Role; weighted_total: number | null; scored_weight: number }[]>(db().from('score_totals').select('*'));
  const rubric = await loadRubric();
  const opsIds = rubric.filter((r) => /did the operations work themselves/i.test(r.name)).map((r) => r.id);
  const opsScores = await q<{ candidate_id: number; role: Role; score: number | null }[]>(db().from('scores').select('candidate_id, role, score').in('criterion_id', opsIds));
  const scored = new Set(totals.map((t) => t.candidate_id));
  const eligible = cands.filter((c) => scored.has(c.id));

  const top: Record<Role, Set<number>> = { PM: new Set(), SPM: new Set() };
  const cut: Record<Role, number | null> = { PM: null, SPM: null };
  const ranked: Record<Role, RankedRow[]> = { PM: [], SPM: [] };
  for (const role of ROLES) {
    const rows = eligible.filter((c) => c.role_applied === role).map((c) => {
      const t = totals.find((x) => x.candidate_id === c.id && x.role === role);
      const ops = opsScores.find((x) => x.candidate_id === c.id && x.role === role)?.score ?? null;
      return { id: c.id, total: t?.weighted_total == null ? null : Number(t.weighted_total), scoredWeight: t?.scored_weight ?? 0, ops };
    });
    ranked[role] = rank(rows);
    const withTotal = ranked[role].filter((r) => r.total !== null);
    const decision = (id: number) => eligible.find((c) => c.id === id)?.decision ?? null;
    const open = withTotal.filter((r) => decision(r.id) !== 'reject');
    open.slice(0, shortlist.topN).filter((r) => r.total! >= shortlist.threshold).forEach((r) => top[role].add(r.id));
    eligible.filter((c) => c.role_applied === role && c.decision === 'invite').forEach((c) => top[role].add(c.id));
    cut[role] = open[shortlist.topN - 1]?.total ?? null;
  }
  return { eligible, top, cut, ranked, shortlist };
}

async function scoreLines(id: number) {
  const lines = await q<{ role: Role; score: number | null; reason: string; evidence: string | null; rubric_criteria: { name: string; weight: number; position: number } }[]>(
    db().from('scores').select('role, score, reason, evidence, rubric_criteria(name, weight, position)').eq('candidate_id', id),
  );
  return Object.fromEntries(
    ROLES.map((r) => [r, lines.filter((l) => l.role === r).sort((a, b) => a.rubric_criteria.position - b.rubric_criteria.position)
      .map<ScoreLine>((l) => ({ name: l.rubric_criteria.name, weight: l.rubric_criteria.weight, score: l.score, reason: l.reason, evidence: l.evidence }))]),
  ) as Record<Role, ScoreLine[]>;
}

async function writeDraft(c: CandidateRow, emailType: 'invite' | 'rejection', briefRoles: Role[]) {
  const pii: PII = { name: c.name, email: c.email, phone: c.phone };
  const out = await generateJSON<DraftResult>({
    system: draftSystem(),
    prompt: draftPrompt({ cv: detectInjection(c.cv_content ?? '').cleaned, roleApplied: c.role_applied, emailType, briefRoles, scores: await scoreLines(c.id) }),
    schema: draftSchema,
    pii,
  });
  const body = out.email_body.replace(/\[(name|email|phone|header|link|profile link) removed\]/gi, '').replace(/[ \t]{2,}/g, ' ');
  return { out, email: { email_type: emailType, email_subject: emailSubject(emailType, c.role_applied), email_body: wrapEmail(body) } };
}

export async function generateDrafts(limit = 3) {
  const { eligible, top } = await rankings();
  const drafts = await q<Draft[]>(db().from('drafts').select('candidate_id, brief_pm, brief_spm, email_type, email_body, edited'));
  const byId = new Map(drafts.map((d) => [d.candidate_id, d]));
  const briefKey = (r: Role): 'brief_pm' | 'brief_spm' => (r === 'PM' ? 'brief_pm' : 'brief_spm');

  const work: { c: CandidateRow; emailType: 'invite' | 'rejection'; needEmail: boolean; needBriefs: Role[] }[] = [];
  for (const c of eligible) {
    if (c.sent_at || c.status === 'sent') continue;
    const d = byId.get(c.id);
    const emailType = top[c.role_applied].has(c.id) ? 'invite' : 'rejection';
    // An email Arjun edited or chose himself is never overwritten.
    const needEmail = !d?.email_body || (!d.edited && d.email_type !== emailType);
    const needBriefs = ROLES.filter((r) => top[r].has(c.id) && !d?.[briefKey(r)]);
    const stale = ROLES.filter((r) => !top[r].has(c.id) && d?.[briefKey(r)]);
    if (stale.length) await q(db().from('drafts').update(Object.fromEntries(stale.map((r) => [briefKey(r), null]))).eq('candidate_id', c.id));
    if (needEmail || needBriefs.length) work.push({ c, emailType, needEmail, needBriefs });
    else if (c.status !== 'ready') await q(db().from('candidates').update({ status: 'ready' }).eq('id', c.id));
  }

  const batch = work.slice(0, limit);
  const errors: string[] = [];
  await Promise.all(
    batch.map(async ({ c, emailType, needEmail, needBriefs }) => {
      try {
        const { out, email } = await writeDraft(c, emailType, needBriefs);
        const d = byId.get(c.id);
        const row: Record<string, unknown> = {
          candidate_id: c.id,
          brief_pm: top.PM.has(c.id) ? (needBriefs.includes('PM') ? out.brief_pm?.trim() || null : d?.brief_pm) : null,
          brief_spm: top.SPM.has(c.id) ? (needBriefs.includes('SPM') ? out.brief_spm?.trim() || null : d?.brief_spm) : null,
          updated_at: new Date().toISOString(),
        };
        if (needEmail) Object.assign(row, email, { edited: false });
        await q(db().from('drafts').upsert(row));
        await q(db().from('candidates').update({ status: 'ready' }).eq('id', c.id));
      } catch (e) {
        errors.push(`#${c.id} ${c.file_name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );
  return { processed: batch.length - errors.length, remaining: work.length - batch.length + errors.length, errors };
}

// Review mode: Arjun chose to send the other kind of email. Write it now; nothing is sent here.
export async function draftEmailOfType(id: number, emailType: 'invite' | 'rejection') {
  const [c] = await q<CandidateRow[]>(db().from('candidates').select('*').eq('id', id));
  if (!c) throw new Error('Candidate not found');
  if (c.sent_at) throw new Error('Already sent');
  const { email } = await writeDraft(c, emailType, []);
  await q(db().from('drafts').upsert({ candidate_id: id, ...email, edited: true, updated_at: new Date().toISOString() }));
  return email;
}
