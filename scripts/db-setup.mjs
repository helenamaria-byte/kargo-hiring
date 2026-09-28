// Runs supabase/setup.sql against DATABASE_URL, then proves the weights guard works. No SQL knowledge needed:
//   npm run db:setup
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: '.env.local' });
if (!process.env.DATABASE_URL) { console.error('✖ DATABASE_URL is missing from .env.local'); process.exit(1); }

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query(readFileSync('supabase/setup.sql', 'utf8'));
  const { rows } = await client.query('select role, count(*)::int as criteria, sum(weight)::int as total from rubric_criteria group by role order by role');
  console.table(rows);
  const ok = rows.length === 2 && rows.every((r) => r.criteria === 5 && r.total === 100);
  if (!ok) throw new Error('Rubric not loaded correctly');

  // Guard test: try to break the weights inside a transaction; it must be refused.
  await client.query('begin');
  try {
    await client.query("update rubric_criteria set weight = 31 where role = 'PM' and position = 1");
    await client.query('commit');
    throw new Error('GUARD FAILED: database accepted PM weights summing to 101');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    if (String(e.message).startsWith('GUARD FAILED')) throw e;
    console.log(`✔ Weights guard works — database refused the change: "${e.message}"`);
  }
  const tables = await client.query("select tablename, rowsecurity from pg_tables where schemaname='public' order by 1");
  console.table(tables.rows);
  console.log('✔ Database ready');
} catch (e) {
  console.error(`✖ ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
