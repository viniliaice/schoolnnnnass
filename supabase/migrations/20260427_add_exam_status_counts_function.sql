-- Add a helper RPC function for exam status counts grouped by status
-- This function is used by the frontend to fetch aggregated exam counts
-- without requiring multiple separate exam count requests.

create or replace function public.get_exam_status_counts(
  class_names text[] default null,
  student_ids text[] default null,
  subject_filter text default null,
  search_filter text default null
)
returns table (status text, count int)
language sql
stable
as $$
  select
    exams.status,
    count(*)::int as count
  from public.exams
  left join public.students on students.id = exams.studentid
  where
    (
      student_ids is null
      or array_length(student_ids, 1) is null
      or exams.studentid = any(student_ids)
    )
    and (
      class_names is null
      or array_length(class_names, 1) is null
      or students.classname = any(class_names)
    )
    and (
      subject_filter is null
      or subject_filter = 'All'
      or exams.subject = subject_filter
    )
    and (
      search_filter is null
      or search_filter = ''
      or exams.subject ilike '%' || search_filter || '%'
    )
  group by exams.status;
$$;
