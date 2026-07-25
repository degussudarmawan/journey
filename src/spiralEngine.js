/* ============================================================================
   SPIRAL ENGINE — a scroll-driven dot-particle animation.
   ============================================================================

   This is a plain, framework-agnostic class: it owns a <canvas>, a "track"
   element (a tall spacer whose scroll position drives the timeline) and a
   "hint" element (the fading "Scroll" label). React's job (see Spiral.jsx)
   is just to hand it those three DOM nodes and a way to read the latest
   props — everything else, all the animation math, lives here.

   THE IDEA
   A fixed pool of particles (built once in buildGrid()) is reused for every
   shape in the piece. Scroll position (0..1, read in onScroll()) drives a
   timeline of STAGES (see mount()'s `this.stageDefs`); each stage just
   tells the render loop() which two shapes to interpolate between and how
   far along (0..1) to blend. Nothing is a discrete "scene change" -
   everything is a lerp between two point clouds for the same particle
   index `i`, which is what makes the dots feel like they *flow* from one
   form into the next instead of cutting.

   THE SHAPES A PARTICLE CAN OCCUPY
     1. Grid      — resting dot-grid layout, built in buildGrid() (p.gx/p.gy).
     2. Spiral    — a slowly-rotating spiral arm, computed live from
                    p.spiralAngle0 / p.spiralRadius each frame.
     3. Word      — one of the active words (word1/word2/word3/word4 — any
                    that are empty/unset are skipped entirely, so word4+ are
                    optional), rendered to an offscreen canvas and sampled
                    into points in sampleWordPoints().
     4. Starburst — an eight-point star logo built from an explicit outline
                    (starTips/buildStarOutline) that's rasterised into a
                    "radius per angle" lookup table (buildStarLUT) and then
                    filled with a halftone dot grid (buildStar).

   THE TIMELINE (scroll fraction t, 0 = top of page, 1 = bottom of track)
   is *generated*, not hardcoded — buildStageDefs(wordCount) lays out:
     static -> explode -> [toWord -> hold -> toSpiral] per word (the last
     word gets toStar instead of toSpiral) -> starHold
   with proportional weights that are re-normalised to always cover exactly
   0..1, whatever wordCount is. rebuildWords() calls it every time the set
   of active words changes, so adding/removing a word (e.g. leaving word4
   unset) "just works" — no stage list to hand-edit. To change how long a
   phase feels, edit the weight constants at the top of buildStageDefs().
   You can also tune the track's height (set via CSS in Spiral.jsx) to
   change how much scrolling the whole sequence takes.

   QUICK CUSTOMIZATION GUIDE
     - Words shown:            props word1 / word2 / word3 / word4 (word4 optional)
     - Dot colours:             props accentPalette (4 hex colours) + INK below
     - Idle spiral spin speed:  props rotationSpeed -> ROT_SPEED in loop()
     - Starburst ray wobble:    props raySway -> starFrame()
     - Cursor push-away force:  props cursorRepel + repelR in loop()
     - Star silhouette shape:   starTips() angles/lengths, STAR_VALLEY, STAR_BOW
     - Particle density:        spacing math in buildGrid() and buildStar()
     - Stage timing:            the weight constants in buildStageDefs()
   ============================================================================ */

export const DEFAULT_PALETTE = ["#c98a8a", "#8aa8c9", "#8ec9a6", "#b98ac9"];

export class SpiralEngine {
  // ---- Palette --------------------------------------------------------------
  // INK is the "settled" colour: dots fade toward it as the star forms, and
  // ~40% of particles (colorSlot === -1) are always drawn in it.
  INK = "#2a2a2f";

  // ---- Eight-point starburst tuning ------------------------------------------
  STAR_VALLEY = 0.2; // valley radius, as a fraction of R
  STAR_BOW = 0.3; // 0 = perfectly straight edges, 1 = collapsed on axis
  STAR_LUT_N = 2048; // angular resolution of the radius lookup table

  // ---- Galaxy-style spiral motion tuning --------------------------------------
  // See buildGrid() (where these are rolled per-particle) and loop()'s
  // spiral position calc (where they're applied) for how these combine.
  ORBIT_SPREAD = 0.35; // +/- fraction of ROT_SPEED each particle's own orbit rate can vary by (0 = rigid pinwheel)
  DRIFT_R_MIN = 1.5; // smallest per-particle local wobble radius, in px
  DRIFT_R_MAX = 5; // largest per-particle local wobble radius, in px
  DRIFT_SPEED_MIN = 0.5; // slowest per-particle local wobble speed, rad/s
  DRIFT_SPEED_MAX = 1.8; // fastest per-particle local wobble speed, rad/s

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLElement} track - tall spacer element; its scroll position drives the timeline
   * @param {HTMLElement} hint - the "Scroll" label, faded out as the user scrolls
   * @param {() => object} getProps - returns the latest { word1, word2, word3, word4,
   *   rotationSpeed, accentPalette, raySway, cursorRepel }, read fresh every frame
   */
  constructor(canvas, track, hint, getProps) {
    this.canvas = canvas;
    this.track = track;
    this.hint = hint;
    this.getProps = getProps;

    this.onScroll = this.onScroll.bind(this);
    this.onResize = this.onResize.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerLeave = this.onPointerLeave.bind(this);
    this.loop = this.loop.bind(this);
  }

  // ---- Small math helpers -----------------------------------------------
  hash(n) {
    const x = Math.sin(n * 12.9898) * 43758.5453123;
    return x - Math.floor(x);
  }
  lerp(a, b, t) {
    return a + (b - a) * t;
  }
  clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
  smoothstep(e0, e1, v) {
    const t = this.clamp((v - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  // ---- Colour helpers -----------------------------------------------------
  hexToRgb(hex) {
    let h = String(hex).replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const v = parseInt(h, 16) || 0;
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  // Blend a colour toward the ink, memoised on (colour, quantised amount).
  towardInk(hex, t) {
    const q = Math.round(this.clamp(t, 0, 1) * 16) / 16;
    if (q <= 0) return hex;
    if (q >= 1) return this.INK;
    const key = hex + "|" + q;
    this._mixCache = this._mixCache || {};
    if (this._mixCache[key]) return this._mixCache[key];
    const a = this.hexToRgb(hex),
      b = this.hexToRgb(this.INK);
    const c =
      "rgb(" +
      Math.round(this.lerp(a[0], b[0], q)) +
      "," +
      Math.round(this.lerp(a[1], b[1], q)) +
      "," +
      Math.round(this.lerp(a[2], b[2], q)) +
      ")";
    this._mixCache[key] = c;
    return c;
  }

  // ---- Canvas / viewport setup ----------------------------------------------
  getDims() {
    return { w: window.innerWidth, h: window.innerHeight };
  }

  // Sizes the canvas' backing store for device-pixel-ratio sharpness (capped
  // at 2x so huge/5K displays don't push an oversized buffer), then scales
  // the drawing context so all other code can keep working in CSS pixels.
  resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.dims.w * dpr);
    this.canvas.height = Math.round(this.dims.h * dpr);
    this.canvas.style.width = this.dims.w + "px";
    this.canvas.style.height = this.dims.h + "px";
    this.ctx = this.canvas.getContext("2d");
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---- Particle pool: resting grid + idle spiral -----------------------------
  // Builds the fixed set of particles used for the whole animation and gives
  // each one everything it needs up front: its resting grid position (gx/gy),
  // its spiral position (spiralAngle0/spiralRadius), and assorted per-particle
  // randomness (seed, dot size, colour, spiral entry delay). Every later stage
  // just picks different (x,y) for the same particle index.
  buildGrid() {
    const { w, h } = this.dims;
    const spacing = this.clamp(Math.round(w / 46), 20, 32); // grid pitch in px — smaller divisor = denser grid
    const dotR = spacing * 0.16;
    const cols = Math.ceil(w / spacing) + 3;
    const rows = Math.ceil(h / spacing) + 3;
    const particles = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const stagger = r % 2 === 0 ? 0 : spacing / 2; // brick-pattern offset on odd rows
        const gx = -spacing * 1.5 + c * spacing + stagger;
        const gy = -spacing * 1.5 + r * spacing;
        if (
          gx < -spacing * 1.5 ||
          gx > w + spacing * 1.5 ||
          gy < -spacing * 1.5 ||
          gy > h + spacing * 1.5
        )
          continue;
        particles.push({ gx, gy });
      }
    }
    const N = particles.length;
    const cx = w / 2,
      cy = h / 2;
    let maxDist = 1;
    particles.forEach((p) => {
      const d = Math.hypot(p.gx - cx, p.gy - cy);
      if (d > maxDist) maxDist = d;
    });
    const maxRadius = Math.min(w, h) * 0.4; // spiral's outer radius
    const TURNS = 8; // how many times the spiral winds around
    particles.forEach((p, i) => {
      p.seed = this.hash(i * 3.77);
      p.rox = 0;
      p.roy = 0; // smoothed cursor-repel offset (star stage)
      p.dotR = dotR * (0.82 + this.hash(i * 5.1) * 0.32); // grid-stage dot radius, slightly randomised
      p.dustR = 1.6 * (0.65 + this.hash(i * 9.3) * 0.95); // radius used for spiral/word stages ("dust" size)
      p.delayFrac = Math.hypot(p.gx - cx, p.gy - cy) / maxDist; // 0 near centre, 1 at the edge — staggers the explode stage
      const roll = this.hash(i * 13.1);
      p.colorSlot = roll < 0.6 ? -1 : Math.floor(this.hash(i * 17.3) * 4) % 4; // -1 = ink, else index into accentPalette
      const f = i / N;
      p.spiralAngle0 =
        f * TURNS * Math.PI * 2 + (this.hash(i * 21.7) - 0.5) * 0.3;
      p.spiralRadius =
        maxRadius * Math.sqrt(f) +
        (this.hash(i * 27.9) - 0.5) * maxRadius * 0.03; // sqrt spacing = even area density
      // Galaxy-style motion (used in loop()'s spiral position calc): every
      // particle orbits at its own rate rather than sharing one rigid
      // rotation speed (ORBIT_SPREAD), like differential rotation — the
      // shape keeps subtly re-winding instead of spinning as one solid
      // pinwheel. On top of that, each particle also loops around a tiny
      // point of its own (driftR/driftSpeed/driftPhase), like an individual
      // star's own local motion layered on its galactic orbit.
      p.orbitRateMul = 1 + (this.hash(i * 31.3) - 0.5) * 2 * this.ORBIT_SPREAD;
      p.driftR =
        this.DRIFT_R_MIN +
        this.hash(i * 37.7) * (this.DRIFT_R_MAX - this.DRIFT_R_MIN);
      p.driftSpeed =
        this.DRIFT_SPEED_MIN +
        this.hash(i * 41.1) * (this.DRIFT_SPEED_MAX - this.DRIFT_SPEED_MIN);
      p.driftPhase = this.hash(i * 43.9) * Math.PI * 2;
    });
    this.particles = particles;
  }

  // ---- Word shapes: rasterise text, then sample it into particle points ------
  // Draws `word` to an offscreen canvas at high resolution, walks the alpha
  // channel to collect every "ink" pixel as a point, shuffles them, and picks
  // `count` of them (recycling if the pool has fewer opaque pixels than
  // particles) so there's a 1:1 target point for every particle index.
  sampleWordPoints(word, count) {
    const off = document.createElement("canvas");
    const scale = 2;
    const w = Math.min(this.dims.w * 0.9, 1100);
    const h = Math.min(this.dims.h * 0.5, 420);
    off.width = w * scale;
    off.height = h * scale;
    const ctx = off.getContext("2d");
    ctx.scale(scale, scale);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#000";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let fontSize = h * 0.6;
    ctx.font = `900 ${fontSize}px "Playfair Display", serif`;
    let mw = ctx.measureText(word).width;
    const maxTextWidth = w * 0.86;
    if (mw > maxTextWidth) {
      fontSize = fontSize * (maxTextWidth / mw); // shrink to fit long words
      ctx.font = `900 ${fontSize}px "Playfair Display", serif`;
    }
    ctx.fillText(word, w / 2, h / 2 + fontSize * 0.03);
    const img = ctx.getImageData(0, 0, w * scale, h * scale).data;
    const pts = [];
    const stride = 3 * scale; // sampling step in device px — smaller = denser word outline
    for (let y = 0; y < h * scale; y += stride) {
      for (let x = 0; x < w * scale; x += stride) {
        const idx = (y * (w * scale) + x) * 4 + 3; // alpha channel of this pixel
        if (img[idx] > 120)
          pts.push({ x: x / scale - w / 2, y: y / scale - h / 2 });
      }
    }
    for (let i = pts.length - 1; i > 0; i--) {
      // Fisher-Yates shuffle (deterministic, via hash())
      const j = Math.floor(this.hash(i * 3.1 + word.length * 1.7) * (i + 1));
      const tmp = pts[i];
      pts[i] = pts[j];
      pts[j] = tmp;
    }
    const out = new Array(count);
    const cx = this.dims.w / 2,
      cy = this.dims.h / 2;
    for (let i = 0; i < count; i++) {
      const p = pts.length ? pts[i % pts.length] : { x: 0, y: 0 }; // recycle points if count > pts.length
      const jx = (this.hash(i * 1.7 + word.length) - 0.5) * 3;
      const jy = (this.hash(i * 2.3 + word.length) - 0.5) * 3;
      out[i] = { x: cx + p.x + jx, y: cy + p.y + jy };
    }
    return out;
  }

  // Re-samples the active words against the current props/viewport and
  // rebuilds the scroll timeline to match how many of them there are (so
  // word4, word5, ... are all optional — only non-empty words get a stage).
  // Called on mount, on resize, and whenever word1..wordN change (React
  // calls setWords() for that — see Spiral.jsx).
  rebuildWords() {
    const props = this.getProps();
    const words = [props.word1, props.word2, props.word3, props.word4].filter(
      (w) => typeof w === "string" && w.trim().length > 0,
    );
    this.words = words.length ? words : ["less", "is", "more"]; // safety net if every word is empty
    this.letterPoints = this.words.map((w) =>
      this.sampleWordPoints(w, this.particles.length),
    );
    this.stageDefs = this.buildStageDefs(this.words.length);
  }

  /** Called by React when word1/word2/word3/word4 change after the initial mount. */
  setWords() {
    if (!this.particles) return;
    this.rebuildWords();
  }

  // ---- Scroll timeline generator ---------------------------------------------
  // Builds this.stageDefs for however many words are active: static grid,
  // explode into the spiral, then for each word a toWord -> hold -> toSpiral
  // triple (the *last* word gets toStar instead of toSpiral, leading into
  // the starburst), and finally starHold. The raw segment lengths below are
  // just relative weights — they're normalised (via `scale`) so the result
  // always covers exactly the 0..1 scroll range no matter how many words
  // there are. This is what you'd edit to change how long each phase feels;
  // add a word and its slice is carved out of the same 0..1 automatically.
  buildStageDefs(wordCount) {
    const STATIC = 0.02,
      EXPLODE = 0.09,
      TO_STAR = 0.08,
      STAR_HOLD = 0.06;
    const TO_WORD = 0.09,
      HOLD = 0.06,
      TO_SPIRAL = 0.05;
    const rawTotal =
      STATIC +
      EXPLODE +
      TO_STAR +
      STAR_HOLD +
      (TO_WORD + HOLD + TO_SPIRAL) * (wordCount - 1) + // every word but the last also does toSpiral
      (TO_WORD + HOLD); // the last word skips toSpiral (goes to the star instead)
    const scale = 1 / rawTotal;

    const defs = [];
    let t = 0;
    const push = (kind, len, extra) => {
      const t1 = t + len * scale;
      defs.push({ t0: t, t1, kind, ...extra });
      t = t1;
    };
    push("static", STATIC);
    push("explode", EXPLODE);
    for (let w = 0; w < wordCount; w++) {
      push("toWord", TO_WORD, { word: w });
      push("hold", HOLD, { word: w });
      if (w < wordCount - 1) push("toSpiral", TO_SPIRAL, { prevWord: w });
    }
    push("toStar", TO_STAR, { prevWord: wordCount - 1 });
    push("starHold", STAR_HOLD);
    return defs;
  }

  // The target point for particle `i` while word `wordIdx` is showing, with a
  // small per-particle circular wiggle so held words feel alive, not frozen.
  wordPointsFor(wordIdx, i, elapsed) {
    const base = this.letterPoints[wordIdx][i];
    const particle = this.particles[i];
    const wiggleAngle = particle.seed * 6.28 + elapsed * 1.1;
    const wr = 2.2; // wiggle radius in px
    return {
      x: base.x + Math.cos(wiggleAngle) * wr,
      y: base.y + Math.sin(wiggleAngle) * wr,
    };
  }

  // ---- Eight-point starburst --------------------------------------------------
  // The silhouette is an explicit outline: eight needle spikes whose edges run
  // valley -> tip as quadratic curves. The control point sits on the straight
  // edge, nudged toward the spike axis by STAR_BOW, so the edges stay dead
  // straight-to-slightly-concave and the tips come to a real point.

  // The 8 spike angles/lengths, hand-tuned off a reference image and nudged
  // off the exact 45deg grid so the star reads as hand-drawn rather than a
  // mechanical asterisk. `a` is the angle in radians, `len` a fraction of R.
  starTips(R) {
    const D = Math.PI / 180;
    return [
      { a: -137 * D, len: R * 0.5 },
      { a: -90 * D, len: R * 0.72 },
      { a: -47 * D, len: R * 0.47 },
      { a: 0 * D, len: R * 0.7 },
      { a: 43 * D, len: R * 0.5 },
      { a: 90 * D, len: R * 1.0 },
      { a: 136 * D, len: R * 0.5 },
      { a: 180 * D, len: R * 0.69 },
    ];
  }

  // Walks the tips and, for each spike, emits two quadratic-curve edges
  // (valley -> tip -> valley) as a dense polyline. Returns raw {x,y} points
  // relative to the star's own centre; buildStarLUT() turns this into the
  // radius-per-angle table actually used for hit-testing.
  buildStarOutline(R, tips) {
    const vr = R * this.STAR_VALLEY;
    const n = tips.length;
    const TAU = Math.PI * 2;
    const pts = [];
    const quad = (A, C, B, t) => {
      const m = 1 - t;
      return {
        x: m * m * A.x + 2 * t * m * C.x + t * t * B.x,
        y: m * m * A.y + 2 * t * m * C.y + t * t * B.y,
      };
    };
    for (let k = 0; k < n; k++) {
      const a = tips[k].a;
      const daNext = (((tips[(k + 1) % n].a - a) % TAU) + TAU) % TAU;
      const daPrev = (((a - tips[(k - 1 + n) % n].a) % TAU) + TAU) % TAU;
      const vIn = a - daPrev / 2,
        vOut = a + daNext / 2; // valley angles bisecting neighbouring tips
      const A0 = { x: vr * Math.cos(vIn), y: vr * Math.sin(vIn) };
      const B0 = { x: vr * Math.cos(vOut), y: vr * Math.sin(vOut) };
      const T = { x: tips[k].len * Math.cos(a), y: tips[k].len * Math.sin(a) };
      const ax = Math.cos(a),
        ay = Math.sin(a);
      const edges = [
        [A0, T],
        [T, B0],
      ];
      for (const [P, Q] of edges) {
        const mx = (P.x + Q.x) / 2,
          my = (P.y + Q.y) / 2;
        const proj = mx * ax + my * ay; // midpoint projected on the axis
        const C = {
          x: mx + (ax * proj - mx) * this.STAR_BOW,
          y: my + (ay * proj - my) * this.STAR_BOW,
        };
        for (let i = 1; i <= 40; i++) pts.push(quad(P, C, Q, i / 40));
      }
    }
    return pts;
  }

  // The shape is star-convex about its centre, so it collapses losslessly into
  // a radius-per-angle table: exact edges, and O(1) hit-testing (starRadius())
  // afterwards. Any angular gaps (rare) are filled by interpolating between
  // the nearest known radii on either side.
  buildStarLUT(pts) {
    const NA = this.STAR_LUT_N;
    const lut = new Float32Array(NA);
    for (const p of pts) {
      const r = Math.hypot(p.x, p.y);
      const b =
        ((Math.floor(((Math.atan2(p.y, p.x) + Math.PI) / (Math.PI * 2)) * NA) %
          NA) +
          NA) %
        NA;
      if (r > lut[b]) lut[b] = r;
    }
    for (let i = 0; i < NA; i++) {
      if (lut[i] > 0) continue;
      let j = 1;
      while (j < NA && lut[(i - j + NA) % NA] === 0) j++;
      let k = 1;
      while (k < NA && lut[(i + k) % NA] === 0) k++;
      const a = lut[(i - j + NA) % NA],
        b = lut[(i + k) % NA];
      lut[i] = a + (b - a) * (j / (j + k));
    }
    return lut;
  }

  // Silhouette radius at a given angle (interpolated between adjacent LUT
  // buckets). Anything closer to the centre than this is "inside" the star.
  starRadius(theta) {
    const NA = this.STAR_LUT_N;
    const f = ((theta + Math.PI) / (Math.PI * 2)) * NA;
    const i0 = ((Math.floor(f) % NA) + NA) % NA;
    const i1 = (i0 + 1) % NA;
    const t = f - Math.floor(f);
    return this.starLUT[i0] * (1 - t) + this.starLUT[i1] * t;
  }

  // Grid points grouped into 2x2 blocks: one block per particle, so a single
  // travelling dot shatters into up to four halftone pieces as it lands on
  // the star. That buys 4x the texture resolution without needing 4x the
  // particles in the earlier (grid/spiral/word) stages. Returns an array of
  // "cells", each cell an array of 1-4 sample points {theta, r0, u, id}
  // (u = distance from centre as a fraction of the local silhouette radius —
  // 0 at the core, 1 right on the edge).
  sampleStarBlocks(spacing) {
    const half = this.starR * 1.08;
    const n = Math.ceil((half * 2) / spacing);
    const map = new Map();
    let idx = 0;
    for (let row = 0; row <= n; row++) {
      for (let col = 0; col <= n; col++) {
        idx++;
        const jx = (this.hash(idx * 7.13) - 0.5) * spacing * 0.3; // jitter breaks up the grid pattern
        const jy = (this.hash(idx * 11.37) - 0.5) * spacing * 0.3;
        const px = -half + col * spacing + jx;
        const py = -half + row * spacing + jy;
        const dist = Math.hypot(px, py);
        if (dist < 0.0001) continue;
        const theta = Math.atan2(py, px);
        const rt = this.starRadius(theta);
        if (dist > rt) continue; // outside the silhouette — discard
        const key = (row >> 1) * 8192 + (col >> 1); // groups each 2x2 grid square into one block
        let cell = map.get(key);
        if (!cell) {
          cell = [];
          map.set(key, cell);
        }
        cell.push({ theta, r0: dist, u: dist / rt, id: idx });
      }
    }
    return Array.from(map.values());
  }

  // Which of the 8 spikes is angularly closest to `theta` — used to look up
  // that spike's per-frame sway amount in starPointFor().
  nearestRay(theta) {
    let best = 0,
      bd = 9;
    for (let k = 0; k < this.starTipsList.length; k++) {
      let d = theta - this.starTipsList[k].a;
      d = Math.abs(Math.atan2(Math.sin(d), Math.cos(d))); // shortest signed angular distance
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return best;
  }

  // Builds the star silhouette + LUT, then assigns each particle a block of
  // 1-4 halftone sample points on it (auto-tuning the sample spacing so the
  // number of blocks lands close to the particle count, so every particle
  // gets used and none are left drawing nothing).
  buildStar() {
    const { w, h } = this.dims;
    // Extents are 1.72R tall (long ray down, shorter up) and 1.39R wide.
    const R = Math.min((h * 0.94) / 1.72, (w * 0.94) / 1.39);
    this.starR = R;
    this.starCx = w / 2;
    this.starCy = h / 2 - 0.14 * R; // recentre for the uneven vertical rays
    this.starTipsList = this.starTips(R);
    this.starLUT = this.buildStarLUT(
      this.buildStarOutline(R, this.starTipsList),
    );

    // Tune the grid pitch until the block count lands near the particle count.
    const target = this.particles.length;
    let spacing = R * 0.02;
    let blocks = this.sampleStarBlocks(spacing);
    for (let iter = 0; iter < 8; iter++) {
      if (!blocks.length) {
        spacing *= 0.7;
        blocks = this.sampleStarBlocks(spacing);
        continue;
      }
      const ratio = blocks.length / target;
      if (Math.abs(ratio - 1) < 0.04) break;
      spacing = spacing * Math.sqrt(ratio);
      blocks = this.sampleStarBlocks(spacing);
    }
    this.starSpacing = spacing;

    for (let i = blocks.length - 1; i > 0; i--) {
      // shuffle so particle index doesn't correlate with screen position
      const j = Math.floor(this.hash(i * 4.91 + 2.7) * (i + 1));
      const tmp = blocks[i];
      blocks[i] = blocks[j];
      blocks[j] = tmp;
    }

    for (let i = 0; i < target; i++) {
      const p = this.particles[i];
      const cell = blocks.length
        ? blocks[i % blocks.length]
        : [{ theta: 0, r0: 0, u: 0, id: i }];
      const dup = i >= blocks.length; // more particles than blocks: reuse a block with slight jitter
      p.starSub = cell.map((s, k) => {
        // Dots run right up to the outline at near-full size: the silhouette
        // has to read sharp, so only the last few percent dither away.
        const edge = 1 - 0.22 * this.smoothstep(0.93, 1.0, s.u);
        return {
          theta: s.theta + (dup ? (this.hash(i * 6.7 + k) - 0.5) * 0.03 : 0),
          r0: s.r0 * (dup ? 1 + (this.hash(i * 8.9 + k) - 0.5) * 0.04 : 1),
          u: s.u,
          ray: this.nearestRay(s.theta),
          ph: this.hash(s.id * 19.3 + k) * Math.PI * 2, // per-dot shimmer phase
          rox: 0,
          roy: 0, // smoothed cursor-repel offset
          dotR: Math.max(
            0.55,
            spacing * 0.46 * (0.8 + this.hash(s.id * 15.7) * 0.42) * edge,
          ),
        };
      });
    }
  }

  // Sway is per-ray and constant across a frame, so it is computed once here
  // rather than per halftone piece (there are thousands of those). Called
  // once per frame from loop() while the star is on screen.
  starFrame(elapsed) {
    const sway = this.getProps().raySway ?? 0.14;
    const bend = this._bend || (this._bend = new Float64Array(8));
    for (let k = 0; k < 8; k++) {
      const rp = k * 1.37; // per-ray phase offset so rays don't sway in lockstep
      bend[k] =
        (Math.sin(elapsed * 0.62 + rp) * 0.9 +
          Math.sin(elapsed * 0.41 + rp * 1.9 + 2.1) * 0.55) *
        sway;
    }
    this._sf = { bend, drift: Math.sin(elapsed * 0.17) * 0.05, t: elapsed };
  }

  // Live (x,y) for one halftone sample point, combining: ray bend (sways the
  // whole spike as a unit, weighted by u^2 so the core stays pinned and the
  // tip swings most), a small radial breathing pulse, and a tiny per-dot
  // shimmer orbit.
  starPointFor(sub, elapsed) {
    const f = this._sf;
    const ang = sub.theta + f.bend[sub.ray] * sub.u * sub.u + f.drift;
    const rad =
      sub.r0 *
      (1 +
        Math.sin(elapsed * 0.85 - sub.u * 4.2 + sub.ray * 1.37) *
          0.035 *
          sub.u);
    const sh = 0.35; // shimmer orbit radius in px
    return {
      x:
        this.starCx +
        Math.cos(ang) * rad +
        Math.cos(elapsed * 1.3 + sub.ph) * sh,
      y:
        this.starCy +
        Math.sin(ang) * rad +
        Math.sin(elapsed * 1.1 + sub.ph) * sh,
    };
  }

  // ---- Scroll timeline --------------------------------------------------------
  // Finds which entry of this.stageDefs the scroll fraction `t` falls into,
  // plus `mix`: how far through that stage we are (0..1, eased by nothing —
  // individual stages apply their own easing where it matters).
  getStage(t) {
    for (const s of this.stageDefs) {
      if (t <= s.t1) {
        const mix = this.clamp((t - s.t0) / (s.t1 - s.t0), 0, 1);
        return { ...s, mix };
      }
    }
    return { ...this.stageDefs[this.stageDefs.length - 1], mix: 1 };
  }

  // ---- Lifecycle --------------------------------------------------------------
  // Sets everything up and starts the render loop. Call once, after the
  // canvas/track/hint DOM nodes exist. Mirrors a class component's
  // componentDidMount — React just calls it from a mount effect.
  async mount() {
    this.dims = this.getDims();
    this.resizeCanvas();
    this.buildGrid();
    this.buildStar();
    try {
      // Wait for the display font so word silhouettes aren't sampled off the
      // browser's fallback font on first paint.
      await document.fonts.load('900 200px "Playfair Display"');
      await document.fonts.ready;
    } catch (e) {}
    // Also builds this.stageDefs, sized to however many words came through
    // (see buildStageDefs() — that's what makes word4+ optional).
    this.rebuildWords();
    this.scrollT = 0;
    this.pointer = { x: -9999, y: -9999, active: false };
    window.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("resize", this.onResize);
    window.addEventListener("pointermove", this.onPointerMove, {
      passive: true,
    });
    window.addEventListener("pointerdown", this.onPointerMove, {
      passive: true,
    });
    window.addEventListener("pointerleave", this.onPointerLeave);
    window.addEventListener("blur", this.onPointerLeave);
    this.onScroll();
    this.raf = requestAnimationFrame(this.loop);
  }

  // Debounced (200ms) full rebuild: dimensions, grid, words and star all
  // depend on viewport size, so a resize has to redo everything.
  onResize() {
    clearTimeout(this._rt);
    this._rt = setTimeout(() => {
      this.dims = this.getDims();
      this.resizeCanvas();
      this.buildGrid();
      this.rebuildWords();
      this.buildStar();
    }, 200);
  }

  // ---- Input handlers -----------------------------------------------------
  onPointerMove(e) {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = e.clientX - rect.left;
    this.pointer.y = e.clientY - rect.top;
    this.pointer.active = true;
  }

  onPointerLeave() {
    if (this.pointer) this.pointer.active = false;
  }

  // Converts the track element's scroll position into this.scrollT (0..1),
  // and fades the "Scroll" hint out over the first ~7% of scroll.
  onScroll() {
    if (!this.track) return;
    const rect = this.track.getBoundingClientRect();
    const total = rect.height - this.dims.h;
    const scrolled = -rect.top;
    let t = total > 0 ? scrolled / total : 0;
    t = this.clamp(t, 0, 1);
    this.scrollT = t;
    if (this.hint) this.hint.style.opacity = String(Math.max(0, 1 - t * 14));
  }

  // ---- Main render loop ---------------------------------------------------
  // Runs every animation frame. For each particle, works out which stage is
  // active and where that particle should be this frame, then draws it. The
  // star stages (toStar/starHold) are handled in their own branch since a
  // particle explodes into multiple halftone sub-dots (p.starSub) there.
  loop(ts) {
    if (!this.startTime) this.startTime = ts;
    const elapsed = (ts - this.startTime) / 1000;
    const ctx = this.ctx;
    const { w, h } = this.dims;
    ctx.clearRect(0, 0, w, h);
    const t = this.scrollT || 0;
    const stage = this.getStage(t);
    const cx = w / 2,
      cy = h / 2;
    const props = this.getProps();
    const ROT_SPEED = props.rotationSpeed ?? 0.16;
    const palette =
      props.accentPalette && props.accentPalette.length
        ? props.accentPalette
        : DEFAULT_PALETTE;
    // 0 = full accent colours (word stages), 1 = fully settled to ink (star stages).
    const starPresence =
      stage.kind === "toStar"
        ? this.clamp(stage.mix * 1.4, 0, 1)
        : stage.kind === "starHold"
          ? 1
          : 0;
    const repelStrength = props.cursorRepel ?? 1;
    const repelR = Math.max(90, Math.min(w, h) * 0.17); // cursor repel radius in px
    const inStar = stage.kind === "toStar" || stage.kind === "starHold";
    if (inStar) this.starFrame(elapsed);
    if (starPresence >= 0.999) ctx.fillStyle = this.INK; // fully settled: skip per-dot colour lookups

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];

      if (inStar && p.starSub) {
        const toStar = stage.kind === "toStar";
        const lp = toStar
          ? this.wordPointsFor(stage.prevWord, i, elapsed)
          : null;
        for (let k = 0; k < p.starSub.length; k++) {
          const sub = p.starSub[k];
          const sp = this.starPointFor(sub, elapsed);
          let x, y, r;
          if (toStar) {
            // Outer ray pieces arrive last, so the star grows from its core.
            const m = this.clamp(stage.mix * 1.55 - sub.u * 0.45, 0, 1);
            const e = m * m * (3 - 2 * m); // smoothstep ease
            x = this.lerp(lp.x, sp.x, e);
            y = this.lerp(lp.y, sp.y, e);
            r = this.lerp(p.dustR, sub.dotR, e);
          } else {
            x = sp.x;
            y = sp.y;
            r = sub.dotR;
          }
          // Cursor repel: push dots within repelR away from the pointer,
          // smoothed (sub.rox/roy) so the push eases in/out instead of snapping.
          let tox = 0,
            toy = 0;
          if (this.pointer.active && repelStrength > 0) {
            const dx = x - this.pointer.x,
              dy = y - this.pointer.y;
            const d = Math.hypot(dx, dy);
            if (d < repelR) {
              const f = Math.pow(1 - d / repelR, 1.7);
              const push = f * repelR * 0.62 * repelStrength * starPresence;
              if (d > 0.001) {
                tox = (dx / d) * push;
                toy = (dy / d) * push;
              } else {
                tox = Math.cos(sub.ph) * push;
                toy = Math.sin(sub.ph) * push;
              } // dot is exactly under the cursor
            }
          }
          sub.rox += (tox - sub.rox) * 0.16;
          sub.roy += (toy - sub.roy) * 0.16;
          x += sub.rox;
          y += sub.roy;
          if (starPresence < 0.999) {
            ctx.fillStyle =
              p.colorSlot === -1
                ? this.INK
                : this.towardInk(palette[p.colorSlot], starPresence);
          }
          if (r < 1.6) {
            ctx.fillRect(x - r, y - r, r * 2, r * 2); // sub-pixel dots: a filled square reads sharper than a tiny circle
          } else {
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        continue;
      }

      // Non-star stages: one point per particle. `sx`/`sy` is always this
      // particle's live spiral position, since several stages blend into it.
      // Two layers of individual motion on top of the shared rotation:
      // orbitRateMul varies each particle's own orbital speed (differential
      // rotation, like a galaxy, instead of one rigid pinwheel), and the
      // drift term loops each particle around a tiny point of its own so
      // the swarm reads as many independently-moving dots, not one shape.
      const angleNow = p.spiralAngle0 + elapsed * ROT_SPEED * p.orbitRateMul;
      const driftAngle = elapsed * p.driftSpeed + p.driftPhase;
      const sx =
        cx + p.spiralRadius * Math.cos(angleNow) + Math.cos(driftAngle) * p.driftR;
      const sy =
        cy + p.spiralRadius * Math.sin(angleNow) + Math.sin(driftAngle) * p.driftR;
      let x, y, r;
      if (stage.kind === "static") {
        const bob = Math.sin(elapsed * 0.8 + p.seed * 6.28) * 1.3;
        x = p.gx;
        y = p.gy + bob;
        r = p.dotR;
      } else if (stage.kind === "explode") {
        const localMix = this.clamp(stage.mix * 1.9 - p.delayFrac * 0.9, 0, 1); // outer particles lag behind
        x = this.lerp(p.gx, sx, localMix);
        y = this.lerp(p.gy, sy, localMix);
        r = this.lerp(p.dotR, p.dustR, localMix);
      } else if (stage.kind === "toWord") {
        const lp = this.wordPointsFor(stage.word, i, elapsed);
        x = this.lerp(sx, lp.x, stage.mix);
        y = this.lerp(sy, lp.y, stage.mix);
        r = p.dustR;
      } else if (stage.kind === "hold") {
        const lp = this.wordPointsFor(stage.word, i, elapsed);
        x = lp.x;
        y = lp.y;
        r = p.dustR;
      } else if (stage.kind === "toSpiral") {
        const lp = this.wordPointsFor(stage.prevWord, i, elapsed);
        x = this.lerp(lp.x, sx, stage.mix);
        y = this.lerp(lp.y, sy, stage.mix);
        r = p.dustR;
      } else {
        x = sx;
        y = sy;
        r = p.dustR;
      }
      ctx.beginPath();
      ctx.fillStyle = p.colorSlot === -1 ? this.INK : palette[p.colorSlot];
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Stops the loop and tears down listeners. Call from a mount effect's cleanup. */
  unmount() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this._rt);
    window.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerMove);
    window.removeEventListener("pointerleave", this.onPointerLeave);
    window.removeEventListener("blur", this.onPointerLeave);
  }
}
