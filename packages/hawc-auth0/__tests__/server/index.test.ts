import { describe, expect, it } from "vitest";

import * as serverIndex from "../../src/server/index";
import { createAuthenticatedWSS, handleConnection } from "../../src/server/createAuthenticatedWSS";
import { verifyAuth0Token } from "../../src/server/verifyAuth0Token";
import { extractTokenFromProtocol } from "../../src/server/extractTokenFromProtocol";
import { UserCore } from "../../src/server/UserCore";

describe("server index exports", () => {
  it("re-exports server APIs", () => {
    expect(serverIndex.createAuthenticatedWSS).toBe(createAuthenticatedWSS);
    expect(serverIndex.handleConnection).toBe(handleConnection);
    expect(serverIndex.verifyAuth0Token).toBe(verifyAuth0Token);
    expect(serverIndex.extractTokenFromProtocol).toBe(extractTokenFromProtocol);
    expect(serverIndex.UserCore).toBe(UserCore);
  });
});
