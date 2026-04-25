import { describe, it, expect } from "vitest";
import { StripeSdkProvider, type StripeNodeLike } from "../src/providers/StripeSdkProvider";

function createFakeClient(overrides: Partial<Record<string, any>> = {}): {
  client: StripeNodeLike;
  calls: {
    piCreate: { params: Record<string, unknown>; opts?: Record<string, unknown> }[];
    siCreate: { params: Record<string, unknown>; opts?: Record<string, unknown> }[];
    piRetrieve: { id: string; opts?: Record<string, unknown> }[];
    siRetrieve: { id: string; opts?: Record<string, unknown> }[];
    siCancel: string[];
  };
} {
  const calls = {
    piCreate: [] as { params: Record<string, unknown>; opts?: Record<string, unknown> }[],
    siCreate: [] as { params: Record<string, unknown>; opts?: Record<string, unknown> }[],
    piRetrieve: [] as { id: string; opts?: Record<string, unknown> }[],
    siRetrieve: [] as { id: string; opts?: Record<string, unknown> }[],
    siCancel: [] as string[],
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
      async cancel(id) {
        calls.siCancel.push(id);
        return { id, status: "canceled" };
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

  it("delegates cancelSetupIntent to setupIntents.cancel", async () => {
    const { client, calls } = createFakeClient();
    const provider = new StripeSdkProvider(client);
    await provider.cancelSetupIntent("seti_abc");
    expect(calls.siCancel).toEqual(["seti_abc"]);
  });

  it("throws when setupIntents.cancel is not available on the client", async () => {
    const { client } = createFakeClient();
    delete (client.setupIntents as any).cancel;
    const provider = new StripeSdkProvider(client);
    await expect(provider.cancelSetupIntent("seti_x")).rejects.toThrow(/not available/);
  });

  it("treats payment_method_types: [] as unset on createPaymentIntent (regression)", async () => {
    // Empty array is truthy in JS, so the previous `=== undefined` gate
    // forwarded it to Stripe verbatim — Stripe then returns a 400
    // ("payment_method_types[] is empty") that looks like a library bug.
    // Both provider paths must strip the empty array and fall through to
    // the automatic_payment_methods default.
    const { client, calls } = createFakeClient();
    const provider = new StripeSdkProvider(client);
    await provider.createPaymentIntent({
      amount: 500,
      currency: "usd",
      payment_method_types: [],
    } as any);
    expect(calls.piCreate).toHaveLength(1);
    const params = calls.piCreate[0].params as Record<string, unknown>;
    expect(params.payment_method_types).toBeUndefined();
    expect(params.automatic_payment_methods).toEqual({ enabled: true });
  });

  it("treats payment_method_types: [] as unset on createSetupIntent (regression)", async () => {
    const { client, calls } = createFakeClient();
    const provider = new StripeSdkProvider(client);
    await provider.createSetupIntent({
      customer: "cus_x",
      payment_method_types: [],
    } as any);
    expect(calls.siCreate).toHaveLength(1);
    const params = calls.siCreate[0].params as Record<string, unknown>;
    expect(params.payment_method_types).toBeUndefined();
    expect(params.automatic_payment_methods).toEqual({ enabled: true });
  });

  it("still respects a non-empty payment_method_types by not overriding it with automatic_payment_methods", async () => {
    const { client, calls } = createFakeClient();
    const provider = new StripeSdkProvider(client);
    await provider.createPaymentIntent({
      amount: 500,
      currency: "usd",
      payment_method_types: ["card"],
    } as any);
    expect(calls.piCreate).toHaveLength(1);
    const params = calls.piCreate[0].params as Record<string, unknown>;
    expect(params.payment_method_types).toEqual(["card"]);
    expect(params.automatic_payment_methods).toBeUndefined();
  });
});
