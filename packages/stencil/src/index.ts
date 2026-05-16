import { forceUpdate } from "@stencil/core";
import { bind, isWcBindable } from "@wc-bindable/core";

export type WcBindableTarget =
  | HTMLElement
  | null
  | undefined
  | (() => HTMLElement | null | undefined);

export type WcBindableHost = HTMLElement | object;

export class WcBindableController<V extends object = Record<string, unknown>> {
  values: V;

  private readonly host: WcBindableHost;
  private readonly getTarget: () => HTMLElement | null | undefined;
  private currentTarget: HTMLElement | null = null;
  private unbind?: () => void;

  constructor(
    host: WcBindableHost,
    target: WcBindableTarget,
    initialValues: Partial<V> = {},
  ) {
    this.host = host;
    this.values = { ...initialValues } as V;
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
    if (!el || !isWcBindable(el)) {
      this.currentTarget = el;
      return;
    }

    this.currentTarget = el;
    this.unbind = bind(el, (name, value) => {
      this.values = { ...this.values, [name]: value };
      forceUpdate(this.host as HTMLElement);
    });
  }

  private detach(): void {
    this.unbind?.();
    this.unbind = undefined;
    this.currentTarget = null;
  }
}
