import { describe, it, expect } from "vitest";
import { StripeSdkProvider, type StripeNodeLike } from "../src/providers/StripeSdkProvider";

function createFakeClient(overrides: Partial<Record<string, any>> = {}): {
  client: StripeNodeLike;
  calls: {
    piCreate: { params: Record<string, unknown>; opts?: Record<string, unknown> }[];
    siCreate: { params: Record<string, unknown>; opts?: Record<string, unknown> }[];
    piRetrieve: { id: string; opts?: Record<string, unknown> }[];
    siRetrieve: { id: string; opts?: Record<string, unknown> }[];
  };
} {
  const calls = {
    piCreate: [] as { params: Record<string, unknown>; opts?: Record<string, unknown> }[],
    siCreate: [] as { params: Record<string, unknown>; opts?: Record<string, unknown> }[],
    piRetrieve: [] as { id: string; opts?: Record<string, unknown> }[],
    siRetrieve: [] as { id: string; opts?: Record<string, unknown> }[],
  };
  const client: StripeNodeLike = {
    paymentIntents: {
      async create(params, opts) {
        calls.piCreate.push({ params, opts });
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
      async create(params, opts) {
        calls.siCreate.push({ params, opts });
        return { id: "seti_new", client_secret: "cs_seti_new" };
      },
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

describe("StripeSdkProvider", () => {
  it("throws when buildIdempotencyKey is not a function", () => {
    const { client } = createFakeClient();
    expect(() => new StripeSdkProvider(client, { buildIdempotencyKey: "nope" as any }))
      .toThrow(/must be a function/);
  });

  it("does not pass idempotencyKey by default", async () => {
    const { client, calls } = createFakeClient();
    const provider = new StripeSdkProvider(client);
    await provider.createPaymentIntent({ amount: 1980, currency: "jpy" });
    await provider.createSetupIntent({});
    expect(calls.piCreate).toHaveLength(1);
    expect(calls.siCreate).toHaveLength(1);
    expect(calls.piCreate[0].opts).toBeUndefined();
    expect(calls.siCreate[0].opts).toBeUndefined();
  });

  it("does not pass options when buildIdempotencyKey returns undefined", async () => {
    const { client, calls } = createFakeClient();
    const provider = new StripeSdkProvider(client, {
      buildIdempotencyKey: () => undefined,
    });
    await provider.createPaymentIntent({ amount: 100, currency: "usd" });
    expect(calls.piCreate).toHaveLength(1);
    expect(calls.piCreate[0].opts).toBeUndefined();
  });

  it("passes idempotencyKey when buildIdempotencyKey is configured", async () => {
    const { client, calls } = createFakeClient();
    const provider = new StripeSdkProvider(client, {
      buildIdempotencyKey: ({ operation, mode }) => `${operation}:${mode}:cart-1:user-1`,
    });
    await provider.createPaymentIntent({ amount: 1980, currency: "jpy" });
    await provider.createSetupIntent({ customer: "cus_123" });
    expect(calls.piCreate[0].opts).toEqual({ idempotencyKey: "createPaymentIntent:payment:cart-1:user-1" });
    expect(calls.siCreate[0].opts).toEqual({ idempotencyKey: "createSetupIntent:setup:cart-1:user-1" });
  });

  it("provides operation/mode/options to buildIdempotencyKey", async () => {
    const { client } = createFakeClient();
    const seen: unknown[] = [];
    const provider = new StripeSdkProvider(client, {
      buildIdempotencyKey: (ctx) => {
        seen.push(ctx);
        return "k";
      },
    });
    await provider.createPaymentIntent({ amount: 1200, currency: "usd", customer: "cus_1" });
    await provider.createSetupIntent({ customer: "cus_2" });

    expect(seen).toEqual([
      {
        operation: "createPaymentIntent",
        mode: "payment",
        options: { amount: 1200, currency: "usd", customer: "cus_1" },
      },
      {
        operation: "createSetupIntent",
        mode: "setup",
        options: { customer: "cus_2" },
      },
    ]);
  });

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
