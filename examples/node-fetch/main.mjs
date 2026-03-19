/**
 * wc-bindable: Node.js — Fetch
 *
 * Demonstrates that MyFetchCore (EventTarget-based) and bind()
 * work in Node.js with zero DOM dependencies.
 */
import { bind } from "../../packages/core/dist/index.js";
import { MyFetchCore } from "../vanilla/fetch/my-fetch-core.js";

const core = new MyFetchCore();
const state = {};

// Subscribe to state changes — same pattern as every framework adapter
const unbind = bind(core, (name, value) => {
  state[name] = value;
  console.log(`  onUpdate("${name}", ${JSON.stringify(value)})`);
});

console.log("--- wc-bindable: Node.js — Fetch ---\n");
console.log("Fetching https://jsonplaceholder.typicode.com/posts/1 ...\n");

await core.fetch("https://jsonplaceholder.typicode.com/posts/1");

console.log("\n--- Final state ---");
console.log(JSON.stringify(state, null, 2));

unbind();
console.log("\n--- unbound, done ---");
