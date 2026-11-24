// SpanGuard app shell: loads a project, wires up panels, drives the 3D scene.
// Every piece of project data reaches the page through html`…` (web/js/html.js), which escapes it.
import { Scene3D } from "./scene3d.js";
import { Inspector } from "./inspector.js";
import { Map2D } from "./map2d.js";
import { Measure } from "./measure.js";
import { makeRelabel } from "./ids.js";
import { html, raw, cssColor } from "./html.js";

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("en-IN");
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
// Compact layout (tablets and phones): details panel becomes a bottom sheet. Phones also start on the 2D map.
const small = () => window.matchMedia("(max-width: 1000px)").matches;
const phone = () => window.matchMedia("(max-width: 760px)").matches;
const runPath = new URLSearchParams(location.search).get("run") ?? "";
const workspaceRun = /^(?:[0-9a-f]{32}\/){2}[0-9a-f]{32}$/.test(runPath);
const embeddedRun = workspaceRun && window.parent !== window && new URLSearchParams(location.search).get("embed") === "1";
if (embeddedRun) {
  document.documentElement.dataset.theme = "dark";
  document.body.classList.add("embedded-network");
}
const dataRoot = workspaceRun ? `/results/${runPath}` : "data";

const LABELS = {
  unassigned: "Unassigned", tower: "Towers", conductor: "Conductors", structural_cable: "Structural cables",
  insulator: "Insulators", veg_high: "High vegetation", veg_low: "Low vegetation", veg_herb: "Grass / herbaceous",
  ground: "Ground", road: "Road", water: "Water", building: "Buildings", rail: "Railway",
};
// Thin features drawn slightly larger so they stay readable among dense terrain.
const SIZE_BOOST = { tower: 1.3, conductor: 2.0, structural_cable: 1.6, insulator: 1.6 };

// If WebGL is unavailable (old GPU driver, or the browser blocked it), keep the app usable:
// every 3D call becomes a no-op and the 2D map is shown instead.
let webglOK = true;
let scene;
try {
  scene = new Scene3D($("scene"));
} catch (err) {
  console.warn("3D disabled:", err);
  webglOK = false;
  scene = new Proxy({}, { get: (_, k) => (k === "env" ? undefined : () => {}) });
}
const inspector = new Inspector(scene);
const map2d = new Map2D($("map"), { externalBasemap: !workspaceRun });
const measure = webglOK ? new Measure(scene) : null;
if (!webglOK) $("measureBtn").hidden = true;
window.spanguard = { scene, inspector, map2d, measure }; // handy for inspection from the dev console

// ---------------------------------------------------------------- URL state (shareable deep links)
// #p=<project>&s=<span>&e=<environment>, e.g. …/#p=gridnet_t5b5&s=T01-T02&e=hot
const state = { p: null, s: null, e: null };
let restoring = false;
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  return { p: h.get("p"), s: h.get("s"), e: h.get("e") };
}
function writeHash() {
  if (restoring) return;
  const h = new URLSearchParams();
  for (const k of ["p", "s", "e"]) if (state[k]) h.set(k, state[k]);
  history.replaceState(null, "", `#${h}`);
}

function setView(view) {
  document.querySelectorAll("#viewMode button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.view === view)));
  document.body.classList.toggle("view-2d", view === "2d");
  if (view === "2d") { inspector.close(); measure?.toggle(false); map2d.show(); } else map2d.hide();
}

/** Fly to a span and, for full spans, open the live what-if inspector. */
function focusSpan(span, btn) {
  const list = $("spanList");
  list.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
  scene.highlightSpan(span.id);
  scene.flyToSpan(span);
  const dense = currentManifest?.spans?.[span.id];
  if (dense && currentBase) {
    scene.loadDense(`${currentBase}/tiles/${dense.file}`, dense)
      .then((ok) => ok && setStatusNote(`${span.id}: full-density points loaded (${compact.format(dense.count)})`))
      .catch(() => {});
  } else scene.clearDense?.();
  if (inspector.has(span.id)) inspector.open(span.id); else inspector.close();
  state.s = span.id;
  writeHash();
}

function focusSpanById(id) {
  const span = currentModel?.spans.find((x) => x.id === id);
  if (!span) return false;
  if (document.body.classList.contains("view-2d")) setView("3d");
  focusSpan(span, document.querySelector(`#spanList button[data-span="${CSS.escape(id)}"]`));
  return true;
}

function setStatusNote(text) {
  $("statusNote").textContent = text;
}

/** "gridnet_t5b6" → "GridNet T5B6", "1st_test__test" → "1st test test". */
function projectName(p) {
  const s = String(p ?? "");
  if (/^gridnet_/i.test(s)) return `GridNet ${s.slice(8).replace(/_+/g, " ").toUpperCase()}`;
  const t = s.replace(/_+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
const humanize = (s) => { const t = String(s ?? "").replace(/[_:]+/g, " ").trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function getOptionalJSON(url) {
  try { return await getJSON(url); } catch { return null; }
}

function setLoading(on, text, frac) {
  $("loading").classList.toggle("hidden", !on);
  if (text) $("loadingText").textContent = text;
  if (frac != null) $("loadingBar").style.width = `${Math.round(frac * 100)}%`;
}

function renderMeta(manifest, audit) {
  const e = audit.bounds.extent_m;
  const item = (k, v, title = "") => html`<div title="${title}"><dt>${k}</dt><dd>${v}</dd></div>`;
  $("projectMeta").innerHTML = html`${item("LiDAR points", compact.format(audit.points), `${fmt.format(audit.points)} points in the survey`)}
    ${item("Area", `${Math.round(e[0])} × ${Math.round(e[1])} m`, "Survey extent")}
    ${item("Shown in 3D", compact.format(manifest.overview.count), "A thinned overview; dense points load per span")}
    ${item("CRS", manifest.crs ?? "Not set", "Coordinate reference system")}`;
  if (workspaceRun) {
    $("projectTitle").hidden = false;
    $("projectTitle").textContent = projectName(manifest.project);
  }
  setStatusNote("");
}

function renderLayers(manifest, audit) {
  const counts = Object.fromEntries(audit.classes.map((c) => [c.name, c.points]));
  const list = $("layerList");
  list.innerHTML = "";
  for (const [code, c] of Object.entries(manifest.classes)) {
    if (!counts[c.name]) continue;
    scene.setSizeBoost(Number(code), SIZE_BOOST[c.name] ?? 1);
    scene.setVisible(Number(code), true);
    list.appendChild(switchRow(`layer-${c.name}`, c.color, LABELS[c.name] ?? c.name, compact.format(counts[c.name]),
      (on) => scene.setVisible(Number(code), on)));
  }
}

const kpi = (value, unit, label, cls = "") => html`<div class="kpi ${cls}"><div class="v">${value}<span class="u">${unit}</span></div><div class="k">${label}</div></div>`;

function renderAudit(audit) {
  const d = audit.density_pts_per_m2;
  $("kpis").innerHTML = html`${kpi(compact.format(audit.points), "", "LiDAR points")}${kpi((audit.footprint_area_m2 / 10000).toFixed(1), "ha", "Footprint")}${kpi(fmt.format(d.median), "pts/m²", "Median density")}${kpi(audit.terrain_hole_pct.toFixed(1), "%", "Terrain holes")}`;

  const items = audit.warnings.length ? audit.warnings : [{ level: "ok", message: "No issues found in the data audit." }];
  const LEVEL = { info: "Info", warn: "Warning", error: "Error", ok: "OK" };
  $("warnings").innerHTML = html`${items.map((w) => html`<li><span class="badge ${w.level}">${LEVEL[w.level] ?? w.level}</span><span>${w.message}</span></li>`)}`;
  const STAGE = { ingest: "Read and classify LiDAR", export3d: "Build 3D overview", model: "Fit wires and towers", clearance: "Clearance analysis", qa: "Quality checks", report: "Reports and exports" };
  $("timings").innerHTML = html`${audit.timings.map((t) => html`<li><span>${STAGE[t.stage] ?? humanize(t.stage)}</span><span>${t.seconds.toFixed(1)} s</span>${t.points_per_s ? html`<span class="sub">${fmt.format(t.points_per_s)} points per second</span>` : ""}</li>`)}`;
}

function switchRow(id, color, label, count, onChange, checked = true, title = "") {
  const li = document.createElement("li");
  li.title = title;
  li.innerHTML = html`
    <span class="dot" style="background:${cssColor(color)}"></span>
    <label for="${id}">${label}</label>
    <span class="count">${count}</span>
    <span class="switch"><input type="checkbox" id="${id}" ${checked ? raw("checked") : ""} aria-label="Show ${label}"><span></span></span>`;
  li.querySelector("input").addEventListener("change", (ev) => onChange(ev.target.checked));
  return li;
}

// ---------------------------------------------------------------- labels in the 3D scene
const LABEL_KINDS = [
  ["towers", "Tower names", "#7B8885", "Tower ID and height above each tower"],
  ["clearance", "Clearance distances", "#12614f", "Closest distance from the wire to ground, trees or buildings, per span"],
  ["issues", "Issue pins", "#d4860b", "Data quality issues and GIS offsets"],
  ["risk", "Risk pins", "#bf3953", "Danger trees, wire clash and work items"],
];

function renderLabelLayers() {
  const list = $("labelLayers");
  list.innerHTML = "";
  for (const [kind, label, color, title] of LABEL_KINDS) {
    list.appendChild(switchRow(`label-${kind}`, color, label, "", (on) => scene.setLabelKindVisible(kind, on), scene.labelPrefs?.[kind] !== false, title));
  }
  syncLabelsButton();
}

function setLabelsOn(on) {
  scene.setLabelsVisible(on);
  syncLabelsButton();
}

function syncLabelsButton() {
  const on = scene.labelsOn !== false;
  const b = $("labelsBtn");
  b.setAttribute("aria-pressed", String(on));
  b.title = on ? "Hide all labels (L)" : "Show labels (L)";
  $("labelLayers").classList.toggle("muted-list", !on);
}

function renderModel(model) {
  const layers = $("modelLayers");
  layers.innerHTML = "";
  scene.setModel(model, $("labelLayer"));
  if (!model) {
    $("modelKpis").innerHTML = "";
    $("spanList").innerHTML = html`<li style="color:var(--text-2)">Run <code>spanguard model</code> to build the network model.</li>`;
    return;
  }
  const s = model.summary;
  layers.appendChild(switchRow("layer-model", "#0A84FF", "Fitted wires & towers", s.wires, (on) => scene.setModelVisible(on), true,
    "Wire curves fitted to the LiDAR points, with tower labels"));

  $("modelKpis").innerHTML = html`${kpi(s.towers, "", "Towers")}${kpi(s.wires, "", `Wires (${s.conductors} conductor, ${s.earth_wires} earth)`)}${kpi(Math.round(s.line_length_m), "m", "Line length (full spans)")}${kpi((s.rmse_median_m * 100).toFixed(1), "cm", "Wire fit error (median)")}`;

  const list = $("spanList");
  list.innerHTML = "";
  for (const span of model.spans) {
    const rm = span.wires.map((w) => w.rmse_m).filter((v) => v != null);
    const cov = Math.min(...span.wires.map((w) => w.coverage ?? 0));
    const sag = span.wires.map((w) => w.sag_m).filter((v) => v != null);
    const where = span.line ? `${span.line}${span.section ? ` · ${span.section}` : ""} · ` : "";
    const li = document.createElement("li");
    li.dataset.asset = `${span.id} ${span.line ?? ""}`;
    li.innerHTML = html`<button type="button" aria-pressed="false" title="${span.kind === "full" ? "Fly to this span and open the live what-if" : "Fly to this span (cut by the survey edge)"}">
      <span class="sid">${span.id}</span>
      <span class="kind">${where}${span.kind === "full" ? `${span.length_m.toFixed(0)} m` : "Survey edge"}</span>
      <span class="sub">${span.wires.length} wires${sag.length ? ` · sag ${Math.min(...sag).toFixed(1)}–${Math.max(...sag).toFixed(1)} m` : ""} · fit ≤ ${(Math.max(...rm) * 100).toFixed(1)} cm · ${(cov * 100).toFixed(0)}% captured</span></button>`;
    const btn = li.querySelector("button");
    btn.dataset.span = span.id;
    btn.addEventListener("click", () => {
      if (document.body.classList.contains("view-2d") && map2d.focusAsset("span", span.id)) return;
      if (btn.getAttribute("aria-pressed") === "true") {
        btn.setAttribute("aria-pressed", "false");
        inspector.close();
        scene.resetView(true);
        state.s = null;
        writeHash();
        return;
      }
      focusSpan(span, btn);
    });
    list.appendChild(li);
  }
}

function renderTowers(model) {
  const list = $("towerList");
  list.innerHTML = "";
  for (const t of model?.towers ?? []) {
    const li = document.createElement("li");
    li.dataset.asset = `${t.id} ${t.line ?? ""}`;
    li.innerHTML = html`<button class="tower-focus" type="button" aria-label="Locate tower ${t.id}" title="Fly to tower ${t.id}">
      <span class="tid">${t.id}</span><span class="type">${humanize(t.structure ?? "")}</span>
      <span class="h">${t.height.toFixed(1)} m</span>
      <span class="sub">Line angle ${t.line_angle_deg == null ? "—" : `${t.line_angle_deg.toFixed(1)}°`} · lean ${t.lean_deg == null ? "—" : `${t.lean_deg.toFixed(1)}°`} · base ${t.footprint_m.toFixed(1)} m</span></button>`;
    li.querySelector("button").onclick = () => {
      if (document.body.classList.contains("view-2d") && map2d.focusAsset("tower", t.id)) return;
      if (t.local_top) scene.flyToPoint(t.local_top, 50);
    };
    list.appendChild(li);
  }
}

function filterAssets() {
  const query = $("assetSearch").value.trim().toLowerCase();
  let count = 0;
  for (const item of document.querySelectorAll("#spanList [data-asset], #towerList [data-asset], #clearList [data-asset]")) {
    item.hidden = !item.dataset.asset.toLowerCase().includes(query);
    if (!item.hidden && item.parentElement.id !== "clearList") count++;
  }
  const status = $("assetSearchStatus");
  status.hidden = !query;
  status.textContent = count ? `${count} matching ${count === 1 ? "asset" : "assets"}` : "No span or tower matches this search.";
}

const SEV_LABEL = { error: "Error", warn: "Warning", info: "Info" };
let qaFilter = "all";

function selectIssue(id, fly = true) {
  const btns = document.querySelectorAll("#issueList .issue");
  btns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.issue === id)));
  scene.activatePin(id);
  const issue = currentQA?.issues.find((i) => i.id === id);
  if (fly && issue?.local) scene.flyToPoint(issue.local, issue.check.startsWith("gis") || issue.check.startsWith("tower") ? 80 : 60);
  document.querySelector(`#issueList .issue[data-issue="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function renderIssues() {
  const list = $("issueList");
  list.innerHTML = "";
  const issues = (currentQA?.issues ?? []).filter((i) => qaFilter === "all" || i.severity === qaFilter);
  if (!issues.length) {
    list.innerHTML = html`<li class="empty-row">${currentQA?.issues?.length ? "No checks at this severity." : "All data quality checks passed."}</li>`;
    return;
  }
  for (const i of issues) {
    const li = document.createElement("li");
    li.innerHTML = html`<button type="button" class="issue" aria-pressed="false" title="Show in 3D">
      <span class="row"><span class="badge ${i.severity}">${SEV_LABEL[i.severity] ?? i.severity}</span><span class="obj">${i.object}</span><span class="iid">${humanize(i.check)}</span></span>
      <span class="msg">${i.message}</span>
      <span class="fix"><b>Next step</b> ${i.suggestion.replace(/^Check in 3D:\s*/i, "Check in 3D: ")}</span></button>`;
    const btn = li.querySelector("button");
    btn.dataset.issue = i.id;
    btn.addEventListener("click", () => selectIssue(i.id));
    list.appendChild(li);
  }
}

// ---------------------------------------------------------------- findings, work items and risk layers
const OPEN_SEV = ["violation", "strike", "error", "watch", "warn"];
const FINDING_SEV = { violation: "Violation", strike: "Strike risk", error: "Error", watch: "Watch", warn: "Warning" };
let currentFindings = null;

function findingLocal(f) {
  const o = currentManifest?.origin;
  return o && f.x != null ? [f.x - o[0], f.y - o[1], f.z - o[2]] : null;
}

function selectFinding(id, fly = true) {
  document.querySelectorAll("#findingsBox .row[data-fid]").forEach((r) => r.classList.toggle("sel", r.dataset.fid === id));
  scene.activateRisk(id);
  const f = currentFindings?.findings.find((x) => x.id === id);
  const at = f && findingLocal(f);
  if (fly && at) {
    if (document.body.classList.contains("view-2d")) setView("3d");
    scene.flyToPoint(at, 45);
  }
  document.querySelector(`#findingsBox .row[data-fid="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/** Findings with stable IDs; status changes made here download as a CSV for `spanguard status --from`. */
function renderFindings(data, project) {
  currentFindings = data;
  const box = $("findingsBox");
  if (!data?.findings?.length) {
    box.innerHTML = html`<div class="row muted">${data ? "No findings in this run." : "Findings are written by spanguard report."}</div>`;
    return;
  }
  const edits = new Map();
  const visible = data.findings.filter((f) => !f.hidden && OPEN_SEV.includes(f.severity));
  if (workspaceRun) {
    const [projectId, surveyId, runId] = runPath.split("/");
    const target = embeddedRun ? raw('target="_top"') : "";
    box.innerHTML = html`${visible.map(f => html`<div class="row finding" data-fid="${f.id}">
        <span class="finding-top"><span class="badge ${f.severity}">${FINDING_SEV[f.severity] ?? humanize(f.severity)}</span><span class="fspan">${f.span ?? "Site"}</span></span>
        <span class="ftitle">${f.title}</span>
        ${findingLocal(f) ? html`<button type="button" class="dl show" data-fid="${f.id}">Show in 3D</button>` : ""}</div>`)}
      <a class="cta" ${target} href="/workspace.html?project=${projectId}&amp;survey=${surveyId}&amp;run=${runId}#findings">Review findings and record decisions <span aria-hidden="true">→</span></a>`;
    box.querySelectorAll("button.show").forEach((button) => button.onclick = () => selectFinding(button.dataset.fid));
    return;
  }
  const opts = (cur) => data.statuses.map((s) => html`<option value="${s}" ${s === cur ? raw("selected") : ""}>${s.replaceAll("_", " ")}</option>`);
  const rows = visible.map((f) => html`<div class="row" data-fid="${f.id}"><b>${f.id}</b> · ${f.kind.replaceAll("_", " ")}${f.span ? ` · ${f.span}` : ""}
    <select data-fid="${f.id}" aria-label="Status of ${f.id}">${opts(f.status)}</select>${findingLocal(f) ? html` <button type="button" class="dl show" data-fid="${f.id}">Show</button>` : ""}<br>
    <span class="muted">${f.title}</span>${f.flag ? html`<br><span class="flag">${f.flag}</span>` : ""}</div>`);
  const hidden = data.summary?.hidden ?? 0;
  rows.push(html`<div class="row muted">${visible.length} open item(s)${hidden ? `, ${hidden} hidden as false positive` : ""}${data.run_id ? ` · run ${data.run_id}` : ""}.
    Change a status, then <button type="button" class="dl" id="statusDl">Download status CSV</button> and run
    <code>spanguard status --config … --from &lt;file&gt;</code>.</div>`);
  box.innerHTML = rows.join("");
  box.querySelectorAll("select").forEach((sel) => sel.addEventListener("change", () => edits.set(sel.dataset.fid, sel.value)));
  box.querySelectorAll("button.show").forEach((b) => b.addEventListener("click", () => selectFinding(b.dataset.fid)));
  $("statusDl").addEventListener("click", () => {
    const lines = ["id,status,note,who,date"];
    const today = new Date().toISOString().slice(0, 10);
    for (const [id, st] of edits) lines.push(`${id},${st},,dashboard,${today}`);
    if (lines.length === 1) { setStatusNote("No status changed yet."); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
    a.download = `${project}_finding_status.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

/** Danger trees, wire clash pairs and open work items as 3D layers with switches. */
function renderRisk(clearance, findings) {
  const trees = clearance?.fall_in?.trees ?? [];
  const clashes = (clearance?.spans ?? [])
    .map((s) => s.clash?.worst && { ...s.clash.worst, id: s.span })
    .filter((p) => p && p.risk !== "ok");
  const work = (findings?.findings ?? [])
    .filter((f) => !f.hidden && OPEN_SEV.includes(f.severity) && !f.kind.startsWith("qa") && f.kind !== "danger_tree")
    .map((f) => ({ ...f, local: findingLocal(f) }))
    .filter((f) => f.local);
  scene.setRisk({ trees, clashes, work }, $("labelLayer"), (kind, id) => {
    if (kind === "clash") { focusSpanById(id); return; }
    switchTab("qa");
    selectFinding(id, false);
  });
  const layers = $("modelLayers");
  const add = (key, color, label, n, on, title) => {
    layers.appendChild(switchRow(`layer-risk-${key}`, color, label, n, (v) => scene.setRiskVisible(key, v), on, title));
    scene.setRiskVisible(key, on);
  };
  if (trees.length) add("trees", "#BF3953", "Danger trees", trees.length, true, "Trees that could fall onto a wire");
  if (clashes.length) add("clash", "#D4860B", "Wire clash", clashes.length, true, "Wire pairs that come too close when one swings in the wind");
  if (work.length) add("work", "#5E5CE6", "Work items", work.length, false, "Open findings that need a field visit or a decision");
}

function renderQA(qa, model) {
  currentQA = qa;
  scene.setQA(qa, model, $("labelLayer"), (id) => { switchTab("qa"); selectIssue(id); });
  const pill = $("qaCount");
  if (!qa) { pill.textContent = ""; pill.hidden = true; return; }
  const s = qa.summary;
  pill.textContent = s.issues;
  pill.hidden = !s.issues;
  pill.className = `pill ${s.error ? "error" : s.warn ? "warn" : ""}`;
  $("qaKpis").innerHTML = html`${kpi(s.error, "", "Errors", s.error ? "sev-error" : "")}${kpi(s.warn, "", "Warnings", s.warn ? "sev-warn" : "")}${kpi(s.info, "", "Info", s.info ? "sev-info" : "")}`;

  const filters = $("qaFilters");
  filters.innerHTML = "";
  for (const f of ["all", "error", "warn", "info"]) {
    const b = document.createElement("button");
    b.className = "chip";
    b.type = "button";
    b.textContent = f === "all" ? `All ${s.issues}` : `${SEV_LABEL[f]} ${s[f]}`;
    b.setAttribute("aria-pressed", String(f === qaFilter));
    b.addEventListener("click", () => {
      qaFilter = f;
      filters.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === b)));
      renderIssues();
    });
    filters.appendChild(b);
  }
  renderIssues();

  const g = qa.gis ?? {};
  const box = $("gisSummary");
  if (g.error || !g.tower_match) {
    box.innerHTML = html`<div class="row muted">${g.error ? `GIS unavailable: ${g.error}` : "No GIS register was added to this survey, so LiDAR towers are not compared with your asset records. Add a tower or line register to the survey to enable this check."}</div>`;
    return;
  }
  const m = g.tower_match;
  const rows = m.matches.map((x) =>
    html`<div class="row"><b>${x.lidar}</b> ↔ ${x.gis.replace("osm:n", "OSM node ")}<br><span class="muted">${x.offset_m.toFixed(2)} m offset · ${x.status}</span></div>`);
  for (const a of g.line_attributes ?? []) {
    if (!a.gis_line) continue;
    const kv = a.gis_voltage_kv ? `${a.gis_voltage_kv} kV` : "voltage n/a";
    const gisCount = a.gis_cables != null ? `${a.gis_cables} cables` : a.gis_circuits != null ? `${a.gis_circuits} circuits` : "?";
    const tick = a.cables_match === false || a.circuits_match === false ? "✗" : a.cables_match || a.circuits_match ? "✓" : "";
    const cond = a.gis_conductor_code ? ` · conductor ${a.gis_conductor_code}${a.conductor_known === false ? " (unknown code)" : ""}` : "";
    rows.push(html`<div class="row"><b>${a.span}</b> on ${a.gis_line.replace("osm:w", "OSM way ")}<br><span class="muted">${kv} · GIS ${gisCount} vs LiDAR ${a.lidar_conductors} conductors ${tick}${cond} · direction Δ ${a.direction_diff_deg.toFixed(1)}°</span></div>`);
  }
  for (const c of g.corrections ?? []) {
    rows.push(html`<div class="row"><b>${c.problem.replaceAll("_", " ")}</b> · ${c.gis_id ?? c.lidar_tower ?? ""}${c.field ? ` (${c.field})` : ""}<br><span class="muted">${c.action}</span></div>`);
  }
  rows.push(html`<div class="row muted">${m.gis_inside_coverage} GIS towers inside LiDAR coverage, ${m.gis_outside_coverage} outside. Missing in GIS: ${m.missing_in_gis.length || "none"}. Missing in LiDAR: ${m.missing_in_lidar.length || "none"}.<br>Source: ${g.provenance?.source ?? "GIS"}${g.provenance?.fetched ? `, fetched ${g.provenance.fetched}` : ""}.</div>`);
  box.innerHTML = rows.join("");
}

// ---------------------------------------------------------------- downloads
// downloads.json is written by `spanguard report`; older outputs fall back to probing the usual files.
const KNOWN_FILES = [
  ["report.html", "Client report", "HTML, prints to PDF"],
  ["{project}_spanguard.xlsx", "Workbook", "Excel, live formulas"],
  ["trim_worklist.csv", "Work list", "CSV for Excel"],
  ["trim_worklist.kmz", "Work list", "KMZ for Google Earth"],
  ["network.geojson", "Network", "GeoJSON for QGIS / ArcGIS"],
  ["pls_cadd_points.csv", "Survey points", "CSV for PLS-CADD import"],
  ["gis_corrections.csv", "GIS corrections", "CSV, one fix per row"],
  ["qa_issues.csv", "QA issues", "CSV"],
  ["findings.csv", "Findings", "CSV with status"],
];

async function renderDownloads(base, project) {
  const box = $("downloads");
  box.innerHTML = html`<div class="row muted">Looking for files…</div>`;
  let items = (await getOptionalJSON(`${base}/downloads.json`))?.files;
  if (!items) {
    const probe = await Promise.all(KNOWN_FILES.map(async ([f, label, note]) => {
      const file = f.replace("{project}", project);
      try { return (await fetch(`${base}/${file}`, { method: "HEAD" })).ok ? { file, label, note } : null; } catch { return null; }
    }));
    items = probe.filter(Boolean);
  }
  if (!items.length) { box.innerHTML = html`<div class="row muted">No deliverables yet. Run <code>spanguard report</code>.</div>`; return; }
  const size = (b) => (b == null ? "" : b > 1e6 ? ` · ${(b / 1e6).toFixed(1)} MB` : ` · ${Math.max(1, Math.round(b / 1e3))} kB`);
  box.innerHTML = items.map((d) => html`<a class="row file" href="${`${base}/${d.file}`}" ${d.file.endsWith(".html") ? raw('target="_blank" rel="noopener"') : raw("download")}>
    <b>${d.label}</b><span class="muted">${d.note}${size(d.bytes)}</span><span class="fname">${d.file}</span></a>`).join("");
}

// ---------------------------------------------------------------- clearance
const RISK_LABEL = { ok: "Clear", watch: "Watch", violation: "Violation", partial: "Partial", unknown: "Unconfirmed" };
const RISK_HELP = {
  ok: "Every checked case keeps the required distance.",
  watch: "Within 1 m of the required distance in at least one case.",
  violation: "Closer than the required distance in at least one case.",
  partial: "Only some cases could be checked for this span.",
  unknown: "Distances were measured, but the pass/fail rule could not be confirmed (voltage or height reference not set).",
};
let currentClearance = null;

function envDescription(env) {
  const e = currentClearance?.assumptions.environments;
  if (!e) return "";
  if (env === "survey") return typeof e.survey.temp_c === "number" && !currentClearance.assumptions.survey_temp_method?.startsWith("derived")
    ? `${e.survey.temp_c} °C · as captured` : "as captured (per-span temperature)";
  if (env === "hot") return e.hot.temp_c === "max_operating" ? "conductor at max operating temperature · still air" : `${e.hot.temp_c} °C conductor · still air`;
  if (env === "ice") return e.ice ? `${e.ice.ice_mm} mm radial ice · ${e.ice.temp_c} °C` : "no ice case in this project";
  return `${e.blowout.wind_pa} Pa wind (~${Math.round(Math.sqrt((2 * e.blowout.wind_pa) / 1.225) * 3.6)} km/h) · ${e.blowout.temp_c} °C`;
}

function renderClearance(cl) {
  currentClearance = cl;
  const list = $("clearList");
  list.innerHTML = "";
  $("envBar").hidden = !cl;
  const pill = $("clrCount");
  if (!cl) {
    list.innerHTML = html`<li class="empty-row">No clearance results for this run.</li>`;
    $("clrKpis").innerHTML = "";
    $("clrNote").textContent = "";
    pill.hidden = true;
    return;
  }
  $("envDesc").textContent = envDescription(scene.env ?? "survey");

  const stateOf = (s) => ((!s.risk || s.risk === "ok") && s.assessment?.state !== "checked" ? s.assessment?.state ?? s.risk : s.risk);
  const states = cl.spans.map(stateOf);
  const nViol = states.filter((x) => x === "violation").length;
  const nWatch = states.filter((x) => x === "watch").length;
  const nUnk = states.filter((x) => x === "unknown" || x === "partial").length;
  // Wire clash, tower air gap and danger-tree strikes are separate checks from ground/object clearance.
  const otherFails = (s) => [s.clash?.worst?.margin_m < 0, s.air_gap?.worst && s.air_gap.worst.gap_m < s.air_gap.worst.required_m, s.fall_in?.strike > 0].filter(Boolean).length;
  const nOther = cl.spans.filter((s) => otherFails(s)).length;
  $("clrKpis").innerHTML = html`${kpi(nViol, "", "Clearance violations", nViol ? "sev-error" : "")}${kpi(nWatch, "", "Within 1 m (watch)", nWatch ? "sev-warn" : "")}${kpi(nOther, "", "Wire clash / air gap / tree", nOther ? "sev-error" : "")}`;
  const flagged = nViol + nOther;
  pill.textContent = flagged || nWatch || "";
  pill.hidden = !(flagged || nWatch);
  pill.className = `pill ${flagged ? "error" : nWatch ? "warn" : ""}`;
  $("clrNote").textContent = nUnk
    ? `${nUnk} of ${cl.spans.length} spans are "Unconfirmed": distances are measured, but the pass/fail rule needs the line voltage and the survey height reference. Set both in the survey settings. Wire clash and air-gap checks are shown in red where they fail.`
    : "Margin = measured distance minus the required distance, in the worst weather case. Click a span to inspect it.";
  const signed = (v, d = 1) => `${v >= 0 ? "+" : ""}${Number(v).toFixed(d)}`;

  for (const s of cl.spans) {
    const w = s.worst;
    const r = s.rating;
    const g = s.grow_in ?? {};
    const mc = s.monte_carlo;
    const cells = [];
    const cell = (k, v, title = "", bad = false) => cells.push(html`<div title="${title}" class="${bad ? "fail" : ""}"><span>${k}</span><b>${v}</b></div>`);
    cell("Closest object", w ? `${humanize(w.class)} · ${humanize(w.environment).toLowerCase()}` : "—", "The object and weather case with the smallest margin");
    cell("Required", w ? `${s.required_m[w.class].toFixed(1)} m${s.voltage_kv ? ` · ${s.voltage_kv} kV` : ""}` : "—",
      s.voltage_kv ? "Required distance for this voltage" : "Voltage not set: the default rule distance is used");
    if (r) {
      cell("Max temperature", r.temp_capped ? `≥ ${r.max_temp_c} °C` : r.max_temp_c == null ? "Fails" : `${r.max_temp_c} °C`, "Hottest conductor temperature that still keeps clearance");
      cell("Max wind", r.wind_capped ? `≥ ${r.max_wind_pa} Pa` : r.max_wind_pa == null ? "Fails" : `${r.max_wind_pa} Pa`, "Strongest wind that still keeps clearance");
    }
    cell("Tree grow-in", g.years_to_violation == null ? "None within 10 m" : g.growth_to_violation_m === 0 ? "Already inside" : `${g.years_to_violation} yr (+${g.growth_to_violation_m} m)`, "Years until nearby trees grow into the clearance zone");
    if (mc) cell("Uncertainty", `${(mc.p_violation * 100).toFixed(0)}% fail · ${Number(mc.margin_p5_m).toFixed(1)} to ${Number(mc.margin_p95_m).toFixed(1)} m`,
      `Monte Carlo: chance of a violation and the 5–95% margin range over ${mc.n} runs`);
    const cw = s.clash?.worst;
    if (cw) cell("Wire clash", `${cw.gap_m} m of ${cw.required_m} m`, `Closest wire-to-wire gap under differential wind (margin ${signed(cw.margin_m, 2)} m)`, cw.margin_m < 0);
    const ag = s.air_gap?.worst;
    if (ag) cell("Tower air gap", `${ag.gap_m} m of ${ag.required_m} m`, "Swung conductor to tower steel", ag.gap_m < ag.required_m);
    if (s.fall_in) cell("Danger trees", `${s.fall_in.strike} strike · ${s.fall_in.watch} watch`, "Trees that could fall onto a wire", s.fall_in.strike > 0);
    if (s.ampacity) cell("Current rating", `${s.ampacity.rating_a == null ? "None" : `${s.ampacity.rating_a} A`} · ${s.ampacity.limited_by}`, `Thermal limit ${s.ampacity.thermal_limit_a} A`);
    if (s.priority) cell("Priority", `#${s.priority.rank} of ${cl.spans.length}`, `Priority score ${s.priority.score}`);

    let hist = "";
    if (mc) {
      const max = Math.max(...mc.histogram, 1);
      hist = html`<span class="mc-wrap" title="Spread of the hot-case margin over ${mc.n} simulated runs; red bars are violations"><span class="mc-cap">Margin spread · ${mc.n} runs</span><span class="mc">${mc.histogram
        .map((h, i) => html`<i class="${mc.bin_edges_m[i + 1] <= 0 ? "neg" : ""}" style="height:${((h / max) * 100).toFixed(1)}%"></i>`)}</span></span>`;
    }
    const note = s.assessment?.limits?.join(" ") || s.note || r?.temp_note;
    const status = stateOf(s);
    const li = document.createElement("li");
    li.dataset.asset = s.span;
    const nf = otherFails(s);
    li.innerHTML = html`<button type="button" class="clear ${nf ? "violation" : status}" title="Open ${s.span} in 3D">
      <span class="top"><span class="sid">${s.span}</span><span class="badge ${status === "ok" ? "ok-risk" : status}" title="${RISK_HELP[status] ?? ""}">${RISK_LABEL[status] ?? "—"}</span>
        ${nf ? html`<span class="badge violation" title="Wire clash, tower air gap or danger-tree check fails">${nf} failing</span>` : ""}
        <span class="big">${w ? signed(w.margin_m) : "—"}<small>m margin</small></span></span>
      <span class="grid">${cells}</span>${hist}
      ${note ? html`<span class="note">${note}</span>` : ""}</button>`;
    li.querySelector("button").addEventListener("click", () => {
      const mspan = currentModel?.spans.find((x) => x.id === s.span);
      if (mspan && inspector.has(s.span)) {
        focusSpan(mspan, document.querySelector(`#spanList button[data-span="${CSS.escape(s.span)}"]`));
        const env = w?.environment ?? "survey";
        inspector.preset(env === "hot" ? "hot" : env === "ice" ? "ice" : env.startsWith("blowout") ? "storm" : "survey");
      } else if (w) {
        inspector.close();
        setEnvironment("survey");
        scene.flyToPoint(w.at_local.map((v, i) => (v + w.object_local[i]) / 2), 55);
      }
    });
    list.appendChild(li);
  }
}

function setEnvironment(env) {
  document.querySelectorAll("#envMode button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.env === env)));
  scene.setEnvironment(env);
  $("envDesc").textContent = envDescription(env);
  state.e = env === "survey" ? null : env;
  writeHash();
}

function switchTab(tab) {
  document.querySelectorAll("#rightTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  document.querySelectorAll(".side-right [data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== tab));
  document.querySelector(".side-right .tab-body").scrollTop = 0;
  if (small()) document.body.classList.add("panel-open");
}

let currentQA = null;
let currentModel = null;

async function loadProject(name) {
  setLoading(true, "Loading project…", 0);
  const base = `${dataRoot}/${encodeURIComponent(name)}`;
  currentBase = base;
  state.p = name;
  state.s = null;
  writeHash();
  scene.clearDense?.();
  inspector.close();
  const raw_ = await Promise.all([
    getJSON(`${base}/manifest.json`), getJSON(`${base}/audit.json`),
    getOptionalJSON(`${base}/model.json`), getOptionalJSON(`${base}/qa.json`),
    getOptionalJSON(`${base}/clearance.json`), getOptionalJSON(`${base}/curves.json`),
    getOptionalJSON(`${base}/whatif.json`),
  ]);
  // Client asset IDs (when a register was loaded) replace T01 / T01-T02 / L1 everywhere on screen.
  const relabel = makeRelabel(raw_[2]?.ids ?? raw_[3]?.ids);
  const [manifest, audit, model, qa, clearance, curves, whatif] = raw_.map((d) => (d ? relabel(d) : d));
  currentModel = model;
  currentManifest = manifest;
  // findings.json is written by `spanguard report` with display IDs already applied.
  const findingsP = getOptionalJSON(`${base}/findings.json`);
  getOptionalJSON(`${base}/network.geojson`).then((g) => map2d.setData(g));
  renderDownloads(base, name);
  inspector.setData(whatif, clearance);
  renderMeta(manifest, audit);
  renderLayers(manifest, audit);
  applyThemePalette();
  renderAudit(audit);
  setLoading(true, `Streaming ${fmt.format(manifest.overview.count)} points…`, 0);
  if (webglOK) {
    await scene.loadTile(`${base}/tiles/${manifest.overview.file}`, manifest.overview, (f) => setLoading(true, null, f));
  } else {
    setStatusNote("3D is unavailable: WebGL could not start in this browser, so the 2D map is shown. Restart the browser to re-enable 3D.");
    document.querySelector('#viewMode [data-view="3d"]').disabled = true;
    setView("2d");
  }
  renderModel(model);
  renderTowers(model);
  renderQA(qa, model);
  scene.setClearance(clearance, curves, $("labelLayer"));
  renderClearance(clearance);
  filterAssets();
  setEnvironment("survey");
  if (clearance) {
    scene.setClearanceVisible(true);
    $("modelLayers").appendChild(switchRow("layer-clearance", "#12614F", "Clearance leaders", clearance.spans.length, (on) => scene.setClearanceVisible(on), true,
      "Dashed line from each span's closest wire point to the nearest ground, tree or building, for the selected scenario"));
  }
  if (qa) $("modelLayers").appendChild(switchRow("layer-qa", "#D4860B", "Data quality & GIS", qa.summary.issues, (on) => scene.setQAVisible(on), true,
    "Pins for data quality issues, and GIS tower records with their offset from the LiDAR tower"));
  renderLabelLayers();
  const findings = await findingsP;
  renderFindings(findings, name);
  renderRisk(clearance, findings);
  setLoading(false);
  document.title = `${manifest.project} · SpanGuard`;
}

function wireControls() {
  $("assetSearch").addEventListener("input", filterAssets);
  const seg = $("colorMode");
  seg.addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    scene.setMode(Number(b.dataset.mode));
  });
  $("viewMode").addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (b) setView(b.dataset.view);
  });
  $("envMode").addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (b) setEnvironment(b.dataset.env);
  });
  $("rightTabs").addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (b) switchTab(b.dataset.tab);
  });
  $("pointSize").addEventListener("input", (ev) => scene.setPointSize(Number(ev.target.value)));
  $("resetView").addEventListener("click", () => scene.resetView(true));
  $("themeToggle").addEventListener("click", () => {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    syncThemeButton();
    applyThemePalette();
  });
  $("labelsBtn").addEventListener("click", () => setLabelsOn(scene.labelsOn === false));
  document.addEventListener("keydown", (ev) => {
    if (ev.target.closest?.("input, select, textarea") || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === "l" || ev.key === "L") setLabelsOn(scene.labelsOn === false);
  });
  const setAllClasses = (on) => document.querySelectorAll("#layerList input").forEach((input) => {
    if (input.checked !== on) { input.checked = on; input.dispatchEvent(new Event("change")); }
  });
  $("classesAll").addEventListener("click", () => setAllClasses(true));
  $("classesNone").addEventListener("click", () => setAllClasses(false));
  // The navigation hint fades away once the scene has been moved.
  $("scene").addEventListener("pointerdown", () => $("hint").classList.add("gone"), { once: true });
  // Keep 2D map controls below the project card, whatever its height.
  new ResizeObserver(() => document.documentElement.style.setProperty("--card-h", `${document.querySelector(".card-project").offsetHeight}px`))
    .observe(document.querySelector(".card-project"));
  $("panelToggle").addEventListener("click", () => {
    const open = document.body.classList.toggle("panel-open");
    $("panelToggle").setAttribute("aria-expanded", String(open));
  });
  $("projectSelect").addEventListener("change", (ev) => loadProject(ev.target.value).catch(showError));
  window.addEventListener("hashchange", () => openLink(readHash()).catch(showError));
}

/** Open what a shared link names: project, then environment and span. */
async function openLink(h) {
  restoring = true;
  try {
    if (h.p && h.p !== state.p && projectList.includes(h.p)) {
      $("projectSelect").value = h.p;
      await loadProject(h.p);
    }
    const env = h.e && document.querySelector(`#envMode [data-env="${CSS.escape(h.e)}"]`) ? h.e : "survey";
    if (env !== (state.e ?? "survey")) setEnvironment(env);
    if (h.s && h.s !== state.s) focusSpanById(h.s);
    else if (!h.s && state.s) {
      inspector.close();
      document.querySelectorAll("#spanList button").forEach((b) => b.setAttribute("aria-pressed", "false"));
      state.s = null;
    }
  } finally {
    restoring = false;
    writeHash();
  }
}
let projectList = [];

// Wires are near-black on light backgrounds; flip them to near-white in dark mode.
const DARK_OVERRIDES = { conductor: "#F5F5F7", structural_cable: "#C7C7CC", tower: "#AEB8C6" };
let currentManifest = null;
let currentBase = null;

function syncThemeButton() {
  const dark = document.documentElement.dataset.theme === "dark";
  $("themeToggle").setAttribute("aria-pressed", String(dark));
  $("themeToggle").title = dark ? "Light appearance" : "Dark appearance";
}

function applyThemePalette() {
  if (!currentManifest) return;
  const dark = document.documentElement.dataset.theme === "dark";
  const classes = structuredClone(currentManifest.classes);
  if (dark) for (const c of Object.values(classes)) if (DARK_OVERRIDES[c.name]) c.color = DARK_OVERRIDES[c.name];
  scene.setPalette(classes);
  measure?.setClassNames(Object.fromEntries(Object.entries(classes).map(([k, c]) => [Number(k), (LABELS[c.name] ?? c.name.replace(/_/g, " ")).toLowerCase()])));
  document.querySelectorAll("#layerList li").forEach((li) => {
    const name = li.querySelector("input").id.replace("layer-", "");
    const entry = Object.values(classes).find((c) => c.name === name);
    if (entry) li.querySelector(".dot").style.background = cssColor(entry.color);
  });
}

function showError(err) {
  console.error(err);
  setLoading(true, `Could not load: ${err.message}`, 0);
  if (embeddedRun) window.parent.postMessage({ type: "spanguard:viewer-error" }, location.origin);
}

async function main() {
  wireControls();
  const projects = (projectList = await getJSON(`${dataRoot}/projects.json`));
  const link = readHash(); // read before the first load rewrites the hash
  const preferred = projects.includes(link.p) ? link.p : projects.includes("gridnet_t5b6") ? "gridnet_t5b6" : projects[0];
  $("projectSelect").innerHTML = projects
    .map((p) => html`<option value="${p}" ${p === preferred ? raw("selected") : ""}>${projectName(p)}</option>`)
    .join("");
  syncThemeButton();
  if (workspaceRun) {
    // A saved workspace run: one project, opened from its survey. Show its name and a way back, not a picker.
    $("projectField").hidden = true;
    if (!embeddedRun) {
      const [project, survey, run] = runPath.split("/");
      document.querySelector(".card-project").insertAdjacentHTML("beforeend", String(html`<div class="viewer-links">
        <a class="viewer-workspace-link" href="/workspace.html?project=${project}&amp;survey=${survey}&amp;run=${run}"><span aria-hidden="true">←</span> Run overview</a>
        <span class="viewer-run-note" title="Results are for exploration until voltage, conductor and height reference are confirmed">Exploratory</span></div>`));
    }
  }
  // Phones: start on the 2D map (lighter, and what a field crew needs); 3D stays one tap away.
  if (phone() && webglOK && !link.s) setView("2d");
  restoring = true;
  try { await loadProject(preferred); } finally { restoring = false; }
  await openLink({ ...link, p: preferred });
  if (embeddedRun) window.parent.postMessage({ type: "spanguard:viewer-ready", has3d: webglOK }, location.origin);
}

main().catch(showError);
