// Dry run of the privacy step on a folder of real CVs — no AI, no database:
//   node scripts/check-pii-files.mjs <folder>
// Checks every CV: name found (and from where), email found, and no name/email/phone left in the AI text,
// including names glued into one word and phone numbers written any other way.
import { readFileSync, readdirSync } from 'node:fs';
import { fileToText } from '../lib/parse-file.ts';
import { extractPII, assertNoPII, nameFromFileName } from '../lib/pii.ts';

const dir = process.argv[2];
const files = readdirSync(dir).filter((f) => /\.(pdf|docx)$/i.test(f)).sort();
const problems = [];
const bySource = { cv: 0, file: 0, none: 0 };
for (const f of files) {
  const b = readFileSync(`${dir}/${f}`);
  const text = await fileToText(f, b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  const { pii, redacted, nameSource } = extractPII(text, f);
  bySource[nameSource ?? 'none']++;
  const low = redacted.toLowerCase();
  const toks = (pii.name ?? '').split(' ').filter((t) => t.length >= 4).map((t) => t.toLowerCase());
  const digits = redacted.replace(/\D/g, '');
  const core = (pii.phone ?? '').replace(/\D/g, '').slice(-10);
  const issues = [];
  try { assertNoPII(redacted, pii); } catch (e) { issues.push(e.message); }
  if (toks.length >= 2 && low.includes(toks.join(''))) issues.push('joined name left');
  if (core && digits.includes(core)) issues.push('phone digits left');
  if (!pii.email || /^[A-Z]/.test(pii.email)) issues.push(`email looks wrong: ${pii.email}`);
  const expected = nameFromFileName(f);
  if (expected && pii.name !== expected) issues.push(`name "${pii.name}" ≠ file "${expected}"`);
  if (issues.length) problems.push(`${f}: ${issues.join('; ')}`);
}
console.log(`${files.length} CVs | name from CV text: ${bySource.cv}, from file name: ${bySource.file}, none: ${bySource.none} | problems: ${problems.length}`);
for (const p of problems) console.log('  ' + p);
