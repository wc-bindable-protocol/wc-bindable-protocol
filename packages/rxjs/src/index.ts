import { BehaviorSubject } from "rxjs";
import { bind, isWcBindable } from "@wc-bindable/core";

export type UnbindFn = () => void;
export type OnUpdate = (name: string, value: unknown) => void;

export function wcBindable(el: Element, onUpdate: OnUpdate): UnbindFn {
  if (!isWcBindable(el)) return () => {};
  return bind(el, onUpdate);
}

export type WcBindableSubjects<V extends object> = {
  [K in keyof V]: BehaviorSubject<V[K]>;
};

export interface WcBindableBinder<V extends object> {
  readonly subjects: WcBindableSubjects<V>;
  bind(el: Element): void;
  unbind(): void;
}

export function createWcBindable<V extends object = Record<string, unknown>>(
  initialValues: Partial<V> = {},
): WcBindableBinder<V> {
  const subjects = {} as Record<string, BehaviorSubject<unknown>>;
  for (const key of Object.keys(initialValues) as (keyof V)[]) {
    subjects[key as string] = new BehaviorSubject<unknown>(
      (initialValues as Record<string, unknown>)[key as string],
    );
  }

  let unbindFn: UnbindFn | null = null;

  return {
    get subjects() {
      return subjects as WcBindableSubjects<V>;
    },
    bind(el) {
      if (unbindFn) {
        unbindFn();
        unbindFn = null;
      }
      if (!isWcBindable(el)) return;
      // syncOn: "connect" defers the initial-value read until the element is
      // attached to the document so users do not have to sequence
      // bind() after appendChild() manually.
      unbindFn = bind(el, (name, value) => {
        const existing = subjects[name];
        if (existing) {
          existing.next(value);
        } else {
          subjects[name] = new BehaviorSubject<unknown>(value);
        }
      }, { syncOn: "connect" });
    },
    unbind() {
      if (unbindFn) {
        unbindFn();
        unbindFn = null;
      }
    },
  };
}
