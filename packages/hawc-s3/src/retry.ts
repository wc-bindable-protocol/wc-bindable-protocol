/**
 * Generic retry-with-exponential-backoff helper.
 *
 * Pulled out of the Shell so the policy is unit-testable without a real XHR.
 * The Shell wraps every browser-originated S3 PUT (single + part) with this.
 */

export interface RetryOptions {
  /** Max retries on top of the first attempt. 3 → up to 4 attempts. */
  maxRetries: number;
  /** Whether an error should trigger another attempt. */
  isRetriable: (error: unknown, attempt: number) => boolean;
  /** Polled before each attempt and after each backoff sleep. Stops the loop. */
  isAborted?: () => boolean;
  /** Initial backoff delay in ms. Doubles each attempt up to `maxDelayMs`. */
  baseDelayMs?: number;
  /** Cap on a single backoff sleep. */
  maxDelayMs?: number;
  /** Injected for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional hook called between attempts; useful for telemetry / logging. */
  onRetry?: (error: unknown, nextAttempt: number, delayMs: number) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const max = Math.max(0, opts.maxRetries | 0);
  const base = opts.baseDelayMs ?? 250;
  const cap = opts.maxDelayMs ?? 4000;
  const sleep = opts.sleep ?? defaultSleep;
  const isAborted = opts.isAborted ?? (() => false);

  let attempt = 0;
  // The loop body either returns or rethrows; the outer `for` is just a guard
  // against the (impossible) case where neither happens.
  for (;;) {
    if (isAborted()) {
      throw new Error("[@wc-bindable/hawc-s3] aborted before attempt.");
    }
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= max || !opts.isRetriable(err, attempt)) throw err;
      const delay = Math.min(cap, base * 2 ** attempt);
      opts.onRetry?.(err, attempt + 1, delay);
      await sleep(delay);
      // Honor abort that arrived during the sleep window.
      if (isAborted()) throw err;
      attempt++;
    }
  }
}

/**
 * Marker error class so the Shell's policy can distinguish HTTP-status
 * failures (whose `status` it can inspect) from pre-flight / network
 * failures (which are always retried).
 */
export class PutHttpError extends Error {
  readonly status: number;
  readonly responseBody: string;
  constructor(message: string, status: number, responseBody = "") {
    super(message);
    this.name = "PutHttpError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

/**
 * Default policy used by the Shell.
 *   - network-level XHR errors → retry
 *   - 5xx, 408, 429            → retry
 *   - other 4xx                → do not retry (won't fix itself)
 *   - user abort               → propagated by the caller before this is consulted
 */
export function defaultPutRetryPolicy(error: unknown): boolean {
  if (error instanceof PutHttpError) {
    const s = error.status;
    return s === 408 || s === 429 || (s >= 500 && s < 600);
  }
  // Anything that didn't carry an HTTP status is treated as a network blip.
  return true;
}
