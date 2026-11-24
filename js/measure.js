// Measure tool: click two LiDAR points to read 3D, horizontal and vertical distance.
const $ = (id) => document.getElementById(id);

export class Measure {
  constructor(scene, classNames = {}) {
    this.scene = scene;
    this.classNames = classNames;
    this.active = false;
    this.pts = [];
    this.btn = $("measureBtn");
    this.btn.addEventListener("click", () => this.toggle());
    const canvas = scene.canvas;
    // A click is a press and release that did not move: a drag still orbits the camera.
    canvas.addEventListener("pointerdown", (ev) => { this.down = [ev.clientX, ev.clientY]; });
    canvas.addEventListener("pointerup", (ev) => {
      if (!this.active || ev.button !== 0 || !this.down) return;
      if (Math.hypot(ev.clientX - this.down[0], ev.clientY - this.down[1]) > 4) return;
      this.click(ev.clientX, ev.clientY);
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.target.closest?.("input, select, textarea")) return;
      if (ev.key === "m" || ev.key === "M") this.toggle();
      else if (ev.key === "Escape" && this.active) this.toggle(false);
    });
  }

  setClassNames(names) { this.classNames = names; }

  toggle(on = !this.active) {
    this.active = on;
    this.btn.setAttribute("aria-pressed", String(on));
    document.body.classList.toggle("measuring", on);
    this.pts = [];
    this.scene.setMeasure(null);
    this.status(on ? "Measure: click the first point (Esc to stop)" : "");
  }

  status(text) {
    const el = $("measureStatus");
    el.textContent = text;
    el.hidden = !text;
  }

  click(x, y) {
    const hit = this.scene.pick(x, y);
    if (!hit) { this.status("No point there. Click on the point cloud."); return; }
    if (this.pts.length === 2) this.pts = [];
    this.pts.push({ ...hit });
    const name = (c) => this.classNames[c] ?? `class ${c}`;
    if (this.pts.length === 1) {
      this.scene.setMeasure([hit.pos]);
      this.status(`From ${name(hit.cls)} · click the second point`);
      return;
    }
    const [a, b] = this.pts;
    const d3 = a.pos.distanceTo(b.pos);
    const dh = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
    const dz = b.pos.z - a.pos.z;
    this.scene.setMeasure([a.pos, b.pos], `<b>${d3.toFixed(2)} m</b><span>horiz ${dh.toFixed(2)} · Δz ${dz >= 0 ? "+" : ""}${dz.toFixed(2)}</span>`);
    this.status(`${name(a.cls)} → ${name(b.cls)}: ${d3.toFixed(2)} m 3D, ${dh.toFixed(2)} m horizontal, ${Math.abs(dz).toFixed(2)} m vertical · click to start again`);
  }
}
