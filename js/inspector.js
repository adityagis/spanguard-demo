// Span inspector: live what-if for one span (temperature, wind) with profile chart, readouts and 3D curves.
import { prepareObjects, runSpan, groundZ, toProject, ampacity } from "./physics.js";

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const W = 520, H = 230, ML = 40, MR = 10, MT = 10, MB = 22;

export class Inspector {
  constructor(scene) {
    this.scene = scene;
    this.data = null;
    this.span = null;
    this.side = 1;
    this.pending = false;
    $("inspClose").addEventListener("click", () => this.close());
    $("tempSlider").addEventListener("input", () => this.schedule());
    $("windSlider").addEventListener("input", () => this.schedule());
    $("iceSlider").addEventListener("input", () => this.schedule());
    $("windSide").addEventListener("click", (ev) => {
      const b = ev.target.closest("button");
      if (!b) return;
      this.side = Number(b.dataset.side);
      $("windSide").querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      this.schedule();
    });
    document.querySelector(".presets").addEventListener("click", (ev) => {
      const b = ev.target.closest("button");
      if (b) this.preset(b.dataset.preset);
    });
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && this.span) this.close(); });
  }

  setData(whatif, clearance) {
    this.data = whatif;
    this.envs = clearance?.assumptions?.environments ?? {};
    this.close();
  }

  has(spanId) { return !!this.data?.[spanId]; }

  open(spanId) {
    const s = this.data?.[spanId];
    if (!s) return false;
    this.span = s;
    this.prep = prepareObjects(s);
    this.yc = s.wires.reduce((acc, w) => acc + w.y0 + w.k * s.length / 2, 0) / s.wires.length;
    const lowest = s.wires.filter((w) => w.type === "conductor")
      .reduce((m, w) => (this._zAt(w, s.length / 2) < this._zAt(m, s.length / 2) ? w : m));
    this.lowestId = lowest.id;
    $("inspTitle").textContent = s.span;
    const kv = Object.values(s.required)[0];
    $("inspSub").textContent = `${s.length.toFixed(0)} m span · ruling ${s.ruling.toFixed(0)} m · ${s.wires.length} wires · ` +
      `${s.conductors[lowest.cond].name} (${s.conductor_source === "GIS register" ? "from GIS" : "assumed"}) · voltage class ${s.required.voltage_class_kv} kV`;
    $("tempSlider").value = s.survey_temp_c;
    $("windSlider").value = 0;
    $("iceSlider").value = 0;
    $("inspector").hidden = false;
    document.body.classList.add("inspecting");
    this._drawStatic();
    this.update();
    return true;
  }

  close() {
    if (!this.span) return;
    this.span = null;
    $("inspector").hidden = true;
    document.body.classList.remove("inspecting");
    this.scene.clearLive();
  }

  preset(name) {
    if (!this.span) return;
    const e = this.envs;
    const map = {
      survey: [this.span.survey_temp_c, 0, 0],
      hot: [this.span.environments?.hot?.temp_c ?? (typeof e.hot?.temp_c === "number" ? e.hot.temp_c : 75), 0, 0],
      storm: [e.blowout?.temp_c ?? 15, e.blowout?.wind_pa ?? 500, 0],
      ice: [e.ice?.temp_c ?? 0, e.ice?.wind_pa ?? 0, e.ice?.ice_mm ?? 10],
    };
    const [t, p, ice] = map[name];
    $("tempSlider").value = t;
    $("windSlider").value = p;
    $("iceSlider").value = ice;
    this.schedule();
  }

  schedule() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.update(); });
  }

  _zAt(w, x) { return w.z0 + w.a * (Math.cosh((x - w.x0) / w.a) - 1); }

  // ----- chart scaffolding -----
  _scale() {
    const s = this.span;
    let zmin = Infinity, zmax = -Infinity;
    for (let x = 0; x <= s.length; x += 2) {
      const g = groundZ(s, x, this.yc);
      if (g != null) zmin = Math.min(zmin, g);
    }
    for (const w of s.wires) for (const x of [0, s.length / 2, s.length]) zmax = Math.max(zmax, this._zAt(w, x));
    for (const p of s.objects?.vegetation ?? []) { zmin = Math.min(zmin, p[2]); }
    zmin -= 2; zmax += 3;
    this.X = (x) => ML + (x / s.length) * (W - ML - MR);
    this.Z = (z) => MT + (1 - (z - zmin) / (zmax - zmin)) * (H - MT - MB);
    this.zr = [zmin, zmax];
  }

  _el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    (parent ?? this.svg).appendChild(e);
    return e;
  }

  _path(xs, zs) {
    let d = "";
    for (let i = 0; i < xs.length; i += 2) d += `${d ? "L" : "M"}${this.X(xs[i]).toFixed(1)},${this.Z(zs[i]).toFixed(1)}`;
    return d;
  }

  _drawStatic() {
    const s = this.span;
    this.svg = $("inspProfile");
    this.svg.innerHTML = "";
    this._scale();
    const [zmin, zmax] = this.zr;
    for (let x = 0; x <= s.length; x += 50) {
      this._el("line", { x1: this.X(x), y1: MT, x2: this.X(x), y2: H - MB, class: "grid" });
      this._el("text", { x: this.X(x), y: H - 7, class: "ax", "text-anchor": "middle" }).textContent = `${x} m`;
    }
    const zstep = zmax - zmin > 70 ? 20 : 10;
    for (let z = Math.ceil(zmin / zstep) * zstep; z < zmax; z += zstep) {
      this._el("line", { x1: ML, y1: this.Z(z), x2: W - MR, y2: this.Z(z), class: "grid" });
      this._el("text", { x: ML - 4, y: this.Z(z) + 3, class: "ax", "text-anchor": "end" }).textContent = `${z.toFixed(0)}`;
    }
    // ground under the line centre
    let pts = `${this.X(0)},${H - MB} `;
    for (let x = 0; x <= s.length; x += 1) {
      const g = groundZ(s, x, this.yc);
      if (g != null) pts += `${this.X(x).toFixed(1)},${this.Z(g).toFixed(1)} `;
    }
    pts += `${this.X(s.length)},${H - MB}`;
    this._el("polygon", { points: pts, class: "gnd" });
    // nearby vegetation and buildings (thinned for the chart)
    for (const [g, cls] of [["vegetation", "veg"], ["building", "bld"]]) {
      const arr = s.objects?.[g] ?? [];
      const step = Math.max(1, Math.floor(arr.length / 2500));
      for (let i = 0; i < arr.length; i += step) {
        const p = arr[i];
        if (Math.abs(p[1] - this.yc) > 15) continue;
        this._el("circle", { cx: this.X(p[0]).toFixed(1), cy: this.Z(p[2]).toFixed(1), r: 1.1, class: cls });
      }
    }
    // survey lowest conductor
    const w = s.wires.find((x) => x.id === this.lowestId);
    const xs = [], zs = [];
    for (let x = 0; x <= s.length; x += 1) { xs.push(x); zs.push(this._zAt(w, x)); }
    this._el("path", { d: this._path(xs, zs), class: "survey" });
    this.livePath = this._el("path", { d: "", class: "live" });
    this.limitPath = this._el("path", { d: "", class: "limit" });
    this.lead = this._el("line", { class: "lead" });
    this.leadT = this._el("text", { class: "leadt" });
  }

  update() {
    const s = this.span;
    if (!s) return;
    const t = Number($("tempSlider").value), p = Number($("windSlider").value);
    $("tempVal").textContent = `${t} °C`;
    $("windVal").textContent = p ? `${p} Pa (~${Math.round(Math.sqrt((2 * p) / 1.225) * 3.6)} km/h)` : "still air";
    const ice = Number($("iceSlider").value);
    $("iceVal").textContent = ice ? `${ice} mm` : "none";
    const r = runSpan(s, this.prep, t, p, this.side, ice);

    // chart
    const low = r.wires.find((w) => w.id === this.lowestId);
    this.livePath.setAttribute("d", this._path(low.xs, low.zs));
    this.livePath.setAttribute("class", p > 0 ? "live wind" : "live");
    const lim = Array.from(low.zs, (z) => z - s.required.ground);
    this.limitPath.setAttribute("d", this._path(low.xs, lim));
    const worst = Object.entries(r.clearance).sort((a, b) => a[1].margin - b[1].margin)[0];
    if (worst) {
      const [g, c] = worst;
      const x = this.X(c.at[0]);
      this.lead.setAttribute("x1", x); this.lead.setAttribute("x2", x);
      this.lead.setAttribute("y1", this.Z(c.at[2])); this.lead.setAttribute("y2", this.Z(c.obj[2]));
      this.leadT.setAttribute("x", x + 5);
      this.leadT.setAttribute("y", (this.Z(c.at[2]) + this.Z(c.obj[2])) / 2);
      this.leadT.textContent = `${c.d.toFixed(1)} m ${g}`;
    }

    // readouts
    const st = low.state;
    const cells = [
      ["Tension", `${(st.h / 1000).toFixed(1)} kN`, ""],
      ["Sag", `${st.sag.toFixed(2)} m`, ""],
      ...(() => {
        const cond = s.conductors[s.wires.find((w) => w.id === this.lowestId).cond];
        const amps = s.rating_weather ? ampacity(cond, t, s.rating_weather) : null;
        const air = s.rating_weather.ambient_c;
        return amps == null ? [] : [["Current (IEEE 738)", t <= air ? "—" : `${Math.round(amps)} A`,
          `<span class="m">${t <= air ? `wire not above ${air} °C air` : `to reach ${t} °C in ${air} °C air`}</span>`]];
      })(),
      ["Swing", `${st.swingDeg.toFixed(0)}°`, st.insulatorSwingDeg ? `<span class="m">string ${st.insulatorSwingDeg.toFixed(0)}°</span>` : ""],
    ];
    for (const g of ["vegetation", "building", "building_horizontal", "ground"]) {
      const c = r.clearance[g];
      if (!c) { if (g !== "building_horizontal") cells.push([g, "—", ""]); continue; }
      const cls = c.margin < 0 ? "neg" : c.margin < 1 ? "low" : "pos";
      cells.push([{ building: "building (vertical)", building_horizontal: "building (beside)" }[g] ?? g, `${c.d.toFixed(2)} m`, `<span class="m ${cls}">${c.margin >= 0 ? "+" : ""}${c.margin.toFixed(2)} m vs ${c.required} m</span>`]);
    }
    $("inspReadouts").innerHTML = cells.map(([k, v, m]) => `<div class="ro"><div class="k">${k}</div><div class="v">${v}</div>${m}</div>`).join("");

    const minMargin = Math.min(...Object.values(r.clearance).map((c) => c.margin));
    const v = $("inspVerdict");
    v.className = `verdict ${minMargin < 0 ? "fail" : minMargin < 1 ? "watch" : "pass"}`;
    v.textContent = minMargin < 0 ? `Fails by ${(-minMargin).toFixed(2)} m` : minMargin < 1 ? `Watch · +${minMargin.toFixed(2)} m` : `Passes · +${minMargin.toFixed(2)} m`;
    v.title = "Live browser estimate. The pipeline result (Clearance list, report) is authoritative.";
    const maxT = s.conductors[s.wires.find((w) => w.id === this.lowestId).cond].max_temp_c;
    $("inspNote").textContent = (t > maxT ? `Above the assumed conductor limit (${maxT} °C). ` : "") +
      `Live preview, ${r.ms.toFixed(0)} ms per update; within ~0.3 m of the pipeline result, which uses denser data and is authoritative.`;

    // 3D
    const wires3d = r.wires.map((w) => {
      const out = [];
      for (let i = 0; i < w.xs.length; i += 2) out.push(toProject(s, w.xs[i], w.ys[i], w.zs[i]));
      return out;
    });
    const leaders = Object.entries(r.clearance).map(([g, c]) => ({
      a: toProject(s, c.at[0], c.at[1], c.at[2]), b: toProject(s, c.obj[0], c.obj[1], c.obj[2]),
      label: `${c.d.toFixed(1)} m ${g}`, risk: c.margin < 0 ? "violation" : c.margin < 1 ? "watch" : "ok",
    }));
    this.scene.setLive(s.span, wires3d, p > 0, leaders);
  }
}
