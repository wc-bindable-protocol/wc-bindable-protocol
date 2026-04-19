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
