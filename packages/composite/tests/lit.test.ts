import { describe, it, expect, beforeAll } from "vitest";
import { LitElement, html } from "lit";
import { bind, getWcBindableDeclaration, isWcBindable } from "@wc-bindable/core";
import { CompositeLitElement, CompositeController } from "../src/lit.js";
import { COMPOSITE_TIERS_SYMBOL, silentLogger } from "../src/index.js";

/** Await Lit update cycles until `predicate` holds (or a few cycles elapse). */
async function flushUntil(
  el: { updateComplete: Promise<unknown> },
  predicate: () => boolean,
): Promise<void> {
  for (let i = 0; i < 8 && !predicate(); i++) {
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
  }
}

// ---- source custom elements ----

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
  if (!customElements.get("s3-uploader")) customElements.define("s3-uploader", S3UploaderElement);
  if (!customElements.get("ai-agent")) customElements.define("ai-agent", AiAgentElement);
});

const sources = [
  { id: "s3", tag: "s3-uploader" },
  { id: "ai", tag: "ai-agent" },
];

describe("CompositeLitElement — Lit class authoring", () => {
  it("produces a Lit shell that is an observable wc-bindable target", async () => {
    const Base = await CompositeLitElement({ sources, logger: silentLogger });
    class Workbench extends Base {
      render() {
        return html`<p class="answer">${this["ai.answer"]}</p>`;
      }
    }
    customElements.define("lit-workbench-a", Workbench);

    const el = document.createElement("lit-workbench-a") as Workbench & Record<string, unknown>;
    document.body.appendChild(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    // Discovery: the synthesized declaration is statically inherited.
    const decl = getWcBindableDeclaration(el)!;
    expect(decl.properties.map((p) => p.name)).toEqual(["s3.progress", "ai.answer"]);

    // External bind() sees composed updates.
    const updates: [string, unknown][] = [];
    bind(el, (name, value) => updates.push([name, value]));
    const s3 = el.shadowRoot!.querySelector("s3-uploader") as S3UploaderElement;
    s3.setProgress(33);
    expect(updates).toContainEqual(["s3.progress", 33]);

    el.remove();
  });

  it("re-renders the author's template when a composed value changes", async () => {
    let renders = 0;
    const Base = await CompositeLitElement({ sources, logger: silentLogger });
    class Workbench extends Base {
      render() {
        renders++;
        return html`<p class="answer">${this["ai.answer"] ?? ""}</p>`;
      }
    }
    customElements.define("lit-workbench-b", Workbench);

    const el = document.createElement("lit-workbench-b");
    document.body.appendChild(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    const rendersAfterFirst = renders;

    const ai = el.shadowRoot!.querySelector("ai-agent") as AiAgentElement;
    ai.setAnswer("42");
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    // A composed update bridged to requestUpdate triggers another render.
    expect(renders).toBeGreaterThan(rendersAfterFirst);
    expect((el as Record<string, unknown>)["ai.answer"]).toBe("42");
    expect(el.shadowRoot!.querySelector("p.answer")?.textContent).toBe("42");

    el.remove();
  });

  it("renders the author UI alongside the engine's sources in one shadow root", async () => {
    const Base = await CompositeLitElement({ sources, logger: silentLogger });
    class Workbench extends Base {
      render() {
        return html`<div class="ui">hello</div>`;
      }
    }
    customElements.define("lit-workbench-c", Workbench);

    const el = document.createElement("lit-workbench-c");
    document.body.appendChild(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    // Sources (created by the engine) and Lit-rendered UI coexist.
    expect(el.shadowRoot!.querySelectorAll("s3-uploader")).toHaveLength(1);
    expect(el.shadowRoot!.querySelectorAll("ai-agent")).toHaveLength(1);
    expect(el.shadowRoot!.querySelector("div.ui")?.textContent).toBe("hello");

    // Reconnect must not duplicate the sources.
    el.remove();
    document.body.appendChild(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    expect(el.shadowRoot!.querySelectorAll("s3-uploader")).toHaveLength(1);

    el.remove();
  });

  it("exposes the T2 facade and dispose()", async () => {
    const Base = await CompositeLitElement({ sources, logger: silentLogger });
    class Workbench extends Base {
      render() {
        return html``;
      }
    }
    customElements.define("lit-workbench-d", Workbench);

    const el = document.createElement("lit-workbench-d") as HTMLElement & {
      dispose(): void;
    } & Record<string, unknown>;
    document.body.appendChild(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    // T2 facade.
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
    const updates: [string, unknown][] = [];
    bind(el, (name, value) => updates.push([name, value]));
    el.dispose();
    const s3 = el.shadowRoot!.querySelector("s3-uploader") as S3UploaderElement;
    s3.setProgress(99);
    expect(updates).not.toContainEqual(["s3.progress", 99]);

    el.remove();
  });
});

describe("CompositeController — Lit reactive controller", () => {
  it("composes host-rendered sources and exposes a reactive .values + .shell", async () => {
    class HostA extends LitElement {
      composite = new CompositeController(this, { sources, logger: silentLogger });
      render() {
        return html`
          <s3-uploader ${this.composite.ref("s3")}></s3-uploader>
          <ai-agent ${this.composite.ref("ai")}></ai-agent>
          <p class="answer">${(this.composite.values as Record<string, unknown>)["ai.answer"] ?? ""}</p>
        `;
      }
    }
    customElements.define("lit-ctrl-host-a", HostA);

    const el = document.createElement("lit-ctrl-host-a") as HostA;
    document.body.appendChild(el);
    await flushUntil(el, () => el.composite.shell !== undefined);

    // The shell is a real wc-bindable target built over the rendered instances.
    expect(el.composite.shell).toBeDefined();
    expect(isWcBindable(el.composite.shell!)).toBe(true);
    expect(getWcBindableDeclaration(el.composite.shell!)!.properties.map((p) => p.name)).toEqual([
      "s3.progress",
      "ai.answer",
    ]);

    // A source update flows to .values and re-renders the host template.
    const ai = el.shadowRoot!.querySelector("ai-agent") as AiAgentElement;
    ai.setAnswer("42");
    await el.updateComplete;
    expect((el.composite.values as Record<string, unknown>)["ai.answer"]).toBe("42");
    expect(el.shadowRoot!.querySelector("p.answer")?.textContent?.trim()).toBe("42");

    el.remove();
  });

  it("delegates the T2 facade through .shell", async () => {
    class HostB extends LitElement {
      composite = new CompositeController(this, { sources, logger: silentLogger });
      render() {
        return html`
          <s3-uploader ${this.composite.ref("s3")}></s3-uploader>
          <ai-agent ${this.composite.ref("ai")}></ai-agent>
        `;
      }
    }
    customElements.define("lit-ctrl-host-b", HostB);

    const el = document.createElement("lit-ctrl-host-b") as HostB;
    document.body.appendChild(el);
    await flushUntil(el, () => el.composite.shell !== undefined);

    const shell = el.composite.shell as unknown as Record<string, unknown>;
    shell["ai.prompt"] = "hello";
    const ai = el.shadowRoot!.querySelector("ai-agent") as AiAgentElement;
    expect(ai.prompt).toBe("hello");
    expect((shell["ai.run"] as () => string)()).toBe("run:hello");

    el.remove();
  });

  it("rebuilds the shell on reconnect and tears it down on dispose", async () => {
    class HostC extends LitElement {
      composite = new CompositeController(this, { sources, logger: silentLogger });
      render() {
        return html`
          <s3-uploader ${this.composite.ref("s3")}></s3-uploader>
          <ai-agent ${this.composite.ref("ai")}></ai-agent>
        `;
      }
    }
    customElements.define("lit-ctrl-host-c", HostC);

    const el = document.createElement("lit-ctrl-host-c") as HostC;
    document.body.appendChild(el);
    await flushUntil(el, () => el.composite.shell !== undefined);
    const firstShell = el.composite.shell;
    expect(firstShell).toBeDefined();

    // Disconnect tears the shell down; reconnect rebuilds a fresh one.
    el.remove();
    expect(el.composite.shell).toBeUndefined();
    document.body.appendChild(el);
    await flushUntil(el, () => el.composite.shell !== undefined);
    expect(el.composite.shell).toBeDefined();
    expect(el.composite.shell).not.toBe(firstShell);

    // Sources still drive .values after the rebuild.
    const ai = el.shadowRoot!.querySelector("ai-agent") as AiAgentElement;
    ai.setAnswer("again");
    await el.updateComplete;
    expect((el.composite.values as Record<string, unknown>)["ai.answer"]).toBe("again");

    // Explicit dispose tears the shell down.
    el.composite.dispose();
    expect(el.composite.shell).toBeUndefined();

    el.remove();
  });

  it("dispose() is terminal — a later reconnect does not resurrect the shell", async () => {
    class HostD extends LitElement {
      composite = new CompositeController(this, { sources, logger: silentLogger });
      render() {
        return html`
          <s3-uploader ${this.composite.ref("s3")}></s3-uploader>
          <ai-agent ${this.composite.ref("ai")}></ai-agent>
        `;
      }
    }
    customElements.define("lit-ctrl-host-d", HostD);

    const el = document.createElement("lit-ctrl-host-d") as HostD;
    document.body.appendChild(el);
    await flushUntil(el, () => el.composite.shell !== undefined);
    expect(el.composite.shell).toBeDefined();

    // Terminal dispose.
    el.composite.dispose();
    expect(el.composite.shell).toBeUndefined();

    // Reconnect: ref callbacks fire again, but a disposed controller MUST NOT
    // rebuild the shell (otherwise the caller would silently regain listeners /
    // a facade it believed released).
    el.remove();
    document.body.appendChild(el);
    await flushUntil(el, () => false); // give it ample cycles to (wrongly) rebuild
    expect(el.composite.shell).toBeUndefined();

    // A source update after dispose must not repopulate .values either.
    const ai = el.shadowRoot!.querySelector("ai-agent") as AiAgentElement;
    ai.setAnswer("ghost");
    await el.updateComplete;
    expect((el.composite.values as Record<string, unknown>)["ai.answer"]).not.toBe("ghost");

    el.remove();
  });
});
