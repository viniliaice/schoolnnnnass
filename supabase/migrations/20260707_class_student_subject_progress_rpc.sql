create or replace function public.get_class_student_subject_progress(
  p_class_name text,
  p_month text
)
returns jsonb
language sql
stable
as $$
  with class_students as (
    select s.id, s.name, s."className"
    from public.students s
    where s."className" = p_class_name
  ),
  class_subject_rows as (
    select
      cs."subjectId" as subject_id,
      coalesce(sub.name, cs."subjectId") as subject_name
    from public.class_subjects cs
    left join public.subjects sub on sub.id = cs."subjectId"
    where cs."className" = p_class_name
  ),
  baseline as (
    select
      st.id as student_id,
      st.name as student_name,
      st."className" as class_name,
      csr.subject_id,
      csr.subject_name
    from class_students st
    cross join class_subject_rows csr
  ),
  matched_exams as (
    select
      b.student_id,
      b.subject_name,
      e."examType" as exam_type,
      e.score,
      e.total
    from baseline b
    join public.exams e
      on e."studentId" = b.student_id
     and e.month = p_month
     and (e.subject = b.subject_id or e.subject = b.subject_name)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'studentId', b.student_id,
        'studentName', b.student_name,
        'className', b.class_name,
        'month', p_month,
        'subject', b.subject_name,
        'caEntered', exists (
          select 1 from matched_exams me
          where me.student_id = b.student_id and me.subject_name = b.subject_name and me.exam_type = 'CA'
        ),
        'homeworkEntered', exists (
          select 1 from matched_exams me
          where me.student_id = b.student_id and me.subject_name = b.subject_name and me.exam_type = 'Homework'
        ),
        'classworkEntered', exists (
          select 1 from matched_exams me
          where me.student_id = b.student_id and me.subject_name = b.subject_name and me.exam_type = 'Classwork'
        ),
        'attendanceEntered', exists (
          select 1 from matched_exams me
          where me.student_id = b.student_id and me.subject_name = b.subject_name and me.exam_type = 'Attendance'
        ),
        'quizEntered', exists (
          select 1 from matched_exams me
          where me.student_id = b.student_id and me.subject_name = b.subject_name and me.exam_type = 'Quiz'
        ),
        'totalExamRows', (
          select count(*) from matched_exams me
          where me.student_id = b.student_id and me.subject_name = b.subject_name
        ),
        'examEntries', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'examType', me.exam_type,
              'score', me.score,
              'total', me.total
            )
            order by me.exam_type
          )
          from matched_exams me
          where me.student_id = b.student_id and me.subject_name = b.subject_name
        ), '[]'::jsonb)
      )
      order by b.student_name, b.subject_name
    ),
    '[]'::jsonb
  )
  from baseline b;
$$;
