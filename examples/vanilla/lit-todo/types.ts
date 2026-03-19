import type { LitTodo } from "./lit-todo.ts";

export type LitTodoElement = LitTodo;

export interface LitTodoValues {
  items: string[];
  count: number;
}
