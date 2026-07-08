const isDev = import.meta.env?.MODE !== 'production';

export function warnFallback(operation: string, cause?: unknown) {
  if (!isDev) return;
  console.warn(`[fallback] ${operation}`, cause ?? 'No cause provided');
}

export function debugLog(...args: unknown[]) {
  if (isDev) console.debug(...args);
}
