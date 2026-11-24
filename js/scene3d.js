// 3D point-cloud scene. Z is up (east, north, up), matching the exported tiles.
import * as THREE from "three";
import { OrbitControls } from "../vendor/OrbitControls.js";
import { html, esc } from "./html.js";

const MAX_CLASSES = 16;
/** "blowout_left" → "Blowout left", "veg_low" → "Veg low": readable names for codes shown on screen. */
const humanize = (s) => { const t = String(s ?? "").replace(/[_:]+/g, " ").trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

const vertexShader = /* glsl */ `
  attribute vec3 rgb;
  attribute float cls;
  uniform int uMode;            // 0 class, 1 true colour, 2 height
  uniform vec3 uPalette[${MAX_CLASSES}];
  uniform float uVisible[${MAX_CLASSES}];
  uniform float uSizeBoost[${MAX_CLASSES}];
  uniform float uSize;          // world-space point size (m)
  uniform float uScale;         // px per world unit at distance 1
  uniform vec2 uZRange;
  varying vec3 vColor;

  vec3 heightRamp(float t) {
    // Calm blue → teal → sand → coral ramp.
    vec3 a = vec3(0.16, 0.38, 0.73), b = vec3(0.20, 0.66, 0.65),
         c = vec3(0.89, 0.80, 0.55), d = vec3(0.90, 0.42, 0.36);
    if (t < 0.33) return mix(a, b, t / 0.33);
    if (t < 0.66) return mix(b, c, (t - 0.33) / 0.33);
    return mix(c, d, (t - 0.66) / 0.34);
  }

  void main() {
    int k = int(cls + 0.5);
    float vis = uVisible[k];
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = vis > 0.5 ? clamp(uSize * uSizeBoost[k] * uScale / -mv.z, 1.0, 24.0) : 0.0;
    if (uMode == 0) vColor = uPalette[k];
    else if (uMode == 1) vColor = rgb;
    else vColor = heightRamp(clamp((position.z - uZRange.x) / (uZRange.y - uZRange.x), 0.0, 1.0));
    if (vis < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // clip hidden points
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard; // round points
    gl_FragColor = vec4(vColor, 1.0);
  }
`;

/** Principal horizontal direction of one class (the line corridor), via 2D PCA. */
function lineFrame(positions, classes, code) {
  let n = 0, mx = 0, my = 0, mz = 0;
  for (let i = 0; i < classes.length; i++) {
    if (classes[i] !== code) continue;
    mx += positions[i * 3]; my += positions[i * 3 + 1]; mz += positions[i * 3 + 2]; n++;
  }
  if (n < 50) return null;
  mx /= n; my /= n; mz /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < classes.length; i++) {
    if (classes[i] !== code) continue;
    const dx = positions[i * 3] - mx, dy = positions[i * 3 + 1] - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const axis = new THREE.Vector3(Math.cos(theta), Math.sin(theta), 0);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < classes.length; i++) {
    if (classes[i] !== code) continue;
    const t = (positions[i * 3] - mx) * axis.x + (positions[i * 3 + 1] - my) * axis.y;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  const mid = (lo + hi) / 2;
  const center = new THREE.Vector3(mx + axis.x * mid, my + axis.y * mid, mz - 8);
  return { center, axis, length: hi - lo };
}

export class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 20000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this.uniforms = {
      uMode: { value: 0 },
      uPalette: { value: Array.from({ length: MAX_CLASSES }, () => new THREE.Color(0x999999)) },
      uVisible: { value: new Array(MAX_CLASSES).fill(1) },
      uSizeBoost: { value: new Array(MAX_CLASSES).fill(1) },
      uSize: { value: 0.12 },
      uScale: { value: 1 },
      uZRange: { value: new THREE.Vector2(0, 1) },
    };
    this.points = null;
    this._fly = null;
    // On-screen labels: a master switch plus one switch per label kind. Measurement labels always show.
    this.labelsOn = true;
    this.labelPrefs = { towers: true, clearance: true, issues: true, risk: true };
    this.clearanceVisible = true;

    window.addEventListener("resize", () => this.resize());
    // Release the GPU context when leaving, so repeated reloads don't exhaust WebGL contexts.
    window.addEventListener("pagehide", () => this.renderer.dispose());
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    this.uniforms.uScale.value = (h * this.renderer.getPixelRatio()) / (2 * Math.tan(fov / 2));
  }

  setPalette(classes) {
    for (const [code, c] of Object.entries(classes)) {
      const k = Number(code);
      if (k < MAX_CLASSES) this.uniforms.uPalette.value[k] = new THREE.Color(c.color);
    }
  }

  setSizeBoost(code, factor) { this.uniforms.uSizeBoost.value[code] = factor; }
  setVisible(code, on) { this.uniforms.uVisible.value[code] = on ? 1 : 0; }
  setMode(mode) { this.uniforms.uMode.value = mode; }
  setPointSize(m) { this.uniforms.uSize.value = m; }

  /** Load a binary tile described by a manifest entry; reports progress 0..1. */
  async loadTile(url, meta, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
    const total = Number(res.headers.get("content-length")) || meta.bytes;
    const reader = res.body.getReader();
    const buf = new Uint8Array(meta.bytes);
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf.set(value, got);
      got += value.length;
      onProgress?.(got / total);
    }
    const n = meta.count;
    const L = meta.layout;
    const positions = new Float32Array(buf.buffer, L.positions[0], n * 3);
    const classes = new Uint8Array(buf.buffer, L.classes[0], n);
    const rgb8 = new Uint8Array(buf.buffer, L.rgb[0], n * 3);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setAttribute("cls", new THREE.BufferAttribute(Float32Array.from(classes), 1));
    geom.setAttribute("rgb", new THREE.BufferAttribute(rgb8, 3, true));
    geom.computeBoundingBox();

    if (this.points) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
    }
    const mat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader, fragmentShader });
    this.points = new THREE.Points(geom, mat);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    const bb = geom.boundingBox;
    this.uniforms.uZRange.value.set(bb.min.z, bb.max.z);
    this.bounds = bb;
    this.lineFrame = lineFrame(positions, classes, 2 /* conductor */) ?? null;
    this.resetView(false);
    return { count: n };
  }

  /** Dense corridor points for one span, drawn over the (thinned) overview; replaces the previous span's. */
  async loadDense(url, meta) {
    this.clearDense();
    const token = (this._denseToken = Symbol(url));
    const res = await fetch(url);
    if (!res.ok || token !== this._denseToken) return false;
    const buf = await res.arrayBuffer();
    if (token !== this._denseToken) return false; // the user moved on to another span meanwhile
    const n = meta.count, L = meta.layout;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(buf, L.positions[0], n * 3), 3));
    geom.setAttribute("cls", new THREE.BufferAttribute(Float32Array.from(new Uint8Array(buf, L.classes[0], n)), 1));
    geom.setAttribute("rgb", new THREE.BufferAttribute(new Uint8Array(buf, L.rgb[0], n * 3), 3, true));
    this.dense = new THREE.Points(geom, this.points.material);
    this.dense.frustumCulled = false;
    this.scene.add(this.dense);
    return true;
  }

  clearDense() {
    this._denseToken = null;
    if (!this.dense) return;
    this.scene.remove(this.dense);
    this.dense.geometry.dispose();
    this.dense = null;
  }

  /** Fitted network model: wires as thin tubes, towers as floating labels. */
  setModel(model, labelLayer) {
    if (this.modelGroup) {
      this.scene.remove(this.modelGroup);
      this.modelGroup.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    }
    this.modelGroup = new THREE.Group();
    this.wireMeshes = new Map();
    this.labels?.forEach((l) => l.el.remove());
    this.labels = [];
    if (!model) return;

    const colors = { conductor: 0x0a84ff, earth_wire: 0x30b0c7 };
    for (const span of model.spans) {
      for (const w of span.wires) {
        const pts = span.polylines[w.id].map((p) => new THREE.Vector3(p[0], p[1], p[2]));
        if (pts.length < 2) continue;
        const curve = new THREE.CatmullRomCurve3(pts);
        const geom = new THREE.TubeGeometry(curve, Math.min(pts.length * 2, 600), 0.09, 6, false);
        const mat = new THREE.MeshBasicMaterial({ color: colors[w.type] ?? 0x0a84ff });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.userData = { span: span.id, wire: w.id };
        this.modelGroup.add(mesh);
        this.wireMeshes.set(w.id, mesh);
      }
    }
    for (const t of model.towers) {
      const el = document.createElement("div");
      el.className = "tag tower";
      el.title = `Tower ${t.id}${t.structure ? ` · ${t.structure}` : ""} · ${t.height.toFixed(1)} m tall`;
      el.innerHTML = html`<b>${t.id}</b><span>${t.height.toFixed(1)} m</span>`;
      labelLayer.appendChild(el);
      this.labels.push({ el, kind: "towers", pos: new THREE.Vector3(...t.local_top).add(new THREE.Vector3(0, 0, 4)) });
    }
    this.scene.add(this.modelGroup);
  }

  /** QA overlay: issue pins plus GIS tower records linked to the LiDAR towers they match. */
  setQA(qa, model, labelLayer, onPinClick) {
    if (this.qaGroup) {
      this.scene.remove(this.qaGroup);
      this.qaGroup.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    }
    this.qaLabels?.forEach((l) => l.el.remove());
    this.qaLabels = [];
    this.qaGroup = new THREE.Group();
    if (!qa) return;

    for (const issue of qa.issues) {
      if (!issue.local) continue;
      const el = document.createElement("button");
      el.type = "button";
      el.className = `tag pin ${esc(issue.severity)}`;
      el.dataset.issue = issue.id;
      el.title = `${issue.id} · ${issue.message}`;
      el.innerHTML = html`<b>${issue.object}</b><span>${humanize(issue.check)}</span>`;
      el.addEventListener("click", () => onPinClick?.(issue.id));
      labelLayer.appendChild(el);
      // Tower-level issues sit at the tower top, where the tower label already is: drop them lower.
      const dz = /^(tower|gis)/.test(issue.check) ? -9 : 2;
      this.qaLabels.push({ el, kind: "issues", pos: new THREE.Vector3(...issue.local).add(new THREE.Vector3(0, 0, dz)), issue: issue.id });
    }

    const gis = qa.gis;
    if (gis?.towers) {
      const ringMat = new THREE.MeshBasicMaterial({ color: 0xff9f0a, side: THREE.DoubleSide });
      const byId = Object.fromEntries((model?.towers ?? []).map((t) => [t.id, t]));
      const matched = Object.fromEntries((gis.tower_match?.matches ?? []).map((m) => [m.gis, m]));
      for (const g of gis.towers) {
        if (g.local[2] == null) continue;
        const p = new THREE.Vector3(g.local[0], g.local[1], g.local[2] + 0.4);
        const ring = new THREE.Mesh(new THREE.RingGeometry(2.2, 2.9, 40), ringMat);
        ring.position.copy(p);
        this.qaGroup.add(ring);
        const m = matched[g.id];
        if (m && byId[m.lidar]) {
          const t = byId[m.lidar].local;
          const line = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([p, new THREE.Vector3(t[0], t[1], p.z)]),
            new THREE.LineDashedMaterial({ color: 0xff9f0a, dashSize: 0.6, gapSize: 0.4 }),
          );
          line.computeLineDistances();
          this.qaGroup.add(line);
          const el = document.createElement("div");
          el.className = "tag gis";
          el.title = `GIS tower record ${g.id}, ${m.offset_m.toFixed(2)} m from LiDAR tower ${m.lidar}`;
          el.innerHTML = html`<b>GIS</b><span>${m.offset_m.toFixed(1)} m offset</span>`;
          labelLayer.appendChild(el);
          this.qaLabels.push({ el, kind: "issues", pos: p.clone().add(new THREE.Vector3(0, 0, 1.5)) });
        }
      }
    }
    this.scene.add(this.qaGroup);
  }

  setQAVisible(on) {
    if (this.qaGroup) this.qaGroup.visible = on;
    this.qaLabels?.forEach((l) => (l.hidden = !on));
  }

  /** Master label switch, and one switch per kind: towers, clearance, issues, risk. */
  setLabelsVisible(on) { this.labelsOn = on; }
  setLabelKindVisible(kind, on) { this.labelPrefs[kind] = on; }

  /** Clearance leaders (dashed line, end dot and distance label) for the current environment. */
  setClearanceVisible(on) {
    this.clearanceVisible = on;
    if (this.envGroup && !this.liveActive) this.envGroup.visible = on;
    this.clrLabels?.forEach((l) => (l.hidden = !on || this.liveActive));
  }

  activatePin(issueId) {
    this.qaLabels?.forEach((l) => l.el.classList.toggle("active", !!issueId && l.issue === issueId));
  }

  /** Glide to look at a point from a comfortable distance, keeping the current viewing direction. */
  flyToPoint(local, distance = 70) {
    const target = new THREE.Vector3(...local);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.z < 0.25) dir.z = 0.35;
    dir.normalize();
    this.flyTo(target.clone().addScaledVector(dir, distance), target);
  }

  /** Clearance overlay for one environment: simulated wires + worst-clearance leader per span. */
  setClearance(clearance, curves, labelLayer) {
    this.clearance = clearance;
    this.curves = curves;
    this.clrLayer = labelLayer;
    this.setEnvironment(this.env ?? "survey");
  }

  setEnvironment(env) {
    this.env = env;
    if (this.envGroup) {
      this.scene.remove(this.envGroup);
      this.envGroup.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    }
    this.clrLabels?.forEach((l) => l.el.remove());
    this.clrLabels = [];
    this.envGroup = new THREE.Group();
    if (!this.clearance) return;

    const envColor = { hot: 0xff9f0a, ice: 0x32ade6, blowout_left: 0xaf52de, blowout_right: 0xaf52de };
    const riskColor = { ok: 0x1f9e6e, watch: 0xe8930c, violation: 0xc2334d, unknown: 0x7d8a86, partial: 0x7d8a86 };
    const simulated = env !== "survey";
    // Survey wires fade when a simulated environment is shown, so the change reads clearly.
    this.wireMeshes?.forEach((m) => { m.material.transparent = simulated; m.material.opacity = simulated ? 0.28 : 1; });

    for (const span of this.clearance.spans) {
      const byEnv = this.curves?.[span.span] ?? {};
      if (simulated && byEnv[env]) {
        for (const pts of Object.values(byEnv[env])) {
          const v = pts.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
          const geom = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(v), Math.min(v.length * 2, 400), 0.11, 6, false);
          this.envGroup.add(new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: envColor[env] ?? 0xff9f0a })));
        }
      }
      const c = span.environments[env] ?? (env === "survey" ? null : span.environments.survey);
      const w = c?.worst;
      if (!w) continue;
      const a = new THREE.Vector3(...w.at_local), b = new THREE.Vector3(...w.object_local);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]),
        new THREE.LineDashedMaterial({ color: riskColor[w.risk], dashSize: 0.5, gapSize: 0.3 }));
      line.computeLineDistances();
      this.envGroup.add(line);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.45, 12, 8), new THREE.MeshBasicMaterial({ color: riskColor[w.risk] }));
      dot.position.copy(b);
      this.envGroup.add(dot);
      const el = document.createElement("div");
      el.className = `tag clr ${esc(w.risk)}`;
      const margin = `${w.margin_m >= 0 ? "+" : ""}${w.margin_m.toFixed(1)} m`;
      el.title = `${span.span}: ${w.clearance_m.toFixed(2)} m to ${humanize(w.class).toLowerCase()} (${margin} margin) · ${humanize(env).toLowerCase()} conditions`;
      el.innerHTML = html`<b>${humanize(w.class)} ${w.clearance_m.toFixed(1)} m</b><span>${margin}</span>`;
      this.clrLayer.appendChild(el);
      this.clrLabels.push({ el, kind: "clearance", hidden: !this.clearanceVisible || this.liveActive, pos: a.clone().lerp(b, 0.5) });
    }
    this.envGroup.visible = this.clearanceVisible && !this.liveActive;
    this.scene.add(this.envGroup);
  }

  /** Live what-if overlay for one span (replaces the precomputed environment overlay for it). */
  setLive(spanId, wires, windy, leaders) {
    if (!this.liveGroup) {
      this.liveGroup = new THREE.Group();
      this.scene.add(this.liveGroup);
      this.liveMat = new THREE.MeshBasicMaterial({ color: 0xff9f0a });
    }
    this._disposeLive();
    this.liveActive = true;
    if (this.envGroup) this.envGroup.visible = false;
    this.clrLabels?.forEach((l) => (l.hidden = true));
    this.liveMat.color.set(windy ? 0xaf52de : 0xff9f0a);
    for (const pts of wires) {
      const v = pts.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
      if (v.length < 2) continue;
      const geom = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(v), Math.min(v.length, 240), 0.12, 6, false);
      this.liveGroup.add(new THREE.Mesh(geom, this.liveMat));
    }
    const riskColor = { ok: 0x1f9e6e, watch: 0xe8930c, violation: 0xc2334d };
    this.liveLabels = this.liveLabels ?? [];
    leaders.forEach((l, i) => {
      const a = new THREE.Vector3(...l.a), b = new THREE.Vector3(...l.b);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]),
        new THREE.LineBasicMaterial({ color: riskColor[l.risk] }));
      this.liveGroup.add(line);
      let lab = this.liveLabels[i];
      if (!lab) {
        const el = document.createElement("div");
        this.clrLayer.appendChild(el);
        lab = this.liveLabels[i] = { el, kind: "clearance", pos: new THREE.Vector3() };
      }
      lab.el.className = `tag clr live ${esc(l.risk)}`;
      lab.hidden = false;
      const [dist, , ...what] = l.label.split(" ");
      lab.el.title = `What-if: ${dist} m to ${what.join(" ")}`;
      lab.el.innerHTML = html`<b>${humanize(what.join("_"))} ${dist} m</b>`;
      lab.pos.copy(a).lerp(b, 0.5);
    });
    for (let i = leaders.length; i < this.liveLabels.length; i++) this.liveLabels[i].hidden = true;
    // fade the survey wires of this span
    this.wireMeshes?.forEach((m) => {
      const mine = m.userData.span === spanId;
      m.material.transparent = true;
      m.material.opacity = mine ? 0.3 : 0.15;
    });
  }

  _disposeLive() {
    if (!this.liveGroup) return;
    for (const o of [...this.liveGroup.children]) {
      this.liveGroup.remove(o);
      o.geometry?.dispose();
      if (o.material !== this.liveMat) o.material?.dispose();
    }
  }

  clearLive() {
    this._disposeLive();
    this.liveLabels?.forEach((l) => l.el.remove());
    this.liveLabels = [];
    this.liveActive = false;
    this.setEnvironment(this.env ?? "survey");
    this.highlightSpan(null);
  }

  setModelVisible(on) {
    if (this.modelGroup) this.modelGroup.visible = on;
    this.labels?.forEach((l) => (l.hidden = !on));
  }

  highlightSpan(spanId) {
    if (!this.wireMeshes) return;
    const simulated = this.env && this.env !== "survey";
    for (const m of this.wireMeshes.values()) {
      const on = !spanId || m.userData.span === spanId;
      m.material.transparent = !on || simulated;
      m.material.opacity = !on ? 0.15 : simulated ? 0.28 : 1;
    }
  }

  /** Glide the camera to look across one span. */
  flyToSpan(span) {
    const all = Object.values(span.polylines).flat();
    if (!all.length) return;
    const c = new THREE.Vector3();
    all.forEach((p) => c.add(new THREE.Vector3(p[0], p[1], p[2])));
    c.divideScalar(all.length);
    const axis = new THREE.Vector3(span.axis[0], span.axis[1], 0).normalize();
    let lo = Infinity, hi = -Infinity;
    for (const p of all) {
      const t = (p[0] - c.x) * axis.x + (p[1] - c.y) * axis.y;
      lo = Math.min(lo, t); hi = Math.max(hi, t);
    }
    const length = Math.max(hi - lo, 40);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    // Frame the span with room for the side panels (they cover ~40% of the width).
    // Side panels leave roughly the middle 55% of the width clear; fit the span (+15%) into that.
    const clear = window.innerWidth > 1100 ? 0.55 : 0.9;
    const r = (length * 1.15) / (2 * clear * Math.tan(fov / 2) * Math.max(this.camera.aspect, 0.6));
    let across = new THREE.Vector3(-axis.y, axis.x, 0);
    // View from the downhill side so the hillside does not block the camera.
    if (this.bounds) {
      const probe = c.clone().addScaledVector(across, -r * 0.5);
      const z = this._terrainZNear(probe);
      const z2 = this._terrainZNear(c.clone().addScaledVector(across, r * 0.5));
      if (z != null && z2 != null && z > z2) across.negate();
    }
    const target = c.clone().add(new THREE.Vector3(0, 0, -10));
    this.flyTo(c.clone().addScaledVector(across, -r * 0.9).add(new THREE.Vector3(0, 0, r * 0.38)), target);
  }

  /** Median height of overview points near an xy location (cheap terrain probe). */
  _terrainZNear(p, radius = 15) {
    const pos = this.points?.geometry.getAttribute("position");
    if (!pos) return null;
    const zs = [];
    const step = Math.max(1, Math.floor(pos.count / 200000));
    for (let i = 0; i < pos.count; i += step) {
      const dx = pos.getX(i) - p.x, dy = pos.getY(i) - p.y;
      if (dx * dx + dy * dy < radius * radius) zs.push(pos.getZ(i));
    }
    if (!zs.length) return null;
    zs.sort((a, b) => a - b);
    return zs[zs.length >> 1];
  }

  /** Nearest visible LiDAR point under the cursor (null if none within a few pixels). */
  pick(clientX, clientY) {
    if (!this.points) return null;
    const ndc = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    // Pick tolerance ~6 px at the orbit target distance, in metres.
    const dist = this.camera.position.distanceTo(this.controls.target);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    ray.params.Points.threshold = (6 * 2 * dist * Math.tan(fov / 2)) / window.innerHeight;
    const vis = this.uniforms.uVisible.value;
    const clsOf = (h) => Math.round(h.object.geometry.getAttribute("cls").getX(h.index));
    const targets = this.dense ? [this.dense, this.points] : [this.points];
    const hit = ray.intersectObjects(targets, false).find((h) => vis[clsOf(h)] > 0.5);
    if (!hit) return null;
    const p = hit.object.geometry.getAttribute("position");
    return { pos: new THREE.Vector3(p.getX(hit.index), p.getY(hit.index), p.getZ(hit.index)), cls: clsOf(hit) };
  }

  /** Draw (or clear, with null) the measurement: markers at each picked point and a line between two. */
  setMeasure(points, labelHtml) {
    if (!this.measureGroup) {
      this.measureGroup = new THREE.Group();
      this.measureGroup.renderOrder = 10;
      this.scene.add(this.measureGroup);
      const el = document.createElement("div");
      el.className = "tag measure";
      (this.clrLayer ?? document.getElementById("labelLayer")).appendChild(el);
      this.measureLabels = [{ el, kind: "measure", hidden: true, pos: new THREE.Vector3() }];
    }
    for (const o of [...this.measureGroup.children]) { this.measureGroup.remove(o); o.geometry?.dispose(); o.material?.dispose(); }
    const lab = this.measureLabels[0];
    lab.hidden = true;
    if (!points?.length) return;
    const dist = this.camera.position.distanceTo(this.controls.target);
    for (const v of points) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(Math.max(dist * 0.004, 0.08), 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xff375f, depthTest: false }));
      m.position.copy(v);
      this.measureGroup.add(m);
    }
    if (points.length === 2) {
      const [a, b] = points;
      const corner = new THREE.Vector3(b.x, b.y, a.z);
      const solid = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]),
        new THREE.LineBasicMaterial({ color: 0xff375f, depthTest: false }));
      const guide = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, corner, b]),
        new THREE.LineDashedMaterial({ color: 0xff375f, dashSize: 0.5, gapSize: 0.4, depthTest: false, transparent: true, opacity: 0.6 }));
      guide.computeLineDistances();
      this.measureGroup.add(solid, guide);
      lab.pos.copy(a).lerp(b, 0.5);
      lab.el.innerHTML = labelHtml;
      lab.hidden = false;
    }
  }

  /**
   * Risk layers: danger trees (trunk from base to top, plus a dashed fall line to the nearest wire),
   * wire clash pairs (the closest approach under differential loading) and work items (pins at each open
   * finding). Each layer is a group that can be toggled; a label click calls onPick(kind, id).
   */
  setRisk({ trees = [], clashes = [], work = [] }, labelLayer, onPick) {
    for (const g of Object.values(this.riskGroups ?? {})) {
      this.scene.remove(g);
      g.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    }
    this.riskLabels?.forEach((l) => l.el.remove());
    this.riskLabels = [];
    this.riskGroups = { trees: new THREE.Group(), clash: new THREE.Group(), work: new THREE.Group() };
    const col = { strike: 0xbf3989, violation: 0xbf3989, watch: 0xff9f0a, error: 0xbf3989, warn: 0xff9f0a, ok: 0x0a84ff };
    const V = (p) => new THREE.Vector3(p[0], p[1], p[2]);
    const label = (layer, kind, id, pos, inner, cls, title) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `tag pin risk ${esc(cls)}`;
      el.innerHTML = inner;
      el.title = title;
      el.addEventListener("click", () => onPick?.(kind, id));
      labelLayer.appendChild(el);
      this.riskLabels.push({ el, pos, layer, id, kind: "risk", hidden: true });
    };

    for (const t of trees) {
      const c = col[t.status] ?? col.watch;
      const base = V(t.base_local), top = V(t.top_local);
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, base.distanceTo(top), 8),
        new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85 }));
      trunk.position.copy(base).lerp(top, 0.5);
      trunk.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), top.clone().sub(base).normalize());
      this.riskGroups.trees.add(trunk);
      if (t.wire_local) {
        const fall = new THREE.Line(new THREE.BufferGeometry().setFromPoints([base, V(t.wire_local)]),
          new THREE.LineDashedMaterial({ color: c, dashSize: 0.8, gapSize: 0.5 }));
        fall.computeLineDistances();
        this.riskGroups.trees.add(fall);
      }
      label("trees", "tree", t.id, top.clone().add(new THREE.Vector3(0, 0, 1.5)),
        html`<b>Danger tree</b><span>${t.dist_to_wire_m} m to wire</span>`, t.status,
        `${t.id} · ${t.status} · ${t.height_m} m tall, ${t.dist_to_wire_m} m from the nearest wire`);
    }

    for (const p of clashes) {
      const a = V(p.at_local), b = V(p.other_local);
      const c = col[p.risk] ?? col.ok;
      this.riskGroups.clash.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]),
        new THREE.LineBasicMaterial({ color: c })));
      for (const v of [a, b]) {
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), new THREE.MeshBasicMaterial({ color: c }));
        m.position.copy(v);
        this.riskGroups.clash.add(m);
      }
      label("clash", "clash", p.id, a.clone().lerp(b, 0.5),
        html`<b>Wire clash ${p.gap_m} m</b><span>needs ${p.required_m} m</span>`, p.risk,
        `Wires ${p.a} and ${p.b} come within ${p.gap_m} m (required ${p.required_m} m) under ${p.case.replaceAll("_", " ")}. Click to open span ${p.id}.`);
    }

    for (const w of work) {
      label("work", "work", w.id, V(w.local).add(new THREE.Vector3(0, 0, 3)),
        html`<b>${humanize(w.kind.split(":")[0])}</b><span>${w.span ?? "Site"}</span>`, w.severity,
        `${w.id} · ${w.title ?? humanize(w.kind)}`);
    }
    for (const g of Object.values(this.riskGroups)) this.scene.add(g);
  }

  setRiskVisible(layer, on) {
    if (this.riskGroups?.[layer]) this.riskGroups[layer].visible = on;
    this.riskLabels?.forEach((l) => { if (l.layer === layer) l.hidden = !on; });
  }

  activateRisk(id) {
    this.riskLabels?.forEach((l) => l.el.classList.toggle("active", !!id && l.id === id));
  }

  /**
   * Place every label over its 3D anchor. Labels that would overlap a more important one are faded out
   * (selected > measurement > issue/risk pins > clearance > tower names), so the scene never shows a pile of text.
   */
  _updateLabels() {
    const all = [...(this.labels ?? []), ...(this.qaLabels ?? []), ...(this.clrLabels ?? []), ...(this.liveLabels ?? []),
      ...(this.riskLabels ?? []), ...(this.measureLabels ?? [])];
    if (!all.length) return;
    const w = window.innerWidth, h = window.innerHeight;
    const v = new THREE.Vector3();
    const RANK = { measure: 1, issues: 2, risk: 2, clearance: 3, towers: 4 };
    const shown = [];
    for (const l of all) {
      const on = !l.hidden && (l.kind === "measure" || (this.labelsOn && this.labelPrefs[l.kind] !== false));
      if (!on) { if (l.el.style.display !== "none") l.el.style.display = "none"; continue; }
      if (l.el.style.display === "none") l.el.style.display = "";
      v.copy(l.pos).project(this.camera);
      const x = ((v.x + 1) / 2) * w, y = ((1 - v.y) / 2) * h;
      l.el.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
      if (!(v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05)) { this._fade(l, false); continue; }
      const rank = l.el.classList.contains("active") ? 0 : RANK[l.kind] ?? 5;
      shown.push({ l, x, y, rank, depth: v.z });
    }
    shown.sort((a, b) => a.rank - b.rank || a.depth - b.depth);
    const placed = [];
    for (const s of shown) {
      const lw = s.l.el.offsetWidth, lh = s.l.el.offsetHeight;
      const r = [s.x - lw / 2 - 3, s.y - lh - 3, s.x + lw / 2 + 3, s.y + 3];
      const clash = placed.some((p) => r[0] < p[2] && r[2] > p[0] && r[1] < p[3] && r[3] > p[1]);
      this._fade(s.l, !clash);
      if (!clash) placed.push(r);
    }
  }

  _fade(l, on) {
    const o = on ? "1" : "0";
    if (l.el.style.opacity !== o) l.el.style.opacity = o;
    const pe = on && l.el.tagName === "BUTTON" ? "auto" : "none";
    if (l.el.style.pointerEvents !== pe) l.el.style.pointerEvents = pe;
  }

  resetView(animate = true) {
    if (!this.bounds) return;
    const bb = this.bounds;
    const size = bb.getSize(new THREE.Vector3());
    let target, pos, r;
    if (this.lineFrame) {
      // Look across the power line, slightly from above, so the spans read left to right.
      const { center, axis, length } = this.lineFrame;
      const across = new THREE.Vector3(-axis.y, axis.x, 0);
      const fov = THREE.MathUtils.degToRad(this.camera.fov);
      const aspect = Math.max(this.camera.aspect, 0.6);
      r = (length * 0.62) / (Math.tan(fov / 2) * aspect);
      target = center.clone();
      pos = center.clone().addScaledVector(across, -r * 0.82).add(new THREE.Vector3(0, 0, r * 0.42));
    } else {
      const center = bb.getCenter(new THREE.Vector3());
      r = Math.max(size.x, size.y) * 0.9;
      target = center.clone();
      pos = new THREE.Vector3(center.x + r * 0.55, center.y - r * 0.85, center.z + r * 0.6);
    }
    this.camera.near = Math.max(r / 2000, 0.05);
    this.camera.far = r * 20;
    this.camera.updateProjectionMatrix();
    if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      return;
    }
    this.flyTo(pos, target);
  }

  /** Smooth camera glide (depth through motion, not jumps). */
  flyTo(pos, target, ms = 900) {
    this._fly = {
      t0: performance.now(), ms,
      p0: this.camera.position.clone(), p1: pos,
      q0: this.controls.target.clone(), q1: target,
    };
  }

  tick() {
    if (this._fly) {
      const f = this._fly;
      const t = Math.min((performance.now() - f.t0) / f.ms, 1);
      const e = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(f.p0, f.p1, e);
      this.controls.target.lerpVectors(f.q0, f.q1, e);
      if (t >= 1) this._fly = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this._updateLabels();
  }
}
