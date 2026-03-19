import "./lit-todo.ts";
import { bind, isWcBindable } from "@wc-bindable/core";
import litTodoSource from "./lit-todo.ts?raw";

const todo = document.getElementById("todo")!;
const boundValue = document.getElementById("bound-value")!;
const countBadge = document.getElementById("count-badge")!;
const log = document.getElementById("log")!;

const state: Record<string, unknown> = {};

const appendLog = (msg: string) => {
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  log.prepend(entry);
};

appendLog(`isWcBindable(todo) = ${isWcBindable(todo)}`);

bind(todo, (name, value) => {
  state[name] = value;
  boundValue.textContent = JSON.stringify(state, null, 2);
  if (name === "count") countBadge.textContent = String(value);
  appendLog(`onUpdate("${name}", ${JSON.stringify(value)})`);
});

appendLog("bind() called — listening for changes");

document.getElementById("source-code")!.textContent = litTodoSource;
