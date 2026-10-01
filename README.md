# Kargo hiring dashboard

An internal tool for a founder (Arjun, Kargo) who has 60 CVs, two open roles (Product Manager and Senior Product Manager) and no time. Upload the CVs; the system strips personal details, scores every CV against a hiring rubric built from his best past hires, ranks the candidates, writes interview briefs and personalised emails, and leaves **every decision and every send to him**.

**Live:** https://kargo-hiring-one.vercel.app (open for review; the case data is fictional and test mode sends every email to one test inbox. Set `DASHBOARD_PASSWORD` to lock it.)

Stack: Next.js 16 · Supabase (Postgres) · Gemini Flash Lite for every AI step · Resend for email · Vercel.

---

## How it works

```
CV (PDF/DOCX) ─► 1. strip name/email/phone/links in code ─► stored privately
                    │
                    ▼ anonymised text only
                 2. Gemini scores it twice, both rubrics (temperature 0) ─► raw runs stored
                    │
                    ▼
                 3. code applies the strictness policy ─► 1–5 per criterion, weighted 0–100, ranking
                    │
                    ▼
                 4. top N per role at/above the threshold ─► 3-sentence brief + invite; everyone else ─► specific rejection
                    │
                    ▼
                 5. Arjun reviews, edits, decides, and clicks Send (one email per click)
```

**1. Privacy first, in code.** Name, email and phone are extracted with code, not AI, and removed from the text (`lib/pii.ts`). It handles PDFs that print the name twice and glue words together (`ROHAN MEHTARohan Mehta`), repeated phone numbers, and links that contain names. A guard runs before **every** AI call and throws if any name, email or phone is still present. The real first name is merged into an email only at the moment of sending.

**2. Two AI runs, raw.** Each CV is split into numbered lines tagged by section (summary / experience) and scored twice against both rubrics. For every criterion the model must cite one CV line; the code checks the quote really is in the CV. Text in a CV addressed to the AI ("ignore previous instructions…") is stripped and flagged.

**3. Strictness is code, not prompt** (`lib/policy.ts`). Because both raw runs are stored, the founder can change the rules and everyone re-ranks instantly with no new AI calls:

| | Strict | Balanced (default) | Lenient |
|---|---|---|---|
| Two runs | lower score | average | average |
| Number needed in evidence | for a 4 or 5 | for a 5 | never |
| One CV line can back | 1 criterion | 2 criteria | any |
| Summary-only claim scores up to | 1 | 2 | 3 |

Weighted total = Σ(score × weight) / 5, from 0 to 100. Null scores (no evidence at all) are excluded and the remaining weights re-normalised. Ties are broken by the "Did the operations work themselves" score. Runs that differ by more than 1 are flagged *scores inconsistent*.

**4. Shortlist.** Invites go to the top N applicants per role at or above the threshold (default: 5 and 65; both adjustable live). The founder can override anyone (★ shortlist / ✕ not moving forward).

**5. Nothing sends by itself.** One Send button per candidate; in review mode the keyboard shortcuts need a double press. Already-sent candidates are locked and never re-drafted. In test mode (`EMAIL_TO_OVERRIDE`) every email goes to one inbox, labelled with who it was for.

### Fairness rules (from the rubric)
Never scored: college, company brand, certifications, age, gender, name, religion, caste, location, marital status, employment gaps. Evidence or no score. Every CV is scored against both rubrics. A strong candidate with no operations background is flagged *strong outsider*, never silently dropped.

---

## The review page

- Ranked list per role in three sections: **Invite**, **Needs your eye** (flagged), **Not moving forward**
- Live **threshold slider** over a score histogram, **invites per role** stepper, **Strict / Balanced / Lenient** with fine-tuning
- Search, filters, sort by any criterion; ★ / ✕ overrides; **J/K** keyboard navigation
- Side panel: brief and recommended action → probe questions → criterion scores as dots (evidence behind "Show evidence") → editable email + Send → personal details
- **Start reviewing**: one candidate at a time with Send invite / Send rejection / Skip (I / R / S)
- Drafts that no longer match a decision are marked; **Update drafts** rewrites them

---

## Run it yourself

1. Create a Supabase project and run `supabase/setup.sql` (schema + rubric seed) in the SQL editor, or `npm run db:setup` with `DATABASE_URL` set. `npm run rubric:build` regenerates the seed from `rubric/rubric.txt` and refuses if either role's weights don't sum to 100; the database also rejects any change that breaks that.
2. Copy `.env.example` to `.env.local` and fill it in (Supabase service-role key, Gemini key, optional Resend key and sender, optional site password).
3. `npm install`, `npm test`, `npm run dev`.
4. Deploy: `npx vercel --prod` with the same environment variables.

Useful scripts: `npm run check:keys` (tests each key), `npm run verify` (privacy and scoring checks on the whole batch), `npm run update:keys` (copy keys to Vercel and redeploy).

## Where things live

| What | File |
|---|---|
| Personal-detail removal + guard | `lib/pii.ts`, `lib/gemini.ts` |
| CV → numbered, sectioned lines | `lib/evidence.ts` |
| Rubric parsing and the weights-sum-to-100 check | `lib/rubric-parse.mjs`, `supabase/schema.sql` |
| Scoring prompt and schema | `lib/prompts.ts` |
| Strictness policy (pure code) | `lib/policy.ts` |
| Weighted totals, ranking, outsider rule | `lib/scoring.ts` |
| Pipeline: ingest, score, recompute, drafts | `lib/pipeline.ts` |
| Duplicate detection | `lib/dedupe.ts` |
| Review UI | `components/Review.tsx`, `app/review/page.tsx` |
| Send (name merged at send time only) | `app/api/send/[id]/route.ts` |
| Tests (calibration table, privacy, policy) | `tests/` |

The unit tests reproduce the rubric's own calibration table (e.g. Lavanya 100, Vikram 35). Test CVs in `tests/fixtures` are fictional. Kargo, Arjun and all case data are fictional (MESA School of Business case study).
