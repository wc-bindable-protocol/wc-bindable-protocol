import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryChallengeStore } from "../src/stores/InMemoryChallengeStore";
import { InMemoryCredentialStore } from "../src/stores/InMemoryCredentialStore";
import { CredentialRecord } from "../src/types";

describe("InMemoryChallengeStore", () => {
  let store: InMemoryChallengeStore;
  beforeEach(() => { store = new InMemoryChallengeStore(); });

  it("take returns null for an unknown session", async () => {
    expect(await store.take("nobody")).toBeNull();
  });

  it("put + take round-trip", async () => {
    await store.put("s1", { challenge: "c", mode: "register", userId: "u", createdAt: 1 });
    const slot = await store.take("s1");
    expect(slot?.challenge).toBe("c");
  });

  it("take is consume-once (anti-replay)", async () => {
    await store.put("s1", { challenge: "c", mode: "register", createdAt: 1 });
    await store.take("s1");
    expect(await store.take("s1")).toBeNull();
  });

  it("put overwrites the prior slot for the same session", async () => {
    await store.put("s1", { challenge: "old", mode: "register", createdAt: 1 });
    await store.put("s1", { challenge: "new", mode: "authenticate", createdAt: 2 });
    const slot = await store.take("s1");
    expect(slot?.challenge).toBe("new");
    expect(slot?.mode).toBe("authenticate");
  });

  describe("expired-slot sweep (regression — memory leak)", () => {
    // Regression: abandoned slots (a session that never verified) used
    // to accumulate in the Map forever. Only `take()` removed entries,
    // and a session that silently drops off the network has no take().
    // `put()` now opportunistically sweeps expired slots, bounding
    // memory to "active sessions + a TTL window of abandoned ones".

    it("drops a slot older than the TTL on the next put()", async () => {
      // Short TTL so the test does not sleep a full 5 min.
      const shortTtl = new InMemoryChallengeStore(50);
      await shortTtl.put("abandoned", { challenge: "c1", mode: "register", createdAt: Date.now() });
      // Let it age past the sweep window.
      await new Promise((r) => setTimeout(r, 80));
      // Any put() — even for a DIFFERENT session — triggers sweep.
      await shortTtl.put("fresh", { challenge: "c2", mode: "register", createdAt: Date.now() });
      expect(await shortTtl.take("abandoned")).toBeNull();
      // The fresh slot survives.
      const still = await shortTtl.take("fresh");
      expect(still?.challenge).toBe("c2");
    });

    it("keeps within-TTL slots alive even across a sweep", async () => {
      const shortTtl = new InMemoryChallengeStore(10_000);
      await shortTtl.put("user-1", { challenge: "a", mode: "register", createdAt: Date.now() });
      await shortTtl.put("user-2", { challenge: "b", mode: "register", createdAt: Date.now() });
      await shortTtl.put("user-3", { challenge: "c", mode: "register", createdAt: Date.now() });
      expect((await shortTtl.take("user-1"))?.challenge).toBe("a");
      expect((await shortTtl.take("user-2"))?.challenge).toBe("b");
      expect((await shortTtl.take("user-3"))?.challenge).toBe("c");
    });

    it("sweepExpired() is publicly callable for timer-driven cleanup", async () => {
      const shortTtl = new InMemoryChallengeStore(50);
      await shortTtl.put("old", { challenge: "x", mode: "register", createdAt: Date.now() });
      await new Promise((r) => setTimeout(r, 80));
      shortTtl.sweepExpired();
      expect(await shortTtl.take("old")).toBeNull();
    });

    // Regression (Cycle 2 #3): the constructor used to accept any number
    // for sweepTtlMs, each breaking the sweep in a distinct way — `0`
    // and negatives evict every slot immediately on each put (including
    // the one just written); `NaN` makes the cutoff comparison always
    // false so nothing is ever swept and memory grows unbounded;
    // `Infinity` produces a `-Infinity` cutoff so the sweep never
    // fires. Fail loudly at construction so a mistyped config is a
    // startup error instead of a silent memory / anti-replay drift.
    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
      "InMemoryChallengeStore rejects non-positive-finite sweepTtlMs (%p)",
      (ttl) => {
        expect(() => new InMemoryChallengeStore(ttl as any)).toThrow(/positive finite/);
      },
    );
  });
});

describe("InMemoryCredentialStore", () => {
  let store: InMemoryCredentialStore;
  beforeEach(() => { store = new InMemoryCredentialStore(); });

  const rec = (overrides: Partial<CredentialRecord> = {}): CredentialRecord => ({
    credentialId: "c1",
    userId: "u1",
    publicKey: "pk",
    counter: 0,
    createdAt: 1,
    ...overrides,
  });

  it("getById returns null for unknown id", async () => {
    expect(await store.getById("nope")).toBeNull();
  });

  it("put + getById round-trip", async () => {
    await store.put(rec());
    expect((await store.getById("c1"))?.userId).toBe("u1");
  });

  it("getById returns a copy — mutating it does not mutate the store", async () => {
    await store.put(rec());
    const fetched = await store.getById("c1");
    fetched!.counter = 999;
    const again = await store.getById("c1");
    expect(again!.counter).toBe(0);
  });

  it("listByUser returns only the target user's credentials", async () => {
    await store.put(rec({ credentialId: "c1", userId: "u1" }));
    await store.put(rec({ credentialId: "c2", userId: "u1" }));
    await store.put(rec({ credentialId: "c3", userId: "u2" }));
    const u1 = await store.listByUser("u1");
    expect(u1.map(r => r.credentialId).sort()).toEqual(["c1", "c2"]);
    const u2 = await store.listByUser("u2");
    expect(u2).toHaveLength(1);
  });

  it("updateCounter persists the new counter", async () => {
    await store.put(rec({ counter: 5 }));
    await store.updateCounter("c1", 9);
    expect((await store.getById("c1"))?.counter).toBe(9);
  });

  it("updateCounter on unknown id is a no-op", async () => {
    // Should not throw. This matches the contract of a store that trusts its
    // caller — the Core always loads the record before calling this.
    await expect(store.updateCounter("nope", 1)).resolves.toBeUndefined();
  });
});
