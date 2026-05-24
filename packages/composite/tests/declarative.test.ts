import { describe, it, expect, beforeAll } from "vitest";
import { bind, getWcBindableDeclaration } from "@wc-bindable/core";
import {
  defineComposite,
  registerCompositeDefinitions,
  COMPOSITE_TIERS_SYMBOL,
  silentLogger,
} from "../src/index.js";

// ---- source custom elements (defined once for this test file) ----

class S3UploaderElement extends HTMLElement {
  static wcBindable = {
    protocol: "wc-bindable" as const,
    version: 1,
    properties: [{ name: "progress", event: "uploader:progress" }],
    inputs: [{ name: "file" }],
    commands: [{ name: "upload", async: true }],
  };
  progress = 0;
  file: unknown = null;
  uploads: unknown[][] = [];
  setProgress(v: number): void {
    this.progress = v;
    this.dispatchEvent(new CustomEvent("uploader:progress", { detail: v }));
  }
  async upload(...args: unknown[]): Promise<string> {
    this.uploads.push(args);
    return "ok";
  }
}

class AiAgentElement extends HTMLElement {
  static wcBindable = {
    protocol: "wc-bindable" as const,
    version: 1,
    properties: [{ name: "answer", event: "agent:answer" }],
    inputs: [{ name: "prompt" }],
    commands: [{ name: "run" }],
  };
  answer = "";
  prompt = "";
  setAnswer(v: string): void {
    this.answer = v;
    this.dispatchEvent(new CustomEvent("agent:answer", { detail: v }));
  }
  run(): string {
    return `run:${this.prompt}`;
  }
}

beforeAll(() => {
  customElements.define("s3-uploader", S3UploaderElement);
  customElements.define("ai-agent", AiAgentElement);
});

describe("defineComposite — programmatic", () => {
  it("awaits source definitions, then registers a composed element (vector 15)", async () => {
    const Ctor = await defineComposite({
      tagName: "composite-workbench-a",
      sources: [
        { id: "s3", tag: "s3-uploader" },
        { id: "ai", tag: "ai-agent" },
      ],
      logger: silentLogger,
    });
    // Static declaration is fully determined before any instance is observable.
    expect(Ctor.wcBindable.properties.map((p) => p.name)).toEqual(["s3.progress", "ai.answer"]);
    expect(customElements.get("composite-workbench-a")).toBe(Ctor);
  });

  it("produces instances that are observable wc-bindable shells", async () => {
    await defineComposite({
      tagName: "composite-workbench-b",
      sources: [
        { id: "s3", tag: "s3-uploader" },
        { id: "ai", tag: "ai-agent" },
      ],
      logger: silentLogger,
    });
    const el = document.createElement("composite-workbench-b");
    document.body.appendChild(el);

    const decl = getWcBindableDeclaration(el)!;
    expect(decl.properties.map((p) => p.name)).toEqual(["s3.progress", "ai.answer"]);

    const updates: [string, unknown][] = [];
    bind(el, (name, value) => updates.push([name, value]));

    // Reach into the instance's shadow source and drive an update.
    const s3 = el.shadowRoot!.querySelector("s3-uploader") as S3UploaderElement;
    s3.setProgress(33);
    expect(updates).toContainEqual(["s3.progress", 33]);

    el.remove();
  });

  it("materializes the T2 facade on the element instance", async () => {
    await defineComposite({
      tagName: "composite-workbench-c",
      sources: [
        { id: "s3", tag: "s3-uploader" },
        { id: "ai", tag: "ai-agent" },
      ],
      logger: silentLogger,
    });
    const el = document.createElement("composite-workbench-c") as HTMLElement & Record<string, unknown>;
    document.body.appendChild(el);

    // Input assignment delegates to the shadow source.
    el["ai.prompt"] = "hello";
    const ai = el.shadowRoot!.querySelector("ai-agent") as AiAgentElement;
    expect(ai.prompt).toBe("hello");

    // Command invocation delegates and returns the source result.
    const result = (el["ai.run"] as () => string)();
    expect(result).toBe("run:hello");

    // Tier claim is present and reflects the facade.
    expect((el as Record<symbol, { localFacade: boolean }>)[COMPOSITE_TIERS_SYMBOL].localFacade).toBe(true);

    el.remove();
  });
});

describe("registerCompositeDefinitions — declarative shadow DOM", () => {
  it("registers from a <template shadowroot> definition and exposes the explicit surface", async () => {
    // Build a definition element with a declarative-shadow-DOM-style template
    // wrapping the composed source elements (the unparsed-<template> fallback,
    // which works in environments without native DSD parsing). Scanning is
    // scoped to a dedicated container so the test is isolated from siblings.
    const container = document.createElement("div");
    container.innerHTML = `
      <composite-dsd-d data-wc-composite-definition>
        <template shadowroot="open">
          <s3-uploader data-wc-source="s3"
            data-wc-expose="properties: progress; inputs: file; commands: upload"></s3-uploader>
          <ai-agent data-wc-source="ai"
            data-wc-expose="properties: answer; inputs: prompt; commands: run"></ai-agent>
        </template>
      </composite-dsd-d>`;
    document.body.appendChild(container);

    const [Ctor] = await registerCompositeDefinitions(container, { logger: silentLogger });
    expect(Ctor.wcBindable.properties.map((p) => p.name)).toEqual(["s3.progress", "ai.answer"]);
    expect(Ctor.wcBindable.inputs?.map((i) => i.name)).toEqual(["s3.file", "ai.prompt"]);
    expect(Ctor.wcBindable.commands?.map((c) => c.name)).toEqual(["s3.upload", "ai.run"]);

    // A plain instance of the registered tag composes its sources.
    const el = document.createElement("composite-dsd-d");
    document.body.appendChild(el);
    const updates: [string, unknown][] = [];
    bind(el, (name, value) => updates.push([name, value]));
    const ai = el.shadowRoot!.querySelector("ai-agent") as AiAgentElement;
    ai.setAnswer("42");
    expect(updates).toContainEqual(["ai.answer", "42"]);

    el.remove();
    container.remove();
  });

  it("supports shadowrootmode and auto-expose (no data-wc-expose)", async () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <composite-dsd-e data-wc-composite-definition>
        <template shadowrootmode="open">
          <s3-uploader data-wc-source="s3"></s3-uploader>
        </template>
      </composite-dsd-e>`;
    document.body.appendChild(container);

    const [Ctor] = await registerCompositeDefinitions(container, { logger: silentLogger });
    // Auto-exposed: every source member under its default name.
    expect(Ctor.wcBindable.properties.map((p) => p.name)).toEqual(["s3.progress"]);
    expect(Ctor.wcBindable.inputs?.map((i) => i.name)).toEqual(["s3.file"]);
    expect(Ctor.wcBindable.commands?.map((c) => c.name)).toEqual(["s3.upload"]);
    container.remove();
  });

  it("includes the root element itself when it is a definition (Open Q2)", async () => {
    const def = document.createElement("composite-dsd-root");
    def.setAttribute("data-wc-composite-definition", "");
    def.innerHTML = `
      <template shadowrootmode="open">
        <s3-uploader data-wc-source="s3"></s3-uploader>
      </template>`;
    document.body.appendChild(def);

    // Pass the definition element itself as the scan root.
    const ctors = await registerCompositeDefinitions(def, { logger: silentLogger });
    expect(ctors).toHaveLength(1);
    expect(ctors[0].wcBindable.properties.map((p) => p.name)).toEqual(["s3.progress"]);
    def.remove();
  });
});

describe("defineComposite — concurrency, idempotency & validation", () => {
  it("dedupes concurrent same-tick calls for one tag without a define() race (Finding 1)", async () => {
    const opts = {
      tagName: "composite-concurrent",
      sources: [{ id: "s3", tag: "s3-uploader" }],
      logger: silentLogger,
    };
    // Both calls run in the same tick, before either has reached define().
    const [a, b] = await Promise.all([defineComposite(opts), defineComposite(opts)]);
    expect(a).toBe(b); // shared single registration
    expect(customElements.get("composite-concurrent")).toBe(a);
  });

  it("returns the same constructor on a later re-call (idempotent, Open Q1)", async () => {
    const opts = {
      tagName: "composite-idempotent",
      sources: [{ id: "s3", tag: "s3-uploader" }],
      logger: silentLogger,
    };
    const first = await defineComposite(opts);
    const second = await defineComposite(opts);
    expect(second).toBe(first);
  });

  it("throws when the tag is occupied by a non-composite element", async () => {
    class Foreign extends HTMLElement {}
    customElements.define("composite-foreign-collision", Foreign);
    await expect(
      defineComposite({
        tagName: "composite-foreign-collision",
        sources: [{ id: "s3", tag: "s3-uploader" }],
        logger: silentLogger,
      }),
    ).rejects.toThrow(/already defined by another/);
  });

  it("rejects an empty data-wc-source rather than silently dropping it (Finding 2)", async () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <composite-dsd-emptyid data-wc-composite-definition>
        <template shadowrootmode="open">
          <s3-uploader data-wc-source=""></s3-uploader>
        </template>
      </composite-dsd-emptyid>`;
    document.body.appendChild(container);
    await expect(registerCompositeDefinitions(container, { logger: silentLogger })).rejects.toThrow(
      /empty data-wc-source/,
    );
    container.remove();
  });

  it("can retry setup on reconnect after a failed install() (Finding 3)", async () => {
    // A source whose addEventListener throws on the first install attempt, then
    // succeeds — exercising the connectedCallback rollback + retry path.
    let failNextInstall = true;
    class FlakySource extends HTMLElement {
      static wcBindable = {
        protocol: "wc-bindable" as const,
        version: 1,
        properties: [{ name: "v", event: "flaky:v" }],
      };
      v = 7;
      addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ): void {
        if (type === "flaky:v" && failNextInstall) {
          failNextInstall = false;
          throw new Error("install boom");
        }
        super.addEventListener(type, listener, options);
      }
    }
    customElements.define("flaky-source", FlakySource);

    const Ctor = await defineComposite({
      tagName: "composite-flaky",
      sources: [{ id: "f", tag: "flaky-source" }],
      logger: silentLogger,
    });
    const el = document.createElement("composite-flaky");

    // First connect: install() throws and connectedCallback rolls the shadow
    // back. Whether the host propagates a connectedCallback throw is
    // environment-dependent, so tolerate either and assert the rolled-back state.
    try {
      document.body.appendChild(el);
    } catch (err) {
      expect((err as Error).message).toMatch(/install boom/);
    }
    expect(el.shadowRoot?.childElementCount ?? 0).toBe(0); // rolled back, no strays

    // Reconnect: setup retries cleanly and now succeeds (no duplicate sources).
    el.remove();
    document.body.appendChild(el);
    expect(el.shadowRoot!.querySelectorAll("flaky-source")).toHaveLength(1);
    const updates: [string, unknown][] = [];
    bind(el, (name, value) => updates.push([name, value]));
    expect(updates).toContainEqual(["f.v", 7]);
    el.remove();
  });
});
