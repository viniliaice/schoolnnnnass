import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('https://esm.sh/@supabase/supabase-js@2.99.3', () => ({
  createClient: vi.fn(),
}));

interface ReviewProviderModule {
  buildProviderRoutes: (openRouterApiKey?: string, geminiApiKey?: string) => Array<{
    provider: 'openrouter' | 'gemini';
    url: string;
    model: string;
    apiKey: string | undefined;
    secretName: 'OPENROUTER_API_KEY' | 'GEMINI_API_KEY';
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

function openRouterEnvelope() {
  return {
    choices: [{ message: { content: JSON.stringify(validReview) } }],
    usage: { prompt_tokens: 120, completion_tokens: 80 },
  };
}

function geminiEnvelope() {
  return {
    status: 'completed',
    steps: [
      { type: 'thought', content: [{ type: 'text', text: 'must not be parsed' }] },
      { type: 'model_output', content: [{ type: 'text', text: JSON.stringify(validReview) }] },
    ],
    usage: { input_tokens: 130, output_tokens: 90 },
  };
}

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    serve: vi.fn(),
    env: { get: vi.fn() },
  });
  providerModule = await import('../../../supabase/functions/generate-lesson-review/index');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('generate-lesson-review provider layer', () => {
  it('builds the fixed Lightning → Gemini 3.6 → Gemini 3.5 Lite route order', () => {
    expect(providerModule.buildProviderRoutes('openrouter-key', 'gemini-key')).toEqual([
      {
        provider: 'openrouter',
        url: 'https://openrouter.ai/api/v1/chat/completions',
        model: 'nvidia/nemotron-3.5-lightning:free',
        apiKey: 'openrouter-key',
        secretName: 'OPENROUTER_API_KEY',
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

  it('sends the unchanged prompt through the Lightning OpenRouter request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(openRouterEnvelope()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const route = providerModule.buildProviderRoutes('openrouter-key', 'gemini-key')[0];

    const output = await providerModule.callLLM('EXACT REVIEW PROMPT', route, new AbortController().signal);

    expect(output.result).toEqual(validReview);
    expect(output.usage).toEqual({ input_tokens: 120, output_tokens: 80 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body).toEqual(expect.objectContaining({
      model: 'nvidia/nemotron-3.5-lightning:free',
      temperature: 1,
      top_p: 0.95,
      max_tokens: 16384,
      stream: false,
      reasoning: { effort: 'minimal', exclude: true },
    }));
    expect(body.messages[0].content).toContain('You are an expert instructional coach');
    expect(body.messages[1]).toEqual({ role: 'user', content: 'EXACT REVIEW PROMPT' });
    expect(body).not.toHaveProperty('response_format');
    expect(body).not.toHaveProperty('provider');
    expect(request.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer openrouter-key',
    });
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
  });

  it.each([
    { routeIndex: 0, model: 'Lightning', envelope: openRouterEnvelope },
    { routeIndex: 1, model: 'Gemini 3.6', envelope: geminiEnvelope },
    { routeIndex: 2, model: 'Gemini 3.5 Lite', envelope: geminiEnvelope },
  ])('retries a $model 503 once with backoff before returning the result', async ({
    routeIndex,
    envelope,
  }) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(envelope()), {
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
  });

  it('preserves the primary malformed-output retry without applying HTTP backoff', async () => {
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
});
