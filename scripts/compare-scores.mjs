// Before/after report: top 10 per role (among that role's applicants, as the shortlist works) and 90+ counts.
//   node scripts/compare-scores.mjs <before.json>
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
dotenv.config({ path: '.env.local', quiet: true });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

const before = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const cands = must(await sb.from('candidates').select('id, name, role_applied, duplicate_of, flags, sent_at'));
const totals = must(await sb.from('score_totals').select('*'));
const rubric = must(await sb.from('rubric_criteria').select('id, role, name'));
const opsIds = rubric.filter((r) => /operations work themselves/i.test(r.name)).map((r) => r.id);
const ops = must(await sb.from('scores').select('candidate_id, role, score').in('criterion_id', opsIds));
const drafts = must(await sb.from('drafts').select('candidate_id, email_type'));
const MIN = 75;

const live = cands.filter((c) => !c.duplicate_of);
const tot = (list, id, role) => { const t = list.find((x) => x.candidate_id === id && x.role === role); return t?.weighted_total == null ? null : Number(t.weighted_total); };
const n90 = (list, role) => live.filter((c) => (tot(list, c.id, role) ?? 0) >= 90).length;

for (const role of ['PM', 'SPM']) {
  const rows = live.filter((c) => c.role_applied === role).map((c) => ({
    c, now: tot(totals, c.id, role), was: tot(before.totals, c.id, role),
    ops: ops.find((o) => o.candidate_id === c.id && o.role === role)?.score ?? 0,
    sw: totals.find((t) => t.candidate_id === c.id && t.role === role)?.scored_weight ?? 0,
  })).filter((r) => r.now !== null)
    .sort((a, b) => b.now - a.now || b.ops - a.ops || b.sw - a.sw || a.c.id - b.c.id);
  console.log(`\n${role} top 10 (of ${rows.length} ${role} applicants) — invites: top 5 with ≥ ${MIN}`);
  rows.slice(0, 10).forEach((r, i) => {
    const invite = i < 5 && r.now >= MIN;
    const flags = r.c.flags.map((f) => f.type).filter((t) => !['role_assigned'].includes(t));
    const delta = r.was === null ? '' : ` (was ${r.was.toFixed(1)}, ${r.now - r.was >= 0 ? '+' : ''}${(r.now - r.was).toFixed(1)})`;
    console.log(`  ${String(i + 1).padStart(2)}. ${r.c.name.padEnd(18)} ${r.now.toFixed(1).padStart(5)}${delta.padEnd(20)} ops ${r.ops ?? '—'}  ${invite ? 'INVITE' : '      '} ${r.c.sent_at ? '[already sent]' : ''} ${flags.join(', ')}`);
  });
}
console.log(`\n90+ (everyone, scored on both rubrics): PM ${n90(before.totals, 'PM')} → ${n90(totals, 'PM')}, SPM ${n90(before.totals, 'SPM')} → ${n90(totals, 'SPM')}`);
const avg = (list, role) => { const v = live.map((c) => tot(list, c.id, role)).filter((x) => x !== null); return (v.reduce((s, x) => s + x, 0) / v.length).toFixed(1); };
console.log(`average score: PM ${avg(before.totals, 'PM')} → ${avg(totals, 'PM')}, SPM ${avg(before.totals, 'SPM')} → ${avg(totals, 'SPM')}`);
const f = {}; live.forEach((c) => c.flags.forEach((x) => (f[x.type] = (f[x.type] || 0) + 1)));
console.log(`flags now: ${JSON.stringify(f)}`);
console.log(`drafts: invites ${drafts.filter((d) => d.email_type === 'invite').length}, rejections ${drafts.filter((d) => d.email_type === 'rejection').length}`);
