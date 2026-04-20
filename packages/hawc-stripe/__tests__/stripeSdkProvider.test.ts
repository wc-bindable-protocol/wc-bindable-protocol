import { describe, it, expect } from "vitest";
import { StripeSdkProvider, type StripeNodeLike } from "../src/providers/StripeSdkProvider";

function createFakeClient(overrides: Partial<Record<string, any>> = {}): {
  client: StripeNodeLike;
  calls: {
    piRetrieve: { id: string; opts?: Record<string, unknown> }[];
    siRetrieve: { id: string; opts?: Record<string, unknown> }[];
  };
} {
  const calls = {
    piRetrieve: [] as { id: string; opts?: Record<string, unknown> }[],
    siRetrieve: [] as { id: string; opts?: Record<string, unknown> }[],
  };
  const client: StripeNodeLike = {
    paymentIntents: {
      async create(params) {
        return { id: "pi_new", client_secret: "cs_new", amount: params.amount, currency: params.currency };
      },
      async retrieve(id, opts) {
        calls.piRetrieve.push({ id, opts });
        return overrides.piRetrieveResult ?? {
          id,
          status: "succeeded",
          amount: 1000,
          currency: "usd",
          payment_method: "pm_string_only",  // NOT expanded — the real default shape
        };
      },
      async cancel(id) { return { id, status: "canceled" }; },
    },
    setupIntents: {
      async create() { return { id: "seti_new", client_secret: "cs_seti_new" }; },
      async retrieve(id, opts) {
        calls.siRetrieve.push({ id, opts });
        return overrides.siRetrieveResult ?? { id, status: "succeeded", payment_method: "pm_string_only" };
      },
    },
    webhooks: {
      constructEvent(_p, _h, _s) {
        return { id: "evt_1", type: "test", data: { object: {} }, created: 0 };
      },
    },
  };
  return { client, calls };
}

describe("StripeSdkProvider (regression: finding #3)", () => {
  it("passes expand: ['payment_method'] to paymentIntents.retrieve", async () => {
    const { client, calls } = createFakeClient();
    const provider = new StripeSdkProvider(client);
    await provider.retrieveIntent("payment", "pi_abc");
    expect(calls.piRetrieve).toHaveLength(1);
    expect(calls.piRetrieve[0].id).toBe("pi_abc");
    expect(calls.piRetrieve[0].opts).toEqual({ expand: ["payment_method"] });
  });

  it("passes expand: ['payment_method'] to setupIntents.retrieve", async () => {
    const { client, calls } = createFakeClient();
    const provider = new StripeSdkProvider(client);
    await provider.retrieveIntent("setup", "seti_abc");
    expect(calls.siRetrieve).toHaveLength(1);
    expect(calls.siRetrieve[0].opts).toEqual({ expand: ["payment_method"] });
  });

  it("extracts brand/last4 when payment_method is expanded", async () => {
    const { client } = createFakeClient({
      piRetrieveResult: {
        id: "pi_abc",
        status: "succeeded",
        amount: 1000,
        currency: "usd",
        payment_method: {
          id: "pm_expanded",
          card: { brand: "visa", last4: "4242" },
        },
      },
    });
    const provider = new StripeSdkProvider(client);
    const view = await provider.retrieveIntent("payment", "pi_abc");
    expect(view.paymentMethod).toEqual({ id: "pm_expanded", brand: "visa", last4: "4242" });
  });

  it("returns undefined paymentMethod when payment_method is still a string (expand not honored)", async () => {
    // Default fake returns string-only — verifies the graceful degradation
    // path: no crash, just no paymentMethod detail.
    const { client } = createFakeClient();
    const provider = new StripeSdkProvider(client);
    const view = await provider.retrieveIntent("payment", "pi_abc");
    expect(view.paymentMethod).toBeUndefined();
  });
});
