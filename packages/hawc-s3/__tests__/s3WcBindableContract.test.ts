import { describe, it, expect, beforeAll } from "vitest";
import { S3 } from "../src/components/S3";
import { S3Core } from "../src/core/S3Core";

beforeAll(() => {
  if (!customElements.get("hawc-s3")) customElements.define("hawc-s3", S3);
});

/**
 * The wcBindable declaration is a CONTRACT that external tooling trusts when
 * it introspects the element to wire up bindings. Anything advertised as a
 * command MUST be callable as a method on instances; anything advertised as
 * an input or property must be readable/writable. Declaration drift is the
 * exact class of bug that makes a generic adapter blow up at runtime with
 * `element.requestUpload is not a function`.
 */
describe("S3 wcBindable contract", () => {
  it("declares exactly the commands the Shell actually implements", () => {
    // The Shell is NOT meant to forward Core's internal orchestration RPCs
    // (requestUpload / reportProgress / complete / completeMultipart /
    // abortMultipart / requestDownload / deleteObject). Those are private
    // Shell↔Core coordination, not element-level surface. Pinning the
    // element's command list to just the two public methods protects
    // against a future change that re-introduces the full spread of
    // Core commands — which was the original bug.
    const cmdNames = (S3.wcBindable.commands ?? []).map((c) => c.name);
    expect(cmdNames.sort()).toEqual(["abort", "upload"]);
  });

  it("does NOT inherit Core's internal orchestration commands", () => {
    const coreOnlyCommands = [
      "requestUpload",
      "reportProgress",
      "complete",
      "requestDownload",
      "deleteObject",
      "requestMultipartUpload",
      "completeMultipart",
      "abortMultipart",
    ];
    const shellCmds = new Set((S3.wcBindable.commands ?? []).map((c) => c.name));
    for (const internal of coreOnlyCommands) {
      expect(shellCmds.has(internal), `Shell must not advertise Core-only command "${internal}"`).toBe(false);
    }
  });

  it("every declared command exists as a callable method on instances", () => {
    // The actual invariant wc-bindable tools rely on: for every entry in
    // `element.constructor.wcBindable.commands`, `element[entry.name]` is a
    // function. Instantiating via createElement rather than `new S3()` so
    // we also cover the custom-elements upgrade path.
    const el = document.createElement("hawc-s3") as unknown as Record<string, unknown>;
    for (const cmd of S3.wcBindable.commands ?? []) {
      expect(
        typeof el[cmd.name],
        `<hawc-s3> advertises command "${cmd.name}" but no method of that name is callable on the element`,
      ).toBe("function");
    }
  });

  it("forwards every Core property so bindings can subscribe to the same outputs", () => {
    // Properties, unlike commands, ARE meant to be a superset of Core's —
    // the Shell is a transparent view over Core's observable state, plus
    // the element-only `trigger`. Lock this invariant so a future narrowing
    // of the property list does not silently break state bindings.
    const corePropNames = new Set(S3Core.wcBindable.properties.map((p) => p.name));
    const shellPropNames = new Set(S3.wcBindable.properties.map((p) => p.name));
    for (const p of corePropNames) {
      expect(shellPropNames.has(p), `Shell must forward Core property "${p}"`).toBe(true);
    }
    expect(shellPropNames.has("trigger")).toBe(true);
  });

  it("forwards every Core input", () => {
    const coreInputs = new Set((S3Core.wcBindable.inputs ?? []).map((i) => i.name));
    const shellInputs = new Set((S3.wcBindable.inputs ?? []).map((i) => i.name));
    for (const i of coreInputs) {
      expect(shellInputs.has(i), `Shell must forward Core input "${i}"`).toBe(true);
    }
  });
});
