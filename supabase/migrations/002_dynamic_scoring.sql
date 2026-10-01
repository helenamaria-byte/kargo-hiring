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
