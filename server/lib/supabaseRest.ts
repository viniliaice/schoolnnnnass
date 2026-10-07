/**
 * Tiny Supabase REST (PostgREST) client for serverless functions. Uses plain
 * fetch so the Vercel bundle stays small and behavior is explicit.
 */

export interface RestResult<T = any> {
  data: T | null;
  error: { message: string; status?: number } | null;
}

export class SupabaseRest {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly bearer: string,
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      apikey: this.apiKey,
      Authorization: `Bearer ${this.bearer}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  async rpc<T = any>(name: string, params: Record<string, unknown> = {}): Promise<RestResult<T>> {
    const res = await fetch(`${this.baseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(params),
    });
    const text = await res.text();
    if (!res.ok) return { data: null, error: { message: text || res.statusText, status: res.status } };
    try {
      return { data: JSON.parse(text) as T, error: null };
    } catch {
      return { data: text as unknown as T, error: null };
    }
  }

  async select<T = any[]>(table: string, query: string): Promise<RestResult<T>> {
    const res = await fetch(`${this.baseUrl}/rest/v1/${table}?${query}`, {
      method: 'GET',
      headers: this.headers(),
    });
    const text = await res.text();
    if (!res.ok) return { data: null, error: { message: text || res.statusText, status: res.status } };
    return { data: JSON.parse(text) as T, error: null };
  }

  async insert<T = any>(table: string, rows: unknown, prefer?: string): Promise<RestResult<T>> {
    const res = await fetch(`${this.baseUrl}/rest/v1/${table}`, {
      method: 'POST',
      headers: this.headers(prefer ? { Prefer: prefer } : undefined),
      body: JSON.stringify(rows),
    });
    const text = await res.text();
    if (!res.ok) return { data: null, error: { message: text || res.statusText, status: res.status } };
    if (!text) return { data: null, error: null };
    try {
      return { data: JSON.parse(text) as T, error: null };
    } catch {
      return { data: null, error: null };
    }
  }

  async delete(table: string, query: string): Promise<RestResult> {
    const res = await fetch(`${this.baseUrl}/rest/v1/${table}?${query}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    const text = await res.text();
    if (!res.ok) return { data: null, error: { message: text || res.statusText, status: res.status } };
    return { data: null, error: null };
  }

  async update(table: string, query: string, body: unknown): Promise<RestResult> {
    const res = await fetch(`${this.baseUrl}/rest/v1/${table}?${query}`, {
      method: 'PATCH',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) return { data: null, error: { message: text || res.statusText, status: res.status } };
    return { data: null, error: null };
  }
}

/** PostgREST `in.(...)` filter value. */
export function inFilter(values: string[]): string {
  return `(${values.map((v) => `"${v.replace(/"/g, '')}"`).join(',')})`;
}
