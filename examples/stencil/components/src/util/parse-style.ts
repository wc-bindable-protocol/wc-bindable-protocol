export function parseStyle(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of css.split(";")) {
    const [k, ...rest] = rule.split(":");
    if (!k || rest.length === 0) continue;
    const prop = k.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[prop] = rest.join(":").trim();
  }
  return out;
}
