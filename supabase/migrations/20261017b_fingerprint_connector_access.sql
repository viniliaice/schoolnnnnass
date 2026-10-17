-- Least-privilege connector identity: provision a dedicated Supabase Auth user
-- and set app_metadata.role='fingerprint_connector' using trusted admin tooling.
-- This identity can only read queued dispatch metadata; writes go via the narrow
-- Vercel connector endpoint authenticated by FINGERPRINT_CONNECTOR_TOKEN.
grant select on public.fingerprint_import_jobs to authenticated;
create policy fingerprint_connector_queued_read on public.fingerprint_import_jobs
  for select to authenticated
  using (auth.jwt() -> 'app_metadata' ->> 'role' = 'fingerprint_connector' and status in ('queued','failed'));
-- Private Realtime topic policy: only the dedicated app_metadata identity may join this topic.
create policy fingerprint_connector_private_topic on realtime.messages
  for select to authenticated
  using (realtime.topic() = 'fingerprint-import-dispatch' and auth.jwt() -> 'app_metadata' ->> 'role' = 'fingerprint_connector');
do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='fingerprint_import_jobs') then
    alter publication supabase_realtime add table public.fingerprint_import_jobs;
  end if;
end $$;
