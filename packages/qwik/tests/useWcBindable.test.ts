import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WcBindableDeclaration } from "@wc-bindable/core";

/**
 * Qwik's `useSignal` / `useStore` / `useVisibleTaskQrl` require a running
 * Qwik invoke context, and its testing DOM (domino) does not implement
 * `customElements`, which the wc-bindable protocol depends on. Rather than
 * spin up a full Qwik render, we mock the three primitives so the adapter's
 * own wiring — the visible task callback and how it shapes updates into the
 * Qwik store — is exercised end-to-end against happy-dom's real DOM and
 * customElements registry.
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

vi.mock("@builder.io/qwik", () => ({
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
}));

// Import AFTER the mock is installed.
const { useWcBindable } = await import("../src/index.js");

const TAG = "qwik-test-input";

if (!customElements.get(TAG)) {
  const decl: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "qwik-test-input:value-changed" },
      { name: "checked", event: "qwik-test-input:checked-changed" },
    ],
  };
  class QwikTestInput extends HTMLElement {
    static wcBindable = decl;
  }
  customElements.define(TAG, QwikTestInput);
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

describe("useWcBindable (Qwik)", () => {
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
      new CustomEvent("qwik-test-input:value-changed", { detail: "hello" }),
    );
    expect(values.value).toBe("hello");

    el.dispatchEvent(
      new CustomEvent("qwik-test-input:checked-changed", { detail: true }),
    );
    expect(values.checked).toBe(true);
  });

  it("cleans up listeners via the task's cleanup callback", () => {
    const { values } = useWcBindable<HTMLElement, { value: string }>({ value: "" });

    const el = document.createElement(TAG);
    const cleanup = runTask(el);

    el.dispatchEvent(
      new CustomEvent("qwik-test-input:value-changed", { detail: "before" }),
    );
    expect(values.value).toBe("before");

    cleanup();

    el.dispatchEvent(
      new CustomEvent("qwik-test-input:value-changed", { detail: "after" }),
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
