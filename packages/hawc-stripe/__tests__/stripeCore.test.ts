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
      expect(c.status).toBe("idle");
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

    it("non-fatal handler continues chain and dispatches warning", async () => {
      const order: string[] = [];
      const warnings: CustomEvent[] = [];
      core.addEventListener("hawc-stripe:webhook-warning", (e) => warnings.push(e as CustomEvent));
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
        core.addEventListener("hawc-stripe:authorizer-error", (e) => warnings.push(e as CustomEvent));
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
        core.addEventListener("hawc-stripe:authorizer-error", (e) => warnings.push(e as CustomEvent));
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

    it("uses event names prefixed with hawc-stripe:", () => {
      for (const prop of StripeCore.wcBindable.properties) {
        expect(prop.event).toMatch(/^hawc-stripe:/);
      }
    });
  });
});
