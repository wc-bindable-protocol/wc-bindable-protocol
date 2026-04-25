import { config } from "./config.js";

let refCount = 0;

function handleClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const triggerElement = target.closest<Element>(`[${config.triggerAttribute}]`);
  if (!triggerElement) return;

  const aiId = triggerElement.getAttribute(config.triggerAttribute);
  if (!aiId) return;

  const aiElement = document.getElementById(aiId);
  if (!aiElement || aiElement.tagName.toLowerCase() !== config.tagNames.ai) return;

  (aiElement as any).send().catch(() => {});
}

export function registerAutoTrigger(): void {
  if (refCount++ === 0) {
    document.addEventListener("click", handleClick);
  }
}

export function unregisterAutoTrigger(): void {
  if (refCount <= 0) return;
  if (--refCount === 0) {
    document.removeEventListener("click", handleClick);
  }
}
