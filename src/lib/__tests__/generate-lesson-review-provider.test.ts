import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('https://esm.sh/@supabase/supabase-js@2.99.3', () => ({
  createClient: vi.fn(),
}));

interface ReviewProviderModule {
  buildProviderRoutes: (
    openRouterApiKey?: string,
    geminiApiKey?: string,
  ) => Array<{
    provider: 'openrouter' | 'gemini';
    url: string;
    model: string;
    apiKey: string | undefined;
    secretName: 'OPENROUTER_API_KEY' | 'GEMINI_API_KEY';
    retryMalformedOutput?: boolean;
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

function openRouterEnvelope(review: unknown = validReview) {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: JSON.stringify(review),
        reasoning: 'must not be parsed',
      },
    }],
    usage: { prompt_tokens: 140, completion_tokens: 95 },
  };
}

function providerEnvelope(provider: 'openrouter' | 'gemini', review: unknown = validReview) {
  return provider === 'openrouter' ? openRouterEnvelope(review) : geminiEnvelope(review);
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
  it('registers without top-level secret reads and logs receipt before OPTIONS handling', async () => {
    const deno = (globalThis as any).Deno;
    expect(deno.serve).toHaveBeenCalledOnce();
    expect(deno.env.get).not.toHaveBeenCalled();

    const handler = deno.serve.mock.calls[0][0] as (request: Request) => Promise<Response>;
    const response = await handler(new Request('https://example.test/generate-lesson-review', {
      method: 'OPTIONS',
    }));

    expect(response.status).toBe(204);
    expect(console.log).toHaveBeenCalledWith(
      '[generate-lesson-review] request received',
      { method: 'OPTIONS', hasAuthorizationHeader: false },
    );
    expect(deno.env.get).not.toHaveBeenCalled();
  });

  it('builds OpenRouter Nemotron → Gemini 3.6 → Gemini 3.5 Lite in fixed order', () => {
    expect(providerModule.buildProviderRoutes('openrouter-key', 'gemini-key')).toEqual([
      {
        provider: 'openrouter',
        url: 'https://openrouter.ai/api/v1/chat/completions',
        model: 'nvidia/nemotron-3.5-lightning:free',
        apiKey: 'openrouter-key',
        secretName: 'OPENROUTER_API_KEY',
        retryMalformedOutput: true,
      },
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

  it('uses OpenRouter chat completions for Nemotron without unsupported structured-output parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(openRouterEnvelope()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const route = providerModule.buildProviderRoutes('openrouter-key', 'gemini-key')[0];

    const output = await providerModule.callLLM('EXACT REVIEW PROMPT', route, new AbortController().signal);

    expect(output.result).toEqual(validReview);
    expect(output.usage).toEqual({ input_tokens: 140, output_tokens: 95 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body).toEqual(expect.objectContaining({
      model: 'nvidia/nemotron-3.5-lightning:free',
      messages: [
        { role: 'system', content: expect.stringContaining('You are an expert instructional coach') },
        { role: 'user', content: 'EXACT REVIEW PROMPT' },
      ],
      max_tokens: 16384,
    }));
    expect(body).not.toHaveProperty('response_format');
    expect(body).not.toHaveProperty('provider');
    expect(request.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer openrouter-key',
    });
    expect(JSON.stringify(output)).not.toContain('must not be parsed');
  });

  it('uses the Gemini Interactions envelope without parsing thought steps', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(geminiEnvelope()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const route = providerModule.buildProviderRoutes('openrouter-key', 'gemini-key')[1];

    const output = await providerModule.callLLM('EXACT REVIEW PROMPT', route, new AbortController().signal);

    expect(output.result).toEqual(validReview);
    expect(output.usage).toEqual({ input_tokens: 130, output_tokens: 90 });
    expect(fetchMock).toHaveBeenCalledOnce();
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
      '[generate-lesson-review] provider started',
      expect.objectContaining({
        provider: 'gemini',
        model: 'gemini-3.6-flash',
        strategy: 'initial',
        attempt: 1,
        promptChars: 19,
        maxTokens: 16384,
        totalProviderAttempts: 1,
      }),
    );
    expect(console.log).toHaveBeenCalledWith(
      '[generate-lesson-review] validation metadata',
      expect.objectContaining({
        provider: 'gemini',
        model: 'gemini-3.6-flash',
        validJson: true,
        validationResult: 'passed',
        categoryCount: 1,
        periodReviewCount: 0,
        totalProviderAttempts: 1,
      }),
    );
    expect(console.log).toHaveBeenCalledWith(
      '[generate-lesson-review] provider finished',
      expect.objectContaining({ provider: 'gemini', result: 'succeeded' }),
    );
    const logs = JSON.stringify([
      vi.mocked(console.log).mock.calls,
      vi.mocked(console.info).mock.calls,
      vi.mocked(console.error).mock.calls,
    ]);
    expect(logs).not.toContain('EXACT REVIEW PROMPT');
    expect(logs).not.toContain('A complete review.');
    expect(logs).not.toContain('must not be parsed');
    expect(logs).not.toContain('openrouter-key');
    expect(logs).not.toContain('gemini-key');
  });

  it.each([
    { routeIndex: 0, model: 'Nemotron', provider: 'openrouter' as const },
    { routeIndex: 1, model: 'Gemini 3.6', provider: 'gemini' as const },
    { routeIndex: 2, model: 'Gemini 3.5 Lite', provider: 'gemini' as const },
  ])('retries a $model 503 once with backoff before returning the result', async ({
    routeIndex,
    provider,
  }) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(providerEnvelope(provider)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const onRetry = vi.fn();
    const route = providerModule.buildProviderRoutes('openrouter-key', 'gemini-key')[routeIndex];

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
        provider,
        strategy: 'initial',
        attempt: 1,
        httpStatus: 503,
        errorCode: 'PROVIDER_HTTP_ERROR',
        totalProviderAttempts: 1,
      }),
    );
    expect(console.log).toHaveBeenCalledWith(
      '[generate-lesson-review] provider started',
      expect.objectContaining({ strategy: 'retry', attempt: 2, totalProviderAttempts: 2 }),
    );
  });

  it('retries malformed output only on the primary Nemotron route and without HTTP backoff', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(openRouterEnvelope()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const onRetry = vi.fn();
    const route = providerModule.buildProviderRoutes('openrouter-key', 'gemini-key')[0];

    const output = await providerModule.callLLMWithRetry('EXACT REVIEW PROMPT', route, onRetry);

    expect(output.result).toEqual(validReview);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry malformed output from the final fallback model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ steps: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const onRetry = vi.fn();
    const route = providerModule.buildProviderRoutes('openrouter-key', 'gemini-key')[2];

    await expect(providerModule.callLLMWithRetry('EXACT REVIEW PROMPT', route, onRetry))
      .rejects.toThrow('Empty response from LLM');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('logs bounded failed validation metadata without logging review content', async () => {
    const invalidReview = {
      category_scores: { curriculum_alignment: { score: 4, explanation: 'PRIVATE REVIEW CONTENT' } },
      period_reviews: [],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(openRouterEnvelope(invalidReview)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
    const route = providerModule.buildProviderRoutes('openrouter-key', 'gemini-key')[0];

    await expect(providerModule.callLLM('PRIVATE PROMPT CONTENT', route, new AbortController().signal))
      .rejects.toThrow('Missing or invalid total_score/percentage');

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
