/// <reference types="vite/client" />

declare module "*.riot" {
  import type { RiotComponentWrapper } from "riot";
  const component: RiotComponentWrapper;
  export default component;
}

