import type { WcBindableDeclaration } from "@wc-bindable/core";

/**
 * A headless wc-bindable source that mimics an uploader: a `progress` output
 * property, a `file` input, and an `upload` command.
 */
export class UploaderSource extends EventTarget {
  static wcBindable: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: [{ name: "progress", event: "uploader:progress" }],
    inputs: [{ name: "file", attribute: "file" }],
    commands: [{ name: "upload", async: true }],
  };

  progress = 0;
  file: unknown = null;
  uploadCalls: unknown[][] = [];

  setProgress(value: number): void {
    this.progress = value;
    this.dispatchEvent(new CustomEvent("uploader:progress", { detail: value }));
  }

  async upload(...args: unknown[]): Promise<string> {
    this.uploadCalls.push(args);
    return "uploaded";
  }
}

/**
 * A headless wc-bindable source that mimics an AI agent: `loading` + `answer`
 * outputs that share ONE event (discriminated by getter), a `prompt` input, and
 * a `run` command.
 */
export class AgentSource extends EventTarget {
  static wcBindable: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "loading", event: "agent:state", getter: (e) => (e as CustomEvent).detail.loading },
      { name: "answer", event: "agent:state", getter: (e) => (e as CustomEvent).detail.answer },
    ],
    inputs: [{ name: "prompt" }],
    commands: [{ name: "run" }],
  };

  loading = false;
  answer = "";
  prompt = "";

  emitState(loading: boolean, answer: string): void {
    this.loading = loading;
    this.answer = answer;
    this.dispatchEvent(new CustomEvent("agent:state", { detail: { loading, answer } }));
  }

  run(): string {
    return `running: ${this.prompt}`;
  }
}

/**
 * A source whose property is only "present" after an explicit async sync — used
 * to exercise the § 5 rule that `N in shell` is false until a remote-proxy-like
 * source has produced a value. Built as a Proxy so the `has` trap reflects the
 * not-yet-synced state, exactly like `@wc-bindable/remote`'s consumer proxy.
 */
export function createAsyncSource(): EventTarget & { sync(value: unknown): void; value: unknown } {
  class Base extends EventTarget {
    static wcBindable: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "value", event: "async:value" }],
    };
  }
  const target = new Base();
  let synced = false;
  let current: unknown;
  const sync = (value: unknown) => {
    synced = true;
    current = value;
    target.dispatchEvent(new CustomEvent("async:value", { detail: value }));
  };

  return new Proxy(target, {
    has(t, key) {
      if (key === "value") return synced;
      return Reflect.has(t, key);
    },
    get(t, key) {
      if (key === "value") return current;
      if (key === "sync") return sync;
      const value = Reflect.get(t, key, t);
      return typeof value === "function" && (key === "addEventListener" || key === "removeEventListener")
        ? value.bind(t)
        : value;
    },
  }) as unknown as EventTarget & { sync(value: unknown): void; value: unknown };
}
