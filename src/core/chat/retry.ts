// Shared retry policy for both wire clients. Duck-typed on purpose: the
// openai and @anthropic-ai/sdk error classes both expose .status and
// .headers, but importing either SDK here would couple the policy to one.

// 529 is Anthropic's overloaded_error — without it Anthropic under load
// looks like a hard failure.
export const RETRY_STATUSES = new Set([429, 500, 502, 503, 529]);
export const MAX_ATTEMPTS = 5;

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });

export interface RetryContext {
  isLocal: boolean;
  baseUrl: string | null;
  keyHint: string;
  providerName: string;
  /** Extra text for the connection-error message in local mode. */
  localModel?: string;
}

function isConnectionError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const name = (e as { constructor?: { name?: string } }).constructor?.name ?? '';
  if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') return true;
  // duck-type: an Error without an HTTP status but with a network-ish cause
  const status = (e as { status?: unknown }).status;
  const cause = (e as { cause?: { code?: string } }).cause;
  return status === undefined && Boolean(cause?.code);
}

export function classifyHttpError(
  e: unknown,
  attempt: number,
  ctx: RetryContext,
): { retryable: boolean; delaySec: number; message: string } {
  const backoff = Math.min(60, Math.pow(2, attempt)) + Math.random();
  if (isConnectionError(e)) {
    const msg = (e as Error).message ?? String(e);
    if (ctx.isLocal) {
      return {
        retryable: false,
        delaySec: 0,
        message:
          `Couldn't reach Ollama at ${ctx.baseUrl}: ${msg}\n` +
          `Is Ollama running? Start the Ollama app (or 'ollama serve') and make sure '${ctx.localModel ?? 'the model'}' is pulled.`,
      };
    }
    return { retryable: true, delaySec: backoff, message: `network error (${msg})` };
  }
  const status = Number((e as { status?: unknown })?.status ?? NaN);
  if (Number.isFinite(status) && status > 0) {
    const errMsg = (e as Error).message ?? String(e);
    if (RETRY_STATUSES.has(status)) {
      const headers = (e as { headers?: { get?: (k: string) => string | null } }).headers;
      const ra = headers?.get?.('retry-after');
      const delaySec = ra && !Number.isNaN(Number(ra)) ? Number(ra) : backoff;
      return { retryable: true, delaySec, message: `API returned ${status}` };
    }
    if (status === 401) {
      return {
        retryable: false,
        delaySec: 0,
        message: `provider '${ctx.providerName}' rejected the API key (401): ${errMsg}\nFix the key (${ctx.keyHint}).`,
      };
    }
    return { retryable: false, delaySec: 0, message: `API error ${status}: ${errMsg}` };
  }
  return { retryable: false, delaySec: 0, message: (e as Error)?.message ?? String(e) };
}
