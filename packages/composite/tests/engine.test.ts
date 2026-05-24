import { describe, it, expect } from "vitest";
import type { WcBindableDeclaration } from "@wc-bindable/core";
import {
  planComposition,
  declarationsFromSources,
  CompositeEngine,
  silentLogger,
} from "../src/index.js";

/**
 * Build a sourceDecls Map directly, bypassing `declarationsFromSources` (and
 * thus core's per-list name-uniqueness validation). `planComposition` is a
 * public low-level API that accepts pre-built declarations, so this is a
 * legitimate way to exercise its own validation independent of core's.
 */
function declMap(entries: Record<string, WcBindableDeclaration>): Map<string, WcBindableDeclaration> {
  return new Map(Object.entries(entries));
}

// ---- minimal headless sources, with tag-unique class names ----

/** A source with two output properties sharing one event (for grouping tests). */
class EngTwoOut extends EventTarget {
  static wcBindable: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "a", event: "eng:state", getter: (e) => (e as CustomEvent).detail.a },
      { name: "b", event: "eng:state", getter: (e) => (e as CustomEvent).detail.b },
    ],
    inputs: [{ name: "in1" }],
    commands: [{ name: "cmd1" }],
  };
  a = 0;
  b = 0;
  in1 = "";
}

describe("declarationsFromSources", () => {
  it("returns a Map of valid wc-bindable declarations keyed by source id", () => {
    const s1 = new EngTwoOut();
    const map = declarationsFromSources({ one: s1 });
    expect(map).toBeInstanceOf(Map);
    expect(map.get("one")?.properties.map((p) => p.name)).toEqual(["a", "b"]);
  });

  it("throws on a non-wc-bindable source", () => {
    expect(() => declarationsFromSources({ bad: new EventTarget() })).toThrow(
      /not a valid wc-bindable target/,
    );
  });
});

describe("planComposition — validation & expose modes", () => {
  it("detects a per-list duplicate composed property name (assertUnique)", () => {
    // A declaration that lists the SAME member name twice produces two `id.x`
    // raws under all-prefixed, tripping the per-list uniqueness check. Core's
    // own validator would reject such a declaration, so build the Map directly
    // to reach planComposition's independent guard.
    const decls = declMap({
      s: {
        protocol: "wc-bindable",
        version: 1,
        properties: [
          { name: "x", event: "dup:x" },
          { name: "x", event: "dup:y" },
        ],
      },
    });
    expect(() => planComposition(decls, "all-prefixed", { localFacade: false })).toThrow(
      /duplicate composed properties name/,
    );
  });

  it("detects a per-list duplicate composed input name", () => {
    const decls = declMap({
      s: {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        inputs: [{ name: "y" }, { name: "y" }],
      },
    });
    expect(() => planComposition(decls, "all-prefixed", { localFacade: false })).toThrow(
      /duplicate composed inputs name/,
    );
  });

  it("supports an explicit (non-all-prefixed) expose map", () => {
    const decls = declarationsFromSources({ s: new EngTwoOut() });
    const plan = planComposition(
      decls,
      {
        properties: { onlyA: { source: "s", name: "a" } },
        inputs: { theInput: { source: "s", name: "in1" } },
        commands: { theCmd: { source: "s", name: "cmd1" } },
      },
      { localFacade: true },
    );
    expect(plan.properties.map((p) => p.composedName)).toEqual(["onlyA"]);
    expect(plan.inputs.map((i) => i.composedName)).toEqual(["theInput"]);
    expect(plan.commands.map((c) => c.composedName)).toEqual(["theCmd"]);
    // The declaration is built from the explicit names, not the source names.
    expect(plan.declaration.properties.map((p) => p.name)).toEqual(["onlyA"]);
  });
});

describe("CompositeEngine — getValue / has hostile-accessor handling", () => {
  it("has() returns false when the source `in` accessor throws (489)", () => {
    // A Proxy source whose `has` trap throws on the mapped property name.
    class HostileBase extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [{ name: "p", event: "host:p" }],
      };
    }
    const base = new HostileBase();
    const hostile = new Proxy(base, {
      has(t, key) {
        if (key === "p") throw new Error("hostile in");
        return Reflect.has(t, key);
      },
      get(t, key) {
        const v = Reflect.get(t, key, t);
        return typeof v === "function" &&
          (key === "addEventListener" || key === "removeEventListener" || key === "dispatchEvent")
          ? v.bind(t)
          : v;
      },
    });
    const decls = declarationsFromSources({ h: hostile });
    const plan = planComposition(decls, "all-prefixed", { localFacade: false });
    const engine = new CompositeEngine(plan, new Map([["h", hostile]]), new EventTarget(), silentLogger);
    engine.install();
    // Not yet committed; presence must fall through to the throwing `in` and be
    // caught, returning false rather than propagating.
    expect(engine.has("h.p")).toBe(false);
  });

  it("getValue() returns undefined when the source accessor throws (505)", () => {
    class HostileGet extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [{ name: "p", event: "hg:p" }],
      };
      get p(): unknown {
        throw new Error("hostile getter");
      }
    }
    const src = new HostileGet();
    const decls = declarationsFromSources({ h: src });
    const plan = planComposition(decls, "all-prefixed", { localFacade: false });
    const engine = new CompositeEngine(plan, new Map([["h", src]]), new EventTarget(), silentLogger);
    engine.install();
    expect(engine.getValue("h.p")).toBeUndefined();
  });

  it("getValue() returns the source's live value before any commit (source present)", () => {
    class LiveVal extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [{ name: "p", event: "lv:p" }],
      };
      p = 123; // present and readable, but no event has fired yet
    }
    const src = new LiveVal();
    const decls = declarationsFromSources({ h: src });
    const plan = planComposition(decls, "all-prefixed", { localFacade: false });
    const engine = new CompositeEngine(plan, new Map([["h", src]]), new EventTarget(), silentLogger);
    engine.install();
    // Not committed yet (#present is empty), so getValue reads the live source.
    expect(engine.getValue("h.p")).toBe(123);
  });

  it("getValue() returns undefined for an unknown composed name", () => {
    const decls = declarationsFromSources({ s: new EngTwoOut() });
    const plan = planComposition(decls, "all-prefixed", { localFacade: false });
    const engine = new CompositeEngine(plan, new Map([["s", new EngTwoOut()]]), new EventTarget(), silentLogger);
    engine.install();
    expect(engine.getValue("s.nope")).toBeUndefined();
    expect(engine.has("s.nope")).toBe(false);
  });
});

describe("CompositeEngine — setInput", () => {
  it("throws on an unknown composed input name (527)", () => {
    const src = new EngTwoOut();
    const decls = declarationsFromSources({ s: src });
    const plan = planComposition(decls, "all-prefixed", { localFacade: true });
    const engine = new CompositeEngine(plan, new Map([["s", src]]), new EventTarget(), silentLogger);
    engine.install();
    expect(() => engine.setInput("s.unknownInput", 1)).toThrow(/unknown composed input/);
  });
});
