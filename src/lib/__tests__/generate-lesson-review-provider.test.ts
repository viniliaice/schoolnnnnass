import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('https://esm.sh/@supabase/supabase-js@2.99.3', () => ({
  createClient: vi.fn(),
}));

interface ReviewProviderModule {
  buildProviderRoutes: (geminiApiKey?: string) => Array<{
    provider: 'gemini';
    url: string;
    model: string;
    apiKey: string | undefined;
    secretName: 'GEMINI_API_KEY';
  }>;
  callLLM: (
    prompt: string,
    route: ReturnType<ReviewProviderModule['buildProviderRoutes']>[number],
    signal: AbortSignal,
  ) => Promise<{ result: unknown; usage: { input_tokens: number; output_tokens: number } }>;
  callLLMWithRetry: (
    prompt: string,
    route: ReturnType<ReviewProviderModule['buildProviderRoutes']>[number],
    onRetry: () => void,
  ) => Promise<{ result: unknown; usage: { input_tokens: number; output_tokens: number } }>;
  isRetriableStatus: (status: number) => boolean;
}

let providerModule: ReviewProviderModule;

const validReview = {
  schema_version: 1,
  executive_summary: 'A complete review.',
  category_scores: {
    curriculum_alignment: { score: 4, explanation: 'Aligned.' },
  },
  total_score: 40,
  percentage: 80,
  performance_level: 'Very Good',
  score_explanation: 'Strong overall.',
  strengths: ['Clear objective'],
  improvements: [],
  supervisor_notes: { status_recommendation: 'Ready', reasoning: 'Complete.' },
  period_reviews: [],
};

function geminiEnvelope(review: unknown = validReview) {
  return {
    status: 'completed',
    steps: [
      { type: 'thought', content: [{ type: 'text', text: 'must not be parsed' }] },
      { type: 'model_output', content: [{ type: 'text', text: JSON.stringify(review) }] },
    ],
    usage: { input_tokens: 130, output_tokens: 90 },
  };
}

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    serve: vi.fn(),
    env: { get: vi.fn() },
  });
  const moduleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  providerModule = await import('../../../supabase/functions/generate-lesson-review/index');
  expect(moduleLogSpy).toHaveBeenCalledWith('[generate-lesson-review] module initialized');
  moduleLogSpy.mockRestore();
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('generate-lesson-review provider layer', () => {
  it('registers without top-level secret reads and records receipt before OPTIONS handling', async () => {
    const deno = (globalThis as any).Deno;
    expect(deno.serve).toHaveBeenCalledOnce();
    expect(deno.env.get).not.toHaveBeenCalled();

    const handler = deno.serve.mock.calls[0][0] as (request: Request) => Promise<Response>;
    const response = await handler(new Request('https://example.test/generate-lesson-review', {
      method: 'OPTIONS',
    }));

    expect(response.status).toBe(204);
    expect(console.log).toHaveBeenCalledWith(
      '[generate-lesson-review] lifecycle',
      { phase: 'received', method: 'OPTIONS', hasAuthorizationHeader: false },
    );
    expect(deno.env.get).not.toHaveBeenCalled();
  });

  it('builds Gemini 3.6 → Gemini 3.5 Lite in fixed order with no OpenRouter route', () => {
    expect(providerModule.buildProviderRoutes('gemini-key')).toEqual([
      {
        provider: 'gemini',
        url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
        model: 'gemini-3.6-flash',
        apiKey: 'gemini-key',
        secretName: 'GEMINI_API_KEY',
      },
      {
        provider: 'gemini',
        url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
        model: 'gemini-3.5-flash-lite',
        apiKey: 'gemini-key',
        secretName: 'GEMINI_API_KEY',
      },
    ]);
  });

  it('uses Gemini Interactions and logs request, response, validation, and per-attempt success metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(geminiEnvelope()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const route = providerModule.buildProviderRoutes('gemini-key')[0];

    const output = await providerModule.callLLM('EXACT REVIEW PROMPT', route, new AbortController().signal);

    expect(output.result).toEqual(validReview);
    expect(output.usage).toEqual({ input_tokens: 130, output_tokens: 90 });
    expect(fetchMock.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body).toEqual(expect.objectContaining({
      model: 'gemini-3.6-flash',
      input: 'EXACT REVIEW PROMPT',
      generation_config: {
        max_output_tokens: 16384,
        thinking_level: 'minimal',
      },
    }));
    expect(body.system_instruction).toContain('You are an expert instructional coach');
    expect(JSON.stringify(output)).not.toContain('must not be parsed');
    expect(request.headers).toEqual({
      'Content-Type': 'application/json',
      'x-goog-api-key': 'gemini-key',
    });

    expect(console.log).toHaveBeenCalledWith(
      '[generate-lesson-review] provider request',
      expect.objectContaining({
        provider: 'gemini',
        model: 'gemini-3.6-flash',
        strategy: 'initial',
        attempt: 1,
        promptChars: 19,
        maxTokens: 16384,
      }),
    );
    expect(console.log).toHaveBeenCalledWith(
      '[generate-lesson-review] provider response metadata',
      expect.objectContaining({
        provider: 'gemini',
        model: 'gemini-3.6-flash',
        attempt: 1,
        httpStatus: 200,
        responseChars: expect.any(Number),
        responseBytes: expect.any(Number),
        latencyMs: expect.any(Number),
      }),
    );
    expect(console.log).toHaveBeenCalledWith(
      '[generate-lesson-review] validation metadata',
      expect.objectContaining({
        provider: 'gemini',
        model: 'gemini-3.6-flash',
        attempt: 1,
        validJson: true,
        validationResult: 'passed',
        categoryCount: 1,
        periodReviewCount: 0,
      }),
    );
    expect(console.log).toHaveBeenCalledWith(
      '[generate-lesson-review] provider attempt succeeded',
      expect.objectContaining({
        provider: 'gemini',
        model: 'gemini-3.6-flash',
        attempt: 1,
        httpStatus: 200,
        inputTokens: 130,
        outputTokens: 90,
      }),
    );
    expect(console.log).toHaveBeenCalledWith(
      '[generate-lesson-review] lifecycle',
      expect.objectContaining({
        phase: 'provider-started',
        provider: 'gemini',
        model: 'gemini-3.6-flash',
      }),
    );
    expect(console.log).toHaveBeenCalledWith(
      '[generate-lesson-review] lifecycle',
      expect.objectContaining({
        phase: 'provider-finished',
        provider: 'gemini',
        model: 'gemini-3.6-flash',
        httpStatus: 200,
      }),
    );
    expect(console.log).toHaveBeenCalledWith(
      '[generate-lesson-review] lifecycle',
      expect.objectContaining({
        phase: 'validation',
        provider: 'gemini',
        result: 'passed',
      }),
    );

    const logs = JSON.stringify([
      vi.mocked(console.log).mock.calls,
      vi.mocked(console.info).mock.calls,
      vi.mocked(console.error).mock.calls,
    ]);
    expect(logs).not.toContain('EXACT REVIEW PROMPT');
    expect(logs).not.toContain('A complete review.');
    expect(logs).not.toContain('must not be parsed');
  });

  it.each([
    { routeIndex: 0, model: 'Gemini 3.6' },
    { routeIndex: 1, model: 'Gemini 3.5 Lite' },
  ])('retries a $model 503 once with backoff before returning the result', async ({
    routeIndex,
  }) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const route = providerModule.buildProviderRoutes('gemini-key')[routeIndex];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(geminiEnvelope()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const onRetry = vi.fn();

    const pending = providerModule.callLLMWithRetry('EXACT REVIEW PROMPT', route, onRetry);
    await vi.advanceTimersByTimeAsync(799);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    const output = await pending;

    expect(output.result).toEqual(validReview);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
    expect([429, 502, 503, 504, 529].every(providerModule.isRetriableStatus)).toBe(true);
    expect([400, 401, 500].some(providerModule.isRetriableStatus)).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      '[generate-lesson-review] provider attempt failed',
      expect.objectContaining({
        provider: 'gemini',
        strategy: 'initial',
        attempt: 1,
        httpStatus: 503,
        errorCode: 'PROVIDER_HTTP_ERROR',
        totalProviderAttempts: 1,
      }),
    );
    expect(console.log).toHaveBeenCalledWith(
      '[generate-lesson-review] provider response metadata',
      expect.objectContaining({
        provider: 'gemini',
        strategy: 'initial',
        attempt: 1,
        httpStatus: 503,
      }),
    );
    expect(console.log).toHaveBeenCalledWith(
      '[generate-lesson-review] lifecycle',
      expect.objectContaining({ phase: 'provider-started', strategy: 'retry', attempt: 2 }),
    );
  });

  it.each([0, 1])('does not retry malformed output from Gemini route %s', async (routeIndex) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ steps: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const onRetry = vi.fn();
    const route = providerModule.buildProviderRoutes('gemini-key')[routeIndex];

    await expect(providerModule.callLLMWithRetry('EXACT REVIEW PROMPT', route, onRetry))
      .rejects.toThrow('Empty response from LLM');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      '[generate-lesson-review] provider attempt failed',
      expect.objectContaining({
        provider: 'gemini',
        attempt: 1,
        errorCode: 'EMPTY_PROVIDER_RESPONSE',
        validationResult: 'not_run',
      }),
    );
  });

  it('logs bounded failed validation metadata without logging review content', async () => {
    const invalidReview = {
      category_scores: { curriculum_alignment: { score: 4, explanation: 'PRIVATE REVIEW CONTENT' } },
      period_reviews: [],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(geminiEnvelope(invalidReview)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
    const route = providerModule.buildProviderRoutes('gemini-key')[0];

    await expect(providerModule.callLLM('PRIVATE PROMPT CONTENT', route, new AbortController().signal))
      .rejects.toThrow('Missing or invalid total_score/percentage');

    expect(console.log).toHaveBeenCalledWith(
      '[generate-lesson-review] provider response metadata',
      expect.objectContaining({ provider: 'gemini', attempt: 1, httpStatus: 200 }),
    );
    expect(console.log).toHaveBeenCalledWith(
      '[generate-lesson-review] lifecycle',
      expect.objectContaining({
        phase: 'validation',
        validJson: true,
        result: 'failed',
        categoryCount: 1,
        periodReviewCount: 0,
      }),
    );
    expect(console.error).toHaveBeenCalledWith(
      '[generate-lesson-review] validation metadata',
      expect.objectContaining({
        validJson: true,
        validationResult: 'failed',
        categoryCount: 1,
        periodReviewCount: 0,
      }),
    );
    expect(console.error).toHaveBeenCalledWith(
      '[generate-lesson-review] provider attempt failed',
      expect.objectContaining({
        validJson: true,
        validationResult: 'failed',
        errorCode: 'INVALID_REVIEW_RESPONSE',
      }),
    );
    const logs = JSON.stringify([
      vi.mocked(console.log).mock.calls,
      vi.mocked(console.info).mock.calls,
      vi.mocked(console.error).mock.calls,
    ]);
    expect(logs).not.toContain('PRIVATE PROMPT CONTENT');
    expect(logs).not.toContain('PRIVATE REVIEW CONTENT');
  });
});
