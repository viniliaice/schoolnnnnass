-- Track student promotions across academic years
create table if not exists student_promotions (
  id text primary key,
  "studentId" text not null references students(id) on delete cascade,
  "fromClass" text not null,
  "toClass" text not null,
  "academicYearId" text references academic_years(id) on delete set null,
  "createdAt" timestamptz not null default now()
);

create index if not exists idx_student_promotions_student on student_promotions("studentId");
create index if not exists idx_student_promotions_year on student_promotions("academicYearId");

-- Atomic promotion: update students + insert history in one transaction
create or replace function promote_students(
  from_class text,
  to_class text,
  academic_year_id text default null
)
returns table(promoted_id text, student_name text, old_class text, new_class text)
language plpgsql
as $$
begin
  return query
  with updated as (
    update students
    set "className" = to_class
    where "className" = from_class
    returning id, name, from_class as old_class, to_class as new_class
  )
  insert into student_promotions (id, "studentId", "fromClass", "toClass", "academicYearId")
  select
    'promo-' || floor(extract(epoch from now()) * 1000)::text || '-' || substr(md5(random()::text), 1, 6),
    updated.id,
    updated.old_class,
    updated.new_class,
    academic_year_id
  from updated
  returning
    student_promotions."studentId",
    (select name from students where id = student_promotions."studentId"),
    student_promotions."fromClass",
    student_promotions."toClass";
end;
$$;
