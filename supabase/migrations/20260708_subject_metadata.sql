alter table public.subjects
  add column if not exists color text,
  add column if not exists "weeklyLessons" integer not null default 5;
