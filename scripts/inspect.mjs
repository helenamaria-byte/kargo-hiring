// Prints what is in the database, for verification: npm run inspect
import dotenv from 'dotenv';
import pg from 'pg';
dotenv.config({ path: '.env.local', quiet: true });

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const cands = (await c.query('select id, name, email, phone, role_applied, status, duplicate_of, flags, cv_content from candidates order by id')).rows;
for (const x of cands) {
  const tokens = [x.name, x.email, x.phone].filter(Boolean).flatMap((v) => v.split(/\s+/)).filter((t) => t.length >= 3);
  const leaks = tokens.filter((t) => x.cv_content?.toLowerCase().includes(t.toLowerCase()));
  console.log(`\n#${x.id} ${x.name} <${x.email}> ${x.phone} | applied ${x.role_applied} | ${x.status}${x.duplicate_of ? ` | duplicate of #${x.duplicate_of}` : ''}`);
  console.log(`  PII in cv_content: ${leaks.length ? 'LEAK ' + leaks.join(',') : 'none'} | starts: ${x.cv_content?.slice(0, 70).replace(/\n/g, ' / ')}`);
  for (const f of x.flags) console.log(`  FLAG ${f.type}: ${f.detail.slice(0, 200)}`);
  const t = (await c.query('select role, weighted_total, scored_weight from score_totals where candidate_id=$1 order by role', [x.id])).rows;
  if (t.length) console.log('  totals: ' + t.map((r) => `${r.role}=${r.weighted_total ?? 'null'} (${r.scored_weight}% evidenced)`).join('  '));
  for (const role of ['PM', 'SPM']) {
    const s = (await c.query(
      'select r.name, s.score, s.quote_verified, left(s.evidence, 70) as ev, s.probe_question from scores s join rubric_criteria r on r.id = s.criterion_id where s.candidate_id = $1 and s.role = $2 order by r.position',
      [x.id, role],
    )).rows;
    for (const r of s) {
      const detail = r.score === null ? `PROBE: ${r.probe_question?.slice(0, 90)}` : `"${r.ev}" ${r.quote_verified ? '✓' : '✗ unverified'}`;
      console.log(`   ${role.padEnd(3)} ${String(r.score ?? 'null').padEnd(4)} ${r.name.slice(0, 30).padEnd(30)} ${detail}`);
    }
  }
  const d = (await c.query('select brief_pm, brief_spm, email_type, email_subject, email_body from drafts where candidate_id = $1', [x.id])).rows[0];
  if (d) console.log(`  BRIEF PM: ${d.brief_pm ?? '-'}\n  BRIEF SPM: ${d.brief_spm ?? '-'}\n  EMAIL (${d.email_type}) "${d.email_subject}":\n    ${d.email_body.replace(/\n/g, '\n    ')}`);
}
await c.end();
