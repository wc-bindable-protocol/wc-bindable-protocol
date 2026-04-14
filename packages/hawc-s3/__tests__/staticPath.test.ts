import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveSafeStaticPath, isAllowedPackageAsset } from "../tests/integration/staticPath";

// POSIX-style root used throughout: the helper uses path.resolve / path.relative
// which behave correctly cross-platform, and the test only inspects properties
// of the resolved path (containment), not the literal string shape.
const ROOT = path.resolve("/srv/packages");

describe("resolveSafeStaticPath", () => {
  describe("legitimate paths", () => {
    it("resolves a normal file path under the root", () => {
      const r = resolveSafeStaticPath(ROOT, "/hawc-s3/dist/index.js");
      expect(r).toBe(path.join(ROOT, "hawc-s3/dist/index.js"));
    });

    it("strips leading slashes (treats /foo as relative under root)", () => {
      // Without stripping, path.resolve(root, "/foo") would discard root
      // entirely (absolute components win) and serve from filesystem root.
      const r = resolveSafeStaticPath(ROOT, "/a/b/c");
      expect(r).toBe(path.join(ROOT, "a/b/c"));
    });

    it("decodes percent-encoded path segments before resolving", () => {
      const r = resolveSafeStaticPath(ROOT, "/hawc-s3%2Fdist/index.js");
      expect(r).toBe(path.join(ROOT, "hawc-s3/dist/index.js"));
    });

    it("ignores trailing query and fragment", () => {
      const r = resolveSafeStaticPath(ROOT, "/hawc-s3/dist/index.js?v=1#frag");
      expect(r).toBe(path.join(ROOT, "hawc-s3/dist/index.js"));
    });
  });

  describe("traversal rejected", () => {
    it("rejects raw `..` that climbs out one level", () => {
      expect(resolveSafeStaticPath(ROOT, "/../package.json")).toBeNull();
    });

    it("rejects deep raw traversal", () => {
      expect(resolveSafeStaticPath(ROOT, "/../../etc/passwd")).toBeNull();
    });

    it("rejects partial traversal that lands back inside (defense in depth)", () => {
      // /hawc-s3/../../package.json normalizes to /package.json (one above
      // root). Even if it landed inside, the `..` semantics let an attacker
      // probe what is above the root, so we conservatively block any climb.
      expect(resolveSafeStaticPath(ROOT, "/hawc-s3/../../package.json")).toBeNull();
    });

    it("rejects percent-encoded `..` segments", () => {
      expect(resolveSafeStaticPath(ROOT, "/%2e%2e/package.json")).toBeNull();
      expect(resolveSafeStaticPath(ROOT, "/%2E%2E/package.json")).toBeNull();
    });

    it("rejects mixed encoded and literal traversal", () => {
      expect(resolveSafeStaticPath(ROOT, "/foo/%2e%2e%2f..%2fpackage.json")).toBeNull();
    });

    it("rejects null-byte injection", () => {
      // Some legacy code uses the bytes after a NUL. Path utilities in Node
      // do not strip them, but they are still a footgun; reject outright.
      expect(resolveSafeStaticPath(ROOT, "/hawc-s3/dist/index.js\0../package.json")).toBeNull();
    });

    it("rejects when the resolved path equals the root itself (no servable file)", () => {
      // path.relative(root, root) === "" — empty rel means the request just
      // pointed at the directory; we never want to fs.stat() the root either.
      expect(resolveSafeStaticPath(ROOT, "/")).toBeNull();
      expect(resolveSafeStaticPath(ROOT, "")).toBeNull();
    });

    it("rejects malformed percent-encoding", () => {
      // decodeURIComponent throws URIError on malformed sequences. We catch
      // and return null rather than letting the server crash with 500.
      expect(resolveSafeStaticPath(ROOT, "/%E0%A4%A")).toBeNull();
      expect(resolveSafeStaticPath(ROOT, "/%ZZ")).toBeNull();
    });
  });

  describe("regression: naive path.join() WOULD have leaked these", () => {
    // These are the exact shapes the bug review called out. The naive form
    // (path.join(root, urlPath)) normalizes `..` and produces a path outside
    // the root with no protest. Fix this test failing means the helper has
    // been weakened — do not "fix" by relaxing the assertions.
    it("/packages/../package.json equivalent", () => {
      expect(resolveSafeStaticPath(ROOT, "/../package.json")).toBeNull();
    });

    it("/packages/hawc-s3/../../package.json equivalent", () => {
      expect(resolveSafeStaticPath(ROOT, "/hawc-s3/../../package.json")).toBeNull();
    });
  });
});

describe("isAllowedPackageAsset", () => {
  // Even when the traversal check passes, the demo server must only serve
  // files from `<pkg>/dist/**`. This is the subtree the importmap points at
  // and the only bytes a consumer of the built package would have access to
  // via the public `exports` map. Leaking src/, package.json, tests/, etc.
  // turns a docs-adjacent demo server into a source-disclosure vector if
  // someone copy-pastes it into production.

  const PACKAGES = path.resolve("/srv/packages");
  const at = (p: string): string => path.resolve(PACKAGES, p);

  it("allows compiled output under <pkg>/dist/**", () => {
    expect(isAllowedPackageAsset(PACKAGES, at("hawc-s3/dist/index.js"))).toBe(true);
    expect(isAllowedPackageAsset(PACKAGES, at("hawc-s3/dist/providers/AwsS3Provider.js"))).toBe(true);
    expect(isAllowedPackageAsset(PACKAGES, at("core/dist/index.js"))).toBe(true);
  });

  it("rejects TypeScript source under <pkg>/src/**", () => {
    expect(isAllowedPackageAsset(PACKAGES, at("hawc-s3/src/components/S3.ts"))).toBe(false);
    expect(isAllowedPackageAsset(PACKAGES, at("hawc-s3/src/signing/sigv4.ts"))).toBe(false);
  });

  it("rejects package metadata (package.json, tsconfig.json)", () => {
    expect(isAllowedPackageAsset(PACKAGES, at("hawc-s3/package.json"))).toBe(false);
    expect(isAllowedPackageAsset(PACKAGES, at("hawc-s3/tsconfig.json"))).toBe(false);
  });

  it("rejects test directories", () => {
    expect(isAllowedPackageAsset(PACKAGES, at("hawc-s3/__tests__/sigv4.test.ts"))).toBe(false);
    expect(isAllowedPackageAsset(PACKAGES, at("hawc-s3/tests/integration/server.ts"))).toBe(false);
  });

  it("rejects a file that sits directly under a package root", () => {
    expect(isAllowedPackageAsset(PACKAGES, at("hawc-s3/README.md"))).toBe(false);
    expect(isAllowedPackageAsset(PACKAGES, at("hawc-s3/LICENSE"))).toBe(false);
  });

  it("rejects nested node_modules", () => {
    expect(isAllowedPackageAsset(PACKAGES, at("hawc-s3/node_modules/some-lib/lib.js"))).toBe(false);
  });

  it("rejects the packages root itself and a bare package dir", () => {
    expect(isAllowedPackageAsset(PACKAGES, PACKAGES)).toBe(false);
    expect(isAllowedPackageAsset(PACKAGES, at("hawc-s3"))).toBe(false);
  });

  it("rejects paths that are not under packagesRoot at all", () => {
    expect(isAllowedPackageAsset(PACKAGES, path.resolve("/etc/passwd"))).toBe(false);
    expect(isAllowedPackageAsset(PACKAGES, path.resolve("/srv/other/hawc-s3/dist/index.js"))).toBe(false);
  });
});
