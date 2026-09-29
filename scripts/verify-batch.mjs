// Checks a processed batch end to end: npm run verify
// Privacy (no name/email/phone in AI-visible text, briefs or email bodies), quote accuracy, flags, rankings.
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
dotenv.config({ path: '.env.local', quiet: true });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const all = async (t, sel) => {
  let out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(t).select(sel).range(from, from + 999);
    if (error) throw new Error(error.message);
    out = out.concat(data);
    if (data.length < 1000) return out;
  }
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const cands = await all('candidates', 'id, name, email, phone, file_name, role_applied, status, duplicate_of, flags, cv_content');
const scores = await all('scores', 'candidate_id, role, score, quote_verified');
const totals = await all('score_totals', 'candidate_id, role, weighted_total, scored_weight');
const drafts = await all('drafts', 'candidate_id, brief_pm, brief_spm, email_type, email_body');

const leaks = [];
for (const c of cands) {
  const toks = [c.name, c.email, c.phone].filter(Boolean).flatMap((v) => v.split(/\s+/)).filter((t) => t.length >= 3);
  const d = drafts.find((x) => x.candidate_id === c.id);
  const aiText = [c.cv_content, d?.brief_pm, d?.brief_spm, d?.email_body?.replace('{{first_name}}', '')].join(' ').toLowerCase();
  const hit = toks.filter((t) => new RegExp(`\\b${esc(t.toLowerCase())}\\b`).test(aiText));
  if (hit.length) leaks.push(`#${c.id} ${c.file_name}: ${hit.join(',')}`);
}
const scored = scores.filter((x) => x.score !== null);
const count = (arr, f) => arr.reduce((a, x) => ((a[f(x)] = (a[f(x)] || 0) + 1), a), {});
console.log(`candidates ${cands.length} | statuses ${JSON.stringify(count(cands, (c) => c.status))}`);
console.log(`applied: PM ${cands.filter((c) => c.role_applied === 'PM' && !c.duplicate_of).length}, SPM ${cands.filter((c) => c.role_applied === 'SPM' && !c.duplicate_of).length}, duplicates ${cands.filter((c) => c.duplicate_of).length}`);
console.log(`scores: ${scores.length} rows, ${scored.length} scored, ${scores.length - scored.length} null → probe question | quotes found word-for-word: ${scored.filter((x) => x.quote_verified).length}/${scored.length}`);
console.log(`personal details in AI-visible text, briefs or email bodies: ${leaks.length ? leaks.join(' | ') : 'none'}`);
const flags = {};
cands.forEach((c) => c.flags.forEach((f) => (flags[f.type] = (flags[f.type] || 0) + 1)));
console.log(`flags: ${JSON.stringify(flags)}`);
console.log(`emails: invites ${drafts.filter((d) => d.email_type === 'invite').length}, rejections ${drafts.filter((d) => d.email_type === 'rejection').length}; bodies with leftover markers: ${drafts.filter((d) => /removed\]|\[name|\{\{(?!first_name)/i.test(d.email_body ?? '')).length}`);
for (const role of ['PM', 'SPM']) {
  const r = totals
    .filter((t) => t.role === role && t.weighted_total != null)
    .map((t) => ({ ...t, c: cands.find((c) => c.id === t.candidate_id) }))
    .filter((t) => t.c && !t.c.duplicate_of)
    .sort((a, b) => b.weighted_total - a.weighted_total || b.scored_weight - a.scored_weight || a.candidate_id - b.candidate_id);
  console.log(`\n${role} top 7 (of ${r.length}):`);
  r.slice(0, 7).forEach((t, i) =>
    console.log(`  #${i + 1} ${String(t.weighted_total).padStart(5)} ${(t.c.name ?? '?').padEnd(20)} applied ${t.c.role_applied}  ${t.c.flags.map((f) => f.type).filter((f) => f !== 'name_from_file').join(', ')}`),
  );
}
for (const c of cands.filter((c) => c.flags.some((f) => f.type === 'prompt_injection')))
  console.log(`\nTEXT ADDRESSED TO AI in ${c.file_name}: ${c.flags.find((f) => f.type === 'prompt_injection').detail.slice(0, 240)}`);
for (const c of cands.filter((c) => c.duplicate_of)) console.log(`DUPLICATE ${c.file_name}: ${c.flags.find((f) => f.type === 'duplicate')?.detail}`);
