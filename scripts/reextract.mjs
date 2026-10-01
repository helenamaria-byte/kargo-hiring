// Re-runs the privacy step on the original CV files for candidates already in the database, in place.
// Keeps ids, sent status, drafts and other flags; replaces name/email/phone, the anonymised text and the
// name/email flags. No AI calls.   node scripts/reextract.mjs <folder-with-original-cvs>
import { readFileSync, existsSync } from 'node:fs';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { fileToText } from '../lib/parse-file.ts';
import { extractPII, assertNoPII } from '../lib/pii.ts';
import { contentHash } from '../lib/dedupe.ts';

dotenv.config({ path: '.env.local', quiet: true });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const dir = process.argv[2];
const EXTRACTION_FLAGS = new Set(['name_from_file', 'name_not_detected', 'email_not_detected']);

const { data: cands, error } = await sb.from('candidates').select('id, file_name, name, email, phone, flags');
if (error) throw new Error(error.message);
let updated = 0, renamed = [], missing = [];
for (const c of cands) {
  const path = `${dir}/${c.file_name}`;
  if (!existsSync(path)) { missing.push(c.file_name); continue; }
  const b = readFileSync(path);
  const text = await fileToText(c.file_name, b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  const { pii, redacted, nameSource } = extractPII(text, c.file_name);
  assertNoPII(redacted, pii);
  const flags = (c.flags ?? []).filter((f) => !EXTRACTION_FLAGS.has(f.type));
  if (!pii.name) flags.push({ type: 'name_not_detected', detail: 'Could not find the candidate’s name in the CV — add it before sending.' });
  if (nameSource === 'file') flags.push({ type: 'name_from_file', detail: `Name taken from the file name (“${c.file_name}”) because the CV text has none — check it before sending.` });
  if (!pii.email) flags.push({ type: 'email_not_detected', detail: 'No email address found in the CV — add it before sending.' });
  if (pii.name !== c.name || pii.email !== c.email) renamed.push(`#${c.id}: ${c.name} <${c.email}> → ${pii.name} <${pii.email}>`);
  const { error: e } = await sb.from('candidates').update({ ...pii, cv_content: redacted, content_hash: contentHash(redacted), flags }).eq('id', c.id);
  if (e) throw new Error(e.message);
  updated++;
}
console.log(`updated ${updated} candidates in place; missing source files: ${missing.length ? missing.join(', ') : 'none'}`);
console.log(`name/email changes: ${renamed.length ? '\n  ' + renamed.join('\n  ') : 'none'}`);
