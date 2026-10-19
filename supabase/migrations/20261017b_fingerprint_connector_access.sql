-- Least-privilege connector identity: provision a dedicated Supabase Auth user
-- and set app_metadata.role='fingerprint_connector' using trusted admin tooling.
-- This identity can only read queued dispatch metadata; writes go via the narrow
-- Vercel connector endpoint authenticated by FINGERPRINT_CONNECTOR_TOKEN.
grant select on public.fingerprint_import_jobs to authenticated;

-- CREATE POLICY has no IF NOT EXISTS clause. Keep existing policies on reruns;
-- inspect pg_policies if an existing policy with this name is unexpected.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='fingerprint_import_jobs' and policyname='fingerprint_connector_queued_read') then
    create policy fingerprint_connector_queued_read on public.fingerprint_import_jobs
      for select to authenticated
      using (auth.jwt() -> 'app_metadata' ->> 'role' = 'fingerprint_connector' and status in ('queued','failed'));
  end if;
  if not exists (select 1 from pg_policies where schemaname='realtime' and tablename='messages' and policyname='fingerprint_connector_private_topic') then
    create policy fingerprint_connector_private_topic on realtime.messages
      for select to authenticated
      using (realtime.topic() = 'fingerprint-import-dispatch' and auth.jwt() -> 'app_metadata' ->> 'role' = 'fingerprint_connector');
  end if;
end $$;

do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='fingerprint_import_jobs') then
    alter publication supabase_realtime add table public.fingerprint_import_jobs;
  end if;
end $$;
