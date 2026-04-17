import { describe, it, expect, vi } from "vitest";
import { retryWithBackoff, defaultPutRetryPolicy, PutHttpError, MissingEtagError } from "../src/retry";

describe("retryWithBackoff", () => {
  it("returns the result on first success without sleeping", async () => {
    const sleep = vi.fn();
    const out = await retryWithBackoff(() => Promise.resolve("ok"), {
      maxRetries: 3, isRetriable: () => true, sleep,
    });
    expect(out).toBe("ok");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries on retriable errors up to maxRetries then succeeds", async () => {
    let calls = 0;
    const sleep = vi.fn(async () => {});
    const out = await retryWithBackoff(async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "ok";
    }, { maxRetries: 5, isRetriable: () => true, sleep });
    expect(out).toBe("ok");
    expect(calls).toBe(3);
    // 2 sleeps between 3 attempts.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("uses exponential backoff capped at maxDelayMs", async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => { delays.push(ms); });
    let calls = 0;
    await expect(retryWithBackoff(async () => {
      calls++;
      throw new Error("nope");
    }, {
      maxRetries: 5,
      isRetriable: () => true,
      baseDelayMs: 100,
      maxDelayMs: 500,
      sleep,
    })).rejects.toThrow("nope");
    expect(calls).toBe(6);
    // 100, 200, 400, capped at 500, 500.
    expect(delays).toEqual([100, 200, 400, 500, 500]);
  });

  it("rethrows immediately when isRetriable returns false", async () => {
    const sleep = vi.fn();
    let calls = 0;
    await expect(retryWithBackoff(async () => {
      calls++;
      throw new Error("permanent");
    }, { maxRetries: 5, isRetriable: () => false, sleep })).rejects.toThrow("permanent");
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops on the first attempt when isAborted starts true", async () => {
    const fn = vi.fn();
    await expect(retryWithBackoff(fn, {
      maxRetries: 5, isRetriable: () => true, isAborted: () => true, sleep: async () => {},
    })).rejects.toThrow(/aborted/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("bails out mid-loop when isAborted flips true during sleep", async () => {
    let aborted = false;
    let calls = 0;
    const sleep = vi.fn(async () => { aborted = true; });
    await expect(retryWithBackoff(async () => {
      calls++;
      throw new Error("transient");
    }, {
      maxRetries: 5,
      isRetriable: () => true,
      isAborted: () => aborted,
      sleep,
    })).rejects.toThrow("transient");
    // First attempt fails, sleep flips abort, loop bails before second attempt.
    expect(calls).toBe(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("invokes onRetry between attempts", async () => {
    const events: Array<{ attempt: number; delay: number }> = [];
    let calls = 0;
    await retryWithBackoff(async () => {
      calls++;
      if (calls < 3) throw new Error("x");
      return "ok";
    }, {
      maxRetries: 5,
      isRetriable: () => true,
      sleep: async () => {},
      baseDelayMs: 10,
      onRetry: (_e, attempt, delay) => events.push({ attempt, delay }),
    });
    expect(events).toEqual([
      { attempt: 1, delay: 10 },
      { attempt: 2, delay: 20 },
    ]);
  });

  it("passes the attempt count to fn (0-based)", async () => {
    const seen: number[] = [];
    await retryWithBackoff(async (attempt) => {
      seen.push(attempt);
      if (attempt < 2) throw new Error("again");
      return "ok";
    }, { maxRetries: 5, isRetriable: () => true, sleep: async () => {} });
    expect(seen).toEqual([0, 1, 2]);
  });
});

describe("defaultPutRetryPolicy", () => {
  it("retries 5xx", () => {
    expect(defaultPutRetryPolicy(new PutHttpError("x", 500))).toBe(true);
    expect(defaultPutRetryPolicy(new PutHttpError("x", 503))).toBe(true);
    expect(defaultPutRetryPolicy(new PutHttpError("x", 599))).toBe(true);
  });

  it("retries 408 and 429", () => {
    expect(defaultPutRetryPolicy(new PutHttpError("x", 408))).toBe(true);
    expect(defaultPutRetryPolicy(new PutHttpError("x", 429))).toBe(true);
  });

  it("does not retry other 4xx", () => {
    expect(defaultPutRetryPolicy(new PutHttpError("x", 400))).toBe(false);
    expect(defaultPutRetryPolicy(new PutHttpError("x", 403))).toBe(false);
    expect(defaultPutRetryPolicy(new PutHttpError("x", 404))).toBe(false);
  });

  it("retries network-level Errors (no status)", () => {
    expect(defaultPutRetryPolicy(new Error("network down"))).toBe(true);
  });

  it("does NOT retry MissingEtagError (configuration, not transient)", () => {
    // A 2xx PUT with no ETag means either CORS is hiding the header or the
    // server does not emit one. Both are configuration issues — retrying
    // will not produce an ETag, so looping through the entire retry budget
    // just delays the failure surface with no benefit.
    expect(defaultPutRetryPolicy(new MissingEtagError("no ETag"))).toBe(false);
  });
});
