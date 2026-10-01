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
import { formatSegments, hasNumber, locate, segmentCv, type Segment } from './evidence';
import { isStrongOutsider, rank, reconcile, SHORTLIST_MIN, THIN_EVIDENCE_PCT, TOP_N, weightedTotal, type Role } from './scoring';
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

// ── 2. Score one stored candidate against both rubrics ─────────────────
// Strict scoring. The model is told the rules; the code then enforces them on every answer:
//  - evidence must be a work-history line (summary/profile lines never count)
//  - a 4 or 5 needs a number in the evidence, else it is capped at 3
//  - one CV line can back only one criterion
//  - each role is scored twice at temperature 0; the lower score is kept, and a gap of more than 1
//    (or evidence found in only one run) flags the candidate "scores inconsistent"
type Judged = { score: number | null; evidence: string | null; verified: boolean | null; lineId: number | null; reason: string; probe: string | null };

function judgeRun(out: ScoringResult, criteria: Criterion[], segs: Segment[]): Map<number, Judged> {
  const res = new Map<number, Judged>();
  for (const cr of criteria) {
    const r = out.criteria?.find((x) => x.criterion_id === cr.id);
    let s = r && Number.isInteger(r.score) && r.score! >= 1 && r.score! <= 5 ? r.score : null;
    const quote = r?.evidence_quote?.trim() || '';
    let reason = r?.reason?.trim() || (r ? '' : 'The model returned no assessment for this criterion.');
    let probe = r?.probe_question?.trim() || null;
    const seg = quote ? locate(segs, r?.evidence_line, quote) : null;
    if (s !== null && !quote) s = null; // evidence or no score
    if (s !== null) probe = null; // probe questions belong to criteria without a score, unless set below
    if (s !== null && s > 1 && (r?.evidence_source !== 'work_history' || seg?.section === 'summary')) {
      // Only work history counts: a summary/profile claim earns nothing, i.e. stays at the starting 1.
      s = 1;
      reason = 'No credit: only a summary or profile claim supports this; no job bullet does.';
      probe = `Which job shows this in practice: ${cr.name.toLowerCase()}? Ask for a specific example.`;
    }
    if (s !== null && s >= 4 && !hasNumber(quote)) {
      s = 3; // 4 or 5 needs a number
      reason = `Capped at 3: the evidence has no volume, timeframe or adoption number. ${reason}`.trim();
    }
    res.set(cr.id, { score: s, evidence: s === null ? null : quote, verified: s === null ? null : Boolean(seg), lineId: seg?.id ?? null, reason, probe });
  }
  // One line, one criterion — for evidence that earns credit (2+). Keep the line for the criterion it adds
  // most to (score × weight); elsewhere the criterion gets no credit from it and stays at 1.
  // (A 1 citing a job-title line as proof of absence may share that line.)
  const byLine = new Map<number, number[]>();
  for (const [cid, j] of res) if (j.score !== null && j.score >= 2 && j.lineId !== null) byLine.set(j.lineId, [...(byLine.get(j.lineId) ?? []), cid]);
  for (const cids of byLine.values()) {
    if (cids.length < 2) continue;
    const w = (cid: number) => (res.get(cid)!.score ?? 0) * (criteria.find((c) => c.id === cid)?.weight ?? 0);
    const [keep, ...drop] = [...cids].sort((a, b) => w(b) - w(a));
    const keptName = criteria.find((c) => c.id === keep)?.name ?? 'another criterion';
    for (const cid of drop) {
      const cr = criteria.find((c) => c.id === cid)!;
      res.set(cid, {
        ...res.get(cid)!, score: 1,
        reason: `No credit: its only evidence is the CV line already used for “${keptName}”.`,
        probe: `Ask for a separate example of: ${cr.name.toLowerCase()}.`,
      });
    }
  }
  return res;
}

export async function score(id: number) {
  const [c] = await q<CandidateRow[]>(db().from('candidates').select('*').eq('id', id));
  if (!c?.cv_content) throw new Error('No stored CV text for this candidate — re-upload the file');
  const pii: PII = { name: c.name, email: c.email, phone: c.phone };
  const rubric = await loadRubric();
  const { lines: codeInjections, cleaned } = detectInjection(c.cv_content);
  const segs = segmentCv(cleaned);
  const prompt = scoringPrompt(formatSegments(segs));

  // Two independent runs per role, all four requests at once.
  const results = await Promise.all(
    ROLES.map(async (role) => {
      const criteria = rubric.filter((r) => r.role === role);
      const call = () => generateJSON<ScoringResult>({ system: scoringSystem(role, criteria), prompt, schema: scoringSchema, pii, temperature: 0 });
      const runs = await Promise.all([call(), call()]);
      return { role, criteria, runs };
    }),
  );

  const scoreRows: Record<string, unknown>[] = [];
  const totals: Record<string, unknown>[] = [];
  const flags: Flag[] = (c.flags ?? []).filter((f) => !SCORING_FLAGS.includes(f.type));
  const aiInjections = new Set<string>();
  const inconsistent: string[] = [];

  for (const { role, criteria, runs } of results) {
    for (const out of runs) {
      // Skip our own placeholder, which the model sometimes reports back.
      out.addressed_to_ai?.forEach((t) => t?.trim() && !/^\[?text addressed to the screening system removed\]?$/i.test(t.trim()) && aiInjections.add(t.trim().slice(0, 200)));
    }
    const [a, b] = runs.map((out) => judgeRun(out, criteria, segs));
    const items = criteria.map((cr) => {
      const x = a.get(cr.id)!, y = b.get(cr.id)!;
      const r = reconcile(x.score, y.score);
      const chosen = r.from === 0 ? x : y;
      if (r.inconsistent) inconsistent.push(`${role} “${cr.name}” (${x.score ?? '—'} vs ${y.score ?? '—'})`);
      const probe = r.score === null ? (chosen.probe || x.probe || y.probe || `Ask for a concrete example of: ${cr.name.toLowerCase()}.`) : chosen.probe;
      scoreRows.push({
        candidate_id: id, criterion_id: cr.id, role, score: r.score,
        evidence: r.score === null || chosen.score === null ? null : chosen.evidence,
        quote_verified: r.score === null || chosen.score === null ? null : chosen.verified,
        reason: (x.score === null) !== (y.score === null) ? `No credit: only one of the two scoring runs found evidence (${x.score ?? 'none'} vs ${y.score ?? 'none'}).` : chosen.reason,
        probe_question: probe,
      });
      return { name: cr.name, weight: cr.weight, score: r.score };
    });
    const { total, scoredWeight } = weightedTotal(items);
    totals.push({ candidate_id: id, role, weighted_total: total, scored_weight: scoredWeight });
    if (isStrongOutsider(items)) {
      flags.push({ type: 'strong_outsider', detail: `Strong outsider — review (${role}): 4+ on every criterion except “Did the operations work themselves”.` });
    }
    if (total !== null && scoredWeight < THIN_EVIDENCE_PCT) {
      flags.push({ type: 'thin_evidence', detail: `${role} score rests on only ${scoredWeight}% of the rubric weight; the rest had no work-history evidence.` });
    }
  }

  const injections = [...new Set([...codeInjections, ...aiInjections])];
  if (injections.length) {
    flags.push({ type: 'prompt_injection', detail: `CV contains text addressed to the AI (ignored for scoring): ${injections.map((t) => `“${t}”`).join('; ')}` });
  }
  if (inconsistent.length) {
    flags.push({ type: 'scores_inconsistent', detail: `Scores inconsistent: the two scoring runs differed by more than 1 (lower score kept) on ${inconsistent.join('; ')}.` });
  }

  await q(db().from('scores').delete().eq('candidate_id', id));
  await q(db().from('scores').insert(scoreRows));
  await q(db().from('score_totals').upsert(totals));
  // A candidate who was already emailed stays "sent".
  await q(db().from('candidates').update({ flags, error_message: null, ...(c.sent_at ? {} : { status: 'processing' }) }).eq('id', id));
}

// ── 3. Briefs + email drafts, driven by the code's ranking ─────────────
type Draft = { candidate_id: number; brief_pm: string | null; brief_spm: string | null; email_type: string | null; email_body: string | null; edited: boolean };
export type RankedRow = { id: number; total: number | null; scoredWeight: number; ops: number | null; rank: number };

// Each role is ranked among the people who applied for it. Invites go to the top 5 of those, and only
// to candidates at or above SHORTLIST_MIN. Ties are broken by the operations score.
export async function rankings() {
  const cands = await q<CandidateRow[]>(
    db().from('candidates').select('id, role_applied, status, duplicate_of, sent_at, cv_content, name, email, phone, flags, file_name').is('duplicate_of', null).neq('status', 'error'),
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
    withTotal.slice(0, TOP_N).filter((r) => r.total! >= SHORTLIST_MIN).forEach((r) => top[role].add(r.id));
    cut[role] = withTotal[TOP_N - 1]?.total ?? null;
  }
  return { eligible, top, cut, ranked };
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
