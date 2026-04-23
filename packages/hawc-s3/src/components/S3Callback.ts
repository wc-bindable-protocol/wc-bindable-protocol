import { _getInternalConfig } from "../config.js";

/**
 * <hawc-s3-callback on="completed"><script type="module">…</script></hawc-s3-callback>
 *
 * Browser-side declarative callback for state-change events emitted by an
 * ancestor <hawc-s3>. The inline ES module is loaded via a Blob URL and its
 * default export is invoked with the event detail.
 *
 * Server-side post-processing does NOT use this element — for that, register
 * a hook on the server-side S3Core via `core.registerPostProcess(fn)`.
 *
 * SECURITY WARNING — this element dynamic-imports arbitrary ES modules from:
 *   (a) an inline `<script type="module">` child, or
 *   (b) the `src` attribute (a URL).
 * Both are an XSS-equivalent vector when rendered inside untrusted HTML: a
 * page that includes HTML from a user-authored source can inject
 * `<hawc-s3-callback src="https://attacker/evil.js">` and the attacker's
 * module will execute with the same privileges as the page. Do NOT mount
 * this element in any context that renders untrusted HTML. For trusted
 * contexts, consider pairing it with a strict CSP (`script-src` /
 * `trusted-types`) to restrict which module URLs are loadable.
 */
export class S3Callback extends HTMLElement {
  private _hostElement: HTMLElement | null = null;
  private _eventName: string = "";
  private _handler: ((e: Event) => void) | null = null;
  private _fn: ((detail: unknown, ctx: { event: Event; host: HTMLElement }) => unknown | Promise<unknown>) | null = null;
  private _blobUrl: string | null = null;
  /** Increments per (re)load; lets stale dynamic-import resolutions abort. */
  private _loadGeneration: number = 0;

  static get observedAttributes(): string[] {
    return ["on", "src", "for"];
  }

  constructor() {
    super();
    // The <script> child is metadata for us, not for the page renderer.
    // A no-slot shadow root suppresses default rendering of light DOM children.
    this.attachShadow({ mode: "open" });
  }

  /** Translate friendly `on` values to actual event names. */
  private _resolveEventName(on: string): string {
    if (!on) return "";
    if (on.includes(":")) return on;
    if (on === "error") return "hawc-s3:error";
    return `hawc-s3:${on}-changed`;
  }

  private _findHost(): HTMLElement | null {
    const selector = this.getAttribute("for");
    if (selector) {
      // Allow callbacks placed outside the <hawc-s3> tree, e.g. in a portal.
      return document.querySelector<HTMLElement>(selector);
    }
    // Walk up the DOM looking for an instance of the configured host tag.
    // Reading config here (rather than at module load) means a `setConfig`
    // call before bootstrapS3() takes effect even on already-defined classes.
    const hostTag = _getInternalConfig().tagNames.s3.toLowerCase();
    let node: Node | null = this.parentNode;
    while (node) {
      if (node instanceof HTMLElement && node.tagName.toLowerCase() === hostTag) {
        return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  private async _loadModule(): Promise<void> {
    const generation = ++this._loadGeneration;
    this._revokeBlob();
    this._fn = null;

    // Bail before allocating anything if the element is no longer in the DOM.
    // disconnectedCallback may have already run between our schedule and now
    // (the queueMicrotask in connectedCallback, or an attribute mutation
    // followed by immediate removal). Without this guard, _loadModule would
    // create a Blob URL and dynamic-import a module on a detached element
    // with no clean-up path — disconnectedCallback fires only once and is
    // not going to be called again, so the Blob URL and the captured _fn
    // would accumulate across rapid mount/unmount cycles.
    if (!this.isConnected) return;

    const src = this.getAttribute("src");
    let moduleUrl: string;
    // Capture THIS invocation's blob URL locally so a subsequent
    // _loadModule(gen+1) that overwrites `this._blobUrl` with a newer blob
    // does not cause our stale cleanup below to revoke the wrong URL.
    // Previously `this._revokeBlob()` on a stale path read
    // `this._blobUrl` — which by then pointed at the newer generation's
    // blob — and revoked it, causing the newer generation's dynamic
    // import to 404 on a revoked URL.
    let myBlobUrl: string | null = null;
    if (src) {
      moduleUrl = src;
    } else {
      const script = this.querySelector("script");
      const code = script?.textContent ?? "";
      if (!code.trim()) return;
      const blob = new Blob([code], { type: "text/javascript" });
      myBlobUrl = URL.createObjectURL(blob);
      this._blobUrl = myBlobUrl;
      moduleUrl = myBlobUrl;
    }

    try {
      // TODO(future): optional `integrity` attribute (SRI). Native dynamic
      // `import()` does not yet honour the `integrity` option that
      // `<script type="module" integrity="...">` does, so enforcement would
      // have to be done manually: fetch the module as text, verify a
      // SubtleCrypto hash matches, then feed into a Blob URL. Until the
      // platform surfaces an import-time integrity hook, rely on the
      // README security warning + CSP `script-src` / `trusted-types` to
      // restrict which module URLs can be loaded. Recorded as a future
      // enhancement; not gating current behaviour.
      const mod = await import(/* @vite-ignore */ moduleUrl);
      // After the await, two things can have changed: (a) a newer load
      // superseded this one (_loadGeneration bumped), (b) the element was
      // removed from the DOM. In either case we must revoke the Blob URL
      // WE just allocated — not whatever `this._blobUrl` now points at
      // (it may belong to a newer generation that is still live).
      if (generation !== this._loadGeneration || !this.isConnected) {
        this._revokeMyBlob(myBlobUrl);
        return;
      }
      const fn = mod?.default;
      if (typeof fn !== "function") {
        // Revoke OUR Blob URL: the module resolved but has no usable export,
        // so the allocation serves no further purpose. Same "every alloc is
        // matched by a revoke within a bounded window" invariant as the catch
        // path below — we do not wait for a hypothetical disconnect.
        this._revokeMyBlob(myBlobUrl);
        this._dispatchLocalError(new Error("[@wc-bindable/hawc-s3] <hawc-s3-callback> module has no default export function."));
        return;
      }
      // Cast to our declared signature. Runtime shape is validated above
      // (typeof === "function"); the user-authored module's parameter types
      // are opaque to us, so we treat detail as `unknown` per the ABI contract.
      this._fn = fn as (detail: unknown, ctx: { event: Event; host: HTMLElement }) => unknown | Promise<unknown>;
    } catch (e: unknown) {
      // Always revoke OUR Blob URL on the failure path — scoped to the local
      // capture so the revoke can never target a newer generation's blob
      // (which may now live in `this._blobUrl` if a racing _loadModule has
      // already started and assigned its own URL). `_revokeMyBlob` additionally
      // clears `this._blobUrl` when it still points at the one we revoked,
      // so a same-generation disconnectedCallback does not attempt a
      // double-revoke.
      //
      // A prior revision left `_blobUrl` attached on still-connected failure
      // and relied on `disconnectedCallback` (or the next `_loadModule`) to
      // revoke it. In a page that pins a <hawc-s3-callback> for a long
      // session and retries `src` after transient network failures, those
      // stale URLs would accumulate indefinitely — the disconnect path is
      // hypothetical, not guaranteed. Revoking unconditionally upholds the
      // invariant "every createObjectURL is matched by a revokeObjectURL"
      // within a bounded window regardless of how the element is used.
      this._revokeMyBlob(myBlobUrl);
      if (generation !== this._loadGeneration || !this.isConnected) {
        return;
      }
      this._dispatchLocalError(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /**
   * Revoke a specific Blob URL that this invocation allocated, without
   * touching `this._blobUrl` (which may now belong to a newer generation).
   * If our URL IS still the element's current blob, clear the field too so
   * disconnectedCallback does not try to revoke an already-revoked URL.
   */
  private _revokeMyBlob(myBlobUrl: string | null): void {
    if (!myBlobUrl) return;
    URL.revokeObjectURL(myBlobUrl);
    if (this._blobUrl === myBlobUrl) this._blobUrl = null;
  }

  private _revokeBlob(): void {
    if (this._blobUrl) {
      URL.revokeObjectURL(this._blobUrl);
      this._blobUrl = null;
    }
  }

  private _dispatchLocalError(error: Error): void {
    this.dispatchEvent(new CustomEvent("hawc-s3-callback:error", {
      detail: error,
      bubbles: true,
    }));
  }

  private _attach(): void {
    // Guard: callers schedule _attach() through async chains (the microtask in
    // connectedCallback, the await in _loadModule().then(...)). The element
    // can be removed from the DOM before those resolve. If we attach anyway,
    // the listener registers on a still-live host while THIS callback element
    // is detached — preventing GC of the callback and leaving an off-DOM
    // listener. disconnectedCallback already ran, so it will not fire again
    // to clean up. Bail before touching the host.
    if (!this.isConnected) return;
    this._detach();
    const host = this._findHost();
    const eventName = this._resolveEventName(this.getAttribute("on") || "");
    if (!host || !eventName) return;
    this._hostElement = host;
    this._eventName = eventName;
    const handler = (e: Event) => {
      const fn = this._fn;
      if (!fn) return;
      const detail = (e as CustomEvent).detail;
      try {
        const ret = fn(detail, { event: e, host });
        // Surface async failures so they do not vanish silently. Non-Error
        // rejections are re-wrapped so consumers always receive a stable
        // Error shape at `hawc-s3-callback:error`.
        if (ret && typeof (ret as Promise<unknown>).then === "function") {
          (ret as Promise<unknown>).catch((err: unknown) =>
            this._dispatchLocalError(err instanceof Error ? err : new Error(String(err))),
          );
        }
      } catch (err: unknown) {
        this._dispatchLocalError(err instanceof Error ? err : new Error(String(err)));
      }
    };
    this._handler = handler;
    host.addEventListener(eventName, handler);
  }

  private _detach(): void {
    if (this._hostElement && this._handler && this._eventName) {
      this._hostElement.removeEventListener(this._eventName, this._handler);
    }
    this._hostElement = null;
    this._handler = null;
    this._eventName = "";
  }

  connectedCallback(): void {
    this.style.display = "none";
    // Defer one microtask so the parent <hawc-s3> upgrade has run by the time
    // we look it up — the order of customElements.define / DOM parsing is not
    // guaranteed when tags are registered after the document is parsed.
    queueMicrotask(() => {
      this._loadModule().then(() => this._attach());
    });
  }

  attributeChangedCallback(name: string, _oldValue: string | null, _newValue: string | null): void {
    if (!this.isConnected) return;
    if (name === "src") {
      this._loadModule().then(() => this._attach());
    } else {
      this._attach();
    }
  }

  disconnectedCallback(): void {
    this._detach();
    this._revokeBlob();
    this._fn = null;
    // Bump generation so any in-flight import resolution is dropped.
    this._loadGeneration++;
  }
}
