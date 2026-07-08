create or replace function public.get_system_stats()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'totalTeachers', (
      select count(*)
      from public.profiles
      where lower(trim(role::text)) = 'teacher'
    ),
    'totalParents', (
      select count(*)
      from public.profiles
      where lower(trim(role::text)) = 'parent'
    ),
    'totalStudents', (
      select count(*)
      from public.students
    ),
    'totalExams', (
      select count(*)
      from public.exams
    ),
    'pendingExams', (
      select count(*)
      from public.exams
      where status = 'pending'
    ),
    'approvedExams', (
      select count(*)
      from public.exams
      where status = 'approved'
    ),
    'rejectedExams', (
      select count(*)
      from public.exams
      where status = 'rejected'
    ),
    'averageScore', (
      select coalesce(
        round(
          avg(
            case
              when total > 0 then (score::numeric / total::numeric) * 100
              else null
            end
          ),
          2
        ),
        0
      )
      from public.exams
    )
  );
$$;
