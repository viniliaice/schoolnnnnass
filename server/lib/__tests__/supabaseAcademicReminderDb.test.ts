import { describe, expect, it, vi } from 'vitest';
import {
  createSupabaseAcademicReminderDataSource,
  getReminderDeliveryHistory,
  getTeacherSubscriptionSummaries,
} from '../supabaseAcademicReminderDb.js';

describe('Supabase academic reminder adapter', () => {
  it('loads history in one batched query and only returns reminder metadata', async () => {
    const row = {
      id: 'recipient-1',
      user_id: 'teacher-1',
      reminder_type: 'lesson_plan_reminder',
      academic_period: 'year-1:2026-W10',
      relevant_entity: '["plan-1"]',
      reminder_occurrence: 'scheduled:lesson_plan_reminder:reminder:2026-10-07:16:00@Africa/Mogadishu',
      reminder_stage: 'reminder',
      status: 'sent',
      delivered_devices: 1,
      failed_devices: 0,
      expired_devices: 0,
      last_error: null,
      created_at: '2026-10-07T12:00:00Z',
      notifications: { title: 'Lesson plan reminder', body: 'Incomplete.', url: '/teacher/lesson-plans' },
    };
    const rest = { select: vi.fn(async () => ({ data: [row], error: null })) } as any;
    const result = await getReminderDeliveryHistory(rest, ['teacher-1', 'teacher-2']);
    expect(result).toEqual([row]);
    expect(rest.select).toHaveBeenCalledTimes(1);
    const [table, query] = rest.select.mock.calls[0];
    expect(table).toBe('notification_recipients');
    expect(query).toContain('user_id=in.');
    expect(query).toContain('reminder_type=in.');
    expect(query).toContain('reminder_stage');
    expect(query).toContain('notifications(title,body,url)');
    await expect(getReminderDeliveryHistory(rest, [])).resolves.toEqual([]);
    expect(rest.select).toHaveBeenCalledTimes(1);
  });

  it('counts real devices separately and excludes synthetic preview endpoints from device eligibility', async () => {
    const rest = {
      select: vi.fn(async () => ({
        data: [
          { user_id: 'teacher-1', endpoint: 'https://push.example.test/device/a', is_active: true },
          { user_id: 'teacher-1', endpoint: 'https://preview.push.local/subscribe/fake', is_active: true },
          { user_id: 'teacher-2', endpoint: 'https://localhost.test/subscribe/fake', is_active: true },
        ],
        error: null,
      })),
    } as any;
    const result = await getTeacherSubscriptionSummaries(rest, ['teacher-1', 'teacher-2', 'teacher-3']);
    expect(rest.select).toHaveBeenCalledTimes(1);
    expect(result.get('teacher-1')).toEqual({ activeSubscriptions: 2, realActiveSubscriptions: 1, hasRealDevice: true });
    expect(result.get('teacher-2')).toEqual({ activeSubscriptions: 1, realActiveSubscriptions: 0, hasRealDevice: false });
    expect(result.get('teacher-3')).toEqual({ activeSubscriptions: 0, realActiveSubscriptions: 0, hasRealDevice: false });
  });

  it('resolves the previous calendar month to its academic year and term', async () => {
    const calls: Array<{ table: string; query: string }> = [];
    const rest = {
      select: vi.fn(async (table: string, query: string) => {
        calls.push({ table, query });
        if (table === 'academic_years') {
          return { data: [{ id: 'year-2025-26', name: '2025/2026', startDate: '2025-08-01', endDate: '2026-06-30', isCurrent: true }], error: null };
        }
        return { data: [
          { id: 'term-1', name: 'Term 1', academicYearId: 'year-2025-26', startDate: '2025-08-01', endDate: '2025-11-30', months: ['August', 'September', 'October', 'November'] },
          { id: 'term-2', name: 'Term 2', academicYearId: 'year-2025-26', startDate: '2025-12-01', endDate: '2026-03-31', months: ['December', 'January', 'February', 'March'] },
        ], error: null };
      }),
    } as any;
    const source = createSupabaseAcademicReminderDataSource(rest);

    const result = await source.getAcademicPeriodForMonth?.(2025, 'December');

    expect(result).toMatchObject({ year: { id: 'year-2025-26' }, term: { id: 'term-2', months: ['December', 'January', 'February', 'March'] } });
    expect(calls[0].query).toContain('2025-12-15');
    expect(calls[1].query).toContain('academicYearId=eq.year-2025-26');
  });

  it('uses the authenticated monitor RPC for staff and the service-only wrapper for server evaluation', async () => {
    const serviceRest = { rpc: vi.fn(async () => ({ data: [], error: null })) } as any;
    const authorizedRest = { rpc: vi.fn(async () => ({ data: [], error: null })) } as any;
    const query = {
      academicYearId: 'year-1',
      termId: 'term-1',
      examScope: 'monthly' as const,
      month: 'October',
      teacherId: 'teacher-1',
    };

    const serviceSource = createSupabaseAcademicReminderDataSource(serviceRest);
    await serviceSource.getMarksMonitorRows(query);
    expect(serviceRest.rpc).toHaveBeenCalledWith('monitor_marks_entries_for_reminders', {
      p_academic_year_id: 'year-1',
      p_term_id: 'term-1',
      p_exam_scope: 'monthly',
      p_month: 'October',
      p_teacher_id: 'teacher-1',
      p_class_name: null,
      p_subject_id: null,
    });

    const staffSource = createSupabaseAcademicReminderDataSource(serviceRest, authorizedRest);
    await staffSource.getMarksMonitorRows({ ...query, teacherId: null });
    expect(authorizedRest.rpc).toHaveBeenCalledWith('monitor_marks_entries', expect.objectContaining({
      p_academic_year_id: 'year-1',
      p_term_id: 'term-1',
      p_exam_scope: 'monthly',
      p_month: 'October',
      p_teacher_id: null,
    }));
  });
});
