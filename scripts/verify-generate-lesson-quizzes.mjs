#!/usr/bin/env node
// Production-style verification for the generate-lesson-quizzes Edge Function.
//
// The Supabase Edge runtime (Deno) is unavailable offline, so this harness runs
// the REAL function source end-to-end under Node with three documented shims:
//   1. The Deno `serve` import is replaced by a local shim that starts a real
//      HTTP server on 0.0.0.0 (CORS, payload guards, and routing all execute).
//   2. `globalThis.Deno.env` provides GEMINI_API_KEY (+ optional diagnostics
//      flag), exactly as the Edge runtime would.
//   3. The Gemini endpoint constant is pointed at a local stub server that
//      speaks the same v1beta/interactions envelope, so provider HTTP calls,
//      envelope parsing, JSON parsing, repair, validation, and the targeted
//      retry all execute over real HTTP.
//
// Usage: node scripts/verify-generate-lesson-quizzes.mjs
//
import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'supabase/functions/generate-lesson-quizzes/index.ts');

// ── Local stub Gemini server (same envelope shape as v1beta/interactions) ──
const stubState = { responses: [], requests: [] };
const stubServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    stubState.requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    const next = stubState.responses.shift();
    if (next instanceof Error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'stub failure' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'interaction-stub',
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: next }] }],
    }));
  });
});
await new Promise((resolve) => stubServer.listen(0, '127.0.0.1', resolve));
const stubPort = stubServer.address().port;
const STUB_URL = `http://127.0.0.1:${stubPort}/v1beta/interactions`;

// ── Transpile the real function source with documented shim patches ────────
const raw = readFileSync(sourcePath, 'utf8');
let js = ts.transpileModule(raw, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const workDir = path.join(root, '.verify-tmp');
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
// Windows absolute paths (C:\...) are not valid URL schemes: go through pathToFileURL.
const shimUrl = pathToFileURL(path.join(workDir, 'serve-shim.mjs')).href;
js = js.replace('https://deno.land/std@0.224.0/http/server.ts', shimUrl);
// Point the provider at the local stub (verification-only patch of the copy).
js = js.replace(
  "const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';",
  `const GEMINI_API_URL = ${JSON.stringify(STUB_URL)};`,
);
if (js.includes('generativelanguage.googleapis.com') || js.includes('deno.land')) {
  throw new Error('Shim patch failed — refusing to run unpatched source.');
}

writeFileSync(path.join(workDir, 'serve-shim.mjs'), `
import http from 'node:http';
export function serve(handler) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const host = req.headers.host || 'localhost';
      const request = new Request('http://' + host + req.url, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const response = await handler(request);
      const buffer = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(buffer);
    });
  });
  server.listen(0, '0.0.0.0', () => { globalThis.__FUNCTION_PORT = server.address().port; });
}
`);
writeFileSync(path.join(workDir, 'function.mjs'), js);

globalThis.Deno = { env: { get: (name) => name === 'GEMINI_API_KEY' ? 'stub-key' : undefined } };
await import(pathToFileURL(path.join(workDir, 'function.mjs')).href);

// Wait for serve() to bind.
const functionPort = await new Promise((resolve, reject) => {
  const started = Date.now();
  (function poll() {
    if (globalThis.__FUNCTION_PORT) return resolve(globalThis.__FUNCTION_PORT);
    if (Date.now() - started > 5000) return reject(new Error('function server never started'));
    setTimeout(poll, 25);
  })();
});

// ── Console log capture for the observability checks ───────────────────────
const captured = [];
const originalError = console.error;
const originalConsoleLog = console.log;
console.error = (...args) => { captured.push(['error', ...args]); };
console.log = (...args) => { captured.push(['log', ...args]); };
console.warn = (...args) => { captured.push(['warn', ...args]); };

// ── Quiz fixtures ───────────────────────────────────────────────────────────
function fillerQuiz(variant) {
  const words = [
    'Mango', 'River', 'Lantern', 'Harbour', 'Cactus', 'Compass', 'Anvil', 'Pebble',
    'Meadow', 'Signal', 'Orchard', 'Thistle', 'Basalt', 'Lagoon', 'Summit', 'Drizzle',
    'Ember', 'Fjord', 'Grove', 'Hollow', 'Islet', 'Knoll', 'Marsh', 'Nimbus',
  ];
  const pick = (index) => words[(variant * 4 + index) % words.length];
  return {
    title: `Learning check ${variant}`,
    questions: [
      { type: 'multiple_choice', question: `Which meaning best fits the word "${pick(0)}" in set ${variant}?`, options: [`A calm ${pick(0)} scene`, `A loud ${pick(1)} scene`, `A wide ${pick(2)} field`, `A tall ${pick(3)} tower`], correctIndex: 0 },
      { type: 'multiple_choice', question: `Which sentence uses "${pick(1)}" correctly in set ${variant}?`, options: [`The ${pick(1)} shone over the bay`, `The ${pick(2)} ate its tail`, `The ${pick(3)} sang a note`, `The ${pick(0)} drove a car`], correctIndex: 0 },
      { type: 'multiple_choice', question: `Which pair belongs with "${pick(2)}" in set ${variant}?`, options: [`${pick(2)} and calm water`, `${pick(3)} and dry sand`, `${pick(0)} and sharp thorns`, `${pick(1)} and cold iron`], correctIndex: 0 },
      { type: 'direct_answer', question: `Explain in one sentence why "${pick(3)}" matters in set ${variant}.`, rubric: 'Award one point for a relevant reason and one for a clear example.' },
    ],
  };
}

function response(quizOne) {
  return JSON.stringify({ quizzes: [{ title: 'Learning check 1', questions: quizOne }, fillerQuiz(5), fillerQuiz(6)] });
}

const conceptualBad = response([
  { type: 'multiple_choice', question: 'What is the main purpose of photosynthesis?', options: ['Producing food for the plant', '12', '35', '100'], correctIndex: 0 },
  fillerQuiz(1).questions[0], fillerQuiz(1).questions[1], fillerQuiz(1).questions[3],
]);
const conceptualGood = response([
  { type: 'multiple_choice', question: 'What is the main purpose of photosynthesis?', options: ['Producing food for the plant', 'Absorbing sound', 'Creating gravity', 'Cooling the soil'], correctIndex: 0 },
  fillerQuiz(1).questions[0], fillerQuiz(1).questions[1], fillerQuiz(1).questions[3],
]);

const teacherDeliveryQuizOne = {
  title: 'Learning check 1',
  questions: [
    { type: 'multiple_choice', question: 'Which gas do plants absorb to make food?', options: ['Carbon dioxide', 'Oxygen', 'Nitrogen', 'Helium'], correctIndex: 0 },
    { type: 'multiple_choice', question: 'Which strategy should the teacher use to teach this concept?', options: ['A think-pair-share discussion', 'A silent test', 'A field trip', 'A film night'], correctIndex: 0 },
    { type: 'multiple_choice', question: 'Which part of the plant takes in water?', options: ['Roots', 'Leaves', 'Flowers', 'Seeds'], correctIndex: 0 },
    { type: 'direct_answer', question: 'Explain why sunlight matters to plants.', rubric: 'Award one point for energy for food-making and one for a clear example.' },
  ],
};
const forbiddenFirst = JSON.stringify({ quizzes: [teacherDeliveryQuizOne, fillerQuiz(5), fillerQuiz(6)] });
const forbiddenAlways = JSON.stringify({
  quizzes: [
    { ...teacherDeliveryQuizOne, title: 'Learning check 1', questions: teacherDeliveryQuizOne.questions.map((q, i) => i === 1 ? q : { ...q, question: q.question }) },
    fillerQuiz(5),
    fillerQuiz(6),
  ].map((quiz, index) => index === 0 ? { ...quiz, questions: [...quiz.questions.slice(0, 1), teacherDeliveryQuizOne.questions[1], ...quiz.questions.slice(2)] } : quiz),
});

const duplicateSetQuizOne = {
  title: 'Learning check 1',
  questions: [
    { type: 'multiple_choice', question: 'Which gas do plants absorb to make food?', options: ['Carbon dioxide', 'Oxygen', 'Nitrogen', 'Helium'], correctIndex: 0 },
    { type: 'multiple_choice', question: 'Which part of the plant takes in water?', options: ['Roots', 'Leaves', 'Flowers', 'Stems'], correctIndex: 0 },
    { type: 'multiple_choice', question: 'What is the main idea of the passage?', options: ['The coast changes slowly over time', 'Fish live near reefs', 'Boats carry goods', 'Tides follow the moon'], correctIndex: 0 },
    { type: 'direct_answer', question: 'Explain why sunlight matters to plants.', rubric: 'Award one point for energy for food-making and one for a clear example.' },
  ],
};
// quizzes[1].questions[2] reuses quizzes[0].questions[0]'s option set — the
// exact production DUPLICATE_ANSWER_SET path.
const duplicateSetFirst = JSON.stringify({
  quizzes: [
    duplicateSetQuizOne,
    {
      title: 'Learning check 2',
      questions: [
        fillerQuiz(2).questions[0],
        fillerQuiz(2).questions[1],
        { type: 'multiple_choice', question: 'Which gas do people breathe out most?', options: ['Carbon dioxide', 'Oxygen', 'Nitrogen', 'Helium'], correctIndex: 0 },
        { type: 'direct_answer', question: 'Explain in one sentence why breathing matters.', rubric: 'Award one point for a relevant reason and one for clear wording.' },
      ],
    },
    fillerQuiz(7),
  ],
});
const duplicateSetFixed = JSON.stringify({
  quizzes: [
    duplicateSetQuizOne,
    {
      title: 'Learning check 2',
      questions: [
        fillerQuiz(2).questions[0],
        fillerQuiz(2).questions[1],
        { type: 'multiple_choice', question: 'Which gas do people breathe out most?', options: ['Mostly nitrogen', 'Mostly argon', 'Mostly helium', 'Mostly hydrogen'], correctIndex: 0 },
        { type: 'direct_answer', question: 'Explain in one sentence why breathing matters.', rubric: 'Award one point for a relevant reason and one for clear wording.' },
      ],
    },
    fillerQuiz(7),
  ],
});

const scenarios = [
  { name: 'retry after NUMERIC_DISTRACTOR', stubs: [conceptualBad, conceptualGood] },
  {
    name: 'retry after FORBIDDEN_CONTEXT',
    stubs: [forbiddenFirst, conceptualGood],
    expectHttp: 200,
    expectFirstCode: 'FORBIDDEN_CONTEXT',
    expectFirstPath: 'quizzes[0].questions[1]',
    expectRetryContains: 'teacher-facing or instructional-delivery question',
  },
  {
    name: 'persistent FORBIDDEN_CONTEXT fails clearly',
    stubs: [forbiddenAlways, forbiddenAlways],
    expectHttp: 502,
    expectFirstCode: 'FORBIDDEN_CONTEXT',
    expectBodyCode: 'FORBIDDEN_CONTEXT',
    mustNotMention: 'duplicate',
  },
  {
    name: 'targeted repair after DUPLICATE_ANSWER_SET',
    stubs: [duplicateSetFirst, duplicateSetFixed],
    expectHttp: 200,
    expectFirstCode: 'DUPLICATE_ANSWER_SET',
    expectFirstPath: 'quizzes[1].questions[2].options',
    expectRetryContains: 'TARGETED REPAIR',
  },
  {
    name: 'persistent DUPLICATE_ANSWER_SET fails clearly',
    stubs: [duplicateSetFirst, duplicateSetFirst],
    expectHttp: 502,
    expectFirstCode: 'DUPLICATE_ANSWER_SET',
    expectBodyCode: 'DUPLICATE_ANSWER_SET',
    mustNotMention: 'carbon dioxide',
  },
  { name: 'math calculations', stubs: [response([
    { type: 'multiple_choice', question: 'What is 8 × 7?', options: ['54', '56', '58', '64'], correctIndex: 1 },
    { type: 'multiple_choice', question: 'What is 45 + 38?', options: ['73', '83', '87', '93'], correctIndex: 1 },
    { type: 'multiple_choice', question: 'Which number is 6 more than 27?', options: ['21', '31', '33', '34'], correctIndex: 2 },
    { type: 'direct_answer', question: 'Calculate 12 × 8.', rubric: 'Award one mark for the product 96 and one for the method.' },
  ])] },
  { name: 'english vocabulary', stubs: [response([
    { type: 'multiple_choice', question: 'Which word means the opposite of ancient?', options: ['Modern', 'Old', 'Aged', 'Antique'], correctIndex: 0 },
    { type: 'multiple_choice', question: 'Which sentence uses the past tense?', options: ['She walked home', 'She walks home', 'She will walk home', 'She walking home'], correctIndex: 0 },
    { type: 'multiple_choice', question: 'Which word is a noun?', options: ['harbour', 'quickly', 'bright', 'gently'], correctIndex: 0 },
    { type: 'direct_answer', question: 'Write one sentence using the word ancient.', rubric: 'Award one point for correct meaning and one for a complete sentence.' },
  ])] },
  { name: 'science mixed units', stubs: [response([
    { type: 'multiple_choice', question: 'What is the main purpose of photosynthesis?', options: ['Producing food for the plant', 'Absorbing sound', 'Creating gravity', 'Cooling the soil'], correctIndex: 0 },
    { type: 'multiple_choice', question: 'How long does Earth take to orbit the Sun?', options: ['365 days', '30 days', '24 hours', '1 year'], correctIndex: 0 },
    { type: 'multiple_choice', question: 'At what temperature does water boil at sea level?', options: ['100°C', '90°C', '80°C', '50°C'], correctIndex: 0 },
    { type: 'direct_answer', question: 'Explain evaporation in your own words.', rubric: 'Award one point for liquid to gas and one for an example.' },
  ])] },
  { name: 'history dates', stubs: [response([
    { type: 'multiple_choice', question: 'When did World War II end?', options: ['1945', '1939', '1918', '1950'], correctIndex: 0 },
    { type: 'multiple_choice', question: 'Which statement about 1939 is correct?', options: ['World War II began in 1939', 'The moon landing happened in 1939', 'The Titanic sank in 1939', 'The Berlin Wall fell in 1939'], correctIndex: 0 },
    { type: 'multiple_choice', question: 'Who led Britain during most of World War II?', options: ['Winston Churchill', 'Napoleon', 'Julius Caesar', 'Nelson Mandela'], correctIndex: 0 },
    { type: 'direct_answer', question: 'Explain why dates help us study the past.', rubric: 'Award one point for ordering events and one for an example.' },
  ])] },
  { name: 'fractions and decimals', stubs: [response([
    { type: 'multiple_choice', question: 'Which fraction equals 0.75?', options: ['3/4', '2/3', '1/2', '4/5'], correctIndex: 0 },
    { type: 'multiple_choice', question: 'What fraction of the shape is shaded?', options: ['2/5', '1/5', '3/5', '4/5'], correctIndex: 0 },
    { type: 'multiple_choice', question: 'Which decimal is the greatest?', options: ['0.9', '0.09', '0.19', '0.099'], correctIndex: 0 },
    { type: 'direct_answer', question: 'Explain how to compare two fractions.', rubric: 'Award one point for a common method and one for an example.' },
  ])] },
  { name: 'percentages', stubs: [response([
    { type: 'multiple_choice', question: 'What is 25% of 80?', options: ['10%', '20%', '25%', '30%'], correctIndex: 1 },
    { type: 'multiple_choice', question: 'Which percentage is the largest?', options: ['45%', '5%', '0.5%', '95%'], correctIndex: 3 },
    { type: 'multiple_choice', question: 'Which decimal equals 50 percent?', options: ['0.5', '0.05', '0.25', '0.75'], correctIndex: 0 },
    { type: 'direct_answer', question: 'Explain what a percentage shows.', rubric: 'Award one point for parts per hundred and one for an example.' },
  ])] },
  { name: 'monetary values', stubs: [response([
    { type: 'multiple_choice', question: 'How much did the item cost?', options: ['$5', '$10', '$15', '$20'], correctIndex: 0 },
    { type: 'multiple_choice', question: 'What is the price of two notebooks?', options: ['8 USD', '12 USD', '16 USD', '20 USD'], correctIndex: 2 },
    { type: 'multiple_choice', question: 'Which amount is greatest?', options: ['$40', '$14', '$25', '$31'], correctIndex: 0 },
    { type: 'direct_answer', question: 'Explain how to check change after buying two items.', rubric: 'Award one point for adding first and one for subtracting from the amount paid.' },
  ])] },
  { name: 'measurement approximations', stubs: [response([
    { type: 'multiple_choice', question: 'About how many millilitres are in one litre?', options: ['about 100', 'about 500', 'about 1000', 'about 1500'], correctIndex: 2 },
    { type: 'multiple_choice', question: 'Which measurement is the longest?', options: ['1 km', '100 m', '10 cm', '1 m'], correctIndex: 0 },
    { type: 'multiple_choice', question: 'Which mass is the greatest?', options: ['5 kg', '500 g', '50 g', '2 kg'], correctIndex: 0 },
    { type: 'direct_answer', question: 'Explain why units matter when measuring.', rubric: 'Award one point for a clear reason and one for an example.' },
  ])] },
];

// ── Execute each scenario over real HTTP ────────────────────────────────────
const payloadFor = (subject, title, objective) => ({
  plan: { class_name: 'Grade 6B', grade: '6', title, objective, vocabulary: ['concept', 'example'] },
  subject,
  periods: [{ subject, topic: title, objective }],
  quiz_count: 3,
  questions_per_quiz: 4,
  direct_answer_min: 1,
});

const rows = [];
let failures = 0;

const preflight = await fetch(`http://127.0.0.1:${functionPort}/generate-lesson-quizzes`, { method: 'OPTIONS' });
rows.push({ scenario: 'CORS preflight', http: preflight.status, ok: preflight.status === 204 });

for (const scenario of scenarios) {
  stubState.responses = [...scenario.stubs];
  stubState.requests = [];
  const startedAt = Date.now();
  const result = await fetch(`http://127.0.0.1:${functionPort}/generate-lesson-quizzes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payloadFor('Science', 'Photosynthesis and the water cycle', 'Explain photosynthesis and the water cycle')),
  });
  const body = await result.json();
  const executionMs = Date.now() - startedAt;

  const validationLogs = captured
    .filter(([level, label]) => label === '[generate-lesson-quizzes] validation metadata')
    .map(([, , meta]) => meta);
  const first = validationLogs[0] || {};

  const expectedHttp = scenario.expectHttp ?? 200;
  const lastCode = validationLogs.at(-1)?.validationErrorCode ?? null;
  const ok = result.status === expectedHttp
    && (expectedHttp === 502 || (Array.isArray(body.quizzes) && body.quizzes.length === 3
      && body.quizzes.every((q) => q.questions.length === 4)
      && validationLogs.at(-1)?.validationResult === 'passed'))
    && (!scenario.expectFirstCode || first.validationErrorCode === scenario.expectFirstCode)
    && (!scenario.expectFirstPath || first.validationPath === scenario.expectFirstPath)
    && (!scenario.expectBodyCode || body.validationErrorCode === scenario.expectBodyCode)
    && (!scenario.expectRetryContains || stubState.requests[1]?.body?.input?.includes(scenario.expectRetryContains) === true)
    && (!scenario.mustNotMention
      || JSON.stringify({ logs: validationLogs, body }).toLowerCase().includes(scenario.mustNotMention) === false)
    && first.promptChars < 6000
    && stubState.requests.length === scenario.stubs.length
    && (scenario.name === 'retry after NUMERIC_DISTRACTOR'
      ? stubState.requests[1]?.body?.input?.includes('NUMERIC_DISTRACTOR') === true
      : true);
  if (!ok) failures += 1;
  rows.push({
    scenario: scenario.name,
    http: result.status,
    attempts: stubState.requests.length,
    validationResult: validationLogs.at(-1)?.validationResult ?? null,
    firstAttemptCode: first.validationErrorCode ?? null,
    firstAttemptPath: first.validationPath ?? null,
    finalCode: expectedHttp === 502 ? (body.validationErrorCode ?? lastCode) : null,
    promptChars: first.promptChars ?? null,
    latencyMs: first.latencyMs ?? null,
    executionMs,
    ok,
  });
  captured.length = 0;
}

// Restore the real console before printing the results table.
console.error = originalError;
console.log = originalConsoleLog;
console.table(rows.map((r) => ({ ...r })));
originalError(
  `verification ${failures === 0 ? 'PASSED' : 'FAILED'}: ${rows.length - failures - 1}/${rows.length - 1} scenarios ok`,
);
stubServer.close();
rmSync(workDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
