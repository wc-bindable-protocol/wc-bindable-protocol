import "../inject-loader.ts";
import { render } from "@builder.io/qwik";
import { App } from "./App.tsx";

render(document.getElementById("root")!, <App />);
