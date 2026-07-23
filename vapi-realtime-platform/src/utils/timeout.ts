export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} exceeded ${ms}ms budget`);
    this.name = 'TimeoutError';
  }
}

/**
 * Every external call (Pinecone, Google Calendar, OpenAI embeddings) on the hot
 * path is wrapped in this. A caller who is on the phone gets a fast, honest
 * degradation ("not sure, let me have the team follow up") instead of dead air
 * while we wait on a slow upstream — see docs/ARCHITECTURE for the latency budget
 * table this enforces.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function withRetry<T>(fn: () => Promise<T>, retries: number, backoffMs = 100): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err instanceof TimeoutError) throw err; // don't retry into an already-blown budget
      if (attempt < retries) await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
    }
  }
  throw lastErr;
}
