-- Security bridge: Supabase Auth user UUID maps to the app profile through profiles.auth_id.
-- The application continues to use profiles.id as the domain/user id.

alter table public.profiles enable row level security;

create or replace function public.current_profile_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select id
  from public.profiles
  where auth_id = auth.uid()
  limit 1;
$$;

create or replace function public.current_profile_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.profiles
  where auth_id = auth.uid()
  limit 1;
$$;

drop policy if exists "Profiles can read own profile" on public.profiles;
create policy "Profiles can read own profile"
on public.profiles
for select
using (auth.uid() = auth_id);

drop policy if exists "Admins can read all profiles" on public.profiles;
create policy "Admins can read all profiles"
on public.profiles
for select
using (public.current_profile_role() = 'admin');

-- Optional baseline examples for student access. Keep existing policies until you
-- have audited all role flows, then remove broad USING (true) policies.
alter table public.students enable row level security;

drop policy if exists "Parents can read own children" on public.students;
create policy "Parents can read own children"
on public.students
for select
using ("parentId" = public.current_profile_id());

drop policy if exists "Admins can read all students" on public.students;
create policy "Admins can read all students"
on public.students
for select
using (public.current_profile_role() = 'admin');

drop policy if exists "Teachers can read assigned class students" on public.students;
create policy "Teachers can read assigned class students"
on public.students
for select
using (
  public.current_profile_role() in ('teacher', 'supervisor')
  and "className" in (
    select jsonb_array_elements_text(
      coalesce(
        (
          select "assignedClasses"
          from public.profiles
          where auth_id = auth.uid()
        ),
        '[]'::jsonb
      )
    )
  )
);
