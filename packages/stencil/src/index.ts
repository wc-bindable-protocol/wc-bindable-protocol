import { forceUpdate } from "@stencil/core";
import { bind, type BindOptions } from "@wc-bindable/core";

export type WcBindableTarget =
  | HTMLElement
  | null
  | undefined
  | (() => HTMLElement | null | undefined);

export type WcBindableHost = HTMLElement | object;

export interface WcBindableControllerOptions {
  /**
   * Forwarded to `bind()`. Defaults to `"define"` so a target whose
   * definition arrives after `connect()` still binds — see SPEC.md
   * § Deferring Discovery Until Definition. Pass `"call"` to opt back into
   * the historical behavior, where a not-yet-upgraded element is skipped
   * until something else triggers a re-attach.
   */
  syncOn?: BindOptions["syncOn"];
}

export class WcBindableController<V extends object = Record<string, unknown>> {
  values: V;

  private readonly host: WcBindableHost;
  private readonly getTarget: () => HTMLElement | null | undefined;
  private readonly syncOn: BindOptions["syncOn"];
  private currentTarget: HTMLElement | null = null;
  private unbind?: () => void;

  constructor(
    host: WcBindableHost,
    target: WcBindableTarget,
    initialValues: Partial<V> = {},
    options: WcBindableControllerOptions = {},
  ) {
    this.host = host;
    this.values = { ...initialValues } as V;
    this.syncOn = options.syncOn ?? "define";
    this.getTarget =
      typeof target === "function" ? target : () => target ?? null;
  }

  connect(): void {
    this.attach();
  }

  disconnect(): void {
    this.detach();
  }

  update(): void {
    const next = this.getTarget() ?? null;
    if (next !== this.currentTarget || (next && !this.unbind)) {
      this.detach();
      this.attach();
    }
  }

  private attach(): void {
    const el = this.getTarget() ?? null;
    this.currentTarget = el;
    if (!el) return;

    // No `isWcBindable()` gate: bind() already returns a no-op cleanup for
    // a non-bindable target, and the gate is precisely what defeated
    // `syncOn: "define"` — it fails for a not-yet-upgraded custom element.
    // Note this also stops `update()` from re-attaching on every host
    // update for a target that is not bindable: `unbind` is now always set,
    // so the `(next && !this.unbind)` re-attach condition no longer fires
    // repeatedly. That retry loop was the only thing that ever recovered a
    // late-defined target here, and the deferred bind replaces it with a
    // single wait.
    this.unbind = bind(el, (name, value) => {
      this.values = { ...this.values, [name]: value };
      forceUpdate(this.host as HTMLElement);
    }, { syncOn: this.syncOn });
  }

  private detach(): void {
    this.unbind?.();
    this.unbind = undefined;
    this.currentTarget = null;
  }
}
