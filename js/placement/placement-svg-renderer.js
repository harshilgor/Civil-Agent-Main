/**
 * 2D SVG renderer for the placement domain.
 *
 * Mounts a transient `<g class="placement-layer">` inside the existing
 * SVG canvas's `.layer-overlay` and redraws on every state change. The
 * layer sits on top of the existing structural plan so we don't have
 * to fight svg-canvas.js for ownership of columns/beams/walls — when
 * the user is on the placement page, this layer is the source of truth
 * and the underlying mock columns/beams are dimmed by CSS.
 */

const NS = "http://www.w3.org/2000/svg";

export class PlacementSvgRenderer {
  /**
   * @param {SVGSVGElement} svg
   */
  constructor(svg) {
    this.svg = svg;
    this.layer = null;
    this._selectedId = null;
  }

  activate() {
    this._ensureLayer();
    this.svg.classList.add("placement-active");
  }

  deactivate() {
    this.svg.classList.remove("placement-active");
    if (this.layer && this.layer.parentNode) this.layer.parentNode.removeChild(this.layer);
    this.layer = null;
  }

  _ensureLayer() {
    if (this.layer && this.layer.isConnected) return;
    let host = this.svg.querySelector(".layer-overlay");
    if (!host) {
      host = document.createElementNS(NS, "g");
      host.setAttribute("class", "layer-overlay");
      this.svg.appendChild(host);
    }
    const existing = host.querySelector(".placement-layer");
    if (existing) existing.remove();
    this.layer = document.createElementNS(NS, "g");
    this.layer.setAttribute("class", "placement-layer");
    host.appendChild(this.layer);
  }

  render(strategy, grid, options = {}) {
    if (!this.layer) this._ensureLayer();
    if (!this.layer) return;
    this._selectedId = options.selectedId || null;

    // Wipe previous content.
    while (this.layer.firstChild) this.layer.removeChild(this.layer.firstChild);

    // Order matters: walls beneath beams beneath columns so columns sit on top.
    for (const w of strategy.elements.shearWalls) this._drawWall(w);
    for (const b of strategy.elements.beams) this._drawBeam(b);
    for (const c of strategy.elements.columns) this._drawColumn(c);

    // Tool guides — pending point for two-click tools, snap rings, etc.
    if (options.pendingPoint) this._drawPending(options.pendingPoint);
    if (options.snapPoint) this._drawSnapMarker(options.snapPoint);
  }

  setSelected(id) { this._selectedId = id; }

  // ─── Element drawers ──────────────────────────────────────────────

  _drawColumn(c) {
    const isManual = c.source === "manual";
    const selected = c.id === this._selectedId;
    const size = isManual ? 2.6 : 2.0;
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "p-col" +
      (isManual ? " is-manual" : "") +
      (selected ? " is-selected" : "") +
      (c.locked ? " is-locked" : ""));
    g.setAttribute("data-placement-type", "column");
    g.setAttribute("data-placement-id", c.id);

    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", String(c.x - size / 2));
    rect.setAttribute("y", String(c.y - size / 2));
    rect.setAttribute("width", String(size));
    rect.setAttribute("height", String(size));
    rect.setAttribute("rx", "0.4");
    g.appendChild(rect);

    if (isManual) {
      const ring = document.createElementNS(NS, "circle");
      ring.setAttribute("cx", String(c.x));
      ring.setAttribute("cy", String(c.y));
      ring.setAttribute("r", String(size * 0.95));
      ring.setAttribute("class", "p-col-ring");
      g.appendChild(ring);
    }

    if (c.kind === "intermediate") g.classList.add("is-intermediate");

    this.layer.appendChild(g);
  }

  _drawBeam(b) {
    const isManual = b.source === "manual";
    const selected = b.id === this._selectedId;
    const line = document.createElementNS(NS, "line");
    line.setAttribute("class", "p-beam" +
      (isManual ? " is-manual" : "") +
      (selected ? " is-selected" : ""));
    line.setAttribute("data-placement-type", "beam");
    line.setAttribute("data-placement-id", b.id);
    line.setAttribute("x1", String(b.x1));
    line.setAttribute("y1", String(b.y1));
    line.setAttribute("x2", String(b.x2));
    line.setAttribute("y2", String(b.y2));
    if (b.spanFt && b.spanFt > 32) line.classList.add("is-long-span");
    this.layer.appendChild(line);
  }

  _drawWall(w) {
    const isManual = w.source === "manual";
    const selected = w.id === this._selectedId;
    const dx = w.x2 - w.x1;
    const dy = w.y2 - w.y1;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length < 0.1) return;

    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    const cx = (w.x1 + w.x2) / 2;
    const cy = (w.y1 + w.y2) / 2;
    const thicknessVisual = Math.max(1.2, (w.thickness || 0.35) * 4);

    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "p-wall" +
      (isManual ? " is-manual" : "") +
      (selected ? " is-selected" : "") +
      (w.locked ? " is-locked" : ""));
    g.setAttribute("data-placement-type", "shearWall");
    g.setAttribute("data-placement-id", w.id);
    g.setAttribute("transform", `translate(${cx} ${cy}) rotate(${angle})`);

    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", String(-length / 2));
    rect.setAttribute("y", String(-thicknessVisual / 2));
    rect.setAttribute("width", String(length));
    rect.setAttribute("height", String(thicknessVisual));
    rect.setAttribute("rx", "0.2");
    g.appendChild(rect);

    this.layer.appendChild(g);
  }

  _drawPending(p) {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("class", "p-pending");
    c.setAttribute("cx", String(p.x));
    c.setAttribute("cy", String(p.y));
    c.setAttribute("r", "1.5");
    this.layer.appendChild(c);
  }

  _drawSnapMarker(p) {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("class", "p-snap");
    c.setAttribute("cx", String(p.x));
    c.setAttribute("cy", String(p.y));
    c.setAttribute("r", "0.9");
    this.layer.appendChild(c);
  }
}
