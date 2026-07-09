create or replace function public.get_midterm_report(
  p_student_id text,
  p_term_id text
)
returns jsonb
language sql
stable
as $$
  with target_student as (
    select id, "className"
    from public.students
    where id = p_student_id
  ),
  class_students as (
    select s.id
    from public.students s
    join target_student ts on ts."className" = s."className"
  ),
  class_midterms as (
    select
      e.id,
      e."studentId" as student_id,
      e.subject,
      e.score,
      e.total,
      case when e.total > 0 then round((e.score::numeric / e.total::numeric) * 100)::int else 0 end as percentage
    from public.exams e
    join class_students cs on cs.id = e."studentId"
    where e."termId" = p_term_id
      and e."examType" = 'Midterm'
      and e.status = 'approved'
  ),
  student_midterms as (
    select *
    from class_midterms
    where student_id = p_student_id
  ),
  subject_scores as (
    select
      sm.id as exam_id,
      sm.subject,
      sm.score,
      sm.total,
      sm.percentage,
      case
        when sm.percentage >= 90 then 'A'
        when sm.percentage >= 80 then 'B'
        when sm.percentage >= 70 then 'C'
        when sm.percentage >= 60 then 'D'
        else 'F'
      end as grade,
      case
        when sm.percentage >= 90 then 'Excellent'
        when sm.percentage >= 80 then 'Very Good'
        when sm.percentage >= 70 then 'Good'
        when sm.percentage >= 60 then 'Satisfactory'
        else 'Needs Improvement'
      end as remark,
      (
        select count(*) + 1
        from class_midterms cm
        where cm.subject = sm.subject
          and cm.percentage > sm.percentage
      ) as subject_rank,
      (
        select coalesce(round(avg(cm.percentage))::int, 0)
        from class_midterms cm
        where cm.subject = sm.subject
      ) as class_average,
      (
        select coalesce(max(cm.percentage), 0)
        from class_midterms cm
        where cm.subject = sm.subject
      ) as highest_in_class
    from student_midterms sm
  ),
  student_averages as (
    select
      cm.student_id,
      round(avg(cm.percentage))::int as average_percentage
    from class_midterms cm
    group by cm.student_id
  ),
  target_average as (
    select coalesce((select average_percentage from student_averages where student_id = p_student_id), 0) as average_percentage
  )
  select jsonb_build_object(
    'scores', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'subject', ss.subject,
          'score', ss.score,
          'total', ss.total,
          'percentage', ss.percentage,
          'grade', ss.grade,
          'remark', ss.remark,
          'subject_rank', ss.subject_rank,
          'class_average', ss.class_average,
          'highest_in_class', ss.highest_in_class,
          'examId', ss.exam_id
        )
        order by ss.subject
      )
      from subject_scores ss
    ), '[]'::jsonb),
    'overall_rank', coalesce((
      select count(*) + 1
      from student_averages sa, target_average ta
      where sa.average_percentage > ta.average_percentage
    ), 0),
    'total_students', (select count(*) from student_averages)
  );
$$;
