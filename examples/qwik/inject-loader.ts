import { QWIK_LOADER } from "@builder.io/qwik/loader";

// qwikVite's CSR mode does not inject qwikloader into the HTML, so Qwik
// event handlers like onClick$/onInput$ never fire. Inject it as a side
// effect from each entry so the bridge between DOM events and QRL handlers
// is wired up before the first render.
const loader = document.createElement("script");
loader.textContent = QWIK_LOADER;
document.head.appendChild(loader);
