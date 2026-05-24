// @wc-bindable/composite/lit — author a composite shell as a Lit element.
//
// `CompositeLitElement(options)` returns a `LitElement` base class that *is* a
// full composite shell — it carries the synthesized `static wcBindable`, the
// per-instance tier claim, the T1 property getters, the optional T2 facade, and
// `dispose()`, exactly like the vanilla `defineCompositeClass` base — and on top
// of that re-renders the author's `render()` whenever a composed value changes.
//
// It builds on the same `synthesizeComposite` / `setupCompositeInstance`
// machinery as the vanilla path, so the source elements are created once in the
// element's shadow root and the composed surface behaves identically; Lit simply
// renders the author's UI into the *same* shadow root, after the sources.

import { LitElement, type ReactiveController, type ReactiveControllerHost } from "lit";
import { ref as litRef } from "lit/directives/ref.js";
import { bind, isWcBindable, type WcBindableDeclaration } from "@wc-bindable/core";
import {
  synthesizeComposite,
  setupCompositeInstance,
  type DefineCompositeClassOptions,
  type SourceSpec,
} from "./declarative.js";
import { createCompositeTarget } from "./createCompositeTarget.js";
import type { CompositeEngine } from "./engine.js";
import type { CompositeShell, ExposeConfig } from "./types.js";
import type { Logger } from "./logger.js";

/**
 * A `LitElement` subclass that is also a composite wc-bindable shell. Instances
 * expose composed property getters, the optional T2 facade, the tier-claim
 * symbol, and an idempotent `dispose()`, and re-render on composed updates.
 */
export type CompositeLitElementClass = (new () => LitElement & { dispose(): void }) & {
  wcBindable: WcBindableDeclaration;
};

const documentRef: Document | undefined = typeof document !== "undefined" ? document : undefined;
const customElementsRef: CustomElementRegistry | undefined =
  typeof customElements !== "undefined" ? customElements : undefined;

/**
 * Build a Lit base class for a composite shell. Subclass it, add a `render()`
 * that reads the composed values, and register it with `@customElement` (or
 * `customElements.define`).
 *
 * ```ts
 * import { html } from "lit";
 * import { customElement } from "lit/decorators.js";
 * import { CompositeLitElement } from "@wc-bindable/composite/lit";
 *
 * const Base = await CompositeLitElement({
 *   sources: [{ id: "s3", tag: "s3-uploader" }, { id: "ai", tag: "ai-agent" }],
 * });
 *
 * @customElement("my-ai-workbench")
 * class MyAiWorkbench extends Base {
 *   render() {
 *     return html`
 *       <progress .value=${this["s3.progress"] ?? 0}></progress>
 *       <p>${this["ai.answer"]}</p>
 *       <button @click=${() => { this["ai.prompt"] = "hi"; this["ai.run"](); }}>Run</button>
 *     `;
 *   }
 * }
 * ```
 *
 * Like {@link defineCompositeClass}, this awaits `customElements.whenDefined()`
 * for every source tag first, so the synthesized `static wcBindable` is fully
 * determined (and statically inherited by the subclass).
 *
 * **Shadow-root sharing.** The base creates the source elements in the element's
 * shadow root during `connectedCallback` (synchronously, so an external
 * `bind(el, …)` right after connection sees the composed surface). Lit then
 * renders the author's `render()` output into that *same* shadow root — its
 * content is inserted after the sources, so the two never clash and
 * `static styles` are adopted as usual. A subclass overriding
 * `connectedCallback` MUST call `super.connectedCallback()`.
 */
export async function CompositeLitElement(
  options: DefineCompositeClassOptions,
): Promise<CompositeLitElementClass> {
  if (!customElementsRef || !documentRef) {
    throw new Error("@wc-bindable/composite/lit: CompositeLitElement requires a DOM");
  }
  const synth = await synthesizeComposite(options);

  class CompositeLit extends LitElement {
    static readonly wcBindable: WcBindableDeclaration = synth.plan.declaration;

    #engine: CompositeEngine | undefined;
    #unbind: (() => void) | undefined;
    #setup = false;

    connectedCallback(): void {
      this.#setupComposite();
      // After the composite surface exists, let Lit run its own connect +
      // first-update cycle. Lit's createRenderRoot reuses the shadow root we
      // already attached (ReactiveElement: `this.shadowRoot ?? attachShadow`)
      // and adopts `static styles` into it, then renders after the sources.
      super.connectedCallback();
    }

    #setupComposite(): void {
      if (this.#setup) return; // reconnect: listeners were kept, nothing to do
      const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
      this.#engine = setupCompositeInstance(this, shadow, synth);
      // Re-render whenever a composed value changes. Composed names are dotted
      // strings, not Lit reactive properties, so Lit would not otherwise observe
      // them — bridge each shell update to requestUpdate().
      this.#unbind = bind(this, () => this.requestUpdate());
      this.#setup = true;
    }

    /** Idempotent terminal teardown (§ 10). Does not dispose the source elements. */
    dispose(): void {
      this.#unbind?.();
      this.#unbind = undefined;
      this.#engine?.dispose();
    }
  }

  return CompositeLit as unknown as CompositeLitElementClass;
}

export interface CompositeControllerOptions {
  /**
   * Expected source specs: a stable id paired with the source custom-element
   * tag. The host renders one element per spec and tags it with the matching
   * {@link CompositeController.ref} directive; the controller composes those
   * rendered instances once all are attached and defined.
   */
  sources: SourceSpec[];
  /** What the shell exposes. Defaults to `"all-prefixed"`. */
  expose?: ExposeConfig;
  /** Materialize a T2 local facade on the shell. Defaults per `createCompositeTarget`. */
  localFacade?: boolean;
  /** Claim remote compatibility on the shell's tier claim. */
  remoteCompatible?: boolean;
  /** Logger for getter-failure / delegation reports. Defaults to the console logger. */
  logger?: Logger;
}

/**
 * A Lit `ReactiveController` that composes source elements the host renders in
 * its **own** template — the controller does not create or place the sources, so
 * the author keeps full control of the DOM. Tag each rendered source with the
 * directive returned by {@link CompositeController.ref}; once every expected
 * source is attached and defined, the controller builds a real composite shell
 * (via `createCompositeTarget`) over those instances, exposes the composed values
 * on {@link CompositeController.values} (re-requesting a host update on each
 * change), and exposes the shell itself on {@link CompositeController.shell}.
 *
 * ```ts
 * import { LitElement, html } from "lit";
 * import { customElement } from "lit/decorators.js";
 * import { CompositeController } from "@wc-bindable/composite/lit";
 *
 * @customElement("my-ai-workbench")
 * class MyAiWorkbench extends LitElement {
 *   #c = new CompositeController(this, {
 *     sources: [{ id: "s3", tag: "s3-uploader" }, { id: "ai", tag: "ai-agent" }],
 *   });
 *   render() {
 *     return html`
 *       <s3-uploader ${this.#c.ref("s3")}></s3-uploader>
 *       <ai-agent ${this.#c.ref("ai")}></ai-agent>
 *       <p>${this.#c.values["ai.answer"]}</p>
 *       <button @click=${() => { this.#c.shell!["ai.prompt"] = "hi"; this.#c.shell!["ai.run"](); }}>
 *         Run
 *       </button>
 *     `;
 *   }
 * }
 * ```
 *
 * Unlike {@link CompositeLitElement} (where the host element *is* the shell), the
 * host here is a plain Lit component using composition internally; the composed
 * shell is the separate, headless `createCompositeTarget` value on `.shell`,
 * which the author can also hand to `@wc-bindable/remote` or bind elsewhere. The
 * controller follows the usual controller lifecycle: when the host disconnects,
 * the source ref directives detach, the shell is torn down, and a reconnect
 * rebuilds it (so `.shell` identity is not stable across disconnects — use
 * `createCompositeTarget` directly or {@link CompositeLitElement} if you need a
 * stable external shell).
 */
export class CompositeController<V extends object = Record<string, unknown>>
  implements ReactiveController
{
  /** The latest composed property values, replaced (not mutated) on each update. */
  values: V = {} as V;

  readonly #host: ReactiveControllerHost;
  readonly #sources: SourceSpec[];
  readonly #expose?: ExposeConfig;
  readonly #localFacade?: boolean;
  readonly #remoteCompatible?: boolean;
  readonly #logger?: Logger;

  readonly #instances = new Map<string, EventTarget>();
  readonly #refCallbacks = new Map<string, (el: Element | undefined) => void>();
  #shell: CompositeShell | undefined;
  #unbind: (() => void) | undefined;
  #defined = false;
  #disposed = false;

  constructor(host: ReactiveControllerHost, options: CompositeControllerOptions) {
    this.#host = host;
    this.#sources = options.sources.slice();
    this.#expose = options.expose;
    this.#localFacade = options.localFacade;
    this.#remoteCompatible = options.remoteCompatible;
    this.#logger = options.logger;
    host.addController(this);

    // Wait for every source tag's definition before composing, so the
    // synthesized declaration is finalized before the shell is observable
    // (§ 11). Already-defined tags resolve on a microtask.
    if (customElementsRef) {
      Promise.all(this.#sources.map((s) => customElementsRef.whenDefined(s.tag))).then(() => {
        this.#defined = true;
        this.#tryBuild();
      });
    } else {
      this.#defined = true;
    }
  }

  /** The composed shell once all sources are attached and defined, else `undefined`. */
  get shell(): CompositeShell | undefined {
    return this.#shell;
  }

  /**
   * The Lit `ref` directive to apply to the source element rendered for `id`.
   * The callback is memoized per id so re-renders do not churn the binding.
   */
  ref(id: string): ReturnType<typeof litRef> {
    let cb = this.#refCallbacks.get(id);
    if (!cb) {
      cb = (el: Element | undefined) => this.#onSourceRef(id, el);
      this.#refCallbacks.set(id, cb);
    }
    return litRef(cb);
  }

  hostDisconnected(): void {
    // The source ref directives fire `undefined` on disconnect, which already
    // tears the shell down; this is a defensive backstop for hosts whose parts
    // do not propagate disconnection. NOT terminal — a reconnect rebuilds.
    this.#teardownShell();
  }

  /**
   * Idempotent **terminal** teardown: tears down the shell (sources are
   * borrowed) and puts the controller into a disposed state so no later ref
   * callback or reconnect can rebuild it. Use it when you are done with the
   * controller for good; for an ordinary disconnect, the controller already
   * tears the shell down and rebuilds on reconnect without any call.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#host.removeController(this);
    this.#instances.clear();
    this.#teardownShell();
  }

  #onSourceRef(id: string, el: Element | undefined): void {
    if (this.#disposed) return; // terminal: never rebuild after dispose()
    if (el) {
      this.#instances.set(id, el);
      this.#tryBuild();
    } else {
      this.#instances.delete(id);
      // A source detached → the current shell is stale; tear it down so a later
      // reattach rebuilds against the fresh instances.
      this.#teardownShell();
    }
  }

  #tryBuild(): void {
    if (this.#disposed || this.#shell || !this.#defined) return;
    const sources: Record<string, EventTarget> = {};
    for (const spec of this.#sources) {
      const el = this.#instances.get(spec.id);
      if (!el || !isWcBindable(el)) return; // wait until every source is ready
      sources[spec.id] = el;
    }

    const shell = createCompositeTarget({
      sources,
      expose: this.#expose,
      localFacade: this.#localFacade,
      remoteCompatible: this.#remoteCompatible,
      logger: this.#logger,
    });
    this.#shell = shell;
    this.#unbind = bind(shell, (name, value) => {
      this.values = { ...this.values, [name]: value } as V;
      this.#host.requestUpdate();
    });
    this.#host.requestUpdate();
  }

  #teardownShell(): void {
    this.#unbind?.();
    this.#unbind = undefined;
    this.#shell?.dispose();
    this.#shell = undefined;
  }
}
