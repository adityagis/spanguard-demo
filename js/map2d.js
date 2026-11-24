// 2D GIS view (Leaflet): LiDAR as-built (towers, spans by risk, QA pins) over the client GIS records.
/* global L */

const RISK = { ok: "#1F9E6E", watch: "#E8930C", violation: "#C2334D" };
const SEV = { error: "#BF3989", warn: "#FF9F0A", info: "#0A84FF" };
const UNCONFIRMED = "#8E8E93";
const displayRisk = p => (!p.risk || p.risk === "ok") && p.assessment !== "checked" ? p.assessment ?? p.risk : p.risk;

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export class Map2D {
  constructor(el, { externalBasemap = true } = {}) {
    this.el = el;
    this.externalBasemap = externalBasemap;
    this.map = null;
    this.layer = null;
  }

  _init() {
    if (this.map) return;
    this.map = L.map(this.el, { zoomControl: true, attributionControl: true, preferCanvas: true });
    const basemaps = {};
    if (this.externalBasemap) {
    const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 20, maxNativeZoom: 19, attribution: "© OpenStreetMap contributors",
    });
    const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 20, maxNativeZoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
    });
    sat.addTo(this.map);
    Object.assign(basemaps, { Satellite: sat, Map: osm });
    } else {
      // Workspace runs stay on this computer: no third-party basemap, a survey grid instead.
      this.el.classList.add("no-basemap");
      this.map.attributionControl.addAttribution("Offline map · no basemap is loaded for workspace runs");
    }
    this.control = L.control.layers(basemaps, {}, { position: "topleft", collapsed: window.matchMedia("(max-width: 1000px)").matches }).addTo(this.map);
    L.control.scale({ metric: true, imperial: false, position: "bottomleft" }).addTo(this.map);

    const legend = L.control({ position: "bottomleft" });
    legend.onAdd = () => {
      const d = L.DomUtil.create("div", "map-legend");
      d.innerHTML = `<div class="lg-title">Spans by clearance</div>
        <div class="lg-row"><span><i class="ln" style="border-color:${RISK.ok}"></i>Clear</span><span><i class="ln" style="border-color:${RISK.watch}"></i>Watch</span>
        <span><i class="ln" style="border-color:${RISK.violation}"></i>Violation</span><span><i class="ln" style="border-color:${UNCONFIRMED}"></i>Unconfirmed</span></div>
        <div class="lg-title">Assets</div>
        <div><i class="dot" style="background:#1D1D1F;border:1.5px solid #fff"></i>Tower (LiDAR)</div>
        <div><i class="dot" style="border:2px solid #D4860B"></i>Tower (GIS record)</div>
        <div><i class="dash"></i>GIS line · LiDAR↔GIS offset</div>`;
      return d;
    };
    legend.addTo(this.map);
  }

  setData(geojson) {
    this.geojson = geojson;
    if (this.map) this._render();
  }

  show() {
    this.el.hidden = false;
    this._init();
    this.map.invalidateSize();
    this._render();
  }

  hide() { this.el.hidden = true; }

  focusAsset(kind, id) {
    const group = this.overlays?.[kind === "tower" ? "Towers (LiDAR)" : "Spans (LiDAR)"];
    const target = group?.getLayers().find(layer => layer.feature?.properties?.id === id);
    if (!target) return false;
    if (!this.map.hasLayer(group)) group.addTo(this.map);
    if (target.getBounds) this.map.fitBounds(target.getBounds().pad(0.5), { maxZoom: 18 });
    else this.map.setView(target.getLatLng(), Math.max(this.map.getZoom(), 17));
    target.openPopup();
    return true;
  }

  _render() {
    if (!this.geojson) return;
    if (this.layer) {
      this.layer.remove();
      Object.values(this.overlays ?? {}).forEach((l) => this.control.removeLayer(l));
    }
    const f = (layer) => this.geojson.features.filter((x) => x.properties.layer === layer);
    const groups = {
      "GIS lines": L.geoJSON(f("gis_line"), { style: { color: "#FF9F0A", weight: 2, dashArray: "6 6", opacity: 0.9 },
        onEachFeature: (ft, l) => l.bindPopup(this._gisPopup(ft.properties)) }),
      "Spans (LiDAR)": L.geoJSON(f("span"), {
        style: (ft) => ({ color: RISK[displayRisk(ft.properties)] ?? UNCONFIRMED, weight: 6, opacity: 0.9, lineCap: "round" }),
        onEachFeature: (ft, l) => l.bindPopup(this._spanPopup(ft.properties)),
      }),
      "Wires (fitted)": L.geoJSON(f("wire"), { style: { color: this.externalBasemap ? "#FFFFFF" : "#3A4A46", weight: 1, opacity: 0.7 } }),
      "GIS towers": L.geoJSON(f("gis_tower"), {
        pointToLayer: (ft, ll) => L.circleMarker(ll, { radius: 8, color: "#FF9F0A", weight: 2.5, fillOpacity: 0 }),
        onEachFeature: (ft, l) => l.bindPopup(this._gisPopup(ft.properties)),
      }),
      "Towers (LiDAR)": L.geoJSON(f("tower"), {
        pointToLayer: (ft, ll) => L.circleMarker(ll, { radius: 5, color: "#FFFFFF", weight: 1.5, fillColor: "#1D1D1F", fillOpacity: 1 }),
        onEachFeature: (ft, l) => {
          const p = ft.properties;
          l.bindTooltip(p.id, { permanent: true, direction: "right", offset: [8, 0], className: "" });
          l.bindPopup(`<b>${esc(p.id)}</b> · ${esc(p.structure)}<br>Height ${p.height.toFixed(1)} m · line angle ${p.line_angle_deg ?? "—"}° · lean ${p.lean_deg ?? "—"}°`);
        },
      }),
      "QA issues": L.geoJSON(f("qa_issue"), {
        pointToLayer: (ft, ll) => L.circleMarker(ll, { radius: 4, color: SEV[ft.properties.severity], weight: 2, fillColor: "#fff", fillOpacity: 1 }),
        onEachFeature: (ft, l) => l.bindPopup(`<b>${esc(ft.properties.id)}</b> · ${esc(ft.properties.severity)}<br>${esc(ft.properties.message)}<br><i>${esc(ft.properties.suggestion)}</i>`),
      }),
    };
    // dashed links between each LiDAR tower and the GIS record it matched
    const towers = Object.fromEntries(f("tower").map((t) => [t.properties.id, t.geometry.coordinates]));
    const links = f("gis_tower").filter((g) => g.properties.matched_to && towers[g.properties.matched_to]).map((g) => {
      const a = g.geometry.coordinates, b = towers[g.properties.matched_to];
      return L.polyline([[a[1], a[0]], [b[1], b[0]]], { color: "#FF9F0A", weight: 2, dashArray: "3 4" })
        .bindTooltip(`${g.properties.offset_m.toFixed(1)} m`, { permanent: true, direction: "top", className: "" });
    });
    groups["LiDAR↔GIS offsets"] = L.layerGroup(links);

    this.layer = L.layerGroup(Object.values(groups)).addTo(this.map);
    this.overlays = groups;
    // List only layers this project has: no "GIS towers" switch when no GIS register was loaded.
    for (const [name, g] of Object.entries(groups)) if (g.getLayers().length) this.control.addOverlay(g, name);
    const fit = L.featureGroup([groups["Spans (LiDAR)"], groups["Towers (LiDAR)"]]);
    if (fit.getLayers().length) this.map.fitBounds(fit.getBounds().pad(0.6), { animate: false });
  }

  _spanPopup(p) {
    const yrs = p.years_to_veg_violation != null ? `${p.years_to_veg_violation} yr` : "none within 10 m";
    const state = displayRisk(p);
    const STATE = { ok: "Clear", watch: "Watch", violation: "Violation", unknown: "Unconfirmed", partial: "Partial" };
    return `<b>${esc(p.id)}</b> · ${p.kind === "full" ? "full" : "survey-edge"} span${p.length_m ? ` · ${p.length_m.toFixed(0)} m` : ""}<br>
      Status <b style="color:${RISK[state] ?? UNCONFIRMED}">${esc(STATE[state] ?? state ?? "—")}</b>: ${esc(p.worst_class)} ${p.worst_clearance_m?.toFixed(2) ?? "-"} m
      (${p.worst_margin_m >= 0 ? "+" : ""}${p.worst_margin_m?.toFixed(2) ?? "—"} m, ${esc((p.worst_environment ?? "").replace("_", " "))})<br>
      ${p.wires} wires · vegetation grow-in: ${yrs}${p.assessment_limits ? `<br>${esc(p.assessment_limits)}` : ""}`;
  }

  _gisPopup(p) {
    const tags = Object.entries(p).filter(([k]) => k.startsWith("tag_")).map(([k, v]) => `${esc(k.slice(4))}=${esc(v)}`).join(", ");
    const m = p.matched_to ? `<br>Matched to <b>${esc(p.matched_to)}</b>, ${p.offset_m.toFixed(2)} m (${esc(p.status)})` : "";
    return `<b>${esc(p.id)}</b> (GIS record)${m}<br><span style="color:#6e6e73">${tags || "no tags"}</span>`;
  }
}
