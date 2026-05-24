import { describe, it, expect, vi } from "vitest";
import { bind, getWcBindableDeclaration, isWcBindable } from "@wc-bindable/core";
import {
  createCompositeTarget,
  COMPOSITE_TIERS_SYMBOL,
  silentLogger,
} from "../src/index.js";
import { AgentSource, UploaderSource, createAsyncSource } from "./_helpers.js";

describe("createCompositeTarget — discovery & declaration (T1)", () => {
  it("synthesizes a valid wc-bindable declaration with prefixed names", () => {
    const shell = createCompositeTarget({
      sources: { s3: new UploaderSource(), ai: new AgentSource() },
    });
    expect(isWcBindable(shell)).toBe(true);
    const decl = getWcBindableDeclaration(shell)!;
    expect(decl.protocol).toBe("wc-bindable");
    expect(decl.version).toBe(1);
    expect(decl.properties.map((p) => p.name)).toEqual([
      "s3.progress",
      "ai.loading",
      "ai.answer",
    ]);
    // Each property maps to a distinct shell-owned event name (§ 6).
    expect(decl.properties.map((p) => p.event)).toEqual([
      "@wc-bindable/composite:s3.progress",
      "@wc-bindable/composite:ai.loading",
      "@wc-bindable/composite:ai.answer",
    ]);
    expect(decl.inputs?.map((i) => i.name)).toEqual(["s3.file", "ai.prompt"]);
    expect(decl.commands?.map((c) => c.name)).toEqual(["s3.upload", "ai.run"]);
  });

  it("preserves the source command async hint, never inferring it (§ 9)", () => {
    const shell = createCompositeTarget({
      sources: { s3: new UploaderSource(), ai: new AgentSource() },
    });
    const decl = getWcBindableDeclaration(shell)!;
    const upload = decl.commands!.find((c) => c.name === "s3.upload")!;
    const run = decl.commands!.find((c) => c.name === "ai.run")!;
    expect(upload.async).toBe(true); // UploaderSource declares async: true
    expect("async" in run).toBe(false); // AgentSource.run declares no async hint
  });

  it("freezes the synthesized declaration for immutability (§ 11)", () => {
    const shell = createCompositeTarget({ sources: { s3: new UploaderSource() } });
    const decl = getWcBindableDeclaration(shell)!;
    expect(Object.isFrozen(decl)).toBe(true);
    expect(Object.isFrozen(decl.properties)).toBe(true);
    expect(Object.isFrozen(decl.properties[0])).toBe(true);
  });

  it("exposes a frozen, own, correct tier claim (T1 + T2)", () => {
    const shell = createCompositeTarget({ sources: { s3: new UploaderSource() } });
    const claim = shell[COMPOSITE_TIERS_SYMBOL];
    expect(claim).toMatchObject({
      protocol: "wc-bindable.composite",
      version: 1,
      localFacade: true, // inputs/commands present -> T2 by default
      extension1: false,
    });
    expect(Object.isFrozen(claim)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(shell, COMPOSITE_TIERS_SYMBOL)).toBe(true);
  });

  it("reports localFacade:false for a properties-only T1 shell", () => {
    const src = new UploaderSource();
    const shell = createCompositeTarget({
      sources: { s3: src },
      expose: { properties: { "s3.progress": { source: "s3", name: "progress" } } },
    });
    expect(shell[COMPOSITE_TIERS_SYMBOL].localFacade).toBe(false);
  });
});

describe("createCompositeTarget — initial sync & observation (T1)", () => {
  it("delivers current source values on bind() initial sync (§ 5)", () => {
    const s3 = new UploaderSource();
    s3.progress = 42;
    const shell = createCompositeTarget({ sources: { s3 } });
    const updates: [string, unknown][] = [];
    bind(shell, (name, value) => updates.push([name, value]));
    expect(updates).toContainEqual(["s3.progress", 42]);
  });

  it("re-emits source events as shell events through bind() (§ 6)", () => {
    const s3 = new UploaderSource();
    const shell = createCompositeTarget({ sources: { s3 } });
    const updates: [string, unknown][] = [];
    bind(shell, (name, value) => updates.push([name, value]));
    s3.setProgress(75);
    expect(updates).toContainEqual(["s3.progress", 75]);
  });

  it("fans out a shared source event to every mapped property in order (§ 6)", () => {
    const ai = new AgentSource();
    const shell = createCompositeTarget({ sources: { ai } });
    const updates: [string, unknown][] = [];
    bind(shell, (name, value) => updates.push([name, value]));
    updates.length = 0; // drop initial sync
    ai.emitState(true, "hi");
    expect(updates).toEqual([
      ["ai.loading", true],
      ["ai.answer", "hi"],
    ]);
  });

  it("commits all siblings before dispatching (sibling-read snapshot, § 6)", () => {
    const ai = new AgentSource();
    const shell = createCompositeTarget({ sources: { ai } });
    let answerSeenWhenLoadingFired: unknown;
    // Listen on the shell as a plain EventTarget for the loading event, and read
    // the sibling answer property — it must already reflect the new value.
    shell.addEventListener("@wc-bindable/composite:ai.loading", () => {
      answerSeenWhenLoadingFired = shell["ai.answer"];
    });
    ai.emitState(true, "committed-first");
    expect(answerSeenWhenLoadingFired).toBe("committed-first");
  });

  it("reports N in shell from source presence — false until an async source syncs (§ 5)", () => {
    const async = createAsyncSource();
    const shell = createCompositeTarget({ sources: { rs: async } });
    expect("rs.value" in shell).toBe(false);

    const updates: [string, unknown][] = [];
    bind(shell, (name, value) => updates.push([name, value]));
    expect(updates).toHaveLength(0); // no premature initial value

    async.sync("hello");
    expect("rs.value" in shell).toBe(true);
    expect(shell["rs.value"]).toBe("hello");
    expect(updates).toContainEqual(["rs.value", "hello"]);
  });
});

describe("createCompositeTarget — getter semantics (T1)", () => {
  it("preserves a top-level undefined value end-to-end (§ 7 / vector 12)", () => {
    class UndefSource extends EventTarget {
      static wcBindable = {
        protocol: "wc-bindable" as const,
        version: 1,
        properties: [{ name: "v", event: "u:v", getter: () => undefined }],
      };
      v: unknown = undefined;
    }
    const src = new UndefSource();
    const shell = createCompositeTarget({ sources: { u: src } });
    const seen: { value: unknown; called: boolean } = { value: "sentinel", called: false };
    bind(shell, (_name, value) => {
      seen.value = value;
      seen.called = true;
    });
    src.dispatchEvent(new CustomEvent("u:v", { detail: "ignored-because-getter-returns-undefined" }));
    expect(seen.called).toBe(true);
    expect(seen.value).toBeUndefined();
  });

  it("isolates a getter throw: sibling still dispatches, error reported (§ 12 / vector 20)", () => {
    const reportError = vi.fn();
    (globalThis as { reportError?: unknown }).reportError = reportError;
    try {
      class TwoProp extends EventTarget {
        static wcBindable = {
          protocol: "wc-bindable" as const,
          version: 1,
          properties: [
            {
              name: "bad",
              event: "x:state",
              getter: () => {
                throw new Error("boom");
              },
            },
            { name: "good", event: "x:state", getter: (e: Event) => (e as CustomEvent).detail },
          ],
        };
      }
      const src = new TwoProp();
      const shell = createCompositeTarget({ sources: { x: src }, logger: silentLogger });
      const updates: [string, unknown][] = [];
      bind(shell, (name, value) => updates.push([name, value]));
      updates.length = 0;
      src.dispatchEvent(new CustomEvent("x:state", { detail: "ok" }));
      expect(updates).toEqual([["x.good", "ok"]]); // sibling delivered, bad omitted
      expect(reportError).toHaveBeenCalledOnce();
    } finally {
      delete (globalThis as { reportError?: unknown }).reportError;
    }
  });
});

describe("createCompositeTarget — local facade (T2)", () => {
  it("delegates input assignment to the source (§ 8)", () => {
    const s3 = new UploaderSource();
    const shell = createCompositeTarget({ sources: { s3 } });
    shell["s3.file"] = "report.pdf";
    expect(s3.file).toBe("report.pdf");
  });

  it("delegates command invocation to the source method and preserves the return (§ 9)", async () => {
    const s3 = new UploaderSource();
    const shell = createCompositeTarget({ sources: { s3 } });
    const result = await (shell["s3.upload"] as (...a: unknown[]) => Promise<string>)("a", "b");
    expect(result).toBe("uploaded");
    expect(s3.uploadCalls).toEqual([["a", "b"]]);
  });

  it("returns a stable command reference", () => {
    const shell = createCompositeTarget({ sources: { s3: new UploaderSource() } });
    expect(shell["s3.upload"]).toBe(shell["s3.upload"]);
  });

  it("propagates a throwing source setter synchronously (vector 16)", () => {
    class ThrowSetter extends EventTarget {
      static wcBindable = {
        protocol: "wc-bindable" as const,
        version: 1,
        properties: [],
        inputs: [{ name: "x" }],
      };
      set x(_v: unknown) {
        throw new Error("setter failed");
      }
    }
    const shell = createCompositeTarget({ sources: { t: new ThrowSetter() } });
    expect(() => {
      shell["t.x"] = 1;
    }).toThrow("setter failed");
  });

  it("preserves command completion shape: sync throw vs rejected promise (vector 16)", async () => {
    class Cmds extends EventTarget {
      static wcBindable = {
        protocol: "wc-bindable" as const,
        version: 1,
        properties: [],
        commands: [{ name: "syncThrow" }, { name: "asyncReject", async: true }],
      };
      syncThrow(): never {
        throw new Error("sync");
      }
      asyncReject(): Promise<never> {
        return Promise.reject(new Error("async"));
      }
    }
    const shell = createCompositeTarget({ sources: { c: new Cmds() } });
    expect(() => (shell["c.syncThrow"] as () => unknown)()).toThrow("sync");
    await expect((shell["c.asyncReject"] as () => Promise<unknown>)()).rejects.toThrow("async");
  });

  it("makes composed output properties read-only", () => {
    const shell = createCompositeTarget({ sources: { s3: new UploaderSource() } });
    expect(() => {
      shell["s3.progress"] = 5;
    }).toThrow(TypeError);
  });
});

describe("createCompositeTarget — collisions & validation (§ 3 / § 4)", () => {
  it("auto-prefixes names so two sources never collide (§ 3 / vector 8)", () => {
    // The default <sourceId>.<sourceName> naming keeps composed names unique
    // even when two sources share a member name; this is how the per-list
    // uniqueness invariant (vector 8) is upheld in practice.
    const shell = createCompositeTarget({
      sources: { a: new UploaderSource(), b: new UploaderSource() },
    });
    const names = getWcBindableDeclaration(shell)!.properties.map((p) => p.name);
    expect(names).toEqual(["a.progress", "b.progress"]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("rejects a reserved composed name (vector 9)", () => {
    const s3 = new UploaderSource();
    expect(() =>
      createCompositeTarget({
        sources: { s3 },
        expose: { properties: { dispatchEvent: { source: "s3", name: "progress" } } },
      }),
    ).toThrow(/reserved/);
  });

  it("rejects a cross-surface collision when the facade is claimed (vector 13)", () => {
    const s3 = new UploaderSource();
    expect(() =>
      createCompositeTarget({
        sources: { s3 },
        localFacade: true,
        expose: {
          properties: { "s3.x": { source: "s3", name: "progress" } },
          inputs: { "s3.x": { source: "s3", name: "file" } },
        },
      }),
    ).toThrow(/collides across/);
  });

  it("rejects an invalid source id (§ 3)", () => {
    expect(() => createCompositeTarget({ sources: { "a.b": new UploaderSource() } })).toThrow(
      /invalid source id/,
    );
  });

  it("rejects a non-wc-bindable source", () => {
    expect(() => createCompositeTarget({ sources: { x: new EventTarget() } })).toThrow(
      /not a valid wc-bindable target/,
    );
  });

  it("rejects an expose ref to a missing source member", () => {
    const s3 = new UploaderSource();
    expect(() =>
      createCompositeTarget({
        sources: { s3 },
        expose: { properties: { "s3.nope": { source: "s3", name: "nonexistent" } } },
      }),
    ).toThrow(/does not exist/);
  });
});

describe("createCompositeTarget — lifecycle (§ 10)", () => {
  it("removes source listeners on dispose and is idempotent (vector 10)", () => {
    const s3 = new UploaderSource();
    const shell = createCompositeTarget({ sources: { s3 } });
    const updates: unknown[] = [];
    bind(shell, (_n, v) => updates.push(v));
    updates.length = 0;

    shell.dispose();
    shell.dispose(); // idempotent

    s3.setProgress(99); // must not reach the shell anymore
    expect(updates).toHaveLength(0);
  });

  it("makes input / command delegation fail after dispose", () => {
    const s3 = new UploaderSource();
    const shell = createCompositeTarget({ sources: { s3 } });
    shell.dispose();
    expect(() => {
      shell["s3.file"] = "x";
    }).toThrow(/dispose/);
    expect(() => (shell["s3.upload"] as () => unknown)()).toThrow(/dispose/);
  });

  it("does not dispose its source targets (borrow semantics)", () => {
    const s3 = new UploaderSource();
    const shell = createCompositeTarget({ sources: { s3 } });
    shell.dispose();
    // The source still works on its own.
    expect(() => s3.setProgress(1)).not.toThrow();
  });
});

describe("createCompositeTarget — Proxy trap edge cases", () => {
  it("reports `in` true for facade input / command members when localFacade is on (has trap 120-122)", () => {
    const s3 = new UploaderSource();
    const shell = createCompositeTarget({ sources: { s3 } });
    // Inputs and commands are facade members — present so tooling sees the surface.
    expect("s3.file" in shell).toBe(true);
    expect("s3.upload" in shell).toBe(true);
  });

  it("allows ordinary (non-property/input) property assignment to fall through (set fallback 152)", () => {
    const s3 = new UploaderSource();
    const shell = createCompositeTarget({ sources: { s3 } });
    // A key that is neither a composed property nor a composed input is a normal
    // assignment onto the underlying target.
    shell["someArbitraryKey"] = 42;
    expect(shell["someArbitraryKey"]).toBe(42);
  });

  it("forwards reads of non-composed keys to the real target (get fallback)", () => {
    const s3 = new UploaderSource();
    const shell = createCompositeTarget({ sources: { s3 } });
    expect(typeof shell.addEventListener).toBe("function");
    expect(typeof shell.dispose).toBe("function");
  });

  it("does not materialize the facade when localFacade is forced false (T1)", () => {
    const s3 = new UploaderSource();
    const shell = createCompositeTarget({ sources: { s3 }, localFacade: false });
    // The tier claim reflects T1.
    expect(shell[COMPOSITE_TIERS_SYMBOL].localFacade).toBe(false);
    // A command is NOT materialized as a callable facade member.
    expect(typeof shell["s3.upload"]).not.toBe("function");
    // An input assignment does not delegate to the source (it falls through as a
    // plain set onto the target instead of throwing or reaching setInput).
    shell["s3.file"] = "ignored-as-facade";
    expect(s3.file).toBe(null); // source untouched; T1 inputs are metadata-only
    // The declaration still advertises the inputs/commands as metadata.
    const decl = getWcBindableDeclaration(shell)!;
    expect(decl.inputs?.map((i) => i.name)).toContain("s3.file");
    expect(decl.commands?.map((c) => c.name)).toContain("s3.upload");
  });
});
