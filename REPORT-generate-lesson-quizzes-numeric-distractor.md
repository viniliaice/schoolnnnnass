# REPORT — Fix `NUMERIC_DISTRACTOR` failures in `generate-lesson-quizzes`

Production signature: `gemini-3.6-flash` / `gemini-3.5-flash-lite`, `httpStatus: 200`,
`validJson: true`, `quizCount: 3`, `questionCounts: [4,4,4]`, `validationResult: failed`,
`validationErrorCode: NUMERIC_DISTRACTOR` → `[generate-lesson-quizzes] failed all providers`
→ `INVALID_QUIZ_RESPONSE`.

---

## ROOT CAUSE

The provider never failed. `validateNumericOptions` in
`supabase/functions/generate-lesson-quizzes/index.ts` applied a **purely syntactic,
all-or-nothing rule** that never looked at which option was the **correct answer**:

1. **"Mix" rule** — if *some but not all* options parsed as numeric → fail. But
   `parseNumericOption` only understood `number`, `number+unit`, `%`, and `$£€`
   prefixes. Perfectly valid numeric option sets were seen as "mixes" because the
   parser could not read:
   - **fractions**: `2/5`, `1/2`, `3/4` → `["0.75", "1/2", "2/3", "1/4"]` failed
   - **approximations**: `about 100`, `at least 5`
   - **suffixed/coded currency**: `10$`, `15 USD`
   - **space-separated thousands**: `10 000`, leading-dot decimals `.75`
2. **Exact-kind rule** — all-numeric sets had to share one identical `kind` string.
   Legitimately comparable measurement questions failed:
   `["365 days", "30 days", "24 hours", "1 year"]` → kinds `unit:days`/`unit:hours`/`unit:year`
   → *"numeric distractors must use the same value type"*.
3. **No semantics** — the rule could not distinguish *numeric question with numeric
   distractors (valid)* from *conceptual question with numeric distractors (invalid)*.
   Combined with a prompt that never stated a distractor-typing policy, both Gemini
   models reproduced the same shapes on every retry (identical prompt) → both attempts
   failed → `INVALID_QUIZ_RESPONSE`.

Reproduced before the fix (temporary harness, since deleted):

```
fraction + decimal options: FAIL NUMERIC_DISTRACTOR     ← false positive
mixed measurement units:   FAIL NUMERIC_DISTRACTOR     ← false positive
CONCEPTUAL + 45/100/27:    FAIL NUMERIC_DISTRACTOR     ← intended
```

A second latent validator bug of the same family was found and fixed:
`parseArithmeticExpression` treated `"What is 3/4 of 12?"` as `3 ÷ 4 = 0.75` and then
failed the response with `ARITHMETIC_ANSWER` because no option equalled `0.75`
(the real answer is `9`). `"25% of 80"` phrasings are skipped likewise.

## FILES CHANGED

| File | Change |
| --- | --- |
| `supabase/functions/generate-lesson-quizzes/index.ts` | validator semantics, parser, repair layer, retry corrections, failure phases, paths, diagnostics |
| `src/lib/quizGenerationValidation.ts` | mirrored validator semantics (client-side twin used by `lessonPlanQuizzes.ts`) |
| `src/lib/__tests__/generate-lesson-quizzes-numeric-distractor.test.ts` | new: 28 tests (validator units, prompt contract, repair, retry, observability, integration) |
| `scripts/verify-generate-lesson-quizzes.mjs` | new: end-to-end verification harness (real function source over HTTP, stub Gemini) |
| `.gitignore` | ignore the harness scratch dir `.verify-tmp/` |

No changes to auth, DB schema, RLS, other Edge Functions, parent portal, or lesson-plan workflows.

## CODE CHANGES

- **`validateNumericOptions` (edge + mirror)** — rewritten to decide numeric-vs-conceptual
  from the correct answer (see VALIDATOR CHANGES). Option-level `validationPath`s on every
  failure branch.
- **`parseNumericOption`** — extended numeric grammar (see VALIDATOR CHANGES).
- **`compatibleNumericKinds`** (new) — unit-to-unit comparison allowed; percent/currency
  stay exclusive.
- **`parseArithmeticExpression`** — skips `a/b of c` / `a% of c` multiplicative phrasings.
- **`repairQuizCandidate`** (new, Step 7) — deterministic, meaning-preserving normalization
  **before** validation: collapse/trim whitespace, stringify finite numeric JSON options
  (`10` → `"10"`), map `correctIndex` strings (`"B"`, `"1"` → 1), drop empty `options`
  arrays on direct-answer questions. Never invents, reorders, or edits content; the
  repaired candidate is still fully validated; applied repairs are logged.
- **Retry loop (Step 8)** — `attemptGenerationWithValidation` takes a strategy
  (`initial` | `targeted_retry`). After a validation failure the request remembers the
  allowlisted error code; the fallback model's prompt gets that code's targeted
  correction appended (bounded by `buildRetryPrompt` within the 8,000-char hard cap).
  Transport failures (429/timeout/bad envelope) keep the identical prompt.
- **Failure phases (Steps 9/14)** — `FailurePhase` classification on every failure log;
  the wrapper error keeps `code: INVALID_QUIZ_RESPONSE` publicly but carries
  `validationErrorCode`, `validationPath`, `failurePhase` internally for logs and retry.
- **Diagnostics (Steps 3/10)** — validation metadata now records `validationPath`,
  `failurePhase`, and `repairs`. `QUIZ_DEBUG_DIAGNOSTICS=1|true|yes` (off by default)
  additionally logs `questionIndex`, `choiceIndex`, `questionType`, and bounded
  (≤120/80 char) `question`/`correctAnswer`/`distractor` for staging diagnosis.

## VALIDATOR CHANGES

Exact semantic rule now used (`validateNumericOptions`):

1. Parse all 4 options with the extended numeric grammar. None numeric → pass
   (nothing numeric to police).
2. **If the CORRECT ANSWER is non-numeric** (conceptual/definition question) and any
   distractor is a bare numeric token → **NUMERIC_DISTRACTOR** at that option's path.
   (`"What is evaporation?" → 45/100/27` still fails.)
3. **If the correct answer is numeric** (genuinely numeric/calculation/date/quantity/
   price/percentage question): numeric distractors are allowed; the set must be
   *all* numeric (a word-number/prose distractor among numbers is still
   "malformed numeric distractors"), pairwise type-compatible, and duplicate-free
   among identical kinds (so `0.5` vs `1/2` still fails as duplicate values).
4. Type compatibility: plain numbers and fractions are one type; any concrete units may
   be compared (`1 km`/`100 m`/`10 cm`/`1 m` passes); percent and each currency are
   exclusive types (`['13%','12%','14','15%']` still fails "same value type").
5. Numeric grammar accepted: `12`, `3.5`, `0.75`, `.75`, `010`, `10.0`, `25%`, `50 percent`,
   `$15`, `10$`, `15 USD`, `2/5`, `1 1/2`, `-3`, `1,200`, `10 000`, `45°`, `100°C`,
   `10 apples`, `about 100`, `at least 5`. Not numeric: `ten`, `fourteen`, or any sentence
   that merely contains a number (`"World War II began in 1939"`).

All other validation is untouched: required fields, quiz/question counts, 3×MC+1×DA
order, 4 non-empty distinct options, correctIndex range, rubric shape, duplicates,
placeholders/truncation, forbidden lesson-delivery context, arithmetic answer integrity.

## GENERATION PROMPT CHANGES

- Added one compact rule (≈500 chars) to the instruction block:
  *"Distractor typing (decide from the question)…"* — numeric questions get all-numeric
  options in one shared type (`7 + 5 → 10, 11, 12, 13`; cost → `$5…$20`); conceptual
  questions get meaningful non-numeric alternatives — never a bare number.
- `system_instruction` extended with the same one-line policy (keeps the schema-conforming phrase).
- Budgets unchanged: `maxTokens` still **1800**; default prompt ≈ **3.5–4.1k chars**
  (< 6,000 target, ≤ 8,000 hard); retry prompt ≤ 8,000 via context re-truncation.
  Nothing was added that materially increases latency.

## RETRY CHANGES

- `TARGETED_RETRY_CORRECTIONS` maps **every** validation code to a short correction;
  the `NUMERIC_DISTRACTOR` one follows the required text (numeric options only for
  genuinely numeric questions; plausible non-numeric alternatives for conceptual/
  vocabulary/reading/science/history/definition questions; JSON only).
- Applied only to retries after a **validation** failure, never after transport failures.
- Strategy is logged (`initial` vs `targeted_retry`) and the retry request body verifiably
  contains the correction.

## TEST RESULTS

| Gate | Result |
| --- | --- |
| `tsc --noEmit` | **PASS** (no new errors) |
| Full suite `vitest --run` | **495 / 495 PASS** (467 pre-existing + 28 new; zero regressions) |
| `vite build` | **PASS** |
| `node scripts/verify-generate-lesson-quizzes.mjs` | **9 / 9 PASS** |

New tests include the required cases: valid `8 × 7` arithmetic **PASS**; valid conceptual
evaporation **PASS**; conceptual + `45/100/27` **FAIL NUMERIC_DISTRACTOR**;
dates-in-text and year-only options **PASS**; `$5…$20` **PASS**; `25% of 80 →
10%/20%/25%/30%` **PASS**; fractions/mixed-units/approximations **PASS**; broken sets
(word-number mix, percent/number mix, duplicate values, `0.5` vs `1/2`) still **FAIL**;
arithmetic index integrity kept; `3/4 of 12 → 9` no longer mis-solved.

## PRODUCTION VERIFICATION

(Deno/Supabase runtime and live Gemini are unreachable offline, so verification runs the
**real function source** over real HTTP with a local stub speaking the identical
`v1beta/interactions` envelope — only the endpoint constant of the throwaway copy is patched.)

| Scenario | HTTP | Attempts | First-attempt code / path | Result |
| --- | --- | --- | --- | --- |
| CORS preflight | 204 | – | – | PASS |
| retry after NUMERIC_DISTRACTOR | **200** | 2 | `NUMERIC_DISTRACTOR @ quizzes[0].questions[0].options[1]` | attempt 2 = `targeted_retry`, validation **passed** |
| math calculations | **200** | 1 | – | JSON ✓ schema ✓ semantic ✓ |
| english vocabulary | **200** | 1 | – | ✓ |
| science (mixed units) | **200** | 1 | – | ✓ |
| history (dates) | **200** | 1 | – | ✓ |
| fractions & decimals | **200** | 1 | – | ✓ |
| percentages | **200** | 1 | – | ✓ |
| monetary values | **200** | 1 | – | ✓ |
| measurement approximations | **200** | 1 | – | ✓ |

Measured during verification: `promptChars ≈ 4107` (< 6000), `maxTokens 1800`, stub
latency 1–4 ms, full request 3–20 ms wall clock (production Gemini latency of ~8–14 s
per attempt is provider-bound and unchanged). On failure paths the logs now say exactly
which stage broke: `PROVIDER_REQUEST_FAILED` (429/timeout), `PROVIDER_RESPONSE_INVALID`
(bad envelope/JSON), `QUIZ_SCHEMA_INVALID` (shape), `QUIZ_SEMANTIC_INVALID`
(NUMERIC_DISTRACTOR & friends) — a provider returning HTTP 200 + valid JSON is never
reported as a provider request failure.
