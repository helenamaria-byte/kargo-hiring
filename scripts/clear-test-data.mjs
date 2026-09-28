// Deletes candidates whose email is @example.com (the built-in test CVs) and everything linked to them.
//   npm run clear:test   (uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, no database password needed)
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
dotenv.config({ path: '.env.local', quiet: true });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

const all = must(await sb.from('candidates').select('id, name, email').order('id'));
const test = all.filter((r) => /@example\.com$/i.test(r.email ?? ''));
console.log(`candidates: ${all.length} total, ${test.length} test (@example.com): ${test.map((r) => `#${r.id} ${r.name}`).join(', ')}`);
if (test.length) {
  const ids = test.map((r) => r.id);
  must(await sb.from('candidates').update({ duplicate_of: null }).in('duplicate_of', ids).select('id'));
  must(await sb.from('candidates').delete().in('id', ids).select('id'));
}
const { count } = await sb.from('candidates').select('id', { count: 'exact', head: true });
const { count: rubric } = await sb.from('rubric_criteria').select('id', { count: 'exact', head: true });
console.log(`remaining candidates: ${count}; rubric rows: ${rubric}`);
