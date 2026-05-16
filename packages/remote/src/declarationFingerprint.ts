import type { WcBindableDeclaration } from "@wc-bindable/core";
import type { DeclarationFingerprint } from "./types.js";

/**
 * Build the canonical structural fingerprint of a wcBindable declaration.
 *
 * The output is deterministic — name lists are sorted and deduplicated so
 * two declarations that describe the same surface produce equal
 * fingerprints regardless of source-order or accidental repetition.
 * Event names are intentionally NOT included: the consumer-side proxy
 * rewrites them to synthetic per-property names (see SPEC-extensions.md
 * § Extension 2 invariant 2), so comparing them across the wire would
 * report spurious differences for every fingerprint exchange.
 */
export function buildDeclarationFingerprint(
  decl: WcBindableDeclaration,
): DeclarationFingerprint {
  return {
    version: decl.version,
    properties: sortedUniqueNames(decl.properties),
    inputs: sortedUniqueNames(decl.inputs),
    commands: sortedUniqueNames(decl.commands),
  };
}

/**
 * Structural equality on two fingerprints. Returns true iff version matches
 * and every name list is the same set (order- and duplicate-insensitive,
 * though `buildDeclarationFingerprint` already normalizes both).
 */
export function declarationFingerprintsEqual(
  a: DeclarationFingerprint,
  b: DeclarationFingerprint,
): boolean {
  if (a.version !== b.version) return false;
  if (!arraysEqual(a.properties, b.properties)) return false;
  if (!arraysEqual(a.inputs, b.inputs)) return false;
  if (!arraysEqual(a.commands, b.commands)) return false;
  return true;
}

function sortedUniqueNames(
  entries: ReadonlyArray<{ name: string }> | undefined,
): string[] {
  if (!entries || entries.length === 0) return [];
  const set = new Set<string>();
  for (const entry of entries) set.add(entry.name);
  return [...set].sort();
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
