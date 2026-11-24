// Safe HTML templates. Every value interpolated into html`…` is escaped, unless it is itself an html`…`
// result (or raw(…) for markup the app writes). Data from the project files (GIS attributes, QA messages,
// asset IDs) can therefore never inject markup or script, even when the dashboard is hosted publicly.

export class SafeHTML {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

const ENT = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
export const esc = (v) => String(v ?? "").replace(/[&<>"'`]/g, (c) => ENT[c]);

function render(v) {
  if (v instanceof SafeHTML) return v.s;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v == null || v === false) return "";
  return esc(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += render(v) + strings[i + 1]; });
  return new SafeHTML(out);
}

/** Markup written by the app itself (never data). */
export const raw = (s) => new SafeHTML(String(s));

/** A CSS colour from data, or a neutral grey if it is not a plain colour value. */
export const cssColor = (c) => (/^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([\d\s.,%]+\))$/i.test(String(c ?? "")) ? c : "#9AA0A6");
