-- Manual-only ZKTeco fingerprint attendance import. No scheduler or device polling.
create extension if not exists pgcrypto;
create table if not exists public.fingerprint_import_jobs (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references auth.users(id),
  requested_at timestamptz not null default now(),
  last_dispatched_at timestamptz not null default now(),
  retry_count integer not null default 0 check (retry_count >= 0),
  lease_token text,
  lease_expires_at timestamptz,
  status text not null default 'queued' check (status in ('queued','connecting','downloading','saving','running','completed','partial_failed','succeeded','partial','failed','cancelled')),
  export_format text not null check (export_format in ('csv','xlsx')),
  date_from date,
  date_to date,
  retrieved_count integer not null default 0,
  inserted_count integer not null default 0,
  duplicate_count integer not null default 0,
  rejected_count integer not null default 0,
  unmatched_count integer not null default 0,
  error_message text,
  completed_at timestamptz
);
create table if not exists public.fingerprint_attendance_logs (
  id bigint generated always as identity primary key,
  device_serial text not null,
  source_record_id text,
  fingerprint_user_id text not null,
  occurred_at timestamptz not null,
  punch_status text,
  event_type text,
  raw_event jsonb not null,
  dedupe_key text not null,
  import_job_id uuid not null references public.fingerprint_import_jobs(id),
  imported_at timestamptz not null default now(),
  -- Staff profiles use text IDs; keep this nullable until an admin maps a device user.
  employee_id text references public.profiles(id) on delete set null,
  mapping_status text not null default 'review' check (mapping_status in ('matched','review')),
  constraint fingerprint_attendance_dedupe unique (device_serial, dedupe_key)
);
create index if not exists fingerprint_logs_occurred_at_idx on public.fingerprint_attendance_logs (occurred_at);
create index if not exists fingerprint_logs_review_idx on public.fingerprint_attendance_logs (mapping_status) where mapping_status='review';
alter table public.fingerprint_import_jobs enable row level security;
alter table public.fingerprint_attendance_logs enable row level security;
-- Admin is the only human role allowed to see protected job/event data.
create policy fingerprint_jobs_admin_read on public.fingerprint_import_jobs for select to authenticated using (exists(select 1 from public.profiles p where p.auth_id=auth.uid() and p.role='admin'));
create policy fingerprint_logs_admin_read on public.fingerprint_attendance_logs for select to authenticated using (exists(select 1 from public.profiles p where p.auth_id=auth.uid() and p.role='admin'));
-- Writes are performed only by trusted server code using service role; no client write policies.
