import { db, q } from './supabase';
import { validateRubric } from './rubric-parse.mjs';
import type { Criterion } from './prompts';

// Read from the database on every job and validated before any scoring call.
export async function loadRubric(): Promise<Criterion[]> {
  const rows = await q<Criterion[]>(db().from('rubric_criteria').select('*').order('role').order('position'));
  if (!rows.length) throw new Error('rubric_criteria is empty — run supabase/setup.sql in the Supabase SQL editor');
  validateRubric(rows);
  return rows;
}
