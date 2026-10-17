-- Encrypted K40 communication credential and event-driven connection-test requests.
-- Plaintext credentials are never stored in Postgres; encryption key is server-only.
create table public.fingerprint_device_credentials (
  device_serial text primary key,
  ciphertext_b64 text not null,
  nonce_b64 text not null,
  auth_tag_b64 text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id)
);
alter table public.fingerprint_device_credentials enable row level security;
revoke all on public.fingerprint_device_credentials from anon, authenticated;
grant all on public.fingerprint_device_credentials to service_role;

create table public.fingerprint_device_credential_candidates (
  device_serial text primary key,
  revision_id uuid not null default gen_random_uuid() unique,
  ciphertext_b64 text not null,
  nonce_b64 text not null,
  auth_tag_b64 text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id)
);
alter table public.fingerprint_device_credential_candidates enable row level security;
revoke all on public.fingerprint_device_credential_candidates from anon, authenticated;
grant all on public.fingerprint_device_credential_candidates to service_role;

create table public.fingerprint_device_test_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references auth.users(id),
  requested_at timestamptz not null default now(),
  credential_revision_id uuid,
  status text not null default 'queued' check (status in ('queued','running','success','connector_unavailable','address_port_failure','network_failure','timeout','authentication_failure','credential_not_verified','unsupported_protocol','failed')),
  result_message text,
  tested_at timestamptz
);
create index fingerprint_device_tests_requested_at_idx on public.fingerprint_device_test_requests (requested_at desc);
alter table public.fingerprint_device_test_requests enable row level security;
create policy fingerprint_device_tests_admin_read on public.fingerprint_device_test_requests
  for select to authenticated using (exists (
    select 1 from public.profiles p where p.auth_id=auth.uid() and p.role='admin'
  ));
grant select on public.fingerprint_device_test_requests to authenticated;
grant all on public.fingerprint_device_test_requests to service_role;
create policy fingerprint_device_tests_connector_read on public.fingerprint_device_test_requests
  for select to authenticated using (
    auth.jwt() -> 'app_metadata' ->> 'role' = 'fingerprint_connector' and status='queued'
  );
create or replace function public.finish_fingerprint_device_test(p_test_id uuid, p_result text, p_result_message text)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_revision uuid;
  v_status text := p_result;
  v_message text := p_result_message;
  v_candidate public.fingerprint_device_credential_candidates%rowtype;
begin
  select credential_revision_id into v_revision from public.fingerprint_device_test_requests
    where id=p_test_id and status='running' for update;
  if not found then raise exception 'Device test is no longer active.'; end if;
  if p_result='success' and v_revision is not null then
    select * into v_candidate from public.fingerprint_device_credential_candidates
      where revision_id=v_revision for update;
    if not found then
      v_status := 'failed';
      v_message := 'Credential changed during verification; the saved credential was not rotated.';
    else
      insert into public.fingerprint_device_credentials(device_serial,ciphertext_b64,nonce_b64,auth_tag_b64,updated_at,updated_by)
      values(v_candidate.device_serial,v_candidate.ciphertext_b64,v_candidate.nonce_b64,v_candidate.auth_tag_b64,now(),v_candidate.updated_by)
      on conflict(device_serial) do update set ciphertext_b64=excluded.ciphertext_b64,nonce_b64=excluded.nonce_b64,
        auth_tag_b64=excluded.auth_tag_b64,updated_at=excluded.updated_at,updated_by=excluded.updated_by;
      delete from public.fingerprint_device_credential_candidates where device_serial=v_candidate.device_serial and revision_id=v_revision;
    end if;
  end if;
  update public.fingerprint_device_test_requests set status=v_status,result_message=v_message,tested_at=now() where id=p_test_id;
  return v_status;
end;
$$;
revoke all on function public.finish_fingerprint_device_test(uuid,text,text) from public,anon,authenticated;
grant execute on function public.finish_fingerprint_device_test(uuid,text,text) to service_role;

do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='fingerprint_device_test_requests') then
    alter publication supabase_realtime add table public.fingerprint_device_test_requests;
  end if;
end $$;
