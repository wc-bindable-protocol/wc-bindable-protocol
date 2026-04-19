import { ChallengeSlot, IChallengeStore } from "../types.js";

/**
 * Single-process challenge store. Intended for local development, tests,
 * and single-instance deployments. Horizontally-scaled production should
 * swap this for a Redis/Memcached/DB-backed IChallengeStore so take() is
 * atomic across instances.
 *
 * `take()` is consume-once: reading the slot also removes it. Concurrent
 * verify attempts for the same sessionId see at most one slot, which is
 * the anti-replay invariant WebAuthn relies on.
 */
export class InMemoryChallengeStore implements IChallengeStore {
  private _slots: Map<string, ChallengeSlot> = new Map();

  async put(sessionId: string, slot: ChallengeSlot): Promise<void> {
    this._slots.set(sessionId, slot);
  }

  async take(sessionId: string): Promise<ChallengeSlot | null> {
    const slot = this._slots.get(sessionId);
    if (!slot) return null;
    this._slots.delete(sessionId);
    return slot;
  }
}
