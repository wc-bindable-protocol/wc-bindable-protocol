import { Signal } from "signal-polyfill";
import { bind, isWcBindable } from "@wc-bindable/core";

export type UnbindFn = () => void;
export type OnUpdate = (name: string, value: unknown) => void;

export function wcBindable(el: Element, onUpdate: OnUpdate): UnbindFn {
  if (!isWcBindable(el)) return () => {};
  return bind(el, onUpdate);
}

export type WcBindableSignals<V extends object> = {
  [K in keyof V]: Signal.State<V[K]>;
};

export interface WcBindableBinder<V extends object> {
  readonly signals: WcBindableSignals<V>;
  bind(el: Element): void;
  unbind(): void;
}

export function createWcBindable<V extends object = Record<string, unknown>>(
  initialValues: Partial<V> = {},
): WcBindableBinder<V> {
  const signals = {} as Record<string, Signal.State<unknown>>;
  for (const key of Object.keys(initialValues) as (keyof V)[]) {
    signals[key as string] = new Signal.State(
      (initialValues as Record<string, unknown>)[key as string],
    );
  }

  let unbindFn: UnbindFn | null = null;

  return {
    get signals() {
      return signals as WcBindableSignals<V>;
    },
    bind(el) {
      if (unbindFn) {
        unbindFn();
        unbindFn = null;
      }
      if (!isWcBindable(el)) return;
      unbindFn = bind(el, (name, value) => {
        const existing = signals[name];
        if (existing) {
          existing.set(value);
        } else {
          signals[name] = new Signal.State(value);
        }
      });
    },
    unbind() {
      if (unbindFn) {
        unbindFn();
        unbindFn = null;
      }
    },
  };
}
