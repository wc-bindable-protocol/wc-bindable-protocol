import path from "node:path";

/**
 * Resolve a request path safely against an allowed root.
 *
 * Returns the absolute path on success, or null if the request would escape
 * via `..`, percent-encoded `..`, null bytes, or absolute components.
 *
 * `path.join(root, urlPath)` is *not* safe — it normalizes traversal
 * sequences instead of rejecting them. A request like
 * `/packages/../package.json` joined naively resolves to a file outside
 * the allowed root. Demo / dev servers that omit this check are a
 * textbook path-traversal vulnerability.
 *
 * Mirrored inline (in JS form) by `examples/s3-remote/server.mjs` —
 * keep the two implementations in sync.
 */
export function resolveSafeStaticPath(allowedRoot: string, urlPath: string): string | null {
  // Strip query and fragment in case the caller passed them through.
  const cleaned = urlPath.split("?")[0].split("#")[0];
  let decoded: string;
  try { decoded = decodeURIComponent(cleaned); } catch { return null; }
  if (decoded.includes("\0")) return null;
  // path.resolve treats absolute components as overrides. Strip a leading `/`
  // so the URL `/foo` is treated as a relative request under allowedRoot,
  // not as the filesystem root.
  const subPath = decoded.replace(/^\/+/, "");
  const absolute = path.resolve(allowedRoot, subPath);
  // Containment check: anything that climbs out (`..`) or resolves to a
  // different drive (Windows) yields a relative path that starts with `..`
  // or is absolute. An empty `rel` means the request resolved exactly to
  // the root directory itself, which is also not a servable file.
  const rel = path.relative(allowedRoot, absolute);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return absolute;
}

/**
 * Second-layer allowlist for `/packages/...` requests. Containment is already
 * handled by `resolveSafeStaticPath`; this restricts *which* files under
 * `packagesRoot` are actually servable.
 *
 * Without an allowlist, a handler that advertises "serves built package
 * artifacts" actually hands out every source file, tsconfig, package.json,
 * test fixture, and `node_modules/` stash under `packages/`. Even for a test
 * harness this is an easy-to-miss source-disclosure footgun when the pattern
 * gets copy-pasted into a demo or production server.
 *
 * Allowed subpaths (per package): `<pkg>/dist/**` only. Everything else
 * (src/, __tests__/, tests/, package.json, tsconfig.json, node_modules/, …)
 * returns false.
 *
 * Mirrored inline in JS form by `examples/s3-remote/server.mjs` as
 * `isAllowedPackageAsset`; keep the two in sync.
 */
export function isAllowedPackageAsset(packagesRoot: string, absolutePath: string): boolean {
  const rel = path.relative(packagesRoot, absolutePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const segments = rel.split(path.sep);
  if (segments.length < 2) return false;
  return segments[1] === "dist";
}
