-- Kargo hiring dashboard schema. Run once in the Supabase SQL editor (via setup.sql, which appends the rubric seed).
-- All access is server-side with the service-role key. RLS is on with no policies, so the public anon key can read nothing.

-- ── Rubric ──────────────────────────────────────────────────────────────
create table if not exists rubric_criteria (
  id          bigint generated always as identity primary key,
  role        text     not null check (role in ('PM', 'SPM')),
  position    smallint not null,
  name        text     not null,
  description text     not null,
  weight      integer  not null check (weight > 0 and weight <= 100),
  unique (role, name),
  unique (role, position)
);

-- Fail loudly: any transaction that leaves a role's weights not summing to 100 is rolled back.
create or replace function check_rubric_weights() returns trigger language plpgsql as $$
declare r record;
begin
  for r in
    select roles.role, coalesce(sum(c.weight), 0) as total, count(c.id) as n
    from (values ('PM'), ('SPM')) as roles(role)
    left join rubric_criteria c on c.role = roles.role
    group by roles.role
  loop
    if r.total <> 100 then
      raise exception 'rubric_criteria: % weights sum to % (% criteria). They must sum to exactly 100.', r.role, r.total, r.n;
    end if;
  end loop;
  return null;
end $$;

drop trigger if exists rubric_weights_sum_100 on rubric_criteria;
create constraint trigger rubric_weights_sum_100
  after insert or update or delete on rubric_criteria
  deferrable initially deferred
  for each row execute function check_rubric_weights();

-- ── Candidates ──────────────────────────────────────────────────────────
create table if not exists candidates (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  file_name     text not null,
  role_applied  text not null check (role_applied in ('PM', 'SPM')),
  -- Personal details. Stored here only; never sent to any AI call.
  name          text,
  email         text,
  phone         text,
  -- CV text with name/email/phone/profile links removed. This is the only CV text AI ever sees.
  cv_content    text,
  content_hash  text,
  status        text not null default 'processing' check (status in ('processing', 'ready', 'sent', 'error')),
  error_message text,
  duplicate_of  bigint references candidates(id) on delete set null,
  similarity    real,
  flags         jsonb not null default '[]'::jsonb,
  sent_at       timestamptz
);
create index if not exists candidates_hash_idx on candidates (content_hash);

-- ── Scores ──────────────────────────────────────────────────────────────
create table if not exists scores (
  candidate_id   bigint not null references candidates(id) on delete cascade,
  criterion_id   bigint not null references rubric_criteria(id),
  role           text   not null check (role in ('PM', 'SPM')),
  score          smallint check (score between 1 and 5),  -- null = no evidence in CV
  evidence       text,     -- quote from the CV the score relies on
  quote_verified boolean,  -- code checked the quote really appears in the CV
  reason         text,     -- one line
  probe_question text,     -- set when score is null
  primary key (candidate_id, criterion_id)
);

-- Weighted totals are computed in code: sum(score × weight) / 5, nulls excluded and weights re-normalised.
create table if not exists score_totals (
  candidate_id   bigint not null references candidates(id) on delete cascade,
  role           text   not null check (role in ('PM', 'SPM')),
  weighted_total numeric(5, 1),  -- 0–100, null if no criterion had evidence
  scored_weight  integer not null, -- how much of the 100 weight had evidence
  primary key (candidate_id, role)
);

-- ── Drafts ──────────────────────────────────────────────────────────────
create table if not exists drafts (
  candidate_id  bigint primary key references candidates(id) on delete cascade,
  brief_pm      text,  -- only while in PM top 5
  brief_spm     text,  -- only while in SPM top 5
  email_type    text check (email_type in ('invite', 'rejection')),
  email_subject text,
  email_body    text,  -- contains {{first_name}}; the real name is merged only at send time
  edited        boolean not null default false,
  updated_at    timestamptz not null default now()
);

alter table rubric_criteria enable row level security;
alter table candidates      enable row level security;
alter table scores          enable row level security;
alter table score_totals    enable row level security;
alter table drafts          enable row level security;

-- ── Rubric seed (generated from rubric/rubric.txt by npm run rubric:build — do not edit by hand) ──
begin;
delete from rubric_criteria where not exists (select 1 from scores s where s.criterion_id = rubric_criteria.id);
insert into rubric_criteria (role, position, name, description, weight) values
  ('PM', 1, 'Did the operations work themselves', 'Has held a job where they personally handled shipments, documentation, carriers, customs, warehouse or port work — named volumes, named documents or named counterparts (CHAs, shipping lines, terminals). A weak candidate has only built software for, sold to, consulted for, or studied operations. Score 5 = 1+ year in a hands-on logistics operations job. Score 3 = hands-on operations in another physical industry (plant floor, hospital, fulfilment hub). Score 1 = no hands-on operations role.', 30),
  ('PM', 2, 'Fixed something unasked, and others adopted it', 'The CV names a specific broken process they noticed themselves, what they built to fix it, and who started using it and how quickly (for example, "adopted by 3 other hubs within 2 months"). A weak candidate lists only assigned projects, or improvements with no one named as using them. Score 5 = two or more such fixes, adopted beyond their own team. Score 3 = one clear example with stated adoption. Score 1 = none.', 25),
  ('PM', 3, 'Stepped into a breakdown and closed it out', 'Describes a specific incident, failure or crisis — an outage, a held shipment, a lost deal, a vendor change — that they took on personally, resolved, and then documented or changed a process because of it. A weak candidate describes only planned work and successes. Score 5 = took on an incident outside their strict job, resolved it, and wrote it up or fixed the cause. Score 3 = handled incidents as part of the role (on-call, escalations). Score 1 = no incident or failure described.', 20),
  ('PM', 4, 'No layer between them and the user', 'Was the person the end user or client dealt with directly and routinely — the named contact for accounts, working in the users'' own location, or taking the escalation call. A weak candidate reaches users only through scheduled research, account managers or stakeholder reviews. Score 5 = direct, day-to-day contact, and was the one users came to when things went wrong. Score 3 = regular direct contact (weekly calls, site visits). Score 1 = users reached only through other teams.', 15),
  ('PM', 5, 'Operated without a safety net', 'Was the only or most senior person responsible for their area, with no one in their function to hand decisions to. A weak candidate always worked inside a larger team where someone above made the calls. Score 5 = sole owner of the area, or first person in the function. Score 3 = owned an area independently day to day, with a functional manager above. Score 1 = worked within a team led by others.', 10),
  ('SPM', 1, 'Did the operations work themselves', 'PM BASELINE: Has held a job where they personally handled shipments, documentation, carriers, customs, warehouse or port work — named volumes, named documents or named counterparts (CHAs, shipping lines, terminals). A weak candidate has only built software for, sold to, consulted for, or studied operations. Score 5 = 1+ year in a hands-on logistics operations job. Score 3 = hands-on operations in another physical industry (plant floor, hospital, fulfilment hub). Score 1 = no hands-on operations role. SENIOR PRODUCT MANAGER BAR (this overrides the baseline where they differ): As for PM, and the operations experience shaped a specific product or architecture decision they later made (for example, designing an integration around what they knew the real data contained). Operations experience with no link to later decisions scores no higher than 4.', 25),
  ('SPM', 2, 'Fixed something unasked, and others adopted it', 'PM BASELINE: The CV names a specific broken process they noticed themselves, what they built to fix it, and who started using it and how quickly (for example, "adopted by 3 other hubs within 2 months"). A weak candidate lists only assigned projects, or improvements with no one named as using them. Score 5 = two or more such fixes, adopted beyond their own team. Score 3 = one clear example with stated adoption. Score 1 = none. SENIOR PRODUCT MANAGER BAR (this overrides the baseline where they differ): As for PM, but the fixes were adopted across multiple teams or the whole company, or became a standard practice others still run. A fix used only by their own team scores no higher than 3.', 20),
  ('SPM', 3, 'Stepped into a breakdown and closed it out', 'PM BASELINE: Describes a specific incident, failure or crisis — an outage, a held shipment, a lost deal, a vendor change — that they took on personally, resolved, and then documented or changed a process because of it. A weak candidate describes only planned work and successes. Score 5 = took on an incident outside their strict job, resolved it, and wrote it up or fixed the cause. Score 3 = handled incidents as part of the role (on-call, escalations). Score 1 = no incident or failure described. SENIOR PRODUCT MANAGER BAR (this overrides the baseline where they differ): As for PM, and they made the call with no one to escalate to — accepting sunk cost, reversing their own earlier decision, or leading the recovery for others. Resolving an incident under someone else''s direction scores no higher than 3.', 20),
  ('SPM', 4, 'No layer between them and the user', 'PM BASELINE: Was the person the end user or client dealt with directly and routinely — the named contact for accounts, working in the users'' own location, or taking the escalation call. A weak candidate reaches users only through scheduled research, account managers or stakeholder reviews. Score 5 = direct, day-to-day contact, and was the one users came to when things went wrong. Score 3 = regular direct contact (weekly calls, site visits). Score 1 = users reached only through other teams. SENIOR PRODUCT MANAGER BAR (this overrides the baseline where they differ): As for PM, and they built a practice that keeps their team close to users (for example, regular embed days at client sites). Personal user contact alone scores no higher than 4.', 10),
  ('SPM', 5, 'Operated without a safety net', 'PM BASELINE: Was the only or most senior person responsible for their area, with no one in their function to hand decisions to. A weak candidate always worked inside a larger team where someone above made the calls. Score 5 = sole owner of the area, or first person in the function. Score 3 = owned an area independently day to day, with a functional manager above. Score 1 = worked within a team led by others. SENIOR PRODUCT MANAGER BAR (this overrides the baseline where they differ): Was the most senior person in their function for a sustained period (a year or more) — first product hire, head of the function, or founder — and set direction for others. Sole ownership of one area with a senior manager above scores no higher than 3.', 25)
on conflict (role, name) do update
  set position = excluded.position, description = excluded.description, weight = excluded.weight;
commit;  -- the weights trigger fires here and aborts if either role does not sum to 100

select role, count(*) as criteria, sum(weight) as total_weight from rubric_criteria group by role order by role;
