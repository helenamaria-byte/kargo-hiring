// Prints what is in the database, for verification: npm run inspect
//   (uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, no database password needed)
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
dotenv.config({ path: '.env.local', quiet: true });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

const cands = must(await sb.from('candidates').select('id, name, email, phone, role_applied, status, duplicate_of, flags, cv_content, sent_at').order('id'));
const rubric = must(await sb.from('rubric_criteria').select('id, role, name, weight, position').order('position'));
console.log(`rubric: ${['PM', 'SPM'].map((r) => `${r} ${rubric.filter((x) => x.role === r).length} criteria = ${rubric.filter((x) => x.role === r).reduce((s, x) => s + x.weight, 0)}`).join(', ')}`);
console.log(`candidates: ${cands.length}`);
for (const x of cands) {
  const tokens = [x.name, x.email, x.phone].filter(Boolean).flatMap((v) => v.split(/\s+/)).filter((t) => t.length >= 3);
  const leaks = tokens.filter((t) => x.cv_content?.toLowerCase().includes(t.toLowerCase()));
  console.log(`\n#${x.id} ${x.name} <${x.email}> | applied ${x.role_applied} | ${x.status}${x.sent_at ? ` at ${x.sent_at}` : ''}${x.duplicate_of ? ` | duplicate of #${x.duplicate_of}` : ''}`);
  console.log(`  personal details in AI-visible CV text: ${leaks.length ? 'LEAK ' + leaks.join(',') : 'none'}`);
  for (const f of x.flags) console.log(`  FLAG ${f.type}: ${f.detail.slice(0, 200)}`);
  const totals = must(await sb.from('score_totals').select('role, weighted_total, scored_weight').eq('candidate_id', x.id).order('role'));
  if (totals.length) console.log('  totals: ' + totals.map((r) => `${r.role}=${r.weighted_total ?? 'null'} (${r.scored_weight}% evidenced)`).join('  '));
  const scores = must(await sb.from('scores').select('role, criterion_id, score, evidence, quote_verified, probe_question').eq('candidate_id', x.id));
  for (const s of scores.sort((a, b) => a.role.localeCompare(b.role) || a.criterion_id - b.criterion_id)) {
    const cr = rubric.find((r) => r.id === s.criterion_id);
    const detail = s.score === null ? `PROBE: ${s.probe_question?.slice(0, 90)}` : `"${s.evidence?.slice(0, 70)}" ${s.quote_verified ? '✓' : '✗ unverified'}`;
    console.log(`   ${s.role.padEnd(3)} ${String(s.score ?? 'null').padEnd(4)} ${cr?.name.slice(0, 30).padEnd(30)} ${detail}`);
  }
  const [d] = must(await sb.from('drafts').select('brief_pm, brief_spm, email_type, email_subject, email_body').eq('candidate_id', x.id));
  if (d) console.log(`  BRIEF PM: ${d.brief_pm ?? '-'}\n  BRIEF SPM: ${d.brief_spm ?? '-'}\n  EMAIL (${d.email_type}) "${d.email_subject}":\n    ${d.email_body.replace(/\n/g, '\n    ')}`);
}
