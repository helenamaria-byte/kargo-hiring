// Deletes candidates whose email is @example.com (the built-in test CVs) and everything linked to them.
//   npm run clear:test
import dotenv from 'dotenv';
import pg from 'pg';
dotenv.config({ path: '.env.local', quiet: true });
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const all = (await c.query('select id, name, email from candidates order by id')).rows;
const test = all.filter((r) => /@example\.com$/i.test(r.email ?? ''));
console.log(`candidates: ${all.length} total, ${test.length} test (@example.com): ${test.map((r) => `#${r.id} ${r.name}`).join(', ')}`);
if (test.length) {
  await c.query('update candidates set duplicate_of = null where duplicate_of = any($1)', [test.map((r) => r.id)]);
  await c.query('delete from candidates where id = any($1)', [test.map((r) => r.id)]);
}
if (test.length === all.length) await c.query('alter table candidates alter column id restart with 1');
console.log(`remaining candidates: ${(await c.query('select count(*)::int n from candidates')).rows[0].n}; rubric rows: ${(await c.query('select count(*)::int n from rubric_criteria')).rows[0].n}`);
await c.end();
