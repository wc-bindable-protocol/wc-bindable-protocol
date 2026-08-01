import type { bind, isWcBindable, getWcBindableDeclaration } from "../../src/index.js";

declare global {
  interface Window {
    /** Installed by `harness.html` once the import map has resolved. */
    __wcb: {
      bind: typeof bind;
      isWcBindable: typeof isWcBindable;
      getWcBindableDeclaration: typeof getWcBindableDeclaration;
    };
    /**
     * The two async error channels SPEC.md § Teardown Contract keeps
     * distinct. `harness.html` installs the listeners and calls
     * `preventDefault()` so a deliberately-thrown test error does not also
     * fail the run.
     */
    __errors: { uncaught: string[]; rejections: string[] };
  }
}

export {};
