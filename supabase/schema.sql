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
-- Dynamic scoring: keep both raw AI runs so leniency and threshold can change without new AI calls,
-- let Arjun override a candidate's group, and store the review settings.

-- Both scoring runs for this criterion, before any policy is applied:
-- [{ "score": 4, "quote": "...", "source": "work_history", "line": 12, "verified": true, "number": true, "reason": "...", "probe": "" }, {...}]
alter table scores add column if not exists runs jsonb;

-- Arjun's own call, overriding the computed group. null = follow the ranking.
alter table candidates add column if not exists decision text check (decision in ('invite', 'reject'));

create table if not exists settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table settings enable row level security;

insert into settings (key, value) values
  ('scoring', '{"preset": "balanced", "combine": "average", "numberRule": "five", "lineReuse": 2, "summaryMax": 2}'),
  ('shortlist', '{"threshold": 65, "topN": 5}')
on conflict (key) do nothing;

-- Averaging two runs can give half points (3.5).
alter table scores alter column score type numeric(2,1);
