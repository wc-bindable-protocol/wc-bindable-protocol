import { describe, it, expectTypeOf } from "vitest";
import type {
  // New names
  AuthUser,
  AuthError,
  AuthCoreValues,
  AuthValues,
  // Deprecated aliases — must remain importable and structurally identical
  WcsAuthUser,
  WcsAuthError,
  WcsAuthCoreValues,
  WcsAuthValues,
} from "../src/index";

/**
 * Backward-compat guard for the Wcs* → Auth* rename.
 *
 * The legacy names are exported as deprecated aliases of the new names.
 * If anyone removes the alias, this file will fail to compile and the
 * test runner will surface the breakage instead of letting it land
 * silently in a non-version-bumping commit.
 */
describe("deprecated Wcs* aliases (backward compatibility)", () => {
  it("WcsAuthUser is identical to AuthUser", () => {
    expectTypeOf<WcsAuthUser>().toEqualTypeOf<AuthUser>();
  });

  it("WcsAuthError is identical to AuthError", () => {
    expectTypeOf<WcsAuthError>().toEqualTypeOf<AuthError>();
  });

  it("WcsAuthCoreValues is identical to AuthCoreValues", () => {
    expectTypeOf<WcsAuthCoreValues>().toEqualTypeOf<AuthCoreValues>();
  });

  it("WcsAuthValues is identical to AuthValues", () => {
    expectTypeOf<WcsAuthValues>().toEqualTypeOf<AuthValues>();
  });
});
