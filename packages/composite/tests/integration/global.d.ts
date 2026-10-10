import type { bind } from "@wc-bindable/core";
import type { defineComposite, silentLogger } from "../../src/index.js";

declare global {
  interface Window {
    /** Installed by `harness.html` once the import map has resolved. */
    __wcb: {
      bind: typeof bind;
      defineComposite: typeof defineComposite;
      silentLogger: typeof silentLogger;
    };
  }
}

export {};
