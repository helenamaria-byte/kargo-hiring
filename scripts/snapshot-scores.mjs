// Saves current weighted totals and per-criterion scores to a JSON file, for before/after comparisons.
//   node scripts/snapshot-scores.mjs <out.json>
import { writeFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
dotenv.config({ path: '.env.local', quiet: true });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

const candidates = must(await sb.from('candidates').select('id, name, file_name, role_applied, duplicate_of, status, sent_at, flags'));
const totals = must(await sb.from('score_totals').select('*'));
const scores = must(await sb.from('scores').select('candidate_id, criterion_id, role, score'));
const drafts = must(await sb.from('drafts').select('candidate_id, email_type, edited'));
const out = process.argv[2] ?? 'snapshot.json';
writeFileSync(out, JSON.stringify({ takenAt: new Date().toISOString(), candidates, totals, scores, drafts }, null, 1));
const n90 = (role) => totals.filter((t) => t.role === role && Number(t.weighted_total) >= 90).length;
console.log(`saved ${candidates.length} candidates to ${out} | 90+: PM ${n90('PM')}, SPM ${n90('SPM')} | edited drafts: ${drafts.filter((d) => d.edited).length} | sent: ${candidates.filter((c) => c.sent_at).length}`);
