import van, { type State } from "vanjs-core";
import { bind, isWcBindable } from "@wc-bindable/core";

export type UnbindFn = () => void;
export type OnUpdate = (name: string, value: unknown) => void;

export function wcBindable(el: Element, onUpdate: OnUpdate): UnbindFn {
  if (!isWcBindable(el)) return () => {};
  return bind(el, onUpdate);
}

export type WcBindableStates<V extends object> = {
  [K in keyof V]: State<V[K]>;
};

export interface WcBindableBinder<V extends object> {
  readonly states: WcBindableStates<V>;
  bind(el: Element): void;
  unbind(): void;
}

export function createWcBindable<V extends object = Record<string, unknown>>(
  initialValues: Partial<V> = {},
): WcBindableBinder<V> {
  const states = {} as Record<string, State<unknown>>;
  for (const key of Object.keys(initialValues) as (keyof V)[]) {
    states[key as string] = van.state(
      (initialValues as Record<string, unknown>)[key as string],
    );
  }

  let unbindFn: UnbindFn | null = null;

  return {
    get states() {
      return states as WcBindableStates<V>;
    },
    bind(el) {
      if (unbindFn) {
        unbindFn();
        unbindFn = null;
      }
      if (!isWcBindable(el)) return;
      unbindFn = bind(el, (name, value) => {
        const existing = states[name];
        if (existing) {
          existing.val = value;
        } else {
          states[name] = van.state(value);
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
