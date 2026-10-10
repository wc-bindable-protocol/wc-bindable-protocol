import vm from "node:vm";
import { describe, it, expect } from "vitest";
import {
  DEFAULT_WIRE_MAX_DEPTH,
  describeNonJsonArguments,
  describeNonJsonValue,
  isJsonValue,
  toJsonArguments,
  toJsonValue,
} from "../src/jsonValue.js";

const nest = (n: number): unknown => {
  let v: unknown = 0;
  for (let i = 0; i < n; i++) v = [v];
  return v;
};
class SubArray extends Array<unknown> {}
class ToJsonArray extends Array<unknown> {
  toJSON() { return "rewritten"; }
}

const MUST_REJECT: [string, unknown][] = [
  ["Date", new Date()],
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["-Infinity", -Infinity],
  ["sparse [1,,3]", [1, , 3]],
  ["accessor", Object.defineProperty({}, "x", { get: () => 1, enumerable: true })],
  ["non-enumerable", Object.defineProperty({}, "hidden", { value: 1, enumerable: false })],
  ["Object.create(proto)", Object.create({ inherited: 1 })],
  ["Map", new Map([["k", "v"]])],
  ["Set", new Set([1, 2])],
  ["symbol primitive", Symbol("x")],
  ["function", () => {}],
  ["cyclic", (() => { const o: Record<string, unknown> = {}; o.self = o; return o; })()],
  ["symbol-keyed", { [Symbol("meta")]: "x", visible: true }],
  ["top-level undefined", undefined],
  ["nested undefined", { a: undefined, b: 1 }],
  ["undefined element", [undefined]],
  ["bigint", 1n],
  ["boxed string", new String("a")],
  ["Uint8Array", new Uint8Array(2)],
  ["array with extra key", Object.assign([1, 2], { foo: "bar" })],
  ["hole + extra key (count matches)", Object.assign([1, , 3], { foo: 1 })],
  ["array with symbol key", Object.assign([1], { [Symbol("s")]: 1 })],
  ["hole + symbol key (count matches)", Object.assign([, 2], { [Symbol("s")]: 1 })],
  ["array whose index descriptor vanishes", new Proxy([1], { getOwnPropertyDescriptor: (t, k) => (k === "0" ? undefined : Reflect.getOwnPropertyDescriptor(t, k)) })],
  ["array index accessor", Object.defineProperty([0], 0, { get: () => 1 })],
  ["huge sparse array", new Array(1e9)],
  ["nested NaN path", { items: [{ n: 1 }, { n: NaN }] }],
  ["cross-realm plain object", vm.runInNewContext("({ a: 1 })")],
  ["cross-realm array", vm.runInNewContext("[1, 2]")],
  ["Array subclass", SubArray.from([1, 2])],
  ["Array subclass with toJSON", ToJsonArray.from([1, 2])],
  ["array with toJSON prototype", Object.setPrototypeOf([1, 2], { toJSON: () => "x" })],
  ["null-prototype array", Object.setPrototypeOf([1], null)],
  ["depth 200k", nest(200_000)],
  ["proxy trap throws a non-stack RangeError", new Proxy({}, { ownKeys() { throw new RangeError("not depth"); } })],
  ["hostile proxy", new Proxy({}, { ownKeys() { throw new Error("boom"); } })],
  ["throwing getPrototypeOf", new Proxy({}, { getPrototypeOf() { throw new Error("boom"); } })],
  ["key vanishing during validation", new Proxy({ a: 1 }, { getOwnPropertyDescriptor: () => undefined })],
];

const MUST_ACCEPT: [string, unknown][] = [
  ["null", null],
  ["-0", -0],
  ["shared reference (DAG)", (() => { const shared = { k: 1 }; return { a: shared, b: shared }; })()],
  ["null-prototype object", Object.assign(Object.create(null), { a: 1 })],
  ["JSON.parse __proto__ key", JSON.parse('{"__proto__": 1}')],
  ["frozen", Object.freeze({ a: [1, 2] })],
  ["empty array", []],
  [`depth ${DEFAULT_WIRE_MAX_DEPTH}`, nest(DEFAULT_WIRE_MAX_DEPTH)],
  ["lone surrogate string", "\ud800"],
];

describe("jsonValue", () => {
  it.each(MUST_REJECT)("rejects %s", (_label, value) => {
    expect(describeNonJsonValue(value)).toEqual(expect.any(String));
    expect(isJsonValue(value)).toBe(false);
    expect(toJsonValue(value).ok).toBe(false);
  });

  it.each(MUST_ACCEPT)("accepts %s", (_label, value) => {
    expect(describeNonJsonValue(value)).toBeNull();
    expect(isJsonValue(value)).toBe(true);
    expect(toJsonValue(value).ok).toBe(true);
  });

  it("returns a copy that later mutation of the original cannot reach", () => {
    const original: Record<string, unknown> = { list: [1, { x: "y" }], n: null };
    const result = toJsonValue(original);
    (original.list as unknown[])[1] = new Date(0);
    original.extra = 1n;
    expect(result).toEqual({ ok: true, value: { list: [1, { x: "y" }], n: null } });
    expect(result.ok && result.value).not.toBe(original);
  });

  it("builds the copy from descriptors, not from a Proxy get trap", () => {
    const liar = new Proxy({ a: 1 }, { get: () => new Date(0) });
    const result = toJsonValue(liar);
    expect(result.ok && JSON.stringify(result.value)).toBe('{"a":1}');
  });

  it("keeps a JSON-parsed __proto__ key as an own property of the copy", () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "b": 2}');
    const result = toJsonValue(parsed);
    expect(result.ok).toBe(true);
    const copy = (result as { value: Record<string, unknown> }).value;
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(copy, "__proto__")).toBe(true);
    expect(JSON.stringify(copy)).toBe(JSON.stringify(parsed));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("reports a JSONPath-style location under the given root", () => {
    expect(describeNonJsonValue({ a: [1, { b: NaN }] }, "args")).toBe(
      "args.a[1].b is NaN (non-finite numbers are not JsonValue)",
    );
    expect(describeNonJsonValue({ "not an identifier": undefined })).toBe('$["not an identifier"] is undefined');
    expect(describeNonJsonValue({ k: Symbol("s") })).toBe("$.k is a symbol");
  });

  it("bounds the reported path and key length", () => {
    const longKey = "k".repeat(100);
    const reason = describeNonJsonValue({ [longKey]: NaN })!;
    expect(reason).toContain("…");
    expect(reason.length).toBeLessThan(120);
    const deep = toJsonValue(nest(DEFAULT_WIRE_MAX_DEPTH + 1));
    expect(!deep.ok && deep.reason).toMatch(/levels\)…/);
  });

  it("names the constructor of a rejected class instance and labels foreign prototypes", () => {
    expect(describeNonJsonValue(new Map())).toBe("$ is Map, expected a plain object or array");
    expect(describeNonJsonValue(Object.create({}))).toMatch(/prototype is not this realm's/);
    expect(describeNonJsonValue(Object.create(Object.create(null)))).toMatch(/prototype is not this realm's/);
  });

  it("applies the wire depth limit to toJsonValue only, reported as a resource limit", () => {
    const value = nest(DEFAULT_WIRE_MAX_DEPTH + 1);
    expect(describeNonJsonValue(value)).toBeNull();
    expect(isJsonValue(value)).toBe(true);
    expect(toJsonValue(value)).toEqual({
      ok: false,
      reason: expect.stringContaining(`exceeds maxDepth=${DEFAULT_WIRE_MAX_DEPTH} (resource limit)`),
      resourceLimit: true,
    });
    expect(toJsonValue(nest(DEFAULT_WIRE_MAX_DEPTH)).ok).toBe(true);
  });

  it("honors a custom depth bound", () => {
    expect(describeNonJsonValue(nest(3), "$", 2)).toMatch(/exceeds maxDepth=2 \(resource limit\)/);
    expect(toJsonValue(nest(2), "$", 2).ok).toBe(true);
    expect(toJsonValue(nest(DEFAULT_WIRE_MAX_DEPTH + 1), "$", Number.POSITIVE_INFINITY).ok).toBe(true);
  });

  it("distinguishes resource limits from malformed values", () => {
    expect(toJsonValue(NaN)).toMatchObject({ ok: false, resourceLimit: false });
    const exhausted = toJsonValue(nest(200_000), "$", Number.POSITIVE_INFINITY);
    expect(exhausted).toMatchObject({ ok: false, resourceLimit: true });
    expect(!exhausted.ok && exhausted.reason).toMatch(/deeper than this runtime can traverse/);
    const trap = toJsonValue(new Proxy({}, { ownKeys() { throw new RangeError("not depth"); } }));
    expect(trap).toMatchObject({ ok: false, resourceLimit: false });
    expect(!trap.ok && trap.reason).toMatch(/trap or accessor threw/);
  });
});

describe("argument lists (cmd.args)", () => {
  it("requires an array and validates each argument", () => {
    expect(toJsonArguments({ 0: 1 })).toEqual({ ok: false, reason: "args is not an array", resourceLimit: false });
    expect(describeNonJsonArguments({ 0: 1 })).toBe("args is not an array");
    expect(describeNonJsonArguments([1, undefined])).toBe("args[1] is undefined");
    expect(describeNonJsonArguments([1, "a", { b: [null] }])).toBeNull();
    // eslint-disable-next-line no-sparse-arrays
    expect(describeNonJsonArguments([1, , 3])).toBe("args is a sparse array (holes are not JsonValue)");
  });

  it("gives each argument the full depth budget and reports the configured limit", () => {
    expect(toJsonArguments([nest(2)], 2).ok).toBe(true);
    const deep = toJsonArguments([1, nest(3)], 2);
    expect(deep).toMatchObject({ ok: false, resourceLimit: true });
    expect(!deep.ok && deep.reason).toBe("args[1][0][0] exceeds maxDepth=2 (resource limit)");
    expect(describeNonJsonArguments([nest(500)])).toBeNull();
  });

  it("returns a copy", () => {
    const arg = { a: [1] };
    const result = toJsonArguments([arg]);
    expect(result.ok && result.value).toEqual([{ a: [1] }]);
    expect(result.ok && (result.value as unknown[])[0]).not.toBe(arg);
  });
});
