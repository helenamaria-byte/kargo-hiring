// Reads rubric/rubric.txt, validates it (5 criteria per role, weights = 100), and writes
// supabase/setup.sql = schema.sql + the rubric seed. Exits non-zero on any problem.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseRubric } from '../lib/rubric-parse.mjs';

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

try {
  const rows = parseRubric(readFileSync('rubric/rubric.txt', 'utf8'));
  const schema = readFileSync('supabase/schema.sql', 'utf8');
  const values = rows
    .map((r) => `  (${q(r.role)}, ${r.position}, ${q(r.name)}, ${q(r.description)}, ${r.weight})`)
    .join(',\n');

  const seed = `
-- ── Rubric seed (generated from rubric/rubric.txt by npm run rubric:build — do not edit by hand) ──
begin;
delete from rubric_criteria where not exists (select 1 from scores s where s.criterion_id = rubric_criteria.id);
insert into rubric_criteria (role, position, name, description, weight) values
${values}
on conflict (role, name) do update
  set position = excluded.position, description = excluded.description, weight = excluded.weight;
commit;  -- the weights trigger fires here and aborts if either role does not sum to 100

select role, count(*) as criteria, sum(weight) as total_weight from rubric_criteria group by role order by role;
`;
  writeFileSync('supabase/setup.sql', schema + seed);
  for (const role of ['PM', 'SPM']) {
    const r = rows.filter((x) => x.role === role);
    console.log(`${role}: ${r.map((x) => `${x.name} (${x.weight})`).join(' | ')}  = ${r.reduce((s, x) => s + x.weight, 0)}`);
  }
  console.log('Wrote supabase/setup.sql');
} catch (e) {
  console.error(`\n✖ ${e.message}\n`);
  process.exit(1);
}
