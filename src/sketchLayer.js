/* ============================================================================
   SKETCH LAYER — click-and-drag colored-pencil doodling on the final screen.
   ============================================================================

   A small, self-contained canvas layer: while the pointer is held down (and
   only while `isActive()` says so — Spiral.jsx wires that to "the starburst
   has fully formed"), it draws a grainy, colored-pencil-style scribble under
   the cursor. Each new stroke (each pointerdown) rolls a fresh colour from
   PENCIL_COLORS.

   It lives on its own <canvas>, stacked *underneath* the particle canvas in
   Spiral.jsx (see the sketchCanvasRef element there) — the particle canvas
   clears to transparent and redraws every frame, so whatever's on this layer
   shows through in the gaps, like the star is sitting on top of a page the
   user has been scribbling on.

   Deliberately has no requestAnimationFrame loop of its own: it only ever
   draws in response to pointer events, so it costs nothing while idle.

   CUSTOMIZATION
     - Colours available:      PENCIL_COLORS below
     - Grain density/roughness: STEP_PX, PASSES_PER_STEP, and the jitter/
                                length/alpha ranges inside strokeSegment()
     - Where drawing unlocks:   the `isActive` callback passed in from
                                Spiral.jsx (currently: stage.kind === 'starHold')
   ============================================================================ */

export const PENCIL_COLORS = [
  "#d9556f", // warm pink/red
  "#4f8fc9", // sky blue
  "#8a63b8", // violet
  "#e0a83f", // golden yellow
  "#5aa76b", // leaf green
  "#4fb3ac", // teal
  "#d97a4a", // burnt orange
  "#c96b9e", // magenta pink
];

export class SketchLayer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {() => boolean} isActive - whether a *new* stroke may start right now
   */
  constructor(canvas, isActive) {
    this.canvas = canvas;
    this.isActive = isActive;
    this.drawing = false;
    this.color = null;
    this.last = null;

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onResize = this.onResize.bind(this);
    this.clear = this.clear.bind(this);
  }

  getDims() {
    return { w: window.innerWidth, h: window.innerHeight };
  }

  // Mirrors SpiralEngine's resizeCanvas() — same DPR handling so the doodle
  // stays crisp. Resizing (like the particle canvas) wipes the drawing;
  // that's accepted here rather than worked around, since a layout change
  // already invalidates where everything on screen was anyway.
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { w, h } = this.getDims();
    this.dims = { w, h };
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.ctx = this.canvas.getContext("2d");
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 'multiply' against a transparent layer behaves like normal drawing on
    // the first pass, then deepens where strokes overlap — real pencil marks
    // darken/saturate the same way when you scribble back over them.
    this.ctx.globalCompositeOperation = "multiply";
  }

  // Wipes every stroke. Safe to call any time (e.g. from a "Clear" button).
  clear() {
    if (!this.ctx || !this.dims) return;
    this.ctx.clearRect(0, 0, this.dims.w, this.dims.h);
  }

  mount() {
    this.resize();
    window.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove, {
      passive: true,
    });
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointerleave", this.onPointerUp);
    window.addEventListener("blur", this.onPointerUp);
    window.addEventListener("resize", this.onResize);
  }

  unmount() {
    clearTimeout(this._rt);
    window.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointerleave", this.onPointerUp);
    window.removeEventListener("blur", this.onPointerUp);
    window.removeEventListener("resize", this.onResize);
  }

  onResize() {
    clearTimeout(this._rt);
    this._rt = setTimeout(() => this.resize(), 200);
  }

  point(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  onPointerDown(e) {
    if (!this.isActive()) return;
    this.drawing = true;
    this.color = PENCIL_COLORS[Math.floor(Math.random() * PENCIL_COLORS.length)];
    this.last = this.point(e);
    this.dab(this.last); // a plain click (no drag) still leaves a small mark
  }

  onPointerMove(e) {
    if (!this.drawing) return;
    if (!this.isActive()) {
      // scrolled out of the active stage mid-stroke — stop rather than
      // keep drawing somewhere the user can no longer see it happen
      this.drawing = false;
      return;
    }
    const p = this.point(e);
    this.strokeSegment(this.last, p);
    this.last = p;
  }

  onPointerUp() {
    this.drawing = false;
    this.last = null;
  }

  // Grain tuning: how far apart (px) each stamp along a stroke is, and how
  // many jittered mini-strokes get layered at each stamp.
  STEP_PX = 2;
  PASSES_PER_STEP = 3;

  // Draws one grainy pencil-textured segment from `a` to `b`: many short,
  // randomly-angled, low-alpha mini-strokes rather than a single clean
  // line, so it reads as pencil grain/texture instead of a vector stroke.
  strokeSegment(a, b) {
    const ctx = this.ctx;
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const angle = Math.atan2(dy, dx);
    const nx = -dy / dist,
      ny = dx / dist; // unit normal, for perpendicular jitter
    const steps = Math.max(1, Math.ceil(dist / this.STEP_PX));
    ctx.lineCap = "round";
    ctx.strokeStyle = this.color;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = a.x + dx * t,
        py = a.y + dy * t;
      for (let k = 0; k < this.PASSES_PER_STEP; k++) {
        const jitter = (Math.random() - 0.5) * 3.2; // offset off the stroke's centreline
        const len = 2 + Math.random() * 3.5; // individual grain-stroke length
        const ang = angle + (Math.random() - 0.5) * 0.7; // grain strokes don't all point the same way
        ctx.globalAlpha = 0.08 + Math.random() * 0.14;
        ctx.lineWidth = 0.6 + Math.random() * 1.2;
        ctx.beginPath();
        ctx.moveTo(px + nx * jitter, py + ny * jitter);
        ctx.lineTo(
          px + nx * jitter + Math.cos(ang) * len,
          py + ny * jitter + Math.sin(ang) * len,
        );
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  // A tap without dragging: scribble a tiny cluster of grain around the
  // point so a single click still reads as a pencil mark, not nothing.
  dab(p) {
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 2.5;
      this.strokeSegment(p, {
        x: p.x + Math.cos(a) * r,
        y: p.y + Math.sin(a) * r,
      });
    }
  }
}
