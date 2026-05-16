import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WcBindableDeclaration } from "@wc-bindable/core";

/**
 * Parallel of useWcBindable.test.ts for the Qwik 2 (`@qwik.dev/core`) entry.
 * Qwik 2 splits `useVisibleTaskQrl` / `inlinedQrl` into `/internal`, so this
 * test verifies the v2 shim wires the two distinct module paths correctly —
 * the most fragile surface, since `/internal` has no semver guarantee.
 */

type TaskCtx = {
  cleanup: (fn: () => void) => void;
  track: <T>(fn: () => T) => T;
};
type TaskFn = (ctx: TaskCtx) => void | (() => void);
type SignalLike<T> = { value: T | undefined };

const capturedTasks: TaskFn[] = [];
let lastSignal: SignalLike<unknown> | undefined;
let lastStore: Record<string, unknown> | undefined;

// Qwik 2 maps both `@qwik.dev/core` and `@qwik.dev/core/internal` to the same
// underlying `dist/core.mjs` (just different .d.ts), so a single mock factory
// must satisfy both module paths or vi.mock entries collide.
const qwikCoreMock = {
  useSignal: <T,>(): SignalLike<T> => {
    const s: SignalLike<T> = { value: undefined };
    lastSignal = s as SignalLike<unknown>;
    return s;
  },
  useStore: <T extends object>(initial: T): T => {
    const s = { ...initial } as Record<string, unknown>;
    lastStore = s;
    return s as T;
  },
  useVisibleTaskQrl: (qrl: { resolved: TaskFn }) => {
    capturedTasks.push(qrl.resolved);
  },
  inlinedQrl: <T,>(fn: T) => ({ resolved: fn }),
};

vi.mock("@qwik.dev/core", () => qwikCoreMock);
vi.mock("@qwik.dev/core/internal", () => qwikCoreMock);

const { useWcBindable } = await import("../src/v2.js");

const TAG = "qwik-v2-test-input";

if (!customElements.get(TAG)) {
  const decl: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "qwik-v2-test-input:value-changed" },
      { name: "checked", event: "qwik-v2-test-input:checked-changed" },
    ],
  };
  class QwikV2TestInput extends HTMLElement {
    static wcBindable = decl;
  }
  customElements.define(TAG, QwikV2TestInput);
}

function runTask(refValue: Element | undefined): () => void {
  const task = capturedTasks[capturedTasks.length - 1];
  lastSignal!.value = refValue;
  let cleanupFn: () => void = () => {};
  task({
    cleanup: (fn) => {
      cleanupFn = fn;
    },
    track: (fn) => fn(),
  });
  return cleanupFn;
}

describe("useWcBindable (Qwik 2 / v2 entry)", () => {
  beforeEach(() => {
    capturedTasks.length = 0;
    lastSignal = undefined;
    lastStore = undefined;
  });

  it("returns initial values on the store before any event", () => {
    const { values } = useWcBindable<HTMLElement, { value: string; checked: boolean }>({
      value: "init",
      checked: false,
    });

    expect(values).toEqual({ value: "init", checked: false });
  });

  it("registers a visible task that binds when the ref resolves", () => {
    useWcBindable<HTMLElement, { value: string }>({ value: "" });

    expect(capturedTasks).toHaveLength(1);
  });

  it("updates the store when bindable events are dispatched", () => {
    const { values } = useWcBindable<HTMLElement, { value: string; checked: boolean }>({
      value: "",
      checked: false,
    });

    const el = document.createElement(TAG);
    runTask(el);

    el.dispatchEvent(
      new CustomEvent("qwik-v2-test-input:value-changed", { detail: "hello" }),
    );
    expect(values.value).toBe("hello");

    el.dispatchEvent(
      new CustomEvent("qwik-v2-test-input:checked-changed", { detail: true }),
    );
    expect(values.checked).toBe(true);
  });

  it("cleans up listeners via the task's cleanup callback", () => {
    const { values } = useWcBindable<HTMLElement, { value: string }>({ value: "" });

    const el = document.createElement(TAG);
    const cleanup = runTask(el);

    el.dispatchEvent(
      new CustomEvent("qwik-v2-test-input:value-changed", { detail: "before" }),
    );
    expect(values.value).toBe("before");

    cleanup();

    el.dispatchEvent(
      new CustomEvent("qwik-v2-test-input:value-changed", { detail: "after" }),
    );
    expect(values.value).toBe("before");
  });

  it("performs an initial sync from properties already present on the element", () => {
    const { values } = useWcBindable<HTMLElement, { value: string }>({ value: "" });

    const el = document.createElement(TAG) as HTMLElement & { value?: string };
    el.value = "preset";
    runTask(el);

    expect(values.value).toBe("preset");
  });

  it("does not bind when the target is not wc-bindable", () => {
    const { values } = useWcBindable<HTMLDivElement>({});

    const plain = document.createElement("div");
    runTask(plain);

    plain.dispatchEvent(new CustomEvent("anything", { detail: "x" }));
    expect(Object.keys(values)).toHaveLength(0);
  });

  it("does nothing when the tracked ref is empty", () => {
    useWcBindable<HTMLElement>({});

    expect(() => runTask(undefined)).not.toThrow();
  });
});
