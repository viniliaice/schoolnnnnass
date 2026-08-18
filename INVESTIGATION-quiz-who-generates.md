# /investigate: who generates quizzes, and why the Edge log failed

Skill: gstack `/investigate` (cloned to `~/.claude/skills/gstack`; `./setup` did not finish — bun missing).
Branch: `arena/01a01532-schoolnnnnass` @ `8fe8cf6`.
Iron law: no fix in this pass. Root cause only.

---

## Symptoms

1. You described the product as: teacher submits a plan → AI writes the review → **only the supervisor** generates quizzes for that teacher’s students.
2. Hosted `generate-lesson-quizzes` logs show one Gemini 3.6 success and one later call where both Gemini models returned a 3×4 JSON object that then failed validation (`INVALID_QUIZ_RESPONSE`).

## Phase 1 — what the code actually does

Teacher submit (`src/lib/db/lessonPlans.ts:272-276`) fire-and-forgets `generateLessonPlanQuizzes(planId)` immediately after the submit RPC. That is not supervisor-gated. Baseline `b950a74` already awaited quizzes after submit; this branch only made it non-blocking.

The teacher “My Lesson Plans” screen (`src/pages/teacher/SubmittedPlansView.tsx:318-395`) shows Student quizzes, Generate, and Redo. Added on this branch.

The supervisor screen (`src/pages/supervisor/LessonPlanReview.tsx`) also generates quizzes.

`generateLessonPlanQuizzes` (`src/lib/db/lessonPlanQuizzes.ts:248-251`) calls the Edge function **once per distinct period subject**, sequentially, from the **browser** `supabase.functions.invoke`.

## Phase 2 — log reconstruction

Same `function_id` = `generate-lesson-quizzes`. Four isolate boots, two POSTs:

| execution_id | what | when |
|---|---|---|
| `8ad7cc56` | boot + listen, **no quiz log** | same ms as success boot |
| `bfab4bd5` | Gemini 3.6, 3×4, **passed**, 22.8s | first real POST |
| `bd565bd0` | boot + listen, **no quiz log** | same ms as fail boot |
| `d8aba8c1` | 3.6 then 3.5-lite, both 3×4 JSON, **quality failed**, 21.0s | second real POST |

Empty boots match `OPTIONS` (`index.ts:1004` returns 204 with no log). Browser invoke sends CORS preflight + POST. Two subjects = two invokes = four boots. Timing (success, then ~3s later a second POST) matches the sequential `for (const subject of subjects)` loop.

This is **not** OpenRouter. Both POSTs used `gemini-3.6-flash` / `gemini-3.5-flash-lite`.

## Phase 3 — hypotheses

**H1 (confirmed): your intended flow is not implemented.**
Teachers trigger quiz generation on submit and can generate/preview quizzes. Supervisors can too. Evidence: call sites above.

**H2 (confirmed): the failed POST is quality reject, not a dead provider.**
Both models: `httpStatus: 200`, `validJson: true`, `quizCount: 3`, `questionCounts: [4,4,4]`, then `validationResult: "failed"` / `INVALID_QUIZ_RESPONSE`. Shape passed. Semantic rules did not.

**H3 (confirmed): the real reject reason is thrown away.**
`attemptGenerationWithValidation` (`index.ts:992-995`) catches the validator error and replaces it with a generic `Quiz generation returned invalid structured output`. Logs never print the rule (forbidden word, arithmetic, duplicate stem, truncation). So this dump cannot name the exact rule.

**H4 (likely, not proven): second subject is harder for the quality gate.**
First subject passed on 3.6. Second subject failed 3.6 and lite with the same 3×4 shape. Common tripwires: `\bpage\b`, `\btable\b`, `\bresource`, `\bdiagram`, `\bactivity`, arithmetic `correctIndex` mismatch, option ending in `...`. Need the rejected payload or a `validationError.message` field to prove which one.

**H5 (confirmed, secondary): one failed subject aborts the whole replace.**
The subject loop awaits each invoke, then one RPC `replace_generated_lesson_plan_quizzes`. If subject 2 throws, subject 1’s quizzes are never written. User can see a success log and still get no (or stale) quizzes.

## Root cause hypothesis

Two stacked issues, not one:

1. **Product:** quiz generation is teacher-submit + teacher-UI + supervisor-UI. Your rule is supervisor-only after review.
2. **Runtime fail in the log:** Gemini returned a well-shaped 3×4 set; server-side `validateQuizQuality` rejected it; the catch block hid the rule name. Likely the second subject in an auto-submit (or supervisor) loop.

## What I did not do

No code change. `/investigate` iron law: no fix without a confirmed root cause *and* an agreed fix. H4 still needs the discarded validator message.

## What a fix would be (not applied)

If you confirm the product rule:

- Remove `void generateLessonPlanQuizzes` from `submitForReview`.
- Remove quiz preview/generate from `SubmittedPlansView`.
- Leave generate/redo only on `LessonPlanReview`.
- Log `validationError.message` (not question text) so the next 502 names the rule.

## Status

**DONE_WITH_CONCERNS** — product mismatch and log failure are explained from source + your dump. The exact quality rule for the failed subject is still unknown because the function deletes that string.
