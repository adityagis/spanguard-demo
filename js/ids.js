// Client asset IDs in the viewer: the same translation as spanguard/ids.py.
// model.ids maps internal names (T01, T01-T02, L1) to the client's (TWR-4471, TWR-4471–TWR-4472, LN-220-07).
// relabel() rewrites IDs in values, dict keys and message text; file names ("file" keys) stay internal.

const SKIP = new Set(["file", "path", "url", "ids"]);

export function makeRelabel(ids) {
  const map = new Map();
  if (ids?.enabled) {
    for (const [k, v] of Object.entries(ids.towers ?? {})) map.set(k, v.display);
    for (const [k, v] of Object.entries(ids.spans ?? {})) map.set(k, v);
    for (const [k, v] of Object.entries(ids.lines ?? {})) map.set(k, v);
  }
  for (const [k, v] of [...map]) if (k === v) map.delete(k);
  if (!map.size) return (x) => x;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alt = [...map.keys()].sort((a, b) => b.length - a.length).map(esc).join("|");
  const re = new RegExp(`(?<![A-Za-z0-9_])(?:${alt})(?![A-Za-z0-9_])`, "g");
  const text = (s) => s.replace(re, (m) => map.get(m));
  const walk = (o) => {
    if (typeof o === "string") return text(o);
    if (Array.isArray(o)) return o.map(walk);
    if (o && typeof o === "object") {
      const out = {};
      for (const [k, v] of Object.entries(o)) out[text(k)] = SKIP.has(k) ? v : walk(v);
      return out;
    }
    return o;
  };
  return walk;
}
