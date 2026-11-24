// Browser port of SpanGuard's sag-tension and clearance maths (mirrors src/spanguard/physics + clearance).
// Span frame: x along the span (m), y across it (m), z height relative to the project origin (m).

/** Change of state: f(H2) = H2 − H1 + EA w1²L²/(24 H1²) + EA α Δt − EA w2²L²/(24 H2²) = 0 (monotonic in H2). */
export function stateChange(h1, t1, w1, t2, w2, L, ea, alpha) {
  const k1 = (ea * w1 * w1 * L * L) / (24 * h1 * h1);
  const c2 = (ea * w2 * w2 * L * L) / 24;
  const f = (h) => h - h1 + k1 + ea * alpha * (t2 - t1) - c2 / (h * h);
  let lo = 1, hi = Math.max(h1 * 50, 1e7);
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) > 0) hi = mid; else lo = mid;
  }
  return 0.5 * (lo + hi);
}

/** x0, z0 of the catenary with constant a through (xa, za) and (xb, zb). */
export function catenaryThrough(xa, za, xb, zb, a) {
  const L = xb - xa;
  const s = (zb - za) / (2 * a * Math.sinh(L / (2 * a)));
  const x0 = (xa + xb) / 2 - a * Math.asinh(s);
  const z0 = za - a * (Math.cosh((xa - x0) / a) - 1);
  return [x0, z0];
}

const surveyZ = (w, x) => w.z0 + w.a * (Math.cosh((x - w.x0) / w.a) - 1);
const surveyY = (w, x) => w.y0 + w.k * x;

const ICE_DENSITY = 915, G = 9.80665;

/** Simulate one wire; returns sampled points and its state. side = ±1 chooses the wind direction.
 *  Ice (radial mm) adds ρgπt(d+t) per metre and widens the wind area to d+2t. Suspension strings
 *  (wire.insulators = [start, end] lengths, 0 = strain) swing by ψ = atan(qL / (wL + W_ins/2)). */
export function simulateWire(span, wire, tempC, windPa, side = 1, step = 0.5, iceMm = 0) {
  const c = span.conductors[wire.cond];
  const L = span.length;
  const h1 = wire.a * c.w;
  const t = iceMm / 1000;
  const wv = c.w + ICE_DENSITY * G * Math.PI * t * (c.d + t);
  const q = windPa * (c.d + 2 * t);
  const w2 = Math.hypot(wv, q);
  const h2 = stateChange(h1, span.survey_temp_c, c.w, tempC, w2, span.ruling, c.ea, c.alpha);
  const a2 = h2 / w2;
  let za = surveyZ(wire, 0), zb = surveyZ(wire, L);
  let ya = surveyY(wire, 0), yb = surveyY(wire, L);
  const [la, lb] = wire.insulators ?? [0, 0];
  const psi = q > 0 ? Math.atan2(q * L, wv * L + (span.insulator_weight_n ?? 0) / 2) : 0;
  if (psi && (la || lb)) {
    ya += side * la * Math.sin(psi); yb += side * lb * Math.sin(psi);
    za += la * (1 - Math.cos(psi)); zb += lb * (1 - Math.cos(psi));
  }
  const [x0, z0] = catenaryThrough(0, za, L, zb, a2);
  const phi = Math.atan2(q, wv);
  const n = Math.floor(L / step) + 1;
  const xs = new Float64Array(n), ys = new Float64Array(n), zs = new Float64Array(n);
  let maxDepth = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.min(i * step, L);
    const zp = z0 + a2 * (Math.cosh((x - x0) / a2) - 1);
    const cz = za + ((zb - za) * x) / L;
    const cy = ya + ((yb - ya) * x) / L;
    const depth = cz - zp;
    maxDepth = Math.max(maxDepth, depth);
    xs[i] = x;
    zs[i] = cz - depth * Math.cos(phi);
    ys[i] = cy + side * depth * Math.sin(phi);
  }
  return { id: wire.id, type: wire.type, xs, ys, zs, state: { h: h2, a: a2, swingDeg: (phi * 180) / Math.PI, sag: maxDepth,
    insulatorSwingDeg: la || lb ? (psi * 180) / Math.PI : 0 } };
}

/** Pre-sort clearance objects by x so each wire sample only scans a window. */
export function prepareObjects(span) {
  const prep = {};
  for (const [g, pts] of Object.entries(span.objects ?? {})) {
    const sorted = pts.slice().sort((p, q) => p[0] - q[0]);
    const n = sorted.length;
    const X = new Float64Array(n), Y = new Float64Array(n), Z = new Float64Array(n);
    sorted.forEach((p, i) => { X[i] = p[0]; Y[i] = p[1]; Z[i] = p[2]; });
    prep[g] = { X, Y, Z, n };
  }
  return prep;
}

function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

export function groundZ(span, x, y) {
  const g = span.ground;
  const ix = Math.round((x - g.x0) / g.step), iy = Math.round((y - g.y0) / g.step);
  if (ix < 0 || iy < 0 || ix >= g.nx || iy >= g.ny) return null;
  return g.z[ix][iy];
}

/** Minimum clearance per object class over all wires, with the location of each minimum. */
export function clearances(span, prep, wires) {
  const out = {};
  for (const [g, o] of Object.entries(prep)) {
    if (g === "building") continue; // vertical + horizontal, below
    let best = Infinity, at = null, obj = null;
    for (const w of wires) {
      for (let i = 0; i < w.xs.length; i++) {
        const x = w.xs[i], y = w.ys[i], z = w.zs[i];
        const r = Math.min(best, 30);
        const r2 = r * r;
        for (let j = lowerBound(o.X, x - r); j < o.n && o.X[j] <= x + r; j++) {
          const dx = o.X[j] - x, dy = o.Y[j] - y, dz = o.Z[j] - z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < r2 && d2 < best * best) { best = Math.sqrt(d2); at = [x, y, z, w.id]; obj = [o.X[j], o.Y[j], o.Z[j]]; }
        }
      }
    }
    if (at) out[g] = { d: best, at, obj };
  }
  // Buildings (CEA Reg. 63): vertical clearance above parts within the horizontal clearance in plan, and
  // horizontal clearance to parts that reach within the vertical clearance; a part fails only inside both.
  const b = prep.building;
  if (b) {
    const V = span.required.building, H = span.required.building_horizontal ?? V;
    let bv = null, bh = null;
    for (const w of wires) {
      for (let i = 0; i < w.xs.length; i++) {
        const x = w.xs[i], y = w.ys[i], z = w.zs[i];
        const r = Math.max(H, Math.min(bh ? bh.d : 30, 30));
        for (let j = lowerBound(b.X, x - r); j < b.n && b.X[j] <= x + r; j++) {
          const h = Math.hypot(b.X[j] - x, b.Y[j] - y), v = z - b.Z[j];
          if (h < H && (!bv || v < bv.d)) bv = { d: v, at: [x, y, z, w.id], obj: [b.X[j], b.Y[j], b.Z[j]] };
          if (v < V && (!bh || h < bh.d)) bh = { d: h, at: [x, y, z, w.id], obj: [b.X[j], b.Y[j], b.Z[j]] };
        }
      }
    }
    if (bv) out.building = bv;
    if (bh) out.building_horizontal = bh;
  }
  // Ground: vertical clearance under each sample.
  let best = Infinity, at = null, obj = null;
  for (const w of wires) {
    for (let i = 0; i < w.xs.length; i++) {
      const gz = groundZ(span, w.xs[i], w.ys[i]);
      if (gz == null) continue;
      const d = w.zs[i] - gz;
      if (d < best) { best = d; at = [w.xs[i], w.ys[i], w.zs[i], w.id]; obj = [w.xs[i], w.ys[i], gz]; }
    }
  }
  if (at) out.ground = { d: best, at, obj };
  for (const [g, r] of Object.entries(out)) {
    r.required = span.required[g];
    r.margin = r.d - r.required;
  }
  return out;
}

/** Span frame → project-local viewer coordinates. */
export function toProject(span, x, y, z) {
  const [ax, ay] = span.axis;
  return [span.origin_xy[0] + x * ax - y * ay, span.origin_xy[1] + x * ay + y * ax, z];
}

export function runSpan(span, prep, tempC, windPa, side, iceMm = 0) {
  const t0 = performance.now();
  const wires = span.wires.map((w) => simulateWire(span, w, tempC, windPa, side, 0.5, iceMm));
  const cl = clearances(span, prep, wires);
  return { wires, clearance: cl, ms: performance.now() - t0 };
}

/** IEEE Std 738-2012 steady-state heat balance (mirrors src/spanguard/physics/ampacity.py).
 *  Returns the current (A) that holds a conductor of diameter d (m) at tC (°C) in weather wx. */
export function ampacity(cond, tC, wx) {
  if (!cond.r25) return null;
  const ta = wx.ambient_c, tf = (tC + ta) / 2, he = wx.elevation_m ?? 0, d = cond.d;
  const mu = (1.458e-6 * Math.pow(tf + 273, 1.5)) / (tf + 383.4);
  const rho = (1.293 - 1.525e-4 * he + 6.379e-9 * he * he) / (1 + 0.00367 * tf);
  const kf = 2.424e-2 + 7.477e-5 * tf - 4.407e-9 * tf * tf;
  const phi = (wx.wind_angle_deg * Math.PI) / 180;
  const kAngle = 1.194 - Math.cos(phi) + 0.194 * Math.cos(2 * phi) + 0.368 * Math.sin(2 * phi);
  const dt = Math.max(tC - ta, 0);
  const nRe = (d * rho * wx.wind_ms) / mu;
  const qc = Math.max(kAngle * (1.01 + 1.35 * Math.pow(nRe, 0.52)) * kf * dt, kAngle * 0.754 * Math.pow(nRe, 0.6) * kf * dt,
    3.645 * Math.sqrt(rho) * Math.pow(d, 0.75) * Math.pow(dt, 1.25));
  const qr = 17.8 * d * cond.emissivity * (Math.pow((tC + 273) / 100, 4) - Math.pow((ta + 273) / 100, 4));
  const qs = cond.absorptivity * wx.solar_w_m2 * d;
  const r = cond.r25 + ((cond.r75 - cond.r25) * (tC - 25)) / 50;
  const net = qc + qr - qs;
  return net > 0 ? Math.sqrt(net / r) : 0;
}
