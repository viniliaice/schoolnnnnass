// QA-only fake Supabase for the supervisor Lesson Plan Review screen.
// Deterministic data + tunable latency/failure so the decision loop can be
// exercised in a real browser without a backend. Not part of the app build.
//
// Query params:
//   n=40        how many plans in the queue
//   lat=400     ms latency on decision RPCs
//   fail=1      make every decision RPC fail
//   long=1      very long AI feedback + teacher comments + big plan

type Row = Record<string, unknown>;

const q = new URLSearchParams(location.search);
export const N = Number(q.get('n') ?? 40);
export const LATENCY = Number(q.get('lat') ?? 400);
const FAIL = q.get('fail') === '1';
const LONG = q.get('long') === '1';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TEACHERS = ['Amina Warsame', 'Yusuf Cabdi', 'Hodan Xasan', 'Mohamed Cali', 'Fadumo Jama',
  'Ahmed Nuur', 'Sagal Ibrahim', 'Khadar Farah'];
const SUBJECTS = ['Mathematics', 'Biology', 'English', 'Physics', 'Chemistry', 'History'];
const STATUSES = ['submitted', 'in_review', 'in_review', 'ai_failed', 'approved', 'rejected'];

const LOREM = 'The lesson demonstrates a clear progression of ideas and the objectives are measurable. ';

function makePlan(i: number): Row {
  const status = i < Math.floor(N * 0.7) ? (i % 3 === 0 ? 'submitted' : 'in_review') : STATUSES[i % STATUSES.length];
  return {
    id: `plan-${i}`,
    teacher_id: `t-${i % TEACHERS.length}`,
    subject_id: null,
    title: LONG && i === 0
      ? 'Extremely Long Lesson Plan Title That A Teacher Might Actually Type Because They Pasted The Whole Unit Objective Into The Field'
      : `${SUBJECTS[i % SUBJECTS.length]} — Week ${(i % 12) + 1}`,
    class_name: `Grade ${(i % 8) + 1}-${'ABC'[i % 3]}`,
    week_label: `2026-W${String((i % 12) + 1).padStart(2, '0')}`,
    period_count: 6,
    status,
    revision_note: null,
    ai_started_at: null,
    ai_failure_reason: status === 'ai_failed' ? 'Model returned malformed JSON after 2 retries' : null,
    created_at: new Date(Date.now() - i * 3600_000).toISOString(),
    updated_at: new Date(Date.now() - i * 3600_000).toISOString(),
    profiles: { name: TEACHERS[i % TEACHERS.length] },
  };
}

const PLANS: Row[] = Array.from({ length: N }, (_, i) => makePlan(i));

const CATEGORIES = ['objectives', 'engagement', 'differentiation', 'assessment', 'resources',
  'pacing', 'clarity', 'alignment', 'inclusion', 'rigor'];

function makeReview(planId: string): Row {
  const idx = Number(planId.split('-')[1]) || 0;
  // Spread across all four bands so every band gets visually verified.
  const percentage = [95, 82, 68, 41][idx % 4];
  return {
    id: `rev-${planId}`,
    plan_id: planId,
    percentage,
    performance_level: ['Excellent', 'Good', 'Fair', 'Poor'][idx % 4],
    executive_summary: LONG ? LOREM.repeat(14) : LOREM.repeat(2),
    scores: Object.fromEntries(CATEGORIES.map((c, i) => [c, {
      score: ((idx + i) % 5) + 1,
      explanation: LONG ? LOREM.repeat(4) : 'Adequately addressed with room to grow.',
    }])),
    strengths: Array.from({ length: LONG ? 8 : 3 }, (_, i) => `${LONG ? LOREM : ''}Strength number ${i + 1}.`),
    improvements: Array.from({ length: LONG ? 8 : 3 }, (_, i) => ({
      area: `Improvement area ${i + 1}`,
      why: LONG ? LOREM.repeat(3) : 'Students may disengage during the extended lecture segment.',
      recommendation: LONG ? LOREM.repeat(3) : 'Insert a two-minute pair-share after the demonstration.',
    })),
    supervisor_comment: LONG
      ? `Previous supervisor comment. ${LOREM.repeat(10)}`
      : null,
    additional_data: null,
    created_at: new Date().toISOString(),
  };
}

const PERIODS: Record<string, Row[]> = {};
function periodsFor(planId: string): Row[] {
  if (!PERIODS[planId]) {
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Sunday'];
    PERIODS[planId] = days.flatMap((day, d) =>
      Array.from({ length: LONG ? 6 : 3 }, (_, p) => ({
        id: `${planId}-${d}-${p}`,
        plan_id: planId,
        day,
        period_number: p + 1,
        subject: SUBJECTS[(d + p) % SUBJECTS.length],
        class_name: 'Grade 7-A',
        is_free: false,
        topic: LONG ? `Topic ${p + 1}. ${LOREM.repeat(3)}` : `Topic ${p + 1}: Photosynthesis basics`,
        objective: LONG ? LOREM.repeat(5) : 'Students will identify the inputs and outputs of photosynthesis.',
        slide_number: `${p + 10}`,
        details: [`Starter activity ${p + 1}`, 'Guided practice', 'Exit ticket'],
      })),
    );
  }
  return PERIODS[planId];
}

function table(name: string) {
  const builder: Row = {};
  const state: { name: string; id?: string; ids?: string[] } = { name };
  const api = {
    select: () => api,
    eq: (col: string, val: string) => { if (col === 'id' || col === 'plan_id') state.id = val; return api; },
    in: () => api,
    order: () => api,
    limit: () => api,
    maybeSingle: async () => resolve(),
    single: async () => resolve(),
    then: (res: (v: unknown) => void) => resolve().then(res),
  };
  async function resolve() {
    await wait(120);
    if (name === 'lesson_plans') {
      if (state.id) {
        const plan = PLANS.find((p) => p.id === state.id);
        return { data: plan ?? null, error: plan ? null : { message: 'not found' } };
      }
      return { data: PLANS, error: null };
    }
    if (name === 'lesson_plan_periods') return { data: periodsFor(state.id ?? 'plan-0'), error: null };
    if (name === 'ai_reviews') {
      const plan = PLANS.find((p) => p.id === state.id);
      if (!plan || plan.status === 'submitted' || plan.status === 'ai_failed') {
        return { data: null, error: null };
      }
      return { data: makeReview(state.id ?? 'plan-0'), error: null };
    }
    return { data: [], error: null };
  }
  Object.assign(builder, api);
  return api;
}

export const supabase = {
  from: (name: string) => table(name),

  async rpc(fn: string, args: Record<string, unknown>) {
    if (fn === 'expire_stuck_ai_reviews') return { data: null, error: null };

    if (fn === 'decide_lesson_plan_review' || fn === 'request_lesson_plan_revision') {
      await wait(LATENCY);
      if (FAIL) return { data: null, error: { message: 'Network request failed (simulated)' } };
      const plan = PLANS.find((p) => p.id === args.p_plan_id);
      if (!plan) return { data: null, error: { message: 'Lesson plan was not found.' } };
      plan.status = fn === 'request_lesson_plan_revision'
        ? 'revision_requested'
        : (args.p_status as string);
      if (fn === 'request_lesson_plan_revision') plan.revision_note = args.p_note ?? null;
      plan.updated_at = new Date().toISOString();
      // Count calls so the harness can assert "one transition per triple-click".
      const w = window as unknown as { __decisionCalls?: Record<string, number> };
      w.__decisionCalls = w.__decisionCalls ?? {};
      w.__decisionCalls[String(args.p_plan_id)] = (w.__decisionCalls[String(args.p_plan_id)] ?? 0) + 1;
      return { data: plan, error: null };
    }

    if (fn === 'get_lesson_period_ai_reviews') return { data: [], error: null };
    return { data: null, error: null };
  },

  functions: { invoke: async () => ({ data: null, error: null }) },

  channel: () => {
    const ch = { on: () => ch, subscribe: () => ch };
    return ch;
  },
  removeChannel: () => undefined,
};
