import { describe, it, expect, beforeAll } from "vitest";
import { bind, getWcBindableDeclaration } from "@wc-bindable/core";
import { defineCompositeClass, COMPOSITE_TIERS_SYMBOL, silentLogger } from "../src/index.js";
import { synthesizeComposite, setupCompositeInstance } from "../src/declarative.js";

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
  setProgress(v: number): void {
    this.progress = v;
    this.dispatchEvent(new CustomEvent("uploader:progress", { detail: v }));
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
  // Reuse the source tags defined by declarative.test.ts when both files share a
  // worker; guard so a duplicate define() does not throw.
  if (!customElements.get("s3-uploader")) customElements.define("s3-uploader", S3UploaderElement);
  if (!customElements.get("ai-agent")) customElements.define("ai-agent", AiAgentElement);
});

const sources = [
  { id: "s3", tag: "s3-uploader" },
  { id: "ai", tag: "ai-agent" },
];

describe("defineCompositeClass — class authoring", () => {
  it("returns an unregistered base class the caller subclasses and defines", async () => {
    const Base = await defineCompositeClass({ sources, logger: silentLogger });

    // The base is not registered with any tag — the caller owns define().
    let resetCalls = 0;
    class MyWorkbench extends Base {
      reset(): void {
        resetCalls++;
        (this as unknown as Record<string, unknown>)["ai.prompt"] = "";
      }
    }
    customElements.define("authored-workbench-a", MyWorkbench);

    // Synthesized declaration is statically inherited by the subclass, so
    // discovery via constructor.wcBindable works on instances.
    const el = document.createElement("authored-workbench-a") as MyWorkbench & Record<string, unknown>;
    document.body.appendChild(el);

    const decl = getWcBindableDeclaration(el)!;
    expect(decl.properties.map((p) => p.name)).toEqual(["s3.progress", "ai.answer"]);

    // The subclass's own behavior is callable alongside the composed surface.
    el.reset();
    expect(resetCalls).toBe(1);
    const ai = el.shadowRoot!.querySelector("ai-agent") as AiAgentElement;
    expect(ai.prompt).toBe("");

    el.remove();
  });

  it("produces observable wc-bindable shells with the T2 facade and dispose()", async () => {
    const Base = await defineCompositeClass({ sources, logger: silentLogger });
    class MyWorkbench extends Base {}
    customElements.define("authored-workbench-b", MyWorkbench);

    const el = document.createElement("authored-workbench-b") as HTMLElement & {
      dispose(): void;
    } & Record<string, unknown>;
    document.body.appendChild(el);

    // T1 observation.
    const updates: [string, unknown][] = [];
    bind(el, (name, value) => updates.push([name, value]));
    const s3 = el.shadowRoot!.querySelector("s3-uploader") as S3UploaderElement;
    s3.setProgress(42);
    expect(updates).toContainEqual(["s3.progress", 42]);

    // T2 facade: input assignment + command call delegate to the source.
    el["ai.prompt"] = "hello";
    const ai = el.shadowRoot!.querySelector("ai-agent") as AiAgentElement;
    expect(ai.prompt).toBe("hello");
    expect((el["ai.run"] as () => string)()).toBe("run:hello");

    // Tier claim reflects the facade.
    const claim = (el as Record<symbol, { localFacade: boolean; extension1: boolean }>)[
      COMPOSITE_TIERS_SYMBOL
    ];
    expect(claim.localFacade).toBe(true);
    expect(claim.extension1).toBe(false);

    // dispose() detaches the shell's source listeners.
    el.dispose();
    s3.setProgress(99);
    expect(updates).not.toContainEqual(["s3.progress", 99]);

    el.remove();
  });

  it("preserves subclass-rendered shadow content (base only manages its sources)", async () => {
    const Base = await defineCompositeClass({ sources, logger: silentLogger });
    class WithExtraShadow extends Base {
      connectedCallback(): void {
        super.connectedCallback();
        const shadow = this.shadowRoot!;
        if (!shadow.querySelector(".badge")) {
          const badge = document.createElement("div");
          badge.className = "badge";
          shadow.appendChild(badge);
        }
      }
    }
    customElements.define("authored-workbench-c", WithExtraShadow);

    const el = document.createElement("authored-workbench-c");
    document.body.appendChild(el);

    // Both the base's sources and the subclass's own content coexist.
    expect(el.shadowRoot!.querySelector("s3-uploader")).not.toBeNull();
    expect(el.shadowRoot!.querySelector(".badge")).not.toBeNull();

    // Reconnect must not duplicate sources (or the subclass badge).
    el.remove();
    document.body.appendChild(el);
    expect(el.shadowRoot!.querySelectorAll("s3-uploader")).toHaveLength(1);
    expect(el.shadowRoot!.querySelectorAll(".badge")).toHaveLength(1);

    el.remove();
  });

  it("honors an explicit expose map and localFacade: false (T1-only)", async () => {
    const Base = await defineCompositeClass({
      sources,
      expose: { properties: { "s3.progress": { source: "s3", name: "progress" } } },
      localFacade: false,
      logger: silentLogger,
    });
    class T1Only extends Base {}
    customElements.define("authored-workbench-d", T1Only);

    expect(T1Only.wcBindable.properties.map((p) => p.name)).toEqual(["s3.progress"]);
    expect(T1Only.wcBindable.inputs ?? []).toEqual([]);

    const el = document.createElement("authored-workbench-d");
    document.body.appendChild(el);
    const claim = (el as Record<symbol, { localFacade: boolean }>)[COMPOSITE_TIERS_SYMBOL];
    expect(claim.localFacade).toBe(false);
    el.remove();
  });
});

describe("defineCompositeClass — self-reference safety", () => {
  it("cannot be registered under one of its own (already-defined) source tags", async () => {
    // The only way an instance could recursively create itself in its own shadow
    // root is if the composite tag equals a source tag. That registration is
    // impossible through the public API: a defined source tag is already taken,
    // so customElements.define throws "already defined". (An *undefined* self tag
    // instead hangs synthesizeComposite's whenDefined() before a class is ever
    // produced.) Either way the connect-time recursion path is never reached.
    const Base = await defineCompositeClass({
      sources: [{ id: "s3", tag: "s3-uploader" }],
      logger: silentLogger,
    });
    class SelfRef extends Base {}
    expect(() => customElements.define("s3-uploader", SelfRef)).toThrow();
  });

  it("setupCompositeInstance backstops a host whose tag matches a source tag", async () => {
    // Reach the defensive guard directly (it is unreachable via the public API,
    // per the test above): a host element whose localName equals a source tag
    // must be rejected rather than recursively building itself.
    const synth = await synthesizeComposite({
      sources: [{ id: "s3", tag: "s3-uploader" }],
      logger: silentLogger,
    });
    const host = document.createElement("s3-uploader"); // localName === a source tag
    const shadow = host.attachShadow({ mode: "open" });
    expect(() => setupCompositeInstance(host, shadow, synth)).toThrow(
      /cannot list its own tag|cyclic|construction order/,
    );
    // The guard runs before any source element is created.
    expect(shadow.querySelectorAll("[data-wc-source]")).toHaveLength(0);
  });
});
