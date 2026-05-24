import {
  getWcBindableDeclaration,
  type WcBindableDeclaration,
} from "@wc-bindable/core";
import { reportComposite, type Logger } from "./logger.js";
import {
  isReservedComposedName,
  isReservedSourceId,
  reservedComposedNameReason,
} from "./reservedNames.js";
import type { ExposeConfig, SourceRef } from "./types.js";

/**
 * Default shell-owned event-name namespace (COMPOSITE.md § 6). A composed shell
 * MUST expose shell-owned event names rather than reusing source event names;
 * `@wc-bindable/composite:<composedName>` is unique per composed name because
 * composed names are unique (§ 4).
 */
export const SHELL_EVENT_PREFIX = "@wc-bindable/composite:";

/** The kinds of exposed member, in the order they appear in a declaration. */
type MemberKind = "properties" | "inputs" | "commands";

/**
 * Shell-owned event that carries the already-extracted value **out of band**.
 *
 * A plain `new CustomEvent(type, { detail: undefined })` would surface top-level
 * `undefined` as `null` at the structured-clone / `detail` boundary, violating
 * the § 7 undefined / null preservation MUST. Carrying the value as an ordinary
 * own JS property (read by {@link readShellEventValue}) round-trips it faithfully.
 */
export class CompositeUpdateEvent extends Event {
  readonly value: unknown;
  constructor(type: string, value: unknown) {
    super(type);
    this.value = value;
  }
}

/** Synthesized-descriptor getter that reads the out-of-band value (§ 7). */
function readShellEventValue(event: Event): unknown {
  return (event as CompositeUpdateEvent).value;
}

/**
 * An instance-independent resolved property. It records which source *id* and
 * member back this composed property, plus the shell-owned event name — but not
 * the source instance, so one plan can drive many shell instances (the shared
 * static declaration of a declarative custom element, § 11).
 */
interface PlanProperty {
  composedName: string;
  sourceId: string;
  sourceName: string;
  sourceEvent: string;
  sourceGetter?: (event: Event) => unknown;
  shellEvent: string;
}

interface PlanInput {
  composedName: string;
  sourceId: string;
  sourceName: string;
  attribute?: string;
}

interface PlanCommand {
  composedName: string;
  sourceId: string;
  sourceName: string;
  async?: boolean;
}

export interface CompositionPlan {
  properties: PlanProperty[];
  inputs: PlanInput[];
  commands: PlanCommand[];
  /** The synthesized, frozen core declaration (§ 2, § 11). */
  declaration: WcBindableDeclaration;
  localFacade: boolean;
}

/**
 * Read and validate each source target's declaration, keyed by source id. Each
 * source MUST be a valid wc-bindable target (§ Declarative precondition / § 1
 * discovery). Throws on an invalid source.
 */
export function declarationsFromSources(
  sources: Record<string, EventTarget>,
): Map<string, WcBindableDeclaration> {
  const out = new Map<string, WcBindableDeclaration>();
  for (const id of Object.keys(sources)) {
    const decl = getWcBindableDeclaration(sources[id]);
    if (!decl) {
      throw new Error(
        `@wc-bindable/composite: source ${JSON.stringify(id)} is not a valid wc-bindable target`,
      );
    }
    out.set(id, decl);
  }
  return out;
}

/**
 * Plan a composition from per-source declarations and an expose configuration,
 * applying every § 3 / § 4 validation rule and synthesizing the immutable core
 * declaration. The result is instance-independent so it can be shared as the
 * `static wcBindable` of a class whose instances each build their own engine.
 * Throws on any invalid configuration (finalize-before-observe, § 11).
 */
export function planComposition(
  sourceDecls: Map<string, WcBindableDeclaration>,
  expose: ExposeConfig,
  options: { localFacade: boolean },
): CompositionPlan {
  // § 3: source-id validation.
  for (const id of sourceDecls.keys()) {
    if (isReservedSourceId(id)) {
      throw new Error(
        `@wc-bindable/composite: invalid source id ${JSON.stringify(id)} ` +
          `(must be non-empty, contain no ".", and not be __proto__/constructor/prototype)`,
      );
    }
  }

  const findMember = (decl: WcBindableDeclaration, kind: MemberKind, name: string) => {
    const list =
      kind === "properties"
        ? decl.properties
        : kind === "inputs"
          ? (decl.inputs ?? [])
          : (decl.commands ?? []);
    return list.find((entry) => entry.name === name);
  };

  interface Raw {
    composedName: string;
    sourceId: string;
    sourceName: string;
  }

  const collectExplicit = (map: Record<string, SourceRef> | undefined, kind: MemberKind): Raw[] => {
    const out: Raw[] = [];
    if (!map) return out;
    for (const composedName of Object.keys(map)) {
      const ref = map[composedName];
      const decl = sourceDecls.get(ref.source);
      if (!decl) {
        throw new Error(
          `@wc-bindable/composite: expose ${JSON.stringify(composedName)} references unknown source ${JSON.stringify(ref.source)}`,
        );
      }
      if (!findMember(decl, kind, ref.name)) {
        throw new Error(
          `@wc-bindable/composite: expose ${JSON.stringify(composedName)} references ${kind} member ` +
            `${JSON.stringify(ref.name)} that does not exist on source ${JSON.stringify(ref.source)}`,
        );
      }
      out.push({ composedName, sourceId: ref.source, sourceName: ref.name });
    }
    return out;
  };

  const collectAll = (kind: MemberKind): Raw[] => {
    const out: Raw[] = [];
    for (const [id, decl] of sourceDecls) {
      const list =
        kind === "properties" ? decl.properties : kind === "inputs" ? (decl.inputs ?? []) : (decl.commands ?? []);
      for (const member of list) {
        out.push({ composedName: `${id}.${member.name}`, sourceId: id, sourceName: member.name });
      }
    }
    return out;
  };

  let rawProperties: Raw[];
  let rawInputs: Raw[];
  let rawCommands: Raw[];
  if (expose === "all-prefixed") {
    rawProperties = collectAll("properties");
    rawInputs = collectAll("inputs");
    rawCommands = collectAll("commands");
  } else {
    rawProperties = collectExplicit(expose.properties, "properties");
    rawInputs = collectExplicit(expose.inputs, "inputs");
    rawCommands = collectExplicit(expose.commands, "commands");
  }

  // § 4: reserved names, then per-list uniqueness.
  const assertUnique = (raws: Raw[], kind: MemberKind) => {
    const seen = new Set<string>();
    for (const raw of raws) {
      if (isReservedComposedName(raw.composedName)) {
        throw new Error(
          `@wc-bindable/composite: composed name ${JSON.stringify(raw.composedName)} is reserved ` +
            `(${reservedComposedNameReason(raw.composedName)})`,
        );
      }
      if (seen.has(raw.composedName)) {
        throw new Error(
          `@wc-bindable/composite: duplicate composed ${kind} name ${JSON.stringify(raw.composedName)}`,
        );
      }
      seen.add(raw.composedName);
    }
  };
  assertUnique(rawProperties, "properties");
  assertUnique(rawInputs, "inputs");
  assertUnique(rawCommands, "commands");

  // § 4 cross-surface collisions (T2 only): a name that materializes as more
  // than one member of the same object is ambiguous.
  if (options.localFacade) {
    const acrossSurfaces = new Map<string, MemberKind>();
    const checkAcross = (raws: Raw[], kind: MemberKind) => {
      for (const raw of raws) {
        const prior = acrossSurfaces.get(raw.composedName);
        if (prior !== undefined && prior !== kind) {
          throw new Error(
            `@wc-bindable/composite: composed name ${JSON.stringify(raw.composedName)} collides across ` +
              `${prior} and ${kind} (a local-facade member cannot be two things at once)`,
          );
        }
        acrossSurfaces.set(raw.composedName, kind);
      }
    };
    checkAcross(rawProperties, "properties");
    checkAcross(rawInputs, "inputs");
    checkAcross(rawCommands, "commands");
  }

  const properties: PlanProperty[] = rawProperties.map((raw) => {
    const member = findMember(sourceDecls.get(raw.sourceId)!, "properties", raw.sourceName)! as {
      event: string;
      getter?: (event: Event) => unknown;
    };
    return {
      composedName: raw.composedName,
      sourceId: raw.sourceId,
      sourceName: raw.sourceName,
      sourceEvent: member.event,
      sourceGetter: member.getter,
      shellEvent: SHELL_EVENT_PREFIX + raw.composedName,
    };
  });

  const inputs: PlanInput[] = rawInputs.map((raw) => {
    const member = findMember(sourceDecls.get(raw.sourceId)!, "inputs", raw.sourceName)! as {
      attribute?: string;
    };
    return {
      composedName: raw.composedName,
      sourceId: raw.sourceId,
      sourceName: raw.sourceName,
      attribute: member.attribute,
    };
  });

  const commands: PlanCommand[] = rawCommands.map((raw) => {
    const member = findMember(sourceDecls.get(raw.sourceId)!, "commands", raw.sourceName)! as {
      async?: boolean;
    };
    return {
      composedName: raw.composedName,
      sourceId: raw.sourceId,
      sourceName: raw.sourceName,
      // § 9: the async hint is copied straight from the source command
      // descriptor — the shell never infers asynchrony.
      async: member.async,
    };
  });

  // § 2: build the synthesized core declaration. Property descriptors carry the
  // out-of-band-value getter (§ 7); inputs / commands are declared metadata.
  const declaration: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: properties.map((p) => ({
      name: p.composedName,
      event: p.shellEvent,
      getter: readShellEventValue,
    })),
  };
  if (inputs.length > 0) {
    declaration.inputs = inputs.map((i) =>
      i.attribute !== undefined ? { name: i.composedName, attribute: i.attribute } : { name: i.composedName },
    );
  }
  if (commands.length > 0) {
    declaration.commands = commands.map((c) =>
      c.async !== undefined ? { name: c.composedName, async: c.async } : { name: c.composedName },
    );
  }

  // § 11: freeze so the declaration cannot drift once observable.
  declaration.properties.forEach((p) => Object.freeze(p));
  declaration.inputs?.forEach((i) => Object.freeze(i));
  declaration.commands?.forEach((c) => Object.freeze(c));
  Object.freeze(declaration.properties);
  if (declaration.inputs) Object.freeze(declaration.inputs);
  if (declaration.commands) Object.freeze(declaration.commands);
  Object.freeze(declaration);

  return { properties, inputs, commands, declaration, localFacade: options.localFacade };
}

interface ResolvedProperty extends PlanProperty {
  source: EventTarget;
}

/**
 * Runtime engine for one composed shell instance. Owns source-listener
 * lifecycle, the readable value cache / presence set, the three-phase fan-out,
 * and the T2 delegation surface. It dispatches shell events on an injected
 * `dispatchTarget` so the same engine drives both the headless Proxy shell and
 * a declarative custom element instance.
 */
export class CompositeEngine {
  readonly plan: CompositionPlan;
  readonly #dispatchTarget: EventTarget;
  readonly #logger: Logger;

  /** composedName -> committed value (§ 6 commit phase). */
  readonly #cache = new Map<string, unknown>();
  /** composedName -> presence (§ 5 `in`). */
  readonly #present = new Set<string>();
  /** composedName -> resolved property (with bound source instance). */
  readonly #propByName = new Map<string, ResolvedProperty>();
  /** composedName -> { source, sourceName } for input delegation. */
  readonly #inputByName = new Map<string, { source: EventTarget; sourceName: string }>();
  /** composedName -> stable delegating command function (T2). */
  readonly #commandFns = new Map<string, (...args: unknown[]) => unknown>();
  /** One fan-out group per (source target, source event) occurrence (§ 6). */
  readonly #groups: { source: EventTarget; event: string; regs: ResolvedProperty[] }[] = [];

  #cleanups: (() => void)[] = [];
  #installed = false;
  #disposed = false;

  /**
   * @param plan instance-independent composition plan (from {@link planComposition}).
   * @param sources source id -> the concrete source instance for this shell.
   * @param dispatchTarget where shell events are dispatched and consumers listen.
   */
  constructor(
    plan: CompositionPlan,
    sources: Map<string, EventTarget>,
    dispatchTarget: EventTarget,
    logger: Logger,
  ) {
    this.plan = plan;
    this.#dispatchTarget = dispatchTarget;
    this.#logger = logger;

    const sourceOf = (id: string): EventTarget => {
      const source = sources.get(id);
      if (!source) {
        throw new Error(`@wc-bindable/composite: no source instance provided for source id ${JSON.stringify(id)}`);
      }
      return source;
    };

    for (const prop of plan.properties) {
      this.#propByName.set(prop.composedName, { ...prop, source: sourceOf(prop.sourceId) });
    }
    for (const input of plan.inputs) {
      this.#inputByName.set(input.composedName, {
        source: sourceOf(input.sourceId),
        sourceName: input.sourceName,
      });
    }
    for (const command of plan.commands) {
      const source = sourceOf(command.sourceId);
      const { sourceName, composedName } = command;
      this.#commandFns.set(composedName, (...args: unknown[]) => {
        if (this.#disposed) {
          throw new Error(`@wc-bindable/composite: command ${composedName} called after dispose()`);
        }
        // Method-call form so `this` is the source; the source's completion
        // shape (sync throw vs. rejected promise) is preserved verbatim (§ 9).
        const fn = (source as unknown as Record<string, (...a: unknown[]) => unknown>)[sourceName];
        return fn.apply(source, args);
      });
    }

    // Group properties by occurrence, preserving declaration order within each
    // group so phase-3 dispatch is deterministic (§ 6).
    const byOccurrence = new Map<EventTarget, Map<string, ResolvedProperty[]>>();
    for (const prop of this.#propByName.values()) {
      let byEvent = byOccurrence.get(prop.source);
      if (!byEvent) {
        byEvent = new Map();
        byOccurrence.set(prop.source, byEvent);
      }
      let regs = byEvent.get(prop.sourceEvent);
      if (!regs) {
        regs = [];
        byEvent.set(prop.sourceEvent, regs);
      }
      regs.push(prop);
    }
    for (const [source, byEvent] of byOccurrence) {
      for (const [event, regs] of byEvent) this.#groups.push({ source, event, regs });
    }
  }

  get declaration(): WcBindableDeclaration {
    return this.plan.declaration;
  }

  get localFacade(): boolean {
    return this.plan.localFacade;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /**
   * Install one listener per (source, event) occurrence. On any install-time
   * throw (e.g. a hostile source's `addEventListener`), every listener already
   * installed for this shell is torn down before the error propagates (§ 12
   * source-listener install failure).
   */
  install(): void {
    if (this.#installed || this.#disposed) return;
    const cleanups: (() => void)[] = [];
    try {
      for (const group of this.#groups) {
        const handler = (event: Event) => this.#fanOut(group.regs, event);
        group.source.addEventListener(group.event, handler);
        cleanups.push(() => group.source.removeEventListener(group.event, handler));
      }
    } catch (err) {
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          /* swallow secondary teardown errors */
        }
      }
      throw err;
    }
    this.#cleanups = cleanups;
    this.#installed = true;
  }

  /** The three-phase extract -> commit -> dispatch cycle for one occurrence (§ 6). */
  #fanOut(regs: ResolvedProperty[], event: Event): void {
    if (this.#disposed) return;

    // Phase 1 — extract. Evaluate every mapped property's getter into a buffer;
    // never touch the cache here so no getter observes a partial update. A
    // getter that throws is reported and omitted; its siblings still run (§ 12).
    const buffered: { reg: ResolvedProperty; value: unknown }[] = [];
    for (const reg of regs) {
      let value: unknown;
      try {
        value = reg.sourceGetter ? reg.sourceGetter(event) : (event as CustomEvent).detail;
      } catch (err) {
        reportComposite(err, this.#logger);
        continue;
      }
      buffered.push({ reg, value });
    }

    // Phase 2 — commit. Make every buffered value readable before any dispatch,
    // so a listener reading a sibling sees the new value (§ 6 sibling snapshot).
    for (const { reg, value } of buffered) {
      this.#cache.set(reg.composedName, value);
      this.#present.add(reg.composedName);
    }

    // Phase 3 — dispatch one shell event per committed property, in declaration
    // order, synchronously and without batching (§ 6 re-dispatch timing).
    for (const { reg, value } of buffered) {
      this.#dispatchTarget.dispatchEvent(new CompositeUpdateEvent(reg.shellEvent, value));
    }
  }

  /** § 5 presence: committed, or the source currently reports the member present. */
  has(composedName: string): boolean {
    if (this.#present.has(composedName)) return true;
    const reg = this.#propByName.get(composedName);
    if (!reg) return false;
    try {
      return reg.sourceName in (reg.source as object);
    } catch {
      return false;
    }
  }

  /** § 5 value read: committed cache, else the source's current value, else undefined. */
  getValue(composedName: string): unknown {
    if (this.#present.has(composedName)) return this.#cache.get(composedName);
    const reg = this.#propByName.get(composedName);
    if (!reg) return undefined;
    try {
      if (reg.sourceName in (reg.source as object)) {
        return (reg.source as unknown as Record<string, unknown>)[reg.sourceName];
      }
    } catch {
      /* fall through to undefined on a hostile source accessor */
    }
    return undefined;
  }

  isProperty(name: string): boolean {
    return this.#propByName.has(name);
  }

  isInput(name: string): boolean {
    return this.#inputByName.has(name);
  }

  isCommand(name: string): boolean {
    return this.#commandFns.has(name);
  }

  /** T2 input assignment delegation: `shell[N] = v` -> `source[M] = v` (§ 8). */
  setInput(composedName: string, value: unknown): void {
    if (this.#disposed) {
      throw new Error(`@wc-bindable/composite: input ${composedName} assigned after dispose()`);
    }
    const reg = this.#inputByName.get(composedName);
    if (!reg) {
      throw new Error(`@wc-bindable/composite: unknown composed input ${JSON.stringify(composedName)}`);
    }
    // A throwing source setter propagates synchronously (§ 12 / vector 16).
    (reg.source as unknown as Record<string, unknown>)[reg.sourceName] = value;
  }

  /** The stable delegating function for a composed command (T2 method call). */
  getCommand(composedName: string): ((...args: unknown[]) => unknown) | undefined {
    return this.#commandFns.get(composedName);
  }

  /**
   * § 10 terminal teardown: idempotent; removes every installed source listener.
   * Does NOT dispose source targets (borrow semantics — sources frequently
   * outlive a shell).
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const cleanup of this.#cleanups) {
      try {
        cleanup();
      } catch {
        /* best-effort teardown */
      }
    }
    this.#cleanups = [];
  }
}
