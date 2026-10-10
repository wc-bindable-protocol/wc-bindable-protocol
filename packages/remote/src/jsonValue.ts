/**
 * Deep `JsonValue` validation per SPEC-extensions.md § Design invariants,
 * invariant 3. `JSON.stringify` is NOT a validator: it coerces NaN/±Infinity
 * to null, drops undefined / function / symbol-valued keys, serializes Date
 * and anything else with a `toJSON` through that method, and turns Map/Set
 * into {}.
 *
 * Two entry points share one walker:
 * - `toJsonValue` validates AND builds a fresh plain copy from the property
 *   descriptors it validated. Senders serialize the copy, so what crosses the
 *   wire is exactly what was checked — a Proxy whose `get` trap disagrees with
 *   its descriptors, a value mutated while queued, or a `toJSON` reachable
 *   through a prototype cannot change it afterwards.
 * - `describeNonJsonValue` / `isJsonValue` validate without copying, for
 *   receivers whose input was just produced by `JSON.parse`.
 */

export type JsonValue =
  | null
  | boolean
  | string
  | number
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonValueResult =
  | { ok: true; value: JsonValue }
  /** `resourceLimit` distinguishes "too deep / too big to handle here" from "not a JsonValue". */
  | { ok: false; reason: string; resourceLimit: boolean };

/**
 * Nesting-depth resource limit applied at the wire boundary (the proxy and the
 * shell), not by the `isJsonValue` predicate. `JSON.stringify`'s own limit
 * depends on how much stack is already in use — about 1,700 levels from a
 * shallow stack in V8, about 600 with 8,000 frames already on it — so the
 * default stays well below that. Configurable per proxy / shell.
 */
export const DEFAULT_WIRE_MAX_DEPTH = 256;

/** Validate a `maxDepth` option: a positive integer or `Infinity`; default {@link DEFAULT_WIRE_MAX_DEPTH}. */
export function normalizeMaxDepth(value: number | undefined, owner: string): number {
  if (value === undefined) return DEFAULT_WIRE_MAX_DEPTH;
  if (value === Number.POSITIVE_INFINITY) return value;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${owner}: maxDepth must be a positive integer, Infinity, or omitted`);
  }
  return value;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const CANONICAL_INDEX = /^(?:0|[1-9][0-9]*)$/;

type Segment = string | number;

class Rejection {
  constructor(
    readonly segments: readonly Segment[],
    readonly problem: string,
    readonly resourceLimit: boolean,
  ) {}
}

function formatSegment(segment: Segment): string {
  if (typeof segment === "number") return `[${segment}]`;
  if (IDENTIFIER.test(segment) && segment.length <= 64) return `.${segment}`;
  // Keys can come from an untrusted peer and end up in logs / `throw`
  // messages, so cap their length.
  return `[${JSON.stringify(segment.length > 64 ? `${segment.slice(0, 64)}…` : segment)}]`;
}

function formatPath(root: string, segments: readonly Segment[]): string {
  // Keep messages bounded for deeply nested values: head … tail.
  if (segments.length > 16) {
    const head = segments.slice(0, 6).map(formatSegment).join("");
    const tail = segments.slice(-6).map(formatSegment).join("");
    return `${root}${head}…(${segments.length - 12} levels)…${tail}`;
  }
  return root + segments.map(formatSegment).join("");
}

function describeObject(value: object): string {
  const ctor = (Object.getPrototypeOf(value) as { constructor?: { name?: unknown } } | null)?.constructor;
  const name = typeof ctor?.name === "string" ? ctor.name : "";
  // "Object" / "Array" here means some *other* realm's or a substituted
  // prototype: `Object.create({...})`, `Object.setPrototypeOf([], …)`, or a
  // value from another realm (iframe, vm context).
  if (name === "" || name === "Object" || name === "Array") {
    return "an object whose prototype is not this realm's Object.prototype / Array.prototype";
  }
  return name;
}

class Walker {
  readonly segments: Segment[] = [];
  readonly ancestors = new Set<object>();

  /**
   * @param containerLevels Outer levels not counted against `maxDepth` — 1 for
   *   an argument list, so each argument gets the full budget and the message
   *   reports the configured limit.
   */
  constructor(
    readonly copy: boolean,
    readonly maxDepth: number,
    readonly containerLevels = 0,
  ) {}

  fail(problem: string): never {
    throw new Rejection(this.segments.slice(), problem, false);
  }

  failLimit(problem: string): never {
    throw new Rejection(this.segments.slice(), problem, true);
  }

  visit(value: unknown): unknown {
    switch (typeof value) {
      case "string":
      case "boolean":
        return value;
      case "number":
        if (!Number.isFinite(value)) this.fail(`is ${String(value)} (non-finite numbers are not JsonValue)`);
        return value;
      case "undefined":
        return this.fail("is undefined");
      case "bigint":
      case "symbol":
      case "function":
        return this.fail(`is a ${typeof value}`);
    }
    if (value === null) return null;
    const object = value as object;
    if (this.ancestors.has(object)) this.fail("is a cyclic reference");
    if (this.ancestors.size - this.containerLevels >= this.maxDepth) {
      this.failLimit(`exceeds maxDepth=${this.maxDepth} (resource limit)`);
    }
    // Ancestors, not "everything seen": a DAG that references one object
    // twice is valid JSON (it serializes twice); only a reference back up the
    // current path is a cycle.
    this.ancestors.add(object);
    try {
      return Array.isArray(object) ? this.visitArray(object) : this.visitObject(object);
    } finally {
      this.ancestors.delete(object);
    }
  }

  visitArray(value: unknown[]): unknown {
    // Exactly this realm's Array.prototype: a subclass instance is a class
    // instance (out of contract), and any other prototype could carry a
    // `toJSON` that JSON.stringify would call.
    if (Object.getPrototypeOf(value) !== Array.prototype) this.fail(`is ${describeObject(value)}`);
    const length = value.length;
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (typeof key === "symbol") this.fail(`has a symbol key ${String(key)} (rejected)`);
      if (key !== "length" && !CANONICAL_INDEX.test(key)) this.fail(`has a non-index property ${JSON.stringify(key)}`);
    }
    // Every own key is now "length" or a canonical index below `length`, so
    // a count short of length + 1 can only mean holes. Deciding from the
    // count keeps `new Array(1e9)` O(own keys) instead of O(length).
    if (keys.length !== length + 1) this.fail("is a sparse array (holes are not JsonValue)");
    const out: unknown[] | null = this.copy ? new Array(length) : null;
    for (let i = 0; i < length; i++) {
      this.segments.push(i);
      const descriptor = Object.getOwnPropertyDescriptor(value, i);
      if (descriptor === undefined) this.fail("is a sparse hole");
      if (!("value" in descriptor)) this.fail("is an accessor property");
      const element = this.visit(descriptor.value);
      if (out !== null) out[i] = element;
      this.segments.pop();
    }
    return out;
  }

  visitObject(value: object): unknown {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) this.fail(`is ${describeObject(value)}, expected a plain object or array`);
    const out: Record<string, unknown> | null = this.copy ? {} : null;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") this.fail(`has a symbol key ${String(key)} (rejected)`);
      this.segments.push(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) this.fail("disappeared during validation");
      if (!("value" in descriptor)) this.fail("is an accessor property");
      if (!descriptor.enumerable) this.fail("is a non-enumerable property");
      const property = this.visit(descriptor.value);
      if (out !== null) {
        if (key === "__proto__") {
          // A JSON-parsed "__proto__" key is an ordinary own property and must
          // stay one in the copy; plain assignment would set the prototype.
          Object.defineProperty(out, key, { value: property, enumerable: true, writable: true, configurable: true });
        } else {
          out[key] = property;
        }
      }
      this.segments.pop();
    }
    return out;
  }
}

function isStackExhaustion(err: unknown): boolean {
  // V8 / JavaScriptCore: RangeError "Maximum call stack size exceeded";
  // SpiderMonkey: InternalError "too much recursion".
  if (err instanceof RangeError) return /stack/i.test(err.message);
  return (err as { name?: unknown } | null)?.name === "InternalError";
}

function run(value: unknown, root: string, copy: boolean, maxDepth: number, containerLevels = 0): JsonValueResult {
  const walker = new Walker(copy, maxDepth, containerLevels);
  try {
    const result = walker.visit(value);
    return { ok: true, value: (copy ? result : value) as JsonValue };
  } catch (err) {
    if (err instanceof Rejection) {
      return { ok: false, reason: `${formatPath(root, err.segments)} ${err.problem}`, resourceLimit: err.resourceLimit };
    }
    const at = formatPath(root, walker.segments);
    if (isStackExhaustion(err)) {
      return { ok: false, reason: `${at} is nested deeper than this runtime can traverse (resource limit)`, resourceLimit: true };
    }
    // A Proxy trap or prototype accessor threw. Never let it escape.
    return { ok: false, reason: `${at} could not be inspected (a trap or accessor threw during validation)`, resourceLimit: false };
  }
}

/**
 * Validate and copy, for senders. Serialize `result.value`, never the original.
 * Applies the wire nesting-depth limit (default {@link DEFAULT_WIRE_MAX_DEPTH}).
 */
export function toJsonValue(value: unknown, root = "$", maxDepth = DEFAULT_WIRE_MAX_DEPTH): JsonValueResult {
  return run(value, root, true, maxDepth);
}

/**
 * Validate only. Returns `null` for a JsonValue, otherwise a path-aware reason.
 * Never throws. No depth limit unless one is passed — the predicate answers
 * "is this a JsonValue", and depth is a resource limit, not part of that type.
 */
export function describeNonJsonValue(value: unknown, root = "$", maxDepth = Number.POSITIVE_INFINITY): string | null {
  const result = run(value, root, false, maxDepth);
  return result.ok ? null : result.reason;
}

export function isJsonValue(value: unknown): value is JsonValue {
  return describeNonJsonValue(value) === null;
}

/**
 * Validate and copy an argument list for `cmd.args`: the list itself must be
 * a dense plain array, and each argument gets the full `maxDepth` budget.
 */
export function toJsonArguments(args: unknown, maxDepth = DEFAULT_WIRE_MAX_DEPTH): JsonValueResult {
  if (!Array.isArray(args)) return { ok: false, reason: "args is not an array", resourceLimit: false };
  return run(args, "args", true, maxDepth, 1);
}

/** Validate-only counterpart of {@link toJsonArguments}, for receivers. */
export function describeNonJsonArguments(args: unknown, maxDepth = Number.POSITIVE_INFINITY): string | null {
  if (!Array.isArray(args)) return "args is not an array";
  const result = run(args, "args", false, maxDepth, 1);
  return result.ok ? null : result.reason;
}
