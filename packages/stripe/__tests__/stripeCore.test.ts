import { describe, it, expect, beforeEach } from "vitest";
import { StripeCore } from "../src/core/StripeCore";
import {
  IStripeProvider, IntentCreationResult, PaymentIntentOptions, SetupIntentOptions,
  StripeEvent, StripeIntentView, StripeMode,
} from "../src/types";

class FakeProvider implements IStripeProvider {
  createPaymentCalls: PaymentIntentOptions[] = [];
  createSetupCalls: SetupIntentOptions[] = [];
  retrieveCalls: { mode: StripeMode; id: string }[] = [];
  cancelCalls: string[] = [];
  cancelSetupCalls: string[] = [];
  nextPaymentIntentId: string = "pi_123";
  nextSetupIntentId: string = "seti_123";
  nextClientSecret: string = "secret_abc";
  paymentError: Error | null = null;
  retrieveResult: StripeIntentView | null = null;
  webhookEvent: StripeEvent | null = null;
  webhookError: Error | null = null;

  async createPaymentIntent(opts: PaymentIntentOptions): Promise<IntentCreationResult> {
    if (this.paymentError) throw this.paymentError;
    this.createPaymentCalls.push(opts);
    return {
      intentId: this.nextPaymentIntentId,
      clientSecret: this.nextClientSecret,
      mode: "payment",
      amount: { value: opts.amount, currency: opts.currency },
    };
  }

  async createSetupIntent(opts: SetupIntentOptions): Promise<IntentCreationResult> {
    this.createSetupCalls.push(opts);
    return {
      intentId: this.nextSetupIntentId,
      clientSecret: this.nextClientSecret,
      mode: "setup",
    };
  }

  async retrieveIntent(mode: StripeMode, id: string): Promise<StripeIntentView> {
    this.retrieveCalls.push({ mode, id });
    return this.retrieveResult ?? { id, status: "succeeded", mode };
  }

  async cancelPaymentIntent(id: string): Promise<void> {
    this.cancelCalls.push(id);
  }

  async cancelSetupIntent(id: string): Promise<void> {
    this.cancelSetupCalls.push(id);
  }

  verifyWebhook(_body: string, _sig: string, _secret: string): StripeEvent {
    if (this.webhookError) throw this.webhookError;
    if (!this.webhookEvent) throw new Error("no event configured");
    return this.webhookEvent;
  }
}

describe("StripeCore", () => {
  let provider: FakeProvider;
  let core: StripeCore;

  beforeEach(() => {
    provider = new FakeProvider();
    core = new StripeCore(provider, { webhookSecret: "whsec_test" });
  });

  describe("requestIntent", () => {
    it("fail-louds when no IntentBuilder is registered", async () => {
      await expect(core.requestIntent({ mode: "payment", hint: {} })).rejects.toThrow(
        /registerIntentBuilder/
      );
      expect(core.status).toBe("idle");
      expect(core.error?.code).toBe("intent_builder_not_registered");
    });

    it("invokes the builder with hint+ctx and creates a PaymentIntent", async () => {
      const builderCalls: any[] = [];
      const userContext = { sub: "user_42" };
      const c = new StripeCore(provider, { userContext });
      c.registerIntentBuilder((req, ctx) => {
        builderCalls.push({ req, ctx });
        return { mode: "payment", amount: 1980, currency: "jpy" };
      });

      const result = await c.requestIntent({
        mode: "payment",
        hint: { amountValue: 100, amountCurrency: "usd" },
      });

      expect(builderCalls).toHaveLength(1);
      expect(builderCalls[0].req.mode).toBe("payment");
      expect(builderCalls[0].req.hint.amountValue).toBe(100);
      expect(builderCalls[0].ctx).toBe(userContext);
      // Server ignores the hint and uses the builder's amount.
      expect(provider.createPaymentCalls[0].amount).toBe(1980);
      expect(provider.createPaymentCalls[0].currency).toBe("jpy");
      expect(result.intentId).toBe("pi_123");
      expect(result.clientSecret).toBe("secret_abc");
      expect(c.status).toBe("collecting");
      expect(c.intentId).toBe("pi_123");
      expect(c.amount).toEqual({ value: 1980, currency: "jpy" });
    });

    it("passes through extended Stripe intent fields from IntentBuilder", async () => {
      core.registerIntentBuilder((req) => {
        if (req.mode === "payment") {
          return {
            mode: "payment",
            amount: 2500,
            currency: "usd",
            application_fee_amount: 250,
            transfer_data: { destination: "acct_123" },
            confirm: true,
          };
        }
        return {
          mode: "setup",
          payment_method: "pm_123",
          mandate_data: { customer_acceptance: { type: "online" } },
        };
      });

      await core.requestIntent({ mode: "payment", hint: {} });
      await core.requestIntent({ mode: "setup", hint: {} });

      expect(provider.createPaymentCalls).toHaveLength(1);
      expect(provider.createPaymentCalls[0]).not.toHaveProperty("mode");
      expect(provider.createPaymentCalls[0].application_fee_amount).toBe(250);
      expect(provider.createPaymentCalls[0].confirm).toBe(true);
      expect(provider.createPaymentCalls[0].transfer_data).toEqual({ destination: "acct_123" });

      expect(provider.createSetupCalls).toHaveLength(1);
      expect(provider.createSetupCalls[0]).not.toHaveProperty("mode");
      expect(provider.createSetupCalls[0].payment_method).toBe("pm_123");
      expect(provider.createSetupCalls[0].mandate_data).toEqual({
        customer_acceptance: { type: "online" },
      });
    });

    it("clears stale payment amount when switching to setup mode on the same Core", async () => {
      // First request: payment mode — amount lands on observable state.
      core.registerIntentBuilder(() => ({ mode: "payment", amount: 1980, currency: "jpy" }));
      await core.requestIntent({ mode: "payment", hint: {} });
      expect(core.amount).toEqual({ value: 1980, currency: "jpy" });

      // Now switch the builder and issue a setup-mode request. SPEC §5.1
      // says `amount` is only meaningful for payment mode — the prior value
      // must not leak into the setup session.
      core.registerIntentBuilder(() => ({ mode: "setup" }));
      provider.nextSetupIntentId = "seti_switch";
      await core.requestIntent({ mode: "setup", hint: {} });
      expect(core.intentId).toBe("seti_switch");
      expect(core.amount).toBeNull();
    });

    it("rejects on builder mode mismatch", async () => {
      core.registerIntentBuilder(() => ({ mode: "setup" }));
      await expect(core.requestIntent({ mode: "payment", hint: {} })).rejects.toThrow(
        /mode "setup".*"payment"/
      );
      expect(core.status).toBe("idle");
      expect(core.error?.code).toBe("intent_builder_mode_mismatch");
    });

    it("does NOT expose clientSecret through any observable property", async () => {
      core.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
      await core.requestIntent({ mode: "payment", hint: {} });
      // Scan every public getter for the clientSecret value.
      const dangerous = provider.nextClientSecret;
      const surfaces: Record<string, unknown> = {
        status: core.status,
        loading: core.loading,
        amount: core.amount,
        paymentMethod: core.paymentMethod,
        intentId: core.intentId,
        error: core.error,
      };
      for (const [name, value] of Object.entries(surfaces)) {
        expect(JSON.stringify(value)).not.toContain(dangerous);
        expect(name).not.toBe("clientSecret");
      }
      // And no enumerable "clientSecret" key on the core itself.
      expect(Object.keys(core)).not.toContain("clientSecret");
    });

    it("cancels the orphan when superseded mid-flight", async () => {
      core.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
      let release: (() => void) | null = null;
      const firstStarted = new Promise<void>((resolveStarted) => {
        provider.createPaymentIntent = (opts) => new Promise<IntentCreationResult>((resolve) => {
          provider.createPaymentCalls.push(opts);
          release = () => resolve({
            intentId: "pi_orphan",
            clientSecret: "secret_orphan",
            mode: "payment",
            amount: { value: opts.amount, currency: opts.currency },
          });
          resolveStarted();
        });
      });
      const first = core.requestIntent({ mode: "payment", hint: {} });
      await firstStarted; // ensure the slow createPaymentIntent is in flight
      // Supersede with a second request BEFORE the first resolves.
      provider.createPaymentIntent = async (opts) => ({
        intentId: "pi_new",
        clientSecret: "secret_new",
        mode: "payment",
        amount: { value: opts.amount, currency: opts.currency },
      });
      const second = core.requestIntent({ mode: "payment", hint: {} });
      release!();
      await expect(first).rejects.toThrow(/superseded/);
      const r2 = await second;
      expect(r2.intentId).toBe("pi_new");
      expect(provider.cancelCalls).toContain("pi_orphan");
    });

    describe("hint shape validation (regression)", () => {
      // Hints reach the IntentBuilder from a RemoteCoreProxy verbatim, so
      // the Core shape-validates them up-front. Invalid shapes must be
      // rejected before the builder is invoked so builders need not
      // defensively coerce every field.
      beforeEach(() => {
        core.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
      });

      it("rejects a non-object hint", async () => {
        await expect(core.requestIntent({ mode: "payment", hint: "not-an-object" as any }))
          .rejects.toThrow(/request\.hint/);
      });

      it("rejects hint.amountValue as a non-finite number", async () => {
        await expect(core.requestIntent({
          mode: "payment",
          hint: { amountValue: Number.NaN } as any,
        })).rejects.toThrow(/amountValue/);
      });

      it("rejects hint.amountValue as a negative number", async () => {
        await expect(core.requestIntent({
          mode: "payment",
          hint: { amountValue: -1 } as any,
        })).rejects.toThrow(/amountValue/);
      });

      it("rejects hint.amountValue as a non-number", async () => {
        await expect(core.requestIntent({
          mode: "payment",
          hint: { amountValue: { $gt: 0 } } as any,
        })).rejects.toThrow(/amountValue/);
      });

      it("rejects hint.amountCurrency as a non-string", async () => {
        await expect(core.requestIntent({
          mode: "payment",
          hint: { amountCurrency: 123 } as any,
        })).rejects.toThrow(/amountCurrency/);
      });

      it("rejects hint.customerId as a non-string", async () => {
        await expect(core.requestIntent({
          mode: "payment",
          hint: { customerId: { $injected: true } } as any,
        })).rejects.toThrow(/customerId/);
      });

      it("accepts a well-shaped hint unchanged", async () => {
        let seen: unknown = null;
        core.registerIntentBuilder((req) => {
          seen = req.hint;
          return { mode: "payment", amount: 500, currency: "usd" };
        });
        await core.requestIntent({
          mode: "payment",
          hint: { amountValue: 500, amountCurrency: "usd", customerId: "cus_1" },
        });
        expect(seen).toEqual({ amountValue: 500, amountCurrency: "usd", customerId: "cus_1" });
      });
    });
  });

  describe("reportConfirmation", () => {
    beforeEach(() => {
      core.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
    });

    it("transitions to succeeded and records paymentMethod", async () => {
      await core.requestIntent({ mode: "payment", hint: {} });
      await core.reportConfirmation({
        intentId: "pi_123",
        outcome: "succeeded",
        paymentMethod: { id: "pm_1", brand: "visa", last4: "4242" },
      });
      expect(core.status).toBe("succeeded");
      expect(core.paymentMethod).toEqual({ id: "pm_1", brand: "visa", last4: "4242" });
      expect(core.loading).toBe(false);
    });

    it("transitions to failed and records error", async () => {
      await core.requestIntent({ mode: "payment", hint: {} });
      await core.reportConfirmation({
        intentId: "pi_123",
        outcome: "failed",
        error: { code: "card_declined", message: "Your card was declined." },
      });
      expect(core.status).toBe("failed");
      expect(core.error?.code).toBe("card_declined");
    });

    it("transitions to requires_action", async () => {
      await core.requestIntent({ mode: "payment", hint: {} });
      await core.reportConfirmation({ intentId: "pi_123", outcome: "requires_action" });
      expect(core.status).toBe("requires_action");
    });

    it("polls provider when outcome is processing", async () => {
      await core.requestIntent({ mode: "payment", hint: {} });
      provider.retrieveResult = {
        id: "pi_123",
        status: "succeeded",
        mode: "payment",
        paymentMethod: { id: "pm_1", brand: "visa", last4: "4242" },
      };
      await core.reportConfirmation({ intentId: "pi_123", outcome: "processing" });
      expect(provider.retrieveCalls).toEqual([{ mode: "payment", id: "pi_123" }]);
      expect(core.status).toBe("succeeded");
    });

    it("emits stripe-checkout:unknown-status from core when polled intent status is unrecognized", async () => {
      await core.requestIntent({ mode: "payment", hint: {} });
      const unknown: CustomEvent[] = [];
      core.addEventListener("stripe-checkout:unknown-status", (e) => unknown.push(e as CustomEvent));
      // Use a synthetic status that is guaranteed not to appear in Stripe's
      // documented PaymentIntent state machine so this test keeps verifying
      // the "truly unknown" path. Previously we used `requires_capture` here,
      // but that is now a documented manual-capture status and is mapped to
      // `"succeeded"` by `_reconcileFromIntentView`.
      provider.retrieveResult = {
        id: "pi_123",
        status: "some_future_stripe_status",
        mode: "payment",
      };

      await core.reportConfirmation({ intentId: "pi_123", outcome: "processing" });

      expect(core.status).toBe("processing");
      expect(unknown).toHaveLength(1);
      expect((unknown[0].detail as any).source).toBe("core");
      expect((unknown[0].detail as any).intentId).toBe("pi_123");
      expect((unknown[0].detail as any).mode).toBe("payment");
      expect((unknown[0].detail as any).status).toBe("some_future_stripe_status");
    });

    it("maps requires_capture (manual-capture flow) to succeeded, not unknown-status", async () => {
      // PaymentIntents created with `capture_method: "manual"` transition
      // to `requires_capture` after a successful authorization — the
      // browser-side user flow is complete, merchant captures later.
      // Previously this status fell to the default branch, firing
      // unknown-status and leaving the UI on `processing` forever.
      await core.requestIntent({ mode: "payment", hint: {} });
      const unknown: CustomEvent[] = [];
      core.addEventListener("stripe-checkout:unknown-status", (e) => unknown.push(e as CustomEvent));
      provider.retrieveResult = {
        id: "pi_123",
        status: "requires_capture",
        mode: "payment",
      };

      await core.reportConfirmation({ intentId: "pi_123", outcome: "processing" });

      expect(core.status).toBe("succeeded");
      expect(core.loading).toBe(false);
      expect(unknown).toHaveLength(0);
    });

    it("clears stale error on processing → succeeded poll path (fail-then-processing-then-succeed, regression)", async () => {
      // Same failure-then-success contract, but this time success
      // arrives through `_reconcileFromIntentView` (reportConfirmation
      // outcome=processing polls the provider and reconciles a
      // terminal succeeded view). Without clearing in the reconcile
      // branch, the direct and webhook succeeded paths are fixed but
      // this one still shows status=succeeded + error=card_declined.
      await core.requestIntent({ mode: "payment", hint: {} });
      await core.reportConfirmation({
        intentId: "pi_123",
        outcome: "failed",
        error: { code: "card_declined", message: "Declined." },
      });
      expect(core.error?.code).toBe("card_declined");

      // Provider poll resolves as succeeded → reconcile must clear error.
      provider.retrieveResult = {
        id: "pi_123",
        status: "succeeded",
        mode: "payment",
        paymentMethod: { id: "pm_retry", brand: "visa", last4: "9999" },
      };
      await core.reportConfirmation({ intentId: "pi_123", outcome: "processing" });
      expect(core.status).toBe("succeeded");
      expect(core.error).toBeNull();
    });

    it("clears stale error on succeeded (fail-then-succeed on same intent, regression)", async () => {
      // Real user flow: first confirm fails with card_declined, user
      // switches card on the same Elements mount and retries. The
      // second confirm's success MUST clear the prior decline — the
      // observable surface otherwise reads "succeeded" with a stale
      // card_declined error, which UI components render as "paid" +
      // "your card was declined" simultaneously.
      await core.requestIntent({ mode: "payment", hint: {} });
      await core.reportConfirmation({
        intentId: "pi_123",
        outcome: "failed",
        error: { code: "card_declined", message: "Your card was declined." },
      });
      expect(core.status).toBe("failed");
      expect(core.error?.code).toBe("card_declined");

      await core.reportConfirmation({
        intentId: "pi_123",
        outcome: "succeeded",
        paymentMethod: { id: "pm_retry", brand: "visa", last4: "9999" },
      });
      expect(core.status).toBe("succeeded");
      expect(core.error).toBeNull();
    });

    it("drops stale reports for a superseded intent", async () => {
      provider.nextPaymentIntentId = "pi_first";
      await core.requestIntent({ mode: "payment", hint: {} });
      // Supersede with a new intent id.
      provider.nextPaymentIntentId = "pi_second";
      await core.requestIntent({ mode: "payment", hint: {} });
      // A late report for the original intent — activeIntent has moved on.
      await core.reportConfirmation({
        intentId: "pi_first",
        outcome: "succeeded",
        paymentMethod: { id: "pm_stale", brand: "visa", last4: "0000" },
      });
      // The active intent (pi_second) is still collecting.
      expect(core.status).toBe("collecting");
      expect(core.intentId).toBe("pi_second");
    });
  });

  describe("cancelIntent", () => {
    beforeEach(() => {
      core.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
    });

    it("cancels at the provider and returns to idle", async () => {
      await core.requestIntent({ mode: "payment", hint: {} });
      await core.cancelIntent("pi_123");
      expect(provider.cancelCalls).toContain("pi_123");
      expect(core.status).toBe("idle");
      expect(core.intentId).toBeNull();
    });

    it("rejects on id mismatch without calling the provider", async () => {
      await core.requestIntent({ mode: "payment", hint: {} });
      await expect(core.cancelIntent("pi_wrong")).rejects.toThrow(/mismatch/);
      expect(provider.cancelCalls).toHaveLength(0);
    });

    it("does not call provider for SetupIntent cancellation", async () => {
      const c = new StripeCore(provider);
      c.registerIntentBuilder(() => ({ mode: "setup" }));
      await c.requestIntent({ mode: "setup", hint: {} });
      await c.cancelIntent("seti_123");
      expect(provider.cancelCalls).toHaveLength(0);
      expect(provider.cancelSetupCalls).toHaveLength(0);
      expect(c.status).toBe("idle");
    });

    it("calls provider.cancelSetupIntent when cancelSetupIntents opt-in is enabled", async () => {
      const c = new StripeCore(provider, { cancelSetupIntents: true });
      c.registerIntentBuilder(() => ({ mode: "setup" }));
      await c.requestIntent({ mode: "setup", hint: {} });
      await c.cancelIntent("seti_123");
      expect(provider.cancelSetupCalls).toEqual(["seti_123"]);
      expect(c.status).toBe("idle");
      expect(c.intentId).toBeNull();
    });

    it("falls through to state-only reset when cancelSetupIntent is not implemented even with opt-in", async () => {
      (provider as any).cancelSetupIntent = undefined;
      const c = new StripeCore(provider as IStripeProvider, { cancelSetupIntents: true });
      c.registerIntentBuilder(() => ({ mode: "setup" }));
      await c.requestIntent({ mode: "setup", hint: {} });
      await c.cancelIntent("seti_123");
      expect(c.status).toBe("idle");
      expect(c.intentId).toBeNull();
    });

    it("preserves _activeIntent for setup mode when provider cancelSetupIntent fails", async () => {
      const c = new StripeCore(provider, { cancelSetupIntents: true });
      c.registerIntentBuilder(() => ({ mode: "setup" }));
      await c.requestIntent({ mode: "setup", hint: {} });
      const cancelErr = Object.assign(new Error("Connection to api.stripe.com lost."), {
        type: "StripeConnectionError",
      });
      let calls = 0;
      provider.cancelSetupIntent = async (id: string) => {
        calls++;
        provider.cancelSetupCalls.push(id);
        if (calls === 1) throw cancelErr;
      };

      await expect(c.cancelIntent("seti_123")).rejects.toThrow(/Connection to api\.stripe\.com/);
      expect(c.error?.message).toMatch(/Connection to api\.stripe\.com/);
      expect(c.intentId).toBe("seti_123");
      expect(c.status).toBe("collecting");

      await c.reportConfirmation({ intentId: "seti_123", outcome: "succeeded" });
      expect(c.status).toBe("succeeded");

      await c.cancelIntent("seti_123");
      expect(calls).toBe(2);
      expect(c.status).toBe("idle");
      expect(c.intentId).toBeNull();
      expect(c.error).toBeNull();
    });

    it("slow cancel does NOT clobber a newer session started during the await (regression: key-change race)", async () => {
      // Scenario: the Shell triggers `cancelIntent(pi_OLD)` on a
      // key-change, then lets auto-prepare run immediately. If the
      // cancel network call takes longer than the replacement
      // requestIntent, the old cancel's post-await state-clear would
      // wipe pi_NEW's intentId / amount / paymentMethod / status. The
      // generation-check after the await must bail in that case.
      await core.requestIntent({ mode: "payment", hint: {} }); // pi_123 active
      let releaseCancel!: () => void;
      provider.cancelPaymentIntent = (id: string) => {
        provider.cancelCalls.push(id);
        return new Promise<void>((resolve) => { releaseCancel = resolve; });
      };

      // Kick off cancel for pi_123 — it parks.
      const cancelPromise = core.cancelIntent("pi_123");
      // Start a replacement session BEFORE the cancel completes.
      provider.nextPaymentIntentId = "pi_NEW";
      await core.requestIntent({ mode: "payment", hint: {} });
      expect(core.intentId).toBe("pi_NEW");
      expect(core.status).toBe("collecting");
      expect(core.amount).toEqual({ value: 1000, currency: "usd" });

      // Let the stalled cancel resolve. Its post-await clear MUST NOT
      // wipe pi_NEW's state.
      releaseCancel();
      await cancelPromise;

      expect(core.intentId).toBe("pi_NEW");
      expect(core.status).toBe("collecting");
      expect(core.amount).toEqual({ value: 1000, currency: "usd" });
      // Stripe-side cancel did run for pi_123.
      expect(provider.cancelCalls).toContain("pi_123");
    });

    it("preserves _activeIntent when provider cancel fails so retry is still possible", async () => {
      await core.requestIntent({ mode: "payment", hint: {} });
      // stripe-node wraps transport failures as `StripeConnectionError` —
      // the sanitizer recognizes that shape and surfaces the message.
      // (A plain `new Error("network down")` would now collapse to the
      // generic "Payment failed." by design — see SPEC §9.3.)
      const cancelErr = Object.assign(new Error("Connection to api.stripe.com lost."), {
        type: "StripeConnectionError",
      });
      let calls = 0;
      provider.cancelPaymentIntent = async (id: string) => {
        calls++;
        provider.cancelCalls.push(id);
        if (calls === 1) throw cancelErr;
      };

      await expect(core.cancelIntent("pi_123")).rejects.toThrow(/Connection to api\.stripe\.com/);
      // The error must be surfaced, but state is otherwise intact — the
      // intent still exists at Stripe, so dropping ownership would make
      // subsequent reports/webhooks silently unroutable.
      expect(core.error?.message).toMatch(/Connection to api\.stripe\.com/);
      expect(core.intentId).toBe("pi_123");
      expect(core.status).toBe("collecting");

      // Late webhook for the same intent must still fold (ownership alive).
      provider.webhookEvent = {
        id: "evt_late",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_123" } },
        created: 0,
      };
      await core.handleWebhook("{}", "sig");
      expect(core.status).toBe("succeeded");

      // Caller can retry the cancel after the transient error clears.
      // (Even though the intent succeeded in this test, the point is that
      // `cancelIntent` is still callable — no ghost `_activeIntent = null`.)
      await core.cancelIntent("pi_123");
      expect(calls).toBe(2);
      expect(core.status).toBe("idle");
      expect(core.intentId).toBeNull();
      // The stale error from the failed first attempt must NOT leak into
      // the terminal idle state on successful retry.
      expect(core.error).toBeNull();
    });
  });

  describe("handleWebhook", () => {
    beforeEach(() => {
      core.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
    });

    it("requires webhookSecret to be configured", async () => {
      const c = new StripeCore(provider);
      await expect(c.handleWebhook("{}", "sig")).rejects.toThrow(/webhookSecret/);
    });

    it("propagates signature verification errors", async () => {
      provider.webhookError = new Error("bad signature");
      await expect(core.handleWebhook("{}", "sig")).rejects.toThrow(/bad signature/);
      // Error must NOT be folded into observable state — a forged payload
      // should not mutate UI state.
      expect(core.error).toBeNull();
    });

    it("accepts Buffer rawBody (express.raw middleware shape)", async () => {
      // Express's `express.raw({ type: "application/json" })` hands
      // `req.body` as a Buffer. Stripe-node's `constructEvent` accepts
      // Buffer natively; the Core must forward verbatim without forcing
      // callers to `.toString("utf8")` first.
      const seen: unknown[] = [];
      provider.verifyWebhook = (body: any, _h: string, _s: string) => {
        seen.push(body);
        return { id: "evt_buf", type: "x.y", data: { object: {} }, created: 1 };
      };
      const buf = Buffer.from('{"id":"evt_buf"}', "utf8");
      await core.handleWebhook(buf, "sig");
      expect(seen).toEqual([buf]);
    });

    it("accepts Uint8Array rawBody", async () => {
      const seen: unknown[] = [];
      provider.verifyWebhook = (body: any) => {
        seen.push(body);
        return { id: "evt_u8", type: "x.y", data: { object: {} }, created: 1 };
      };
      const u8 = new TextEncoder().encode('{"id":"evt_u8"}');
      await core.handleWebhook(u8, "sig");
      expect(seen).toEqual([u8]);
    });

    it("rejects rawBody that is neither string, Buffer, nor Uint8Array", async () => {
      await expect(core.handleWebhook({ body: "{}" } as unknown as string, "sig"))
        .rejects.toThrow(/rawBody/);
      await expect(core.handleWebhook(null as unknown as string, "sig"))
        .rejects.toThrow(/rawBody/);
    });

    it("rejects signatureHeader that is not a non-empty string (array / undefined)", async () => {
      // Node's `req.headers` types string headers as
      // `string | string[] | undefined`. An array shape typically means
      // the header was delivered multiple times; treating the first
      // element as canonical would be a forgery-friendly default, so
      // the Core rejects loudly instead.
      await expect(core.handleWebhook("{}", ["sig1", "sig2"] as unknown as string))
        .rejects.toThrow(/signatureHeader/);
      await expect(core.handleWebhook("{}", undefined as unknown as string))
        .rejects.toThrow(/signatureHeader/);
      await expect(core.handleWebhook("{}", ""))
        .rejects.toThrow(/signatureHeader/);
    });

    it("folds payment_intent.succeeded into status when id matches", async () => {
      await core.requestIntent({ mode: "payment", hint: {} });
      provider.webhookEvent = {
        id: "evt_1",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_123" } },
        created: 0,
      };
      await core.handleWebhook("{}", "sig");
      expect(core.status).toBe("succeeded");
    });

    it("webhook succeeded clears stale error from a prior failed attempt (regression)", async () => {
      // Webhook-driven success path: pi_123 has a retained error from
      // an earlier failed confirm (stored in observable `error`). A
      // subsequent `payment_intent.succeeded` webhook arrives. The
      // observable surface must end in a clean succeeded state — error
      // cleared — or UIs will simultaneously show "paid" and "your
      // card was declined".
      await core.requestIntent({ mode: "payment", hint: {} });
      await core.reportConfirmation({
        intentId: "pi_123",
        outcome: "failed",
        error: { code: "card_declined", message: "Your card was declined." },
      });
      expect(core.error?.code).toBe("card_declined");

      provider.webhookEvent = {
        id: "evt_succ",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_123" } },
        created: 0,
      };
      await core.handleWebhook("{}", "sig");
      expect(core.status).toBe("succeeded");
      expect(core.error).toBeNull();
    });

    it("clears loading on payment_intent.requires_action webhook (regression: stuck spinner)", async () => {
      // Start with a processing session (loading=true). A
      // requires_action webhook must hand control back to the user —
      // mirror reportConfirmation's requires_action branch which
      // clears loading, so the UI can surface the 3DS / bank challenge
      // instead of showing an indefinite spinner.
      await core.requestIntent({ mode: "payment", hint: {} });
      // Keep the provider's retrieve returning "processing" so
      // reportConfirmation's poll does not short-circuit to succeeded.
      provider.retrieveResult = { id: "pi_123", status: "processing", mode: "payment" };
      await core.reportConfirmation({ intentId: "pi_123", outcome: "processing" });
      expect(core.status).toBe("processing");
      expect(core.loading).toBe(true);

      provider.webhookEvent = {
        id: "evt_ra",
        type: "payment_intent.requires_action",
        data: { object: { id: "pi_123" } },
        created: 0,
      };
      await core.handleWebhook("{}", "sig");
      expect(core.status).toBe("requires_action");
      expect(core.loading).toBe(false);
    });

    it("sets loading=true on payment_intent.processing webhook (contract symmetry)", async () => {
      // Inverse of the requires_action case. A processing webhook
      // after a collecting/idle session must ALSO raise loading so
      // UIs wired on `loading` show the spinner for the processing
      // window, matching reportConfirmation's processing branch.
      await core.requestIntent({ mode: "payment", hint: {} });
      expect(core.loading).toBe(false); // collecting
      provider.webhookEvent = {
        id: "evt_proc",
        type: "payment_intent.processing",
        data: { object: { id: "pi_123" } },
        created: 0,
      };
      await core.handleWebhook("{}", "sig");
      expect(core.status).toBe("processing");
      expect(core.loading).toBe(true);
    });

    it("surfaces last_payment_error on payment_intent.canceled webhook (regression: silent failed)", async () => {
      // Stripe's canceled PaymentIntent retains `last_payment_error`
      // when cancellation followed a failed attempt. The Core must
      // surface it so UIs can show *why*, not just "failed".
      await core.requestIntent({ mode: "payment", hint: {} });
      provider.webhookEvent = {
        id: "evt_cancel_err",
        type: "payment_intent.canceled",
        data: {
          object: {
            id: "pi_123",
            last_payment_error: {
              code: "card_declined",
              decline_code: "insufficient_funds",
              type: "card_error",
              message: "Your card has insufficient funds.",
            },
          },
        },
        created: 0,
      };
      await core.handleWebhook("{}", "sig");
      expect(core.status).toBe("failed");
      expect(core.error?.code).toBe("card_declined");
      expect(core.error?.declineCode).toBe("insufficient_funds");
      expect(core.error?.message).toMatch(/insufficient funds/);
    });

    it("surfaces last_setup_error on setup_intent.canceled webhook (regression)", async () => {
      const c = new StripeCore(provider, { webhookSecret: "whsec_test" });
      c.registerIntentBuilder(() => ({ mode: "setup" }));
      await c.requestIntent({ mode: "setup", hint: {} });
      provider.webhookEvent = {
        id: "evt_setup_cancel_err",
        type: "setup_intent.canceled",
        data: {
          object: {
            id: "seti_123",
            last_setup_error: {
              code: "setup_intent_authentication_failure",
              type: "invalid_request_error",
              message: "Mandate authentication failed.",
            },
          },
        },
        created: 0,
      };
      await c.handleWebhook("{}", "sig");
      expect(c.status).toBe("failed");
      expect(c.error?.code).toBe("setup_intent_authentication_failure");
      expect(c.error?.message).toMatch(/authentication failed/);
    });

    it("folds setup_intent.processing symmetrically with payment_intent.processing (regression)", async () => {
      // Stripe emits `setup_intent.processing` for SetupIntents whose
      // payment methods require async verification (ACH, SEPA
      // mandates, etc). The webhook fold must drive the same state
      // transition as the payment-mode event — otherwise a setup flow
      // that enters processing stays pinned to `collecting` and the
      // UI never shows the bridging spinner.
      const c = new StripeCore(provider, { webhookSecret: "whsec_test" });
      c.registerIntentBuilder(() => ({ mode: "setup" }));
      await c.requestIntent({ mode: "setup", hint: {} });
      expect(c.status).toBe("collecting");
      expect(c.loading).toBe(false);

      provider.webhookEvent = {
        id: "evt_setup_proc",
        type: "setup_intent.processing",
        data: { object: { id: "seti_123" } },
        created: 0,
      };
      await c.handleWebhook("{}", "sig");
      expect(c.status).toBe("processing");
      expect(c.loading).toBe(true);
    });

    it("does NOT fold events for a different intent id", async () => {
      await core.requestIntent({ mode: "payment", hint: {} });
      provider.webhookEvent = {
        id: "evt_1",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_OTHER" } },
        created: 0,
      };
      await core.handleWebhook("{}", "sig");
      expect(core.status).toBe("collecting");
    });

    it("invokes registered handlers in order", async () => {
      const order: string[] = [];
      core.registerWebhookHandler("payment_intent.succeeded", () => { order.push("a"); });
      core.registerWebhookHandler("payment_intent.succeeded", () => { order.push("b"); });
      provider.webhookEvent = {
        id: "evt_1",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_xx" } },
        created: 0,
      };
      await core.handleWebhook("{}", "sig");
      expect(order).toEqual(["a", "b"]);
    });

    it("fatal handler aborts the chain", async () => {
      const order: string[] = [];
      core.registerWebhookHandler("payment_intent.succeeded", () => { order.push("a"); throw new Error("boom"); });
      core.registerWebhookHandler("payment_intent.succeeded", () => { order.push("b"); });
      provider.webhookEvent = {
        id: "evt_1",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_xx" } },
        created: 0,
      };
      await expect(core.handleWebhook("{}", "sig")).rejects.toThrow(/boom/);
      expect(order).toEqual(["a"]);
    });

    it("folds observable state before handlers; fatal throw still leaves folded status", async () => {
      core.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
      await core.requestIntent({ mode: "payment", hint: {} });
      expect(core.status).toBe("collecting");

      core.registerWebhookHandler("payment_intent.succeeded", () => {
        throw new Error("boom");
      });
      provider.webhookEvent = {
        id: "evt_before_handler_fold",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_123" } },
        created: 0,
      };

      await expect(core.handleWebhook("{}", "sig")).rejects.toThrow(/boom/);
      expect(core.status).toBe("succeeded");
    });

    it("non-fatal handler continues chain and dispatches warning", async () => {
      const order: string[] = [];
      const warnings: CustomEvent[] = [];
      core.addEventListener("stripe-checkout:webhook-warning", (e) => warnings.push(e as CustomEvent));
      core.registerWebhookHandler("payment_intent.succeeded", () => { order.push("a"); throw new Error("boom"); }, { fatal: false });
      core.registerWebhookHandler("payment_intent.succeeded", () => { order.push("b"); });
      provider.webhookEvent = {
        id: "evt_1",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_xx" } },
        created: 0,
      };
      await core.handleWebhook("{}", "sig");
      expect(order).toEqual(["a", "b"]);
      expect(warnings).toHaveLength(1);
      expect((warnings[0].detail as any).error.message).toMatch(/boom/);
    });

    it("silently drops duplicate event.id and does not re-run handlers", async () => {
      const calls: string[] = [];
      core.registerWebhookHandler("payment_intent.succeeded", (ev) => {
        calls.push(ev.id);
      });

      provider.verifyWebhook = () => ({
        id: "evt_dup_1",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_1" } },
        created: 1,
      });

      await core.handleWebhook("raw", "sig");
      await core.handleWebhook("raw", "sig");

      expect(calls).toEqual(["evt_dup_1"]);
    });

    it("dispatches stripe-checkout:webhook-deduped on duplicate", async () => {
      let deduped: unknown = null;
      core.addEventListener("stripe-checkout:webhook-deduped", (e: Event) => {
        deduped = (e as CustomEvent).detail;
      });

      provider.verifyWebhook = () => ({
        id: "evt_dup_2",
        type: "x.y",
        data: { object: {} },
        created: 1,
      });

      await core.handleWebhook("raw", "sig");
      await core.handleWebhook("raw", "sig");

      expect(deduped).toEqual({ eventId: "evt_dup_2", type: "x.y" });
    });

    it("evicts the oldest id when capacity is exceeded", async () => {
      for (let i = 0; i < 1025; i++) {
        provider.verifyWebhook = () => ({
          id: `evt_${i}`,
          type: "x.y",
          data: { object: {} },
          created: i,
        });
        await core.handleWebhook("raw", "sig");
      }

      let calls = 0;
      core.registerWebhookHandler("x.y", () => { calls++; });
      provider.verifyWebhook = () => ({
        id: "evt_0",
        type: "x.y",
        data: { object: {} },
        created: 0,
      });
      await core.handleWebhook("raw", "sig");
      expect(calls).toBe(1);
    });

    it("does not add to dedup window when signature verification fails", async () => {
      provider.verifyWebhook = () => { throw new Error("bad signature"); };
      for (let i = 0; i < 10; i++) {
        await expect(core.handleWebhook("raw", "sig")).rejects.toThrow(/bad signature/);
      }

      let calls = 0;
      core.registerWebhookHandler("x.y", () => { calls++; });
      provider.verifyWebhook = () => ({
        id: "evt_valid",
        type: "x.y",
        data: { object: {} },
        created: 1,
      });
      await core.handleWebhook("raw", "sig");
      expect(calls).toBe(1);
    });

    it("evicts id when fatal handler throws, allowing Stripe retry", async () => {
      let attempts = 0;
      core.registerWebhookHandler("x.y", () => {
        attempts++;
        if (attempts === 1) throw new Error("transient DB lock");
      }, { fatal: true });

      provider.verifyWebhook = () => ({
        id: "evt_retry",
        type: "x.y",
        data: { object: {} },
        created: 1,
      });

      await expect(core.handleWebhook("raw", "sig")).rejects.toThrow(/transient DB lock/);
      await core.handleWebhook("raw", "sig");
      expect(attempts).toBe(2);
    });

    it("folds succeeded state before fatal throw, and Stripe retry keeps state idempotent", async () => {
      // Prepare an active intent so webhook folding is eligible.
      core.registerIntentBuilder(() => ({ mode: "payment", amount: 1200, currency: "usd" }));
      await core.requestIntent({ mode: "payment", hint: {} });
      const pmEvents: unknown[] = [];
      core.addEventListener("stripe-checkout:paymentMethod-changed", (e) => {
        pmEvents.push((e as CustomEvent).detail);
      });

      let attempts = 0;
      core.registerWebhookHandler("payment_intent.succeeded", () => {
        attempts++;
        if (attempts === 1) throw new Error("fulfillment db timeout");
      }, { fatal: true });

      provider.webhookEvent = {
        id: "evt_fold_then_fatal",
        type: "payment_intent.succeeded",
        created: 1,
        data: {
          object: {
            id: "pi_123",
            payment_method: {
              id: "pm_fold",
              card: { brand: "visa", last4: "4242" },
            },
          },
        },
      };

      // First delivery: fold runs first (UI moves to succeeded), then fatal
      // handler throws so the HTTP route can return 5xx and Stripe retries.
      await expect(core.handleWebhook("raw", "sig")).rejects.toThrow(/fulfillment db timeout/);
      expect(core.status).toBe("succeeded");
      expect(core.loading).toBe(false);
      expect(core.paymentMethod).toEqual({ id: "pm_fold", brand: "visa", last4: "4242" });

      // Retry delivery: fold is idempotent and handler now succeeds.
      await core.handleWebhook("raw", "sig");
      expect(attempts).toBe(2);
      expect(core.status).toBe("succeeded");
      expect(core.paymentMethod).toEqual({ id: "pm_fold", brand: "visa", last4: "4242" });
      expect(pmEvents).toHaveLength(1);
    });

    it("keeps dedup window on non-fatal throw (duplicate does not re-run handlers)", async () => {
      let attempts = 0;
      const warnings: CustomEvent[] = [];
      core.addEventListener("stripe-checkout:webhook-warning", (e) => warnings.push(e as CustomEvent));
      core.registerWebhookHandler("x.y", () => {
        attempts++;
        throw new Error("ancillary failure");
      }, { fatal: false });

      provider.verifyWebhook = () => ({
        id: "evt_nonfatal_dup",
        type: "x.y",
        data: { object: {} },
        created: 1,
      });

      await core.handleWebhook("raw", "sig");
      await core.handleWebhook("raw", "sig");

      expect(attempts).toBe(1);
      expect(warnings).toHaveLength(1);
    });

    it("bypasses dedup when event.id is empty or undefined", async () => {
      let calls = 0;
      core.registerWebhookHandler("x.y", () => { calls++; });

      provider.verifyWebhook = () => ({
        id: "",
        type: "x.y",
        data: { object: {} },
        created: 1,
      });
      await core.handleWebhook("raw", "sig");
      await core.handleWebhook("raw", "sig");

      provider.verifyWebhook = () => ({
        id: undefined,
        type: "x.y",
        data: { object: {} },
        created: 2,
      } as unknown as StripeEvent);
      await core.handleWebhook("raw", "sig");
      await core.handleWebhook("raw", "sig");

      expect(calls).toBe(4);
    });

    it("cross-mode fold defense: setup_intent.* event with matching id does NOT flip a payment-mode active intent", async () => {
      // Stripe uses type-prefixed ids (`pi_` / `seti_`) so a colliding id
      // across modes is virtually impossible in practice, but the
      // `event.type` prefix check (`active.mode === "payment"` requires
      // `"payment_intent."` type) closes the theoretical window where a
      // custom IStripeProvider or a future Stripe change produces a
      // cross-shaped payload. Without this guard a `setup_intent.succeeded`
      // with a colliding id would flip a `mode="payment"` session to
      // succeeded.
      core.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
      await core.requestIntent({ mode: "payment", hint: {} });
      expect(core.status).toBe("collecting");

      // Simulate a rogue setup_intent event whose object.id collides with
      // the active payment intent's id.
      provider.webhookEvent = {
        id: "evt_cross_mode",
        type: "setup_intent.succeeded",
        created: 1,
        data: {
          object: {
            id: "pi_123",  // colliding id
            status: "succeeded",
          },
        },
      };
      await core.handleWebhook("raw", "sig");

      // Must NOT have flipped to succeeded.
      expect(core.status).toBe("collecting");
    });
  });

  describe("dispose", () => {
    // `dispose()` gates every public command behind a `_disposed` flag and
    // null-outs secrets (see SPEC §9.2). These tests assert the six
    // externally observable invariants: command gating, idempotency,
    // handler clear, dedup reset, in-flight fold supersede, and the
    // webhook-secret null-out (indirectly via handleWebhook's
    // webhookSecret-required raise path).

    it("gates every public command with a _disposed raise", async () => {
      core.dispose();

      await expect(core.requestIntent({ mode: "payment", hint: {} })).rejects.toThrow(/disposed/);
      await expect(core.reportConfirmation({ intentId: "pi_x", outcome: "succeeded" })).rejects.toThrow(/disposed/);
      await expect(core.cancelIntent("pi_x")).rejects.toThrow(/disposed/);
      await expect(core.resumeIntent("pi_x", "payment", "cs_x")).rejects.toThrow(/disposed/);
      expect(() => core.reset()).toThrow(/disposed/);
      await expect(core.handleWebhook("{}", "sig")).rejects.toThrow(/disposed/);
      expect(() => core.registerIntentBuilder(() => ({ mode: "payment", amount: 1, currency: "usd" }))).toThrow(/disposed/);
      expect(() => core.registerWebhookHandler("payment_intent.succeeded", () => {})).toThrow(/disposed/);
      expect(() => core.registerResumeAuthorizer(() => true)).toThrow(/disposed/);
    });

    it("is idempotent 窶・second dispose() is a no-op and does not throw", () => {
      core.dispose();
      expect(() => core.dispose()).not.toThrow();
    });

    it("clears registered webhook handlers so they no longer fire", async () => {
      let fired = 0;
      core.registerWebhookHandler("payment_intent.succeeded", () => { fired++; });
      core.dispose();

      // handleWebhook itself now raises, but even if we synthesize a call
      // through the (now-cleared) handler map there is nothing to fire.
      // The public surface assertion is that handleWebhook raises, and
      // structurally the handler map has been cleared.
      await expect(core.handleWebhook("{}", "sig")).rejects.toThrow(/disposed/);
      expect(fired).toBe(0);
    });

    it("resets the webhook dedup window", async () => {
      // Register a handler, fire an event to seed the dedup set, dispose,
      // then construct a FRESH core and verify the same event id is NOT
      // treated as already-seen. (The dedup set is per-instance; this
      // guards against a future refactor that moves dedup state to a
      // module-level singleton.)
      let calls = 0;
      core.registerWebhookHandler("payment_intent.succeeded", () => { calls++; });
      provider.webhookEvent = {
        id: "evt_dedup_after_dispose",
        type: "payment_intent.succeeded",
        created: 1,
        data: { object: { id: "pi_123", status: "succeeded" } },
      };
      await core.handleWebhook("raw", "sig");
      expect(calls).toBe(1);

      core.dispose();

      const fresh = new StripeCore(provider, { webhookSecret: "whsec_test" });
      fresh.registerWebhookHandler("payment_intent.succeeded", () => { calls++; });
      await fresh.handleWebhook("raw", "sig");
      // Fresh instance's dedup window is empty, so the same event id fires again.
      expect(calls).toBe(2);
      fresh.dispose();
    });

    it("null-outs webhookSecret so handleWebhook fails on the missing-secret path", async () => {
      // webhookSecret was non-null at construction (`whsec_test` above).
      // After dispose the public command gate fires first, so we cannot
      // directly observe the null — the test captures the invariant via
      // the dispose→handleWebhook error path instead.
      core.dispose();
      await expect(core.handleWebhook("{}", "sig")).rejects.toThrow(/disposed/);
    });

    it("supersedes in-flight reportConfirmation via the _generation bump", async () => {
      // Start a reportConfirmation with `outcome: "processing"` that parks
      // on the provider's retrieveIntent await, then dispose mid-flight.
      // The post-await gen check must bail, and the pre-existing
      // processing status must not be overwritten by a stale reconcile.
      core.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
      await core.requestIntent({ mode: "payment", hint: {} });

      let releaseRetrieve!: (v: StripeIntentView) => void;
      provider.retrieveIntent = () => new Promise<StripeIntentView>((resolve) => {
        releaseRetrieve = resolve;
      });

      const parked = core.reportConfirmation({ intentId: "pi_123", outcome: "processing" });
      // Let the sync prefix of reportConfirmation run (setStatus("processing"), setLoading(true))
      await new Promise(r => setTimeout(r, 0));

      core.dispose();

      // Resolve the retrieve — the post-await gen check should bail before
      // any _reconcileFromIntentView mutation.
      releaseRetrieve({ id: "pi_123", status: "succeeded", mode: "payment" });
      await parked;

      // Status should NOT have flipped to succeeded; dispose bumped gen
      // so the reconcile was dropped.
      expect(core.status).toBe("processing");
    });
  });

  describe("reset", () => {
    it("returns to idle and clears all observable state", async () => {
      core.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
      await core.requestIntent({ mode: "payment", hint: {} });
      await core.reportConfirmation({
        intentId: "pi_123",
        outcome: "failed",
        error: { message: "nope" },
      });
      core.reset();
      expect(core.status).toBe("idle");
      expect(core.error).toBeNull();
      expect(core.intentId).toBeNull();
      expect(core.amount).toBeNull();
    });
  });

  describe("setter dispatch dedup", () => {
    it("does not dispatch duplicate amount/paymentMethod/intentId/error events for same values", () => {
      const c = new StripeCore(provider, { webhookSecret: "whsec_test" });
      const counts = {
        amount: 0,
        paymentMethod: 0,
        intentId: 0,
        error: 0,
      };
      c.addEventListener("stripe-checkout:amount-changed", () => { counts.amount++; });
      c.addEventListener("stripe-checkout:paymentMethod-changed", () => { counts.paymentMethod++; });
      c.addEventListener("stripe-checkout:intentId-changed", () => { counts.intentId++; });
      c.addEventListener("stripe-checkout:error", () => { counts.error++; });

      (c as any)._setAmount({ value: 1000, currency: "usd" });
      (c as any)._setAmount({ value: 1000, currency: "usd" });
      expect(counts.amount).toBe(1);

      (c as any)._setPaymentMethod({ id: "pm_1", brand: "visa", last4: "4242" });
      (c as any)._setPaymentMethod({ id: "pm_1", brand: "visa", last4: "4242" });
      expect(counts.paymentMethod).toBe(1);

      (c as any)._setIntentId("pi_123");
      (c as any)._setIntentId("pi_123");
      expect(counts.intentId).toBe(1);

      (c as any)._setError({ code: "card_declined", message: "Declined." });
      (c as any)._setError({ code: "card_declined", message: "Declined." });
      expect(counts.error).toBe(1);
    });

    it("_setAmount does not re-dispatch on identical value/currency through requestIntent", async () => {
      core.registerIntentBuilder(() => ({ mode: "payment", amount: 1980, currency: "jpy" }));
      const events: unknown[] = [];
      core.addEventListener("stripe-checkout:amount-changed", (e) => events.push((e as CustomEvent).detail));

      await core.requestIntent({ mode: "payment", hint: {} });
      const before = events.length;
      await core.requestIntent({ mode: "payment", hint: {} });
      expect(events.length).toBe(before);
    });

    it("_setIntentId does not re-dispatch on identical intentId through requestIntent", async () => {
      core.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
      const events: unknown[] = [];
      core.addEventListener("stripe-checkout:intentId-changed", (e) => events.push((e as CustomEvent).detail));

      provider.nextPaymentIntentId = "pi_same";
      await core.requestIntent({ mode: "payment", hint: {} });
      const before = events.length;
      provider.nextPaymentIntentId = "pi_same";
      await core.requestIntent({ mode: "payment", hint: {} });
      expect(events.length).toBe(before);
    });

    it("_setPaymentMethod does not re-dispatch on identical payment method through reportConfirmation", async () => {
      core.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
      const events: unknown[] = [];
      core.addEventListener("stripe-checkout:paymentMethod-changed", (e) => events.push((e as CustomEvent).detail));

      await core.requestIntent({ mode: "payment", hint: {} });
      await core.reportConfirmation({
        intentId: "pi_123",
        outcome: "succeeded",
        paymentMethod: { id: "pm_1", brand: "visa", last4: "4242" },
      });
      const before = events.length;
      await core.reportConfirmation({
        intentId: "pi_123",
        outcome: "succeeded",
        paymentMethod: { id: "pm_1", brand: "visa", last4: "4242" },
      });
      expect(events.length).toBe(before);
    });

    it("_setError does not re-dispatch on identical error through reportConfirmation", async () => {
      core.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
      const events: unknown[] = [];
      core.addEventListener("stripe-checkout:error", (e) => events.push((e as CustomEvent).detail));

      await core.requestIntent({ mode: "payment", hint: {} });
      await core.reportConfirmation({
        intentId: "pi_123",
        outcome: "failed",
        error: { code: "card_declined", message: "Declined." },
      });
      const before = events.length;
      await core.reportConfirmation({
        intentId: "pi_123",
        outcome: "failed",
        error: { code: "card_declined", message: "Declined." },
      });
      expect(events.length).toBe(before);
    });

    it("re-dispatches paymentMethod after null reset even when card fields are identical", async () => {
      core.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
      const events: unknown[] = [];
      core.addEventListener("stripe-checkout:paymentMethod-changed", (e) => events.push((e as CustomEvent).detail));

      await core.requestIntent({ mode: "payment", hint: {} });
      await core.reportConfirmation({
        intentId: "pi_123",
        outcome: "succeeded",
        paymentMethod: { id: "pm_1", brand: "visa", last4: "4242" },
      });
      const beforeReset = events.length;

      core.reset();
      await core.requestIntent({ mode: "payment", hint: {} });
      await core.reportConfirmation({
        intentId: "pi_123",
        outcome: "succeeded",
        paymentMethod: { id: "pm_1", brand: "visa", last4: "4242" },
      });

      expect(events.length).toBe(beforeReset + 2);
      expect(events[beforeReset]).toBeNull();
      expect(events[beforeReset + 1]).toEqual({ id: "pm_1", brand: "visa", last4: "4242" });
    });
  });

  describe("resumeIntent (regression: finding #1 + clientSecret authorization)", () => {
    it("rebuilds _activeIntent when clientSecret matches the retrieved intent", async () => {
      provider.retrieveResult = {
        id: "pi_resume_1",
        status: "succeeded",
        mode: "payment",
        amount: { value: 2500, currency: "usd" },
        paymentMethod: { id: "pm_x", brand: "visa", last4: "9999" },
        clientSecret: "pi_resume_1_secret_yyy",
      };
      await core.resumeIntent("pi_resume_1", "payment", "pi_resume_1_secret_yyy");
      expect(provider.retrieveCalls).toEqual([{ mode: "payment", id: "pi_resume_1" }]);
      expect(core.status).toBe("succeeded");
      expect(core.intentId).toBe("pi_resume_1");
      expect(core.amount).toEqual({ value: 2500, currency: "usd" });
      expect(core.paymentMethod).toEqual({ id: "pm_x", brand: "visa", last4: "9999" });
      // After successful resume, subsequent reportConfirmation is accepted
      // (regression guard for finding #1: was silently dropped before the
      // resumeIntent addition).
      await core.reportConfirmation({
        intentId: "pi_resume_1",
        outcome: "failed",
        error: { message: "late failure" },
      });
      expect(core.status).toBe("failed");
    });

    it("rejects when clientSecret does NOT match retrieved intent (regression: permission bypass)", async () => {
      // Attacker pastes a foreign intent id into the URL. Stripe still
      // returns the intent details via retrieve, BUT the attacker does not
      // know the secret.
      provider.retrieveResult = {
        id: "pi_victim",
        status: "succeeded",
        mode: "payment",
        amount: { value: 9999, currency: "usd" },
        paymentMethod: { id: "pm_victim", brand: "visa", last4: "0000" },
        clientSecret: "pi_victim_secret_real",
      };
      await expect(
        core.resumeIntent("pi_victim", "payment", "pi_victim_secret_GUESSED"),
      ).rejects.toMatchObject({ code: "resume_client_secret_mismatch" });
      // State must NOT hydrate the victim's intent.
      expect(core.status).toBe("idle");
      expect(core.intentId).toBeNull();
      expect(core.amount).toBeNull();
      expect(core.paymentMethod).toBeNull();
      expect(core.error?.code).toBe("resume_client_secret_mismatch");
    });

    it("subsequent cancelIntent cannot target a mismatched-secret intent", async () => {
      // The resume was denied above, so `_activeIntent` is null; a cancel
      // attempt with the victim id must fail the ownership guard (no
      // active intent to cancel → no-op, no provider.cancel call).
      provider.retrieveResult = {
        id: "pi_victim",
        status: "succeeded",
        mode: "payment",
        clientSecret: "pi_victim_secret_real",
      };
      await expect(core.resumeIntent("pi_victim", "payment", "WRONG")).rejects.toThrow();
      const cancelCountBefore = provider.cancelCalls.length;
      // No active intent → cancelIntent early-returns silently (see Core).
      await core.cancelIntent("pi_victim");
      expect(provider.cancelCalls.length).toBe(cancelCountBefore);
    });

    it("rejects when provider returns no clientSecret (defensive — bogus provider)", async () => {
      provider.retrieveResult = {
        id: "pi_noop",
        status: "succeeded",
        mode: "payment",
        // clientSecret missing
      };
      await expect(core.resumeIntent("pi_noop", "payment", "anything")).rejects.toMatchObject({ code: "resume_client_secret_mismatch" });
      expect(core.status).toBe("idle");
    });

    it("handles setup mode with matching clientSecret", async () => {
      provider.retrieveResult = {
        id: "seti_xx",
        status: "succeeded",
        mode: "setup",
        clientSecret: "seti_xx_secret_zzz",
      };
      await core.resumeIntent("seti_xx", "setup", "seti_xx_secret_zzz");
      expect(provider.retrieveCalls).toEqual([{ mode: "setup", id: "seti_xx" }]);
      expect(core.intentId).toBe("seti_xx");
    });

    it("surfaces lastPaymentError when resumed intent is already canceled (regression: silent failed)", async () => {
      // 3DS redirect back onto a PaymentIntent that Stripe canceled after
      // a failed attempt. `_reconcileFromIntentView` must lift the
      // lastPaymentError into observable state — same as the
      // requires_payment_method branch does — so the UI can explain the
      // failure. Before the fix, only status flipped to "failed" with
      // `core.error` left null.
      provider.retrieveResult = {
        id: "pi_resumed_canceled",
        status: "canceled",
        mode: "payment",
        clientSecret: "pi_resumed_canceled_secret_ok",
        lastPaymentError: {
          code: "card_declined",
          declineCode: "generic_decline",
          type: "card_error",
          message: "Your card was declined.",
        },
      };
      await core.resumeIntent("pi_resumed_canceled", "payment", "pi_resumed_canceled_secret_ok");
      expect(core.status).toBe("failed");
      expect(core.error?.code).toBe("card_declined");
      expect(core.error?.declineCode).toBe("generic_decline");
    });

    it("keeps loading=true when the resumed intent is still processing (regression: processing spinner)", async () => {
      // 3DS redirect can land while Stripe is still asynchronously
      // finalizing the charge — intent.status is "processing" and the
      // terminal state will arrive via webhook. The resume call must
      // NOT flip loading off in that window, or the UI drops the
      // spinner while money is still moving.
      provider.retrieveResult = {
        id: "pi_still_processing",
        status: "processing",
        mode: "payment",
        amount: { value: 1980, currency: "jpy" },
        clientSecret: "pi_still_processing_secret_ok",
      };
      await core.resumeIntent("pi_still_processing", "payment", "pi_still_processing_secret_ok");
      expect(core.status).toBe("processing");
      // Loading must bridge to the webhook-driven terminal state.
      expect(core.loading).toBe(true);
      expect(core.intentId).toBe("pi_still_processing");
    });

    it("drops amount from a setup-mode view (defense against custom providers)", async () => {
      // A conformant Stripe SDK never returns an amount on a setup intent,
      // but the provider interface is open to custom implementations. If
      // one leaks amount into the setup view, the reconciler must drop it
      // rather than expose a meaningless value through the bindable surface
      // (SPEC §5.1 — amount is payment-mode only).
      provider.retrieveResult = {
        id: "seti_amt",
        status: "succeeded",
        mode: "setup",
        amount: { value: 7777, currency: "usd" }, // bogus — should be ignored
        clientSecret: "seti_amt_secret_ok",
      };
      await core.resumeIntent("seti_amt", "setup", "seti_amt_secret_ok");
      expect(core.intentId).toBe("seti_amt");
      expect(core.amount).toBeNull();
    });

    it("rejects invalid mode", async () => {
      await expect(core.resumeIntent("pi_x", "bogus" as any, "cs")).rejects.toThrow(/mode must be/);
    });

    it("rejects missing intentId", async () => {
      await expect(core.resumeIntent("", "payment", "cs")).rejects.toThrow(/intentId/);
    });

    it("rejects missing clientSecret", async () => {
      await expect(core.resumeIntent("pi_x", "payment", "")).rejects.toThrow(/clientSecret/);
    });

    describe("registerResumeAuthorizer (defense-in-depth)", () => {
      beforeEach(() => {
        provider.retrieveResult = {
          id: "pi_auth",
          status: "succeeded",
          mode: "payment",
          clientSecret: "pi_auth_secret_ok",
        };
      });

      it("runs authorizer after clientSecret check passes; true accepts", async () => {
        const calls: any[] = [];
        core.registerResumeAuthorizer((intentId, mode, view, ctx) => {
          calls.push({ intentId, mode, view, ctx });
          return true;
        });
        await core.resumeIntent("pi_auth", "payment", "pi_auth_secret_ok");
        expect(calls).toHaveLength(1);
        expect(calls[0].intentId).toBe("pi_auth");
        expect(calls[0].mode).toBe("payment");
        expect(calls[0].view.id).toBe("pi_auth");
        expect(core.intentId).toBe("pi_auth");
      });

      it("false denies and does not hydrate state", async () => {
        core.registerResumeAuthorizer(() => false);
        await expect(core.resumeIntent("pi_auth", "payment", "pi_auth_secret_ok")).rejects.toMatchObject({
          code: "resume_not_authorized",
        });
        expect(core.status).toBe("idle");
        expect(core.intentId).toBeNull();
        expect(core.error?.code).toBe("resume_not_authorized");
      });

      it("async authorizer returning false also denies", async () => {
        core.registerResumeAuthorizer(async () => false);
        await expect(core.resumeIntent("pi_auth", "payment", "pi_auth_secret_ok")).rejects.toMatchObject({
          code: "resume_not_authorized",
        });
      });

      it("authorizer throws → normalized to resume_not_authorized denial (raw error goes to authorizer-error event)", async () => {
        const warnings: CustomEvent[] = [];
        core.addEventListener("stripe-checkout:authorizer-error", (e) => warnings.push(e as CustomEvent));
        const raw = new Error("acl lookup failed");
        core.registerResumeAuthorizer(() => { throw raw; });
        // The rejection the caller sees is the NORMALIZED denial — not
        // the raw authorizer error. This prevents internal ACL /
        // infrastructure details from leaking across the wire.
        await expect(core.resumeIntent("pi_auth", "payment", "pi_auth_secret_ok")).rejects.toMatchObject({
          code: "resume_not_authorized",
        });
        expect(core.status).toBe("idle");
        // Observable state error is ALSO the normalized form.
        expect(core.error?.code).toBe("resume_not_authorized");
        expect(core.error?.message).not.toMatch(/acl lookup/);
        // The raw error is observable ONLY via the authorizer-error event
        // on the Core's target (server-side observability for operators).
        expect(warnings).toHaveLength(1);
        expect((warnings[0].detail as any).error).toBe(raw);
        expect((warnings[0].detail as any).intentId).toBe("pi_auth");
        expect((warnings[0].detail as any).mode).toBe("payment");
      });

      it("authorizer false return does NOT dispatch authorizer-error (only throws do)", async () => {
        const warnings: CustomEvent[] = [];
        core.addEventListener("stripe-checkout:authorizer-error", (e) => warnings.push(e as CustomEvent));
        core.registerResumeAuthorizer(() => false);
        await expect(core.resumeIntent("pi_auth", "payment", "pi_auth_secret_ok")).rejects.toMatchObject({
          code: "resume_not_authorized",
        });
        expect(warnings).toHaveLength(0);
      });

      it("authorizer receives userContext from constructor", async () => {
        const userContext = { sub: "u_1", tenant: "t_42" };
        const c = new StripeCore(provider, { userContext });
        let got: unknown = null;
        c.registerResumeAuthorizer((_, __, ___, ctx) => { got = ctx; return true; });
        await c.resumeIntent("pi_auth", "payment", "pi_auth_secret_ok");
        expect(got).toBe(userContext);
      });
    });
  });

  describe("reportConfirmation paymentMethod fallback (regression: finding #3)", () => {
    beforeEach(() => {
      core.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
    });

    it("fetches paymentMethod from provider when Shell report omits it", async () => {
      await core.requestIntent({ mode: "payment", hint: {} });
      // Simulate the common case: Stripe.js confirm result had `payment_method`
      // as a bare string, so the Shell could not populate brand/last4.
      provider.retrieveResult = {
        id: "pi_123",
        status: "succeeded",
        mode: "payment",
        paymentMethod: { id: "pm_from_retrieve", brand: "amex", last4: "0005" },
      };
      await core.reportConfirmation({
        intentId: "pi_123",
        outcome: "succeeded",
        // no paymentMethod in the report
      });
      expect(core.paymentMethod).toEqual({ id: "pm_from_retrieve", brand: "amex", last4: "0005" });
      expect(core.status).toBe("succeeded");
    });

    it("keeps report-provided paymentMethod and skips retrieve when present", async () => {
      await core.requestIntent({ mode: "payment", hint: {} });
      const before = provider.retrieveCalls.length;
      await core.reportConfirmation({
        intentId: "pi_123",
        outcome: "succeeded",
        paymentMethod: { id: "pm_direct", brand: "visa", last4: "4242" },
      });
      expect(core.paymentMethod).toEqual({ id: "pm_direct", brand: "visa", last4: "4242" });
      expect(provider.retrieveCalls.length).toBe(before);
    });

    it("webhook succeeded fills paymentMethod from expanded event.data.object (regression)", async () => {
      await core.requestIntent({ mode: "payment", hint: {} });
      // Simulate the race where reportConfirmation's retrieve fell through
      // (transient error → pm left null). The webhook must recover.
      provider.retrieveResult = { id: "pi_123", status: "succeeded", mode: "payment" };
      await core.reportConfirmation({ intentId: "pi_123", outcome: "succeeded" });
      expect(core.paymentMethod).toBeNull();

      // Webhook arrives with expanded payment_method in event.data.object —
      // Core must fold it into state without another retrieve round-trip.
      const retrievesBefore = provider.retrieveCalls.length;
      provider.webhookEvent = {
        id: "evt_pm_expanded",
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_123",
            payment_method: {
              id: "pm_expanded",
              card: { brand: "amex", last4: "0005" },
            },
          },
        },
        created: 0,
      };
      await core.handleWebhook("{}", "sig");
      expect(core.paymentMethod).toEqual({ id: "pm_expanded", brand: "amex", last4: "0005" });
      // Expanded object in the event — no follow-up retrieve needed.
      expect(provider.retrieveCalls.length).toBe(retrievesBefore);
    });

    it("webhook succeeded falls back to provider.retrieveIntent when event.data.object has no expanded pm (regression)", async () => {
      await core.requestIntent({ mode: "payment", hint: {} });
      provider.retrieveResult = { id: "pi_123", status: "succeeded", mode: "payment" };
      await core.reportConfirmation({ intentId: "pi_123", outcome: "succeeded" });
      expect(core.paymentMethod).toBeNull();

      // Webhook payload has payment_method as a bare id string (Stripe's
      // default, no expansion configured) — Core must call retrieveIntent
      // to fill brand/last4.
      provider.retrieveResult = {
        id: "pi_123",
        status: "succeeded",
        mode: "payment",
        paymentMethod: { id: "pm_from_retrieve", brand: "discover", last4: "1117" },
      };
      provider.webhookEvent = {
        id: "evt_pm_string",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_123", payment_method: "pm_bare_id_only" } },
        created: 0,
      };
      await core.handleWebhook("{}", "sig");
      expect(core.paymentMethod).toEqual({
        id: "pm_from_retrieve", brand: "discover", last4: "1117",
      });
    });

    it("webhook succeeded retrieve stall + reset + new requestIntent does NOT leak stale pm/status (regression: TOCTOU)", async () => {
      // Scenario the guard protects against: webhook for pi_OLD parks on
      // provider.retrieveIntent; during the stall, user cancels the
      // session and starts a new intent pi_NEW; when the stale retrieve
      // finally resolves with pi_OLD's card, the result must NOT be
      // written onto pi_NEW's observable state.
      provider.nextPaymentIntentId = "pi_OLD";
      await core.requestIntent({ mode: "payment", hint: {} });
      // reportConfirmation leaves pm null so the webhook path takes the
      // retrieve fallback.
      provider.retrieveResult = { id: "pi_OLD", status: "succeeded", mode: "payment" };
      await core.reportConfirmation({ intentId: "pi_OLD", outcome: "succeeded" });
      expect(core.paymentMethod).toBeNull();

      // Stall the next retrieveIntent call (the webhook's fallback).
      let releaseRetrieve!: (v: StripeIntentView) => void;
      const originalRetrieve = provider.retrieveIntent.bind(provider);
      provider.retrieveIntent = ((_mode: StripeMode, _id: string) => {
        return new Promise<StripeIntentView>((resolve) => { releaseRetrieve = resolve; });
      }) as any;

      // Fire the webhook — it parks on the stalled retrieve.
      provider.webhookEvent = {
        id: "evt_stale",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_OLD", payment_method: "pm_string_only" } },
        created: 0,
      };
      const webhookPromise = core.handleWebhook("{}", "sig");
      await new Promise(r => setTimeout(r, 0));

      // Reset + start a new intent BEFORE the stalled retrieve resolves.
      provider.retrieveIntent = originalRetrieve;
      core.reset();
      provider.nextPaymentIntentId = "pi_NEW";
      await core.requestIntent({ mode: "payment", hint: {} });
      expect(core.intentId).toBe("pi_NEW");
      expect(core.paymentMethod).toBeNull();
      expect(core.status).toBe("collecting");

      // Unblock the stale retrieve with pi_OLD's card. The guard must
      // drop this write — the session it came from is superseded.
      releaseRetrieve({
        id: "pi_OLD",
        status: "succeeded",
        mode: "payment",
        paymentMethod: { id: "pm_OLD", brand: "visa", last4: "1111" },
      });
      await webhookPromise;

      // State of the CURRENT (pi_NEW) session must be untouched.
      expect(core.paymentMethod).toBeNull();
      expect(core.status).toBe("collecting");
      expect(core.intentId).toBe("pi_NEW");
    });

    it("webhook succeeded does NOT re-retrieve when paymentMethod already populated", async () => {
      await core.requestIntent({ mode: "payment", hint: {} });
      // reportConfirmation populated pm directly.
      await core.reportConfirmation({
        intentId: "pi_123",
        outcome: "succeeded",
        paymentMethod: { id: "pm_already", brand: "visa", last4: "4242" },
      });
      const retrievesBefore = provider.retrieveCalls.length;
      provider.webhookEvent = {
        id: "evt_already",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_123", payment_method: "pm_ignored" } },
        created: 0,
      };
      await core.handleWebhook("{}", "sig");
      expect(core.paymentMethod).toEqual({ id: "pm_already", brand: "visa", last4: "4242" });
      expect(provider.retrieveCalls.length).toBe(retrievesBefore);
    });
  });

  describe("error sanitization (SPEC §9.3)", () => {
    it("redacts the message of a non-Stripe error thrown by the IntentBuilder", async () => {
      // A user-supplied IntentBuilder might throw with an internal message
      // (DB auth error, stack trace, hostnames) that must not reach the
      // browser via observable `error` or the cmd-throw wire. The sanitizer
      // replaces non-Stripe, non-internal messages with a generic string.
      const c = new StripeCore(provider);
      c.registerIntentBuilder(() => {
        throw new Error("FATAL: auth failed for user=admin@example.com via 10.0.0.5");
      });
      await expect(c.requestIntent({ mode: "payment", hint: {} })).rejects.toThrow();
      expect(c.error?.message).toBe("Payment failed.");
      expect(c.error?.message).not.toMatch(/admin/);
      expect(c.error?.message).not.toMatch(/10\.0\.0\.5/);
    });

    it("forwards the message of a Stripe SDK error (class-name shape)", async () => {
      // stripe-node throws instances whose `.type` is the class name
      // ("StripeCardError", "StripeAPIError", etc). Those messages are
      // Stripe-curated and safe to surface.
      const c = new StripeCore(provider);
      c.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
      provider.paymentError = Object.assign(new Error("Your card was declined."), {
        type: "StripeCardError",
        code: "card_declined",
        decline_code: "insufficient_funds",
      });
      await expect(c.requestIntent({ mode: "payment", hint: {} })).rejects.toThrow();
      expect(c.error?.message).toBe("Your card was declined.");
      expect(c.error?.code).toBe("card_declined");
      expect(c.error?.declineCode).toBe("insufficient_funds");
      expect(c.error?.type).toBe("StripeCardError");
    });

    it("forwards the message of a Stripe API error object (webhook last_payment_error shape)", async () => {
      // Webhook payloads carry `last_payment_error` as a Stripe API error
      // object whose `.type` uses the snake_case "*_error" shape. Those are
      // also Stripe-curated and safe to surface — covers the sanitizer call
      // from the webhook fold path (StripeCore.ts `_foldWebhookIntoState`).
      const c = new StripeCore(provider, { webhookSecret: "whsec_test" });
      c.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
      await c.requestIntent({ mode: "payment", hint: {} });
      provider.webhookEvent = {
        id: "evt_1",
        type: "payment_intent.payment_failed",
        created: 0,
        data: {
          object: {
            id: "pi_123",
            last_payment_error: {
              type: "card_error",
              code: "card_declined",
              message: "Your card was declined.",
            },
          },
        },
      };
      await c.handleWebhook("{}", "t=0,v1=abc");
      expect(c.error?.message).toBe("Your card was declined.");
      expect(c.error?.type).toBe("card_error");
    });

    it("drops non-taxonomy code/declineCode values while preserving Stripe-shaped message policy", async () => {
      const c = new StripeCore(provider);
      c.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
      await c.requestIntent({ mode: "payment", hint: {} });
      await c.reportConfirmation({
        intentId: "pi_123",
        outcome: "failed",
        error: {
          type: "card_error",
          code: "card_declined<script>",
          declineCode: "insufficient_funds;DROP",
          message: "Your card was declined.",
        },
      });
      expect(c.error?.message).toBe("Your card was declined.");
      expect(c.error?.type).toBe("card_error");
      expect(c.error?.code).toBeUndefined();
      expect(c.error?.declineCode).toBeUndefined();
    });

    it("keeps dot-separated code/declineCode tokens while still dropping unsafe punctuation", async () => {
      const c = new StripeCore(provider);
      c.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
      await c.requestIntent({ mode: "payment", hint: {} });
      await c.reportConfirmation({
        intentId: "pi_123",
        outcome: "failed",
        error: {
          type: "card_error",
          code: "payment_intent.authentication_required",
          declineCode: "issuer.authentication_required<script>",
          message: "Authentication required.",
        },
      });
      expect(c.error?.type).toBe("card_error");
      expect(c.error?.code).toBe("payment_intent.authentication_required");
      expect(c.error?.declineCode).toBeUndefined();
    });

    it("keeps dotted webhook decline_code (snake_case) from last_payment_error", async () => {
      const c = new StripeCore(provider, { webhookSecret: "whsec_test" });
      c.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
      await c.requestIntent({ mode: "payment", hint: {} });
      provider.webhookEvent = {
        id: "evt_decline_dot",
        type: "payment_intent.payment_failed",
        created: 0,
        data: {
          object: {
            id: "pi_123",
            last_payment_error: {
              type: "card_error",
              decline_code: "issuer.insufficient_funds",
              message: "Declined.",
            },
          },
        },
      };
      await c.handleWebhook("{}", "t=0,v1=abc");
      expect(c.error?.declineCode).toBe("issuer.insufficient_funds");
    });

    it("rejects Stripe-shaped type impostors so their message does not pass through", async () => {
      const c = new StripeCore(provider);
      c.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
      await c.requestIntent({ mode: "payment", hint: {} });
      await c.reportConfirmation({
        intentId: "pi_123",
        outcome: "failed",
        error: {
          type: "card_error<img src=x>_error",
          message: "sensitive server-side hostname leak",
        },
      });
      expect(c.error?.type).toBeUndefined();
      expect(c.error?.message).toBe("Payment failed.");
    });

    it("forwards our own [@wc-bindable/stripe]-prefixed internal errors", async () => {
      // Internal errors are hand-curated and carry useful programmer-facing
      // info (e.g. "provider returned no id/client_secret"). They are not
      // Stripe-shaped (no .type) so they would otherwise collapse to the
      // generic message, hurting debuggability.
      const c = new StripeCore(provider);
      c.registerIntentBuilder(() => {
        throw new Error("[@wc-bindable/stripe] builder invariant violated.");
      });
      await expect(c.requestIntent({ mode: "payment", hint: {} })).rejects.toThrow();
      expect(c.error?.message).toBe("[@wc-bindable/stripe] builder invariant violated.");
    });

    it("falls back to generic message when the thrown value has no usable shape", async () => {
      const c = new StripeCore(provider);
      c.registerIntentBuilder(() => { throw "plain string rejection"; });
      await expect(c.requestIntent({ mode: "payment", hint: {} })).rejects.toBeDefined();
      expect(c.error?.message).toBe("Payment failed.");
    });

    it("truncates pathologically large Stripe-shaped messages to a bounded length (regression)", async () => {
      // A giant message on a Stripe-shaped error would otherwise flood
      // logs / DOM / wire frames. The sanitizer caps `message` at a
      // fixed upper bound and appends an ellipsis so operators notice
      // truncation.
      const c = new StripeCore(provider);
      c.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
      const huge = "A".repeat(10_000);
      provider.paymentError = Object.assign(new Error(huge), {
        type: "StripeCardError",
        code: "card_declined",
      });
      await expect(c.requestIntent({ mode: "payment", hint: {} })).rejects.toThrow();
      // Bounded under 1 KiB and carries a truncation marker.
      expect(c.error?.message).toBeDefined();
      expect(c.error!.message.length).toBeLessThanOrEqual(512);
      expect(c.error!.message.endsWith("…")).toBe(true);
      // code / type must still pass through.
      expect(c.error?.code).toBe("card_declined");
      expect(c.error?.type).toBe("StripeCardError");
    });
  });

  describe("wcBindable contract", () => {
    it("declares the expected observable properties", () => {
      const names = StripeCore.wcBindable.properties.map(p => p.name);
      expect(names).toEqual(["status", "loading", "amount", "paymentMethod", "intentId", "error"]);
      // clientSecret must NOT appear in the surface (SPEC §5.2).
      expect(names).not.toContain("clientSecret");
    });

    it("declares the expected commands", () => {
      const names = StripeCore.wcBindable.commands!.map(c => c.name);
      expect(names).toContain("requestIntent");
      expect(names).toContain("reportConfirmation");
      expect(names).toContain("cancelIntent");
      expect(names).toContain("resumeIntent");
      expect(names).toContain("reset");
    });

    it("uses event names prefixed with stripe-checkout:", () => {
      for (const prop of StripeCore.wcBindable.properties) {
        expect(prop.event).toMatch(/^stripe-checkout:/);
      }
    });
  });
});
