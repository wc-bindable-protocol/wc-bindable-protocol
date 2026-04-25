import { ChallengeSlot, IChallengeStore } from "../types.js";

/** Default TTL for opportunistic sweep on `put()`. Slots older than this
 *  are dropped to bound memory under long-lived sessions that never come
 *  back to verify. Matches the Core's default `challengeTtlMs`. Callers
 *  that configure a longer ttl should pass a matching value to the
 *  store constructor so the sweep window agrees with the verify window. */
const DEFAULT_SWEEP_TTL_MS = 5 * 60_000;

/**
 * Single-process challenge store. Intended for local development, tests,
 * and single-instance deployments. Horizontally-scaled production should
 * swap this for a Redis/Memcached/DB-backed IChallengeStore so take() is
 * atomic across instances.
 *
 * `take()` is consume-once: reading the slot also removes it. Concurrent
 * verify attempts for the same sessionId see at most one slot, which is
 * the anti-replay invariant WebAuthn relies on.
 *
 * Memory management: abandoned slots (a session that never verified)
 * used to accumulate forever because `take()` was the only removal
 * path. `put()` now opportunistically sweeps expired entries — bounded
 * work proportional to the current map size, amortized across insert
 * operations. Applications that want stricter bounds can also call
 * `sweepExpired()` from a background timer.
 */
export class InMemoryChallengeStore implements IChallengeStore {
  private _slots: Map<string, ChallengeSlot> = new Map();
  private _sweepTtlMs: number;

  /**
   * @param sweepTtlMs  Slots older than this (by `createdAt`) are dropped
   *   on every `put()`. Defaults to 5 minutes, matching the Core's default
   *   `challengeTtlMs`. Pass a larger value when the Core is configured
   *   with a longer challenge TTL so the sweep does not drop slots the
   *   verify path would still accept.
   */
  constructor(sweepTtlMs: number = DEFAULT_SWEEP_TTL_MS) {
    // `sweepTtlMs` controls the cutoff `Date.now() - this._sweepTtlMs`.
    // Non-finite / non-positive values break the sweep in distinct ways:
    //   - `0` or negative: cutoff >= now, sweeps every slot immediately
    //     on each put() including the one we just wrote.
    //   - `NaN`: comparison with any `createdAt` is false, so nothing is
    //     ever swept and memory grows unbounded.
    //   - `Infinity`: cutoff becomes `-Infinity`, sweep never fires;
    //     same unbounded-memory behavior as NaN but at least not lying
    //     about its intent — still not what any caller actually wants.
    // Reject loudly so the deployment fails at construction instead of
    // silently drifting into one of these states.
    if (!Number.isFinite(sweepTtlMs) || sweepTtlMs <= 0) {
      throw new Error(
        "[@wc-bindable/webauthn] InMemoryChallengeStore sweepTtlMs must be a positive finite number.",
      );
    }
    this._sweepTtlMs = sweepTtlMs;
  }

  async put(sessionId: string, slot: ChallengeSlot): Promise<void> {
    this._sweepExpired();
    this._slots.set(sessionId, slot);
  }

  async take(sessionId: string): Promise<ChallengeSlot | null> {
    const slot = this._slots.get(sessionId);
    if (!slot) return null;
    this._slots.delete(sessionId);
    return slot;
  }

  /** Drop expired slots now. Public for applications that want to drive
   *  sweep from a timer rather than rely on the per-`put()` amortization. */
  sweepExpired(): void {
    this._sweepExpired();
  }

  private _sweepExpired(): void {
    const cutoff = Date.now() - this._sweepTtlMs;
    for (const [sessionId, slot] of this._slots) {
      if (slot.createdAt < cutoff) this._slots.delete(sessionId);
    }
  }
}
