import { Config } from "@stencil/core";

export const config: Config = {
  namespace: "wc-bindable-stencil-examples",
  sourceMap: true,
  outputTargets: [
    {
      type: "dist-custom-elements",
      generateTypeDeclarations: false,
      customElementsExportBehavior: "auto-define-custom-elements",
      externalRuntime: false,
    },
  ],
  testing: { browserHeadless: "shell" },
};
