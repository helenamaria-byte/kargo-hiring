# Kargo hiring dashboard

Upload CVs → personal details stripped in code → Gemini scores every CV on both PM and SPM rubrics → code computes totals and ranks → top 5 per role get a brief and an invite draft, everyone else gets a specific rejection → Arjun edits and clicks **Confirm & Send** per card. Nothing sends automatically.

## Setup

1. **Supabase**: open the SQL editor, paste all of `supabase/setup.sql`, and run it. The last result should show `PM 5 100` and `SPM 5 100`.
   (`setup.sql` is generated from `rubric/rubric.txt` by `npm run rubric:build`, which fails if either role's weights don't sum to 100. The database also rejects any change that breaks the 100 total.)
2. **Env**: fill in `.env.local` (see `.env.example`). Use the **service_role / secret** key, not the anon key.
3. `npm install && npm test && npm run dev`, then open http://localhost:3000.
4. **Vercel**: `npx vercel`, add the same env vars in Project → Settings → Environment Variables (including `DASHBOARD_PASSWORD`), then `npx vercel --prod`.

## Where the rules live

| Rule | File |
|---|---|
| Name/email/phone removed before any AI call; guard throws if any leaks | `lib/pii.ts`, `lib/gemini.ts` |
| Rubric parsed + validated (weights = 100) | `lib/rubric-parse.mjs`, `supabase/schema.sql` trigger |
| Scoring prompt: evidence quote or null, no bias factors, ignore text aimed at AI | `lib/prompts.ts` |
| Weighted total, re-normalising nulls, ranking, strong outsider | `lib/scoring.ts` (tested against the rubric's calibration table) |
| Duplicate detection (on redacted text) | `lib/dedupe.ts` |
| Pipeline, top-5 briefs, invite/rejection drafts | `lib/pipeline.ts` |
| Name merged into email at send time only | `app/api/send/[id]/route.ts` |
