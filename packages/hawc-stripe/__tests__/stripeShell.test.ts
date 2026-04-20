import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Stripe as WcsStripe } from "../src/components/Stripe";
import { StripeCore } from "../src/core/StripeCore";
import type {
  StripeJsLike, StripeElementsLike, StripePaymentElementLike,
} from "../src/components/Stripe";
import type {
  IStripeProvider, IntentCreationResult, PaymentIntentOptions, SetupIntentOptions,
  StripeEvent, StripeIntentView, StripeMode,
} from "../src/types";

class FakeProvider implements IStripeProvider {
  nextPaymentIntentId = "pi_shell";
  nextClientSecret = "cs_shell_secret";
  retrieveCalls: { mode: StripeMode; id: string }[] = [];
  retrieveResult: StripeIntentView | null = null;
  cancelCalls: string[] = [];
  async createPaymentIntent(opts: PaymentIntentOptions): Promise<IntentCreationResult> {
    return {
      intentId: this.nextPaymentIntentId,
      clientSecret: this.nextClientSecret,
      mode: "payment",
      amount: { value: opts.amount, currency: opts.currency },
    };
  }
  async createSetupIntent(_opts: SetupIntentOptions): Promise<IntentCreationResult> {
    return { intentId: "seti_shell", clientSecret: this.nextClientSecret, mode: "setup" };
  }
  async retrieveIntent(mode: StripeMode, id: string): Promise<StripeIntentView> {
    this.retrieveCalls.push({ mode, id });
    return this.retrieveResult ?? {
      id,
      status: "succeeded",
      mode,
      paymentMethod: { id: "pm_retrieved", brand: "visa", last4: "4242" },
    };
  }
  async cancelPaymentIntent(id: string): Promise<void> { this.cancelCalls.push(id); }
  verifyWebhook(): StripeEvent { throw new Error("not used"); }
}

function createFakeStripeJs() {
  const mountCalls: (HTMLElement | string)[] = [];
  const confirmCalls: { kind: "payment" | "setup"; opts: any }[] = [];
  let nextConfirmResult: any = null;
  const paymentElement: StripePaymentElementLike = {
    mount(target) { mountCalls.push(target); },
    unmount() {},
    destroy() {},
    on() {},
  };
  const elements: StripeElementsLike = {
    create() { return paymentElement; },
    getElement() { return paymentElement; },
  };
  const stripeJs: StripeJsLike = {
    elements: () => elements,
    async confirmPayment(opts) { confirmCalls.push({ kind: "payment", opts }); return nextConfirmResult ?? { paymentIntent: { id: "pi_shell", status: "succeeded" } }; },
    async confirmSetup(opts) { confirmCalls.push({ kind: "setup", opts }); return nextConfirmResult ?? { setupIntent: { id: "seti_shell", status: "succeeded" } }; },
    async retrievePaymentIntent() { return { paymentIntent: { id: "pi_shell", status: "succeeded" } }; },
    async retrieveSetupIntent() { return { setupIntent: { id: "seti_shell", status: "succeeded" } }; },
  };
  return {
    stripeJs,
    mountCalls,
    confirmCalls,
    setConfirmResult: (r: any) => { nextConfirmResult = r; },
  };
}

if (!customElements.get("hawc-stripe-test")) {
  customElements.define("hawc-stripe-test", WcsStripe);
}

/**
 * Create and append a `<hawc-stripe-test>` with attrs pre-applied BEFORE
 * appendChild so connectedCallback sees them. Returns an element ready to
 * receive `attachLocalCore`.
 */
function createEl(attrs: Record<string, string> = {}): WcsStripe {
  const el = document.createElement("hawc-stripe-test") as WcsStripe;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

/** Reset the URL search. Used to control `_isPostRedirect` in tests. */
function setUrlSearch(search: string): void {
  history.replaceState(null, "", `${location.pathname}${search}`);
}

describe("<hawc-stripe> Shell", () => {
  let el: WcsStripe;
  let provider: FakeProvider;
  let core: StripeCore;
  let fakes: ReturnType<typeof createFakeStripeJs>;

  beforeEach(() => {
    document.body.innerHTML = "";
    setUrlSearch("");
    provider = new FakeProvider();
    core = new StripeCore(provider, { webhookSecret: "whsec_test" });
    core.registerIntentBuilder(() => ({ mode: "payment", amount: 1980, currency: "jpy" }));
    fakes = createFakeStripeJs();
    WcsStripe.setLoader(async () => fakes.stripeJs);
  });

  afterEach(() => {
    setUrlSearch("");
  });

  it("declares a minimal public command surface (prepare/submit/reset/abort)", () => {
    const names = WcsStripe.wcBindable.commands!.map(c => c.name);
    expect(names).toEqual(["prepare", "submit", "reset", "abort"]);
    expect(names).not.toContain("requestIntent");
    expect(names).not.toContain("reportConfirmation");
    expect(names).not.toContain("resumeIntent");
  });

  describe("prepare() and auto-prepare on connect", () => {
    it("attachLocalCore triggers auto-prepare, mounting Elements", async () => {
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      // auto-prepare is fire-and-forget from attachLocalCore; await via prepare().
      await el.prepare();
      expect(fakes.mountCalls).toHaveLength(1);
      expect(el.status).toBe("collecting");
      expect(el.intentId).toBe("pi_shell");
    });

    it("prepare() is idempotent — concurrent callers share one in-flight promise", async () => {
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      const p1 = el.prepare();
      const p2 = el.prepare();
      await Promise.all([p1, p2]);
      expect(fakes.mountCalls).toHaveLength(1);
    });

    it("prepare() without publishable-key throws", async () => {
      el = createEl({ mode: "payment" });
      el.attachLocalCore(core);
      await expect(el.prepare()).rejects.toThrow(/publishable-key is required/);
    });

    it("a failed prepare does not wedge — subsequent prepare retries", async () => {
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      const original = provider.createPaymentIntent.bind(provider);
      provider.createPaymentIntent = async () => { throw new Error("stripe down"); };
      await expect(el.prepare()).rejects.toThrow(/stripe down/);
      provider.createPaymentIntent = original;
      await el.prepare();
      expect(fakes.mountCalls).toHaveLength(1);
    });

    it("auto-prepare fires when publishable-key is set AFTER connect + attach (regression: finding #1)", async () => {
      // Attrs set AFTER mount + attach: publishable-key is the LAST
      // prerequisite to land. SPEC says auto-prepare must still fire.
      // We deliberately do NOT call `el.prepare()` — if the auto path is
      // broken, the assertions below fail. An earlier version of this test
      // awaited prepare() as a "tick flush," which masked the regression.
      el = createEl({ mode: "payment" });  // no publishable-key yet
      el.attachLocalCore(core);
      expect(fakes.mountCalls).toHaveLength(0);
      el.setAttribute("publishable-key", "pk_test_123");
      // Let the fire-and-forget auto-prepare's microtask chain settle.
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      expect(fakes.mountCalls).toHaveLength(1);
      expect(el.status).toBe("collecting");
      expect(el.intentId).toBe("pi_shell");
    });

    it("publishable-key change invalidates cached Stripe.js (regression: key-cache bug)", async () => {
      // Instrument the loader to record the keys it was called with. The
      // bug was: first prepare() caches _stripeJs for pk_A; subsequent
      // prepare() after a key swap returned the pk_A-bound instance.
      const loaderCalls: string[] = [];
      WcsStripe.setLoader(async (key: string) => {
        loaderCalls.push(key);
        return fakes.stripeJs;
      });

      el = createEl({ mode: "payment", "publishable-key": "pk_A" });
      el.attachLocalCore(core);
      await el.prepare();
      expect(loaderCalls).toEqual(["pk_A"]);

      el.reset();
      el.setAttribute("publishable-key", "pk_B");
      // Auto-prepare must re-fire and must build the NEW Stripe.js with pk_B.
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      expect(loaderCalls).toEqual(["pk_A", "pk_B"]);
    });

    it("publishable-key change cancels the orphan intent from the prior key", async () => {
      el = createEl({ mode: "payment", "publishable-key": "pk_A" });
      el.attachLocalCore(core);
      await el.prepare();
      const orphanId = el.intentId;
      expect(orphanId).toBe("pi_shell");

      el.setAttribute("publishable-key", "pk_B");
      // The orphan on the prior account must be cancelled server-side so
      // it does not linger billing nothing but leaking a row.
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      expect(provider.cancelCalls).toContain(orphanId!);
    });

    it("loader race: key change DURING Stripe._loader(pk_A) discards the pk_A instance (regression)", async () => {
      // Two distinct Stripe.js fakes so we can verify which one actually
      // reaches `elements().mount(...)`. Prior bug: the loader race was
      // only closed at the CACHE seed — the stale instance was still
      // returned to the caller and used to mount Elements against the
      // new key's intent. The fix must ensure the pk_A instance never
      // reaches mount when the key flipped mid-load.
      const fakesA = createFakeStripeJs();
      const fakesB = createFakeStripeJs();

      const loaderCalls: string[] = [];
      let releasePkA!: (v: typeof fakesA.stripeJs) => void;
      const pkALoaderGate = new Promise<typeof fakesA.stripeJs>((resolve) => {
        releasePkA = resolve;
      });
      WcsStripe.setLoader(async (key: string) => {
        loaderCalls.push(key);
        if (key === "pk_A") return pkALoaderGate;  // stall
        return fakesB.stripeJs;
      });

      el = createEl({ mode: "payment", "publishable-key": "pk_A" });
      el.attachLocalCore(core);

      // Drive microtasks until the auto-prepare has reached the stalled
      // pk_A loader. Two ticks: one for attachLocalCore → _maybeAutoPrepare
      // → prepare()'s sync setup + _requestIntent resolution; another for
      // _mountElements → _ensureStripeJs → await loader().
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      expect(loaderCalls).toEqual(["pk_A"]);

      // Swap the key while the first loader is still stalled.
      el.setAttribute("publishable-key", "pk_B");

      // Release the stalled pk_A loader. If the fix is broken, the pk_A
      // instance flows into `_mountElements` and calls
      // `fakesA.stripeJs.elements(...).create(...).mount(...)`, which
      // would increment `fakesA.mountCalls`.
      releasePkA(fakesA.stripeJs);

      // Let the supersede-reject and the retry (auto-prepare with pk_B)
      // settle.
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      // The loader must have been called with both keys — pk_B's call is
      // the retry after the pk_A prepare was superseded.
      expect(loaderCalls).toEqual(["pk_A", "pk_B"]);
      // Crucially: pk_A's Stripe.js instance must NEVER have reached
      // mount. Only pk_B's mount path ran.
      expect(fakesA.mountCalls).toHaveLength(0);
      expect(fakesB.mountCalls).toHaveLength(1);
      expect(el.status).toBe("collecting");
    });

    it("reset() during in-flight prepare (parked on _requestIntent) does NOT mount afterward (regression)", async () => {
      // Gate createPaymentIntent to simulate a slow network / server.
      let releasePi!: (v: IntentCreationResult) => void;
      provider.createPaymentIntent = () => new Promise<IntentCreationResult>((resolve) => {
        releasePi = resolve;
      });

      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      // Let auto-prepare park on createPaymentIntent.
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      expect(fakes.mountCalls).toHaveLength(0);

      // reset() while prepare is parked.
      el.reset();

      // Release the stalled intent creation. The LATE result must NOT
      // drive Elements mount, re-seed _clientSecret, or set error state.
      releasePi({
        intentId: "pi_late_reset",
        clientSecret: "cs_late",
        mode: "payment",
        amount: { value: 1980, currency: "jpy" },
      });
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      expect(el.status).toBe("idle");
      expect(el.intentId).toBeNull();
      expect(fakes.mountCalls).toHaveLength(0);
      expect(el.error).toBeNull();
    });

    it("abort() during in-flight prepare supersedes and cancels the orphan intent (regression)", async () => {
      let releasePi!: (v: IntentCreationResult) => void;
      provider.createPaymentIntent = () => new Promise<IntentCreationResult>((resolve) => {
        releasePi = resolve;
      });

      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      const abortPromise = el.abort();
      // Release the stalled intent creation AFTER abort() started so the
      // Core's own supersede path fires on the unblocked intent.
      releasePi({
        intentId: "pi_late_abort",
        clientSecret: "cs_late",
        mode: "payment",
        amount: { value: 1980, currency: "jpy" },
      });
      await abortPromise;
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      expect(el.status).toBe("idle");
      expect(fakes.mountCalls).toHaveLength(0);
      expect(el.error).toBeNull();
      // Orphan intent must be cancelled server-side so it does not
      // linger in requires_payment_method forever.
      expect(provider.cancelCalls).toContain("pi_late_abort");
    });

    it("disconnectedCallback during in-flight prepare does NOT mount into the detached element (regression)", async () => {
      let releasePi!: (v: IntentCreationResult) => void;
      provider.createPaymentIntent = () => new Promise<IntentCreationResult>((resolve) => {
        releasePi = resolve;
      });

      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      // Remove the element from the DOM; disconnectedCallback fires sync.
      el.remove();

      releasePi({
        intentId: "pi_late_disc",
        clientSecret: "cs_late",
        mode: "payment",
        amount: { value: 1980, currency: "jpy" },
      });
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      // Critical: the stale prepare must NOT call elements/mount against
      // the detached element (would leak an orphan Stripe iframe).
      expect(fakes.mountCalls).toHaveLength(0);
    });

    it("user-abort supersede (reset) does NOT auto-retry (regression)", async () => {
      // Contract: reset() asks for terminal idle. The prepare cleanup
      // must NOT invoke `_maybeAutoPrepare` the way a key-change
      // supersede does — otherwise the element would silently re-mount
      // after every reset().
      let releasePi!: (v: IntentCreationResult) => void;
      let createCount = 0;
      provider.createPaymentIntent = () => {
        createCount++;
        return new Promise<IntentCreationResult>((resolve) => {
          releasePi = resolve;
        });
      };

      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      expect(createCount).toBe(1);

      el.reset();
      releasePi({
        intentId: "pi_late_reset",
        clientSecret: "cs_late",
        mode: "payment",
        amount: { value: 1980, currency: "jpy" },
      });
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      // A key-change supersede would retry and call createPaymentIntent
      // a second time; reset must NOT do so.
      expect(createCount).toBe(1);
      expect(fakes.mountCalls).toHaveLength(0);
      expect(el.status).toBe("idle");
    });

    it("supersede-abort does NOT leak into observable error state (regression: contract guard)", async () => {
      // Supersede (key swapped mid-prepare) is a normal consequence of
      // user action, not a failure. The prepare() catch path has a
      // `gen === this._prepareGeneration` guard that skips _setErrorState
      // specifically for this case. This test pins that contract — if
      // someone removes the guard, supersede starts surfacing the
      // "publishable-key changed during Stripe.js load — aborting..."
      // internal error to el.error / core.error even though the
      // user-visible outcome is a successful retry.
      const fakesA = createFakeStripeJs();
      const fakesB = createFakeStripeJs();

      let releasePkA!: (v: typeof fakesA.stripeJs) => void;
      const pkALoaderGate = new Promise<typeof fakesA.stripeJs>((resolve) => {
        releasePkA = resolve;
      });
      WcsStripe.setLoader(async (key: string) => {
        if (key === "pk_A") return pkALoaderGate;
        return fakesB.stripeJs;
      });

      // Also capture `hawc-stripe:error` events; they must not fire with
      // a non-null detail for a supersede either.
      const errorEvents: unknown[] = [];

      el = createEl({ mode: "payment", "publishable-key": "pk_A" });
      el.addEventListener("hawc-stripe:error", (e) => errorEvents.push((e as CustomEvent).detail));
      el.attachLocalCore(core);

      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      el.setAttribute("publishable-key", "pk_B");
      releasePkA(fakesA.stripeJs);

      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      // Successful retry happened.
      expect(el.status).toBe("collecting");
      // Observable error state is clean.
      expect(el.error).toBeNull();
      expect(core.error).toBeNull();
      // The only `hawc-stripe:error` dispatches should be null transitions
      // (from `_clearErrorState()` at the start of each prepare attempt);
      // none should carry a message mentioning the supersede.
      for (const detail of errorEvents) {
        if (detail && typeof detail === "object") {
          const msg = (detail as { message?: unknown }).message;
          if (typeof msg === "string") {
            expect(msg).not.toMatch(/supersed/i);
            expect(msg).not.toMatch(/publishable-key changed during/i);
          }
        }
      }
    });
  });

  describe("submit() confirms only", () => {
    beforeEach(() => {
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
    });

    it("single submit() transitions to succeeded", async () => {
      await el.prepare();
      await el.submit();
      expect(fakes.confirmCalls).toHaveLength(1);
      expect(el.status).toBe("succeeded");
    });

    it("submit() auto-prepares when called before prepare()", async () => {
      // Do NOT call prepare() explicitly.
      await el.submit();
      expect(fakes.mountCalls).toHaveLength(1);
      expect(fakes.confirmCalls).toHaveLength(1);
      expect(el.status).toBe("succeeded");
    });

    it("surfaces confirm error and reports failure to Core", async () => {
      await el.prepare();
      fakes.setConfirmResult({ error: { code: "card_declined", message: "Declined." } });
      await el.submit();
      expect(el.status).toBe("failed");
      expect(el.error?.code).toBe("card_declined");
    });

    it("mode change after prepare does NOT redirect submit to the wrong confirm API (regression: finding #2)", async () => {
      await el.prepare(); // prepared mode = "payment"
      el.setAttribute("mode", "setup");
      await el.submit();
      // submit must dispatch confirmPayment (prepared mode), NOT
      // confirmSetup — the clientSecret is still a PaymentIntent secret,
      // so calling confirmSetup would be an unrecoverable mis-dispatch.
      expect(fakes.confirmCalls).toHaveLength(1);
      expect(fakes.confirmCalls[0].kind).toBe("payment");
    });

    it("mode change after prepare dispatches hawc-stripe:stale-config warning", async () => {
      const warnings: CustomEvent[] = [];
      el.addEventListener("hawc-stripe:stale-config", (e) => warnings.push(e as CustomEvent));
      await el.prepare();
      el.setAttribute("mode", "setup");
      expect(warnings).toHaveLength(1);
      expect((warnings[0].detail as any).field).toBe("mode");
    });

    it("reset() + re-prepare lets mode change take effect", async () => {
      // Rebuild the core with a mode-responsive builder so switching modes
      // between prepares is legal (the default builder only returns payment).
      document.body.innerHTML = "";
      const flexCore = new StripeCore(provider, { webhookSecret: "whsec_test" });
      flexCore.registerIntentBuilder((req) => req.mode === "setup"
        ? { mode: "setup" }
        : { mode: "payment", amount: 1980, currency: "jpy" });
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(flexCore);

      await el.prepare(); // payment
      el.reset();
      el.setAttribute("mode", "setup");
      await el.prepare();
      await el.submit();
      // The most recent confirm must be setup now that we re-prepared.
      expect(fakes.confirmCalls[fakes.confirmCalls.length - 1].kind).toBe("setup");
    });
  });

  describe("3DS redirect resume (regression: findings #1 + URL authorization)", () => {
    it("rebuilds Core state from URL when intent_id AND client_secret are both present and match", async () => {
      setUrlSearch("?payment_intent=pi_resumed&payment_intent_client_secret=pi_resumed_secret_ok&redirect_status=succeeded");
      provider.retrieveResult = {
        id: "pi_resumed",
        status: "succeeded",
        mode: "payment",
        amount: { value: 1980, currency: "jpy" },
        paymentMethod: { id: "pm_z", brand: "mastercard", last4: "5555" },
        clientSecret: "pi_resumed_secret_ok",
      };
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      expect(provider.retrieveCalls).toEqual([{ mode: "payment", id: "pi_resumed" }]);
      expect(el.status).toBe("succeeded");
      expect(el.intentId).toBe("pi_resumed");
      expect(el.paymentMethod).toEqual({ id: "pm_z", brand: "mastercard", last4: "5555" });
      // Auto-prepare must NOT have created a second intent alongside the resumed one.
      expect(fakes.mountCalls).toHaveLength(0);
    });

    it("URL redirect params are stripped after resume, and subsequent prepare() proceeds (regression)", async () => {
      setUrlSearch("?payment_intent=pi_resumed&payment_intent_client_secret=pi_resumed_secret_ok&redirect_status=succeeded");
      provider.retrieveResult = {
        id: "pi_resumed",
        status: "succeeded",
        mode: "payment",
        amount: { value: 1980, currency: "jpy" },
        paymentMethod: { id: "pm_z", brand: "mastercard", last4: "5555" },
        clientSecret: "pi_resumed_secret_ok",
      };
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      expect(el.status).toBe("succeeded");

      // Stripe's redirect params must be gone from the URL so a reload /
      // share / back-button does not re-trigger resume.
      const params = new URLSearchParams(globalThis.location.search);
      expect(params.has("payment_intent")).toBe(false);
      expect(params.has("payment_intent_client_secret")).toBe(false);
      expect(params.has("redirect_status")).toBe(false);

      // User clicks "pay again" on the completion page. reset() +
      // prepare() must proceed — previously the stale URL kept
      // `_isPostRedirect()` latched true forever.
      el.reset();
      await el.prepare();
      expect(fakes.mountCalls).toHaveLength(1);
      expect(el.status).toBe("collecting");
      expect(el.intentId).toBe("pi_shell");
    });

    it("prepare() is still unblocked when URL cleanup is suppressed (history.replaceState sandboxed)", async () => {
      // Simulate a sandbox where replaceState is a no-op. Verify the
      // `_resumed` fallback gate in `_isPostRedirect()` still lets
      // subsequent prepare() / reset() go through even though the URL
      // cleanup could not run.
      setUrlSearch("?payment_intent=pi_resumed2&payment_intent_client_secret=pi_resumed2_secret_ok");
      const originalReplaceState = history.replaceState.bind(history);
      // Stub AFTER setUrlSearch so the URL actually carries the params
      // when the test starts. During the test, stubbed replaceState
      // leaves the URL alone.
      history.replaceState = () => { /* sandboxed no-op */ };

      try {
        provider.retrieveResult = {
          id: "pi_resumed2",
          status: "succeeded",
          mode: "payment",
          clientSecret: "pi_resumed2_secret_ok",
        };
        el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
        el.attachLocalCore(core);
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
        expect(el.status).toBe("succeeded");
        // URL params were NOT stripped (replaceState was a no-op).
        expect(globalThis.location.search).toContain("payment_intent=pi_resumed2");

        // A new prepare() must still proceed because `_resumed` overrides
        // the URL-based branch of `_isPostRedirect()`.
        el.reset();
        await el.prepare();
        expect(fakes.mountCalls).toHaveLength(1);
      } finally {
        history.replaceState = originalReplaceState;
      }
    });

    it("resume detects setup_intent and uses setup mode", async () => {
      setUrlSearch("?setup_intent=seti_resumed&setup_intent_client_secret=seti_resumed_secret_ok");
      provider.retrieveResult = {
        id: "seti_resumed",
        status: "succeeded",
        mode: "setup",
        paymentMethod: { id: "pm_a", brand: "visa", last4: "1111" },
        clientSecret: "seti_resumed_secret_ok",
      };
      el = createEl({ mode: "setup", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      expect(provider.retrieveCalls).toEqual([{ mode: "setup", id: "seti_resumed" }]);
      expect(el.status).toBe("succeeded");
    });

    it("rejects a foreign intent id when the client_secret does not match (permission-bypass regression)", async () => {
      // Attacker constructs a URL with a valid victim intent id but a
      // guessed/forged client_secret. Stripe retrieves the real intent,
      // but the ownership check rejects.
      setUrlSearch("?payment_intent=pi_victim&payment_intent_client_secret=pi_victim_secret_GUESSED");
      provider.retrieveResult = {
        id: "pi_victim",
        status: "succeeded",
        mode: "payment",
        amount: { value: 9999, currency: "usd" },
        paymentMethod: { id: "pm_v", brand: "visa", last4: "0000" },
        clientSecret: "pi_victim_secret_REAL",
      };
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      // State must NOT hydrate the victim's intent.
      expect(el.status).not.toBe("succeeded");
      expect(el.intentId).toBeNull();
      expect(el.paymentMethod).toBeNull();
      expect(el.error?.code).toBe("resume_client_secret_mismatch");
      // And the attacker cannot cancel via abort() — no active intent.
      const cancelBefore = provider.cancelCalls.length;
      await el.abort();
      expect(provider.cancelCalls.length).toBe(cancelBefore);
    });

    it("URL with intent_id but NO client_secret is treated as not-a-redirect (auto-prepare still runs)", async () => {
      // A hand-crafted/tampered URL. Since the secret is missing, the
      // Shell does not kick off resume — it falls through to normal
      // auto-prepare, which creates a fresh intent.
      setUrlSearch("?payment_intent=pi_hand_crafted");
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await el.prepare();  // auto-prepare runs normally
      expect(provider.retrieveCalls).toHaveLength(0);
      expect(fakes.mountCalls).toHaveLength(1);
      expect(el.intentId).toBe("pi_shell");  // fresh intent from the builder
    });
  });

  describe("non-exposure invariant", () => {
    it("does NOT expose clientSecret through any element property or attribute", async () => {
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await el.prepare();
      const secret = provider.nextClientSecret;
      const props: Record<string, unknown> = {
        status: el.status,
        loading: el.loading,
        amount: el.amount,
        paymentMethod: el.paymentMethod,
        intentId: el.intentId,
        error: el.error,
      };
      for (const [, v] of Object.entries(props)) {
        expect(JSON.stringify(v)).not.toContain(secret);
      }
      for (const attr of el.getAttributeNames()) {
        expect(el.getAttribute(attr) ?? "").not.toContain(secret);
      }
      for (const k of Object.keys(el.dataset)) {
        expect((el.dataset as any)[k]).not.toContain(secret);
      }
      expect(Object.keys(el as any)).not.toContain("clientSecret");
    });
  });

  describe("lifecycle commands", () => {
    beforeEach(() => {
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
    });

    it("abort() cancels the intent and returns to idle", async () => {
      await el.prepare();
      await el.abort();
      expect(provider.cancelCalls).toContain("pi_shell");
      expect(el.intentId).toBeNull();
      expect(el.status).toBe("idle");
    });

    it("reset() returns to idle without calling the provider", async () => {
      await el.prepare();
      el.reset();
      expect(el.status).toBe("idle");
      expect(provider.cancelCalls).toHaveLength(0);
    });

    it("declarative inputs forward to the Core", async () => {
      // Re-set after attach to drive attributeChangedCallback sync.
      el.setAttribute("amount-value", "500");
      el.setAttribute("amount-currency", "usd");
      el.setAttribute("customer-id", "cus_1");
      expect(core.amountValue).toBe(500);
      expect(core.amountCurrency).toBe("usd");
      expect(core.customerId).toBe("cus_1");
    });

    it("trigger=true fires submit()", async () => {
      const submitSpy = vi.spyOn(el, "submit");
      el.trigger = true;
      await new Promise(r => setTimeout(r, 0));
      expect(submitSpy).toHaveBeenCalled();
    });
  });
});
