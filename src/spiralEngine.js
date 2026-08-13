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
     5. Orbit     — the star's own spikes (ORBIT_SPIKES) detach one at a
                    time, each a whole rigid needle with real 3D volume and
                    orientation, and circle the centre on a tilted ring:
                    perspective + far-to-near draw order give it real depth
                    rather than a flat spinning disc. See buildOrbitRays(),
                    orbitFrame() and orbitDotPos().

   THE TIMELINE (scroll fraction t, 0 = top of page, 1 = bottom of track)
   is *generated*, not hardcoded — buildStageDefs(wordCount) lays out:
     static -> explode -> [toWord -> hold -> toSpiral] per word (the last
     word gets toStar instead of toSpiral) -> starHold -> toOrbit -> orbitHold
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
     - Orbit act (3D ring):     the ORBIT_* fields — which spikes detach and
                                in what order, tilt, speed, radius,
                                perspective strength, detach stagger
   ============================================================================ */

import { keyForSpike } from "./keys";
import { drawKey3D, sampleKeyLocalPoints } from "./keyRenderer";
import { buildDoorArt, drawDoor } from "./door";
import { DOOR_LOCK_Y } from "./doorAssets";
import { DOOR_FILL } from "./door3d";

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
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onDoubleClick = this.onDoubleClick.bind(this);
    this.loop = this.loop.bind(this);

    this.selectedSlot = null; // index into orbitSlots, once a key is chosen
    this.selectedKey = null;
    this.unlocking = false;
    this.doorArt = null;
    // Set from Spiral.jsx once a WebGL context exists. When present, the door
    // is real 3D geometry on its own canvas behind this one; when null (no
    // WebGL) the 2D strip fallback in door.js draws it onto this canvas.
    this.door3d = null;
    // Prototype: when set (?dots=gl), the star and orbit stages draw their
    // halftone dots as WebGL points instead of to the 2D context. Everything
    // else — positions, colours, ordering — is unchanged, so the two can be
    // compared like for like. See dotsGL.js.
    this.dotsGL = null;
    this.onUnlocked = null; // set by the host; fires when the door finishes opening
    // Debug: ?unlock=0.72 in the URL jumps straight to the orbit with a key
    // already selected and FREEZES the unlock at that fraction of the
    // sequence. Lets one moment of the door be inspected without scrolling
    // the whole track and clicking through every time. null = normal.
    this._debugU = null;
    this._debugT = null; // ?t= pins scrollT, for comparing one stage
    // Free look inside the orbit. Identity by default, so the default framing
    // is exactly what it was before this existed. `t*` are the drag targets;
    // the un-prefixed values chase them (see updateView).
    this.view = {
      yaw: 0,
      pitch: 0,
      panX: 0,
      panY: 0,
      tYaw: 0,
      tPitch: 0,
      tPanX: 0,
      tPanY: 0,
    };
    this._drag = null;
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
    const TO_ORBIT = 0.1,
      ORBIT_HOLD = 0.16; // generous: this is the interactive final act
    const rawTotal =
      STATIC +
      EXPLODE +
      TO_STAR +
      STAR_HOLD +
      TO_ORBIT +
      ORBIT_HOLD +
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
    push("toOrbit", TO_ORBIT);
    push("orbitHold", ORBIT_HOLD);
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

    this.buildOrbitRays();
  }

  // ---- Orbiting ray pieces (the final act) ------------------------------------
  // Every spike of the star detaches, one at a time, and circles the centre
  // on a tilted orbit. Three things make this work:
  //
  //   1. Each piece is a WHOLE spike. Dots are partitioned by nearestRay(),
  //      with no inner cutoff, so a piece runs from the star's centre all the
  //      way out to its tip — the complete wedge-to-needle shape, with
  //      nothing left behind as a stub.
  //
  //   2. A detaching spike moves as a RIGID BODY in 3D. Each dot is stored in
  //      the spike's own frame — rayAlong (out along the axis), rayAcross
  //      (perpendicular, in the star's plane), rayUp (perpendicular, out of
  //      it) — and the transition interpolates that *frame*: pivot and the
  //      three axis vectors. Interpolating each dot's position independently
  //      instead would collapse the needle through its own centre whenever
  //      the rotation is large, which is what made it look shredded.
  //
  //   3. The needles are REAL 3D, not billboards. Each stands upright along
  //      the ring's normal (see orbitFrame) with its width along the track and
  //      its thickness radial, so it foreshortens and leans as it swings
  //      around, and rayUp gives it a round cross-section instead of zero
  //      thickness. That thickness is scaled by detach progress, so a piece
  //      "inflates" from the star's flat halftone into a solid needle as it
  //      leaves.
  //
  // Indices into starTips(): 0:-137° 1:-90° 2:-47° 3:0° 4:43° 5:90° 6:136° 7:180°
  // Listed in detach order: starts with the long bottom ray, then sweeps
  // around the circle. Drop entries here to keep those spikes on the star.
  ORBIT_SPIKES = [5, 6, 7, 0, 1, 2, 3, 4];
  ORBIT_TILT_DEG = 62; // 0 = flat circle facing the viewer, 90 = fully edge-on
  ORBIT_SPEED = 0.32; // orbital angular speed, rad/s
  ORBIT_RADIUS_FRAC = 0.3; // orbit radius, as a fraction of min(w,h)
  ORBIT_FOCAL = 520; // perspective focal length in px — smaller = stronger depth
  ORBIT_UNDULATE = 0.15; // vertical rise/fall of the track, as a fraction of radius
  // Which point along a spike rides the track (0 = base, 1 = tip). 0.5 centres
  // each needle on the ring; because the pieces stand upright, a low value
  // instead pushes all their mass above the ring and the whole composition
  // drifts up out of frame.
  ORBIT_ANCHOR = 0.5;
  ORBIT_DETACH_WINDOW = 0.42; // fraction of the toOrbit stage one piece's flight takes
  ORBIT_DEPTH_FADE = 2.2; // how much far dots fade; 0 = no depth shading
  ORBIT_MIN_ALPHA = 0.3; // floor on that fade, so far dots never vanish
  ORBIT_THICKNESS = 1.5; // multiplier on each needle's cross-section thickness
  // How far each needle tips outward from the ring's normal, in degrees.
  // This one matters more than it looks: at 0 every needle points along the
  // normal, which is the SAME direction everywhere on the ring — so the
  // pieces stay permanently parallel, never rotate, and the whole thing reads
  // flat no matter how strong the perspective is. Leaning them outward makes
  // each one's axis swing through 3D as it orbits, which is what actually
  // sells the depth. 90 would lay them flat in the orbital plane.
  ORBIT_LEAN_DEG = 38;

  // ---- Key transformation -----------------------------------------------------
  // Clicking an orbiting spike that has a key registered for it (see
  // src/keys/index.js) morphs that piece into a solid 3D key: the piece
  // freezes where it is, its dots gather into the key's silhouette and fade,
  // and the solid key fades in over them.
  KEY_MORPH_SECS = 1.3; // how long the whole dots -> solid key morph takes
  KEY_FIT = 1.05; // key height as a multiple of the needle it replaces
  KEY_PICK_RADIUS = 80; // click tolerance around a piece's axis, screen px

  // ---- Unlock sequence --------------------------------------------------------
  // Clicking an already-formed key runs the whole unlock: the rest of the ring
  // clears out, a door rises behind, the key flies to the keyhole, turns, and
  // the door swings open. All of it is driven off one 0..1 progress value, so
  // the phases below just carve up that range and overlap where a hand-off
  // should feel continuous.
  // The unlock is staged as a journey through a room rather than a cut to a
  // door. The whitespace IS the room: the door rises out of its floor, comes
  // to rest standing at a distance behind the still-orbiting pieces, and only
  // then travels forward until it fills the frame. Overlaps are deliberate —
  // each move starts before the last has quite settled, so the sequence reads
  // as one continuous action instead of a list of steps.
  UNLOCK_SECS = 6.4;
  U_RISE = [0.0, 0.26]; // door slides up out of the floor, far off
  U_CLEAR = [0.2, 0.36]; // the remaining pieces sweep away
  U_APPROACH = [0.28, 0.54]; // door travels forward until it fills the frame
  U_FLIGHT = [0.34, 0.62]; // key crosses to the keyhole, travelling WITH the
  //   approach rather than after it, so the two read as one movement inward
  U_INSERT = [0.62, 0.74]; // key seats into the hole
  U_TURN = [0.74, 0.88]; // key rotates — the actual unlocking
  U_SWING = [0.88, 1.0]; // door opens
  KEY_DOOR_SCALE = 0.26; // key height at the door, as a fraction of min(w,h)
  KEY_PIVOT_Y = 0.72; // point along the key (local units) that enters the hole
  // How far the key rotates to unlock. The turn is about the SHAFT, so the
  // key's flat face swings toward edge-on and it narrows as it goes — near a
  // right angle it's a sliver and reads as having vanished rather than turned.
  // Stopping around 54 degrees keeps ~60% of its width and still reads as a
  // decisive turn.
  KEY_TURN_ANGLE = Math.PI * 0.3;
  // How far the key pitches over to point into the door as it enters. Short
  // of a right angle deliberately: at exactly 90 degrees the key aims straight
  // down the view axis and projects to a flat line, so it disappears.
  KEY_INSERT_TILT = Math.PI * 0.22;
  // ---- Free look ----
  VIEW_DRAG_SPEED = 0.006; // radians of rotation per pixel dragged
  VIEW_PAN_SPEED = 1; // screen px of pan per pixel dragged
  VIEW_PITCH_LIMIT = (74 * Math.PI) / 180; // short of straight down: past this
  //   the ring is edge-on and there is nothing left to look at
  VIEW_EASE = 0.14; // per-frame approach to the drag target
  VIEW_DRAG_SLOP = 5; // px of movement before a press stops being a click

  // Partitions every halftone dot into its spike and records it in that
  // spike's local 3D frame. Dots belonging to spikes not listed in
  // ORBIT_SPIKES stay in star formation forever (orbitResidue).
  buildOrbitRays() {
    const n = this.ORBIT_SPIKES.length;

    // Per-spike constants: axis angle, how far out the needle runs, and the
    // point along it that rides the orbit track.
    this.orbitSlots = this.ORBIT_SPIKES.map((spikeIdx) => {
      const a = this.starTipsList[spikeIdx].a;
      const tipLen = this.starTipsList[spikeIdx].len;
      return {
        spikeIdx,
        spikeAngle: a,
        needleLen: Math.max(1, tipLen),
        anchorAlong: tipLen * this.ORBIT_ANCHOR,
      };
    });

    const slotOf = new Map(this.ORBIT_SPIKES.map((s, i) => [s, i]));
    const groups = Array.from({ length: n }, () => []);
    const residue = [];

    for (const p of this.particles) {
      if (!p.starSub) continue;
      for (const sub of p.starSub) {
        const slotIdx = slotOf.get(sub.ray);
        if (slotIdx === undefined) {
          sub.orbitSlot = -1; // a spike that stays put
          residue.push({ p, sub });
          continue;
        }
        const slot = this.orbitSlots[slotIdx];
        // The dot's resting position relative to the star centre, rewritten
        // in its spike's frame — moving/rotating that frame later carries the
        // needle's exact shape along with it.
        const x = sub.r0 * Math.cos(sub.theta);
        const y = sub.r0 * Math.sin(sub.theta);
        const ca = Math.cos(slot.spikeAngle),
          sa = Math.sin(slot.spikeAngle);
        sub.rayAlong = x * ca + y * sa;
        sub.rayAcross = -x * sa + y * ca;
        sub.orbitSlot = slotIdx;
        groups[slotIdx].push({ p, sub });
      }
    }

    // Give each needle a round cross-section. The star is a flat halftone, so
    // there's no real depth to read off it: instead, measure how wide the
    // spike is at each point along its axis (bucketed max |across|), then
    // treat that as the radius of a circular cross-section and place the dot
    // somewhere on the remaining out-of-plane chord. Result is a spindle with
    // volume rather than a flat sheet.
    const NB = 48;
    groups.forEach((g, gi) => {
      const slot = this.orbitSlots[gi];
      const half = new Float64Array(NB);
      const bucketOf = (along) =>
        this.clamp(Math.floor((along / slot.needleLen) * NB), 0, NB - 1);
      for (const { sub } of g) {
        const b = bucketOf(sub.rayAlong);
        const across = Math.abs(sub.rayAcross);
        if (across > half[b]) half[b] = across;
      }
      let i = 0;
      for (const { sub } of g) {
        const hw = half[bucketOf(sub.rayAlong)];
        const room = Math.sqrt(
          Math.max(0, hw * hw - sub.rayAcross * sub.rayAcross),
        );
        sub.rayUp =
          (this.hash(i * 13.77 + gi * 3.1) - 0.5) *
          2 *
          room *
          this.ORBIT_THICKNESS;
        i++;
      }
    });

    this.orbitGroups = groups;
    this.orbitResidue = residue;
  }

  // Perspective factor for a given depth. The denominator is floored so a
  // large ORBIT_RADIUS_FRAC against a short ORBIT_FOCAL can't drive a near
  // piece through the camera and invert (or explode) its projection.
  orbitPersp(z) {
    const f = this.ORBIT_FOCAL;
    return f / Math.max(f * 0.25, f + z);
  }

  /* ---- Free look --------------------------------------------------------
     The orbit stage is a real 3D space you can walk around in, and this is
     the one door between that space and the screen. Every orbit stage draws
     through project(): the needles, the star core they left behind, and the
     key. Putting the camera here rather than in each of them is what keeps
     them in the same space — miss one and it stays welded to the screen
     while everything else swings past it.

     Identity until the user drags, so the default composition is untouched.
     ---------------------------------------------------------------------- */

  /** Rotates a world point into view space, then projects it to the screen. */
  project(x, y, z) {
    const v = this.view;
    const cy = Math.cos(v.yaw),
      sy = Math.sin(v.yaw);
    const cp = Math.cos(v.pitch),
      sp = Math.sin(v.pitch);
    const ax = x * cy + z * sy; // yaw about the vertical
    const az = z * cy - x * sy;
    const ay = y * cp - az * sp; // then pitch about the horizontal
    const bz = az * cp + y * sp;
    const persp = this.orbitPersp(bz);
    return {
      // Pan is applied in SCREEN space, after the divide. Panning in world
      // space would slide the scene through the perspective and warp it;
      // this just moves the window you're looking through.
      x: this.orbitCx + v.panX + ax * persp,
      y: this.orbitCy + v.panY + ay * persp,
      scale: persp,
      z: bz,
    };
  }

  /**
   * Rotates a world point or vector into view space, without projecting.
   * The GL scene lives in view space (the camera itself never moves), so
   * anything handed to the GPU as geometry rather than as a screen position
   * goes through here first.
   */
  viewRotate(x, y, z) {
    const v = this.view;
    const cy = Math.cos(v.yaw),
      sy = Math.sin(v.yaw);
    const cp = Math.cos(v.pitch),
      sp = Math.sin(v.pitch);
    const ax = x * cy + z * sy;
    const az = z * cy - x * sy;
    return { x: ax, y: y * cp - az * sp, z: az * cp + y * sp };
  }

  /**
   * The key's placement on its orbiting piece, as an origin plus three axes,
   * in the coordinates three.js wants.
   *
   * The 2D renderer gets away with a point-mapping function; a mesh needs a
   * basis. Reading it off the same piece frame keeps the two in step:
   *   mesh X -> the needle's width axis, mesh Y -> its long axis,
   *   mesh Z -> its thickness. (buildKeyMesh already flipped the key's
   *   authored y-down, which is why Y maps to +along and not -along.)
   */
  keyBasisForPiece(f) {
    const len = f.slot.needleLen;
    const s = (len / 2.4) * this.KEY_FIT; // key geometry is 2.4 units tall
    const d = len / 2 - f.slot.anchorAlong; // key's middle at the needle's
    const conv = (x, y, z) => {
      const r = this.viewRotate(x, y, z);
      // Engine y runs down and z runs away; three's run up and toward.
      return [r.x, -r.y, -r.z];
    };
    return {
      o: conv(f.px + d * f.ax, f.py + d * f.ay, f.pz + d * f.az),
      x: conv(f.cx * s, f.cy * s, f.cz * s),
      y: conv(f.ax * s, f.ay * s, f.az * s),
      z: conv(f.ux * s, f.uy * s, f.uz * s),
    };
  }

  /** Just the view-space depth — for painter ordering, which can't use world z. */
  viewDepth(x, y, z) {
    const v = this.view;
    const az = z * Math.cos(v.yaw) - x * Math.sin(v.yaw);
    return az * Math.cos(v.pitch) + y * Math.sin(v.pitch);
  }

  /** A star-formation screen point, lifted into the orbit's space at z = 0. */
  projectStarPoint(sp) {
    return this.project(sp.x - this.orbitCx, sp.y - this.orbitCy, 0);
  }

  /**
   * Eases the live view toward wherever the drag left it. Called once a frame.
   * Smoothing rather than snapping because the pieces are already in motion —
   * a camera that stops dead the instant you release reads as a glitch.
   */
  updateView() {
    const v = this.view;
    const k = this.VIEW_EASE;
    v.yaw += (v.tYaw - v.yaw) * k;
    v.pitch += (v.tPitch - v.pitch) * k;
    v.panX += (v.tPanX - v.panX) * k;
    v.panY += (v.tPanY - v.panY) * k;
  }

  /** Returns the view to its default framing. */
  resetView(immediate = false) {
    const v = this.view;
    v.tYaw = v.tPitch = v.tPanX = v.tPanY = 0;
    if (immediate) {
      v.yaw = v.pitch = v.panX = v.panY = 0;
    }
  }

  /** True when the pointer should be steering the camera rather than picking. */
  canFreeLook() {
    return (
      !this.unlocking &&
      this.stageDefs &&
      ["toOrbit", "orbitHold"].includes(this.getStage(this.scrollT).kind)
    );
  }

  // Per-frame, per-piece state: computed once per piece here rather than per
  // halftone dot (there are thousands of those). Builds each piece's full 3D
  // frame — pivot plus three axis vectors — interpolated from "attached and
  // flat on the star" to "in orbit and fully 3D". Also fixes the draw order:
  // far pieces first, so nearer ones paint over them.
  orbitFrame(elapsed, stageMix) {
    const { w, h } = this.dims;
    const n = this.orbitSlots.length;
    const T = (this.ORBIT_TILT_DEG * Math.PI) / 180;
    const cosT = Math.cos(T),
      sinT = Math.sin(T);
    const R = Math.min(w, h) * this.ORBIT_RADIUS_FRAC;
    this.orbitRadius = R;
    this.orbitCx = w / 2;
    this.orbitCy = h / 2;

    // The orbital plane is spanned by e1 = (1,0,0) and e2 = (0,cosT,sinT), so
    // its normal — the "upright" direction the pieces stand along — is:
    const nx = 0,
      ny = -sinT,
      nz = cosT;
    const lean = (this.ORBIT_LEAN_DEG * Math.PI) / 180;
    const cosL = Math.cos(lean),
      sinL = Math.sin(lean);

    // Stagger so pieces leave one after another, the last finishing just as
    // the stage ends. They overlap slightly, which reads more naturally than
    // a strictly one-at-a-time queue.
    const win = this.ORBIT_DETACH_WINDOW;
    const step = n > 1 ? (1 - win) / (n - 1) : 0;

    const frames = this._orbitFrames || (this._orbitFrames = []);
    for (let k = 0; k < n; k++) {
      const slot = this.orbitSlots[k];
      const pose = frames[k] || (frames[k] = {});
      const phi = elapsed * this.ORBIT_SPEED + (k * Math.PI * 2) / n;
      const cp = Math.cos(phi),
        sp = Math.sin(phi);

      // Where on the ring this piece sits. The gentle second-harmonic lift
      // makes the track rise and fall like a ribbon instead of sitting
      // perfectly in one plane.
      const lift = Math.sin(phi * 2 + k * 0.7) * R * this.ORBIT_UNDULATE;
      const tx = cp * R;
      const ty = sp * R * cosT + lift;
      const tz = sp * R * sinT;

      // 3D direction of travel (d/dphi of the ring), and the in-plane radial
      // direction that completes an orthonormal frame with the plane normal
      // (d x N works out to exactly "outward from the centre, in-plane").
      let dx = -sp,
        dy = cp * cosT,
        dz = cp * sinT;
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;
      let bx = dy * nz - dz * ny,
        by = dz * nx - dx * nz,
        bz = dx * ny - dy * nx;
      const bl = Math.hypot(bx, by, bz) || 1;
      bx /= bl;
      by /= bl;
      bz /= bl;

      const m = this.clamp((stageMix - k * step) / win, 0, 1);
      const e = m * m * (3 - 2 * m); // smoothstep ease

      // The piece's frame while still attached: pivot at its anchor point on
      // the star, axes flat in the screen plane. Star and orbit centres
      // differ, so express the pivot relative to the orbit centre.
      const a = slot.spikeAngle;
      const fx = Math.cos(a),
        fy = Math.sin(a);
      const sx = this.starCx - this.orbitCx + slot.anchorAlong * fx;
      const sy = this.starCy - this.orbitCy + slot.anchorAlong * fy;

      pose.e = e;
      pose.px = this.lerp(sx, tx, e);
      pose.py = this.lerp(sy, ty, e);
      pose.pz = tz * e;

      // The needle's long axis: the ring's normal, tipped outward toward the
      // radial direction by ORBIT_LEAN_DEG, so the pieces stand upright-ish
      // but splay outward like a crown. Because the radial direction rotates
      // as a piece travels round the ring, its long axis genuinely swings
      // through 3D — that rotation is the main thing making it read solid.
      const gx = cosL * nx + sinL * bx,
        gy = cosL * ny + sinL * by,
        gz = cosL * nz + sinL * bz;
      // The remaining perpendicular, in the same normal/radial plane — this is
      // the axis the cross-section's thickness sticks out along.
      const hx = -sinL * nx + cosL * bx,
        hy = -sinL * ny + cosL * by,
        hz = -sinL * nz + cosL * bz;

      // Axis vectors, normalised-lerped between the two frames. Close enough
      // to a proper slerp over this short a flight, and far cheaper.
      let axx = this.lerp(fx, gx, e),
        axy = this.lerp(fy, gy, e),
        axz = gz * e;
      const al = Math.hypot(axx, axy, axz) || 1;
      pose.ax = axx / al;
      pose.ay = axy / al;
      pose.az = axz / al;

      // Width runs along the direction of travel.
      let cxx = this.lerp(-fy, dx, e),
        cyy = this.lerp(fx, dy, e),
        czz = dz * e;
      const cl = Math.hypot(cxx, cyy, czz) || 1;
      pose.cx = cxx / cl;
      pose.cy = cyy / cl;
      pose.cz = czz / cl;

      pose.ux = hx;
      pose.uy = hy;
      pose.uz = hz;
      pose.slot = slot;
      // Coarse piece-level depth ordering, in VIEW space rather than world
      // space. Sorting on world z would be right only from the default
      // camera; swing round behind the ring and the painter order inverts,
      // so near pieces get painted over by far ones.
      pose.z = this.viewDepth(pose.px, pose.py, pose.pz);
    }

    this._orbitOrder = frames
      .map((_, i) => i)
      .sort((a, b) => frames[b].z - frames[a].z);
  }

  // Screen placement of one halftone dot inside its piece: position it in the
  // piece's 3D frame, then project. Out-of-plane thickness is scaled by
  // detach progress so an attached piece is exactly as flat as the star it's
  // still part of.
  orbitDotPos(sub, f) {
    const la = sub.rayAlong - f.slot.anchorAlong;
    const lc = sub.rayAcross;
    const lu = sub.rayUp * f.e;
    return this.project(
      f.px + la * f.ax + lc * f.cx + lu * f.ux,
      f.py + la * f.ay + lc * f.cy + lu * f.uy,
      f.pz + la * f.az + lc * f.cz + lu * f.uz,
    );
  }

  // ---- Key selection ----------------------------------------------------------

  // Which orbiting piece is under a screen point, or -1. Each piece is tested
  // as a thick line down its own axis: sample a few points along the needle,
  // project them, and measure the click against those segments. Far cheaper
  // and steadier than testing thousands of individual dots, and a needle is
  // near enough to a line for picking.
  hitTestPieces(px, py, keyedOnly = false) {
    if (!this._orbitFrames || !this.orbitSlots) return -1;
    const probe = { rayAcross: 0, rayUp: 0, rayAlong: 0 };
    let best = -1;
    let bestScore = 1; // normalised distance; < 1 counts as a hit
    for (let k = 0; k < this._orbitFrames.length; k++) {
      // Skip spikes with no key registered, so hover only ever highlights
      // something that will actually respond to a click.
      if (keyedOnly && !keyForSpike(this.orbitSlots[k].spikeIdx)) continue;
      const f = this._orbitFrames[k];
      const len = f.slot.needleLen;
      let prev = null;
      for (let s = 0; s <= 6; s++) {
        probe.rayAlong = (s / 6) * len;
        const q = this.orbitDotPos(probe, f);
        if (prev) {
          const d = this.distToSegment(px, py, prev.x, prev.y, q.x, q.y);
          // Tolerance follows the piece's perspective scale, so a near piece
          // is as easy to hit as a far one.
          const tol = this.KEY_PICK_RADIUS * ((prev.scale + q.scale) / 2);
          const score = d / tol;
          if (score < bestScore) {
            bestScore = score;
            best = k;
          }
        }
        prev = q;
      }
    }
    return best;
  }

  distToSegment(px, py, x0, y0, x1, y1) {
    const dx = x1 - x0,
      dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
    t = this.clamp(t, 0, 1);
    return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
  }

  /** Begins the morph for piece `k`, or clears the selection when passed -1. */
  selectPiece(k, elapsed) {
    if (k < 0) {
      this.selectedSlot = null;
      this.selectedKey = null; // or the door would later build for a stale key
      return;
    }
    const spikeIdx = this.orbitSlots[k].spikeIdx;
    const def = keyForSpike(spikeIdx);
    if (!def) return; // this spike has no key yet — leave it orbiting
    this.selectedSlot = k;
    this.selectedKey = def;
    this._selectT0 = elapsed;

    // Give each of this piece's dots a destination inside the key outline.
    const group = this.orbitGroups[k];
    const pts = sampleKeyLocalPoints(def, group.length, (i) =>
      this.hash(i * 3.71 + 0.7),
    );
    group.forEach((ref, i) => {
      ref.sub.keyLocal = pts[i];
    });

    // Build the door now rather than on the unlock click. Nothing is shown
    // yet, but choosing a key is the strongest signal we get that the door is
    // about to be needed, and this is the expensive step.
    this.ensureDoorArt();
  }

  // Maps the key's own 2D space into a piece's 3D frame, so the key rides the
  // ring exactly where its needle was — same position, tilt and depth. The
  // key replaces the needle in place; it never leaves the orbit.
  //
  // The key is authored y-down with its bow at the top, and a needle's `along`
  // axis runs outward from the ring's centre, so key y maps to NEGATIVE along
  // — that puts the bow at the needle's outer tip.
  keyProjectForPiece(f) {
    const len = f.slot.needleLen;
    const scale = (len / 2.4) * this.KEY_FIT; // key geometry is 2.4 units tall
    const centerAlong = len / 2; // sit the key's middle at the needle's middle
    const probe = { rayAlong: 0, rayAcross: 0, rayUp: 0 };
    return (kx, ky, kz) => {
      probe.rayAlong = centerAlong - ky * scale;
      probe.rayAcross = kx * scale;
      probe.rayUp = kz * scale;
      return this.orbitDotPos(probe, f);
    };
  }

  /**
   * The point along the key (its own units, y down) currently sitting in the
   * keyhole. Starts at the key's TIP — so the flight ends with the key merely
   * touching the lock — and travels up the shaft to KEY_PIVOT_Y as it seats.
   *
   * Insertion is this number moving, and nothing else. The key's position and
   * the 3D clipping plane that swallows it are both derived from it, so how
   * far in the key looks and how far in the key is can't drift apart.
   */
  keyPivotNow(u) {
    const tip = this.selectedKey?.bounds?.y1 ?? 1.2;
    // Where the key stops going in. Declared per key (see geom.js's `lock`),
    // because it depends on where that key's bit begins — a fixed fraction
    // put the widest part of the lilac key's teeth inside a slot sized for
    // its much narrower stem.
    const seated = this.selectedKey?.lock?.pivotY ?? this.KEY_PIVOT_Y;
    return this.lerp(tip, seated, this.phase(u, this.U_INSERT));
  }

  /** World units per key unit once the key is at the door. */
  keyDoorScale() {
    const { w, h } = this.dims;
    // Sized against the DOOR, not the viewport — the frame means those differ.
    return (Math.min(w, h) * DOOR_FILL * this.KEY_DOOR_SCALE) / 2.4;
  }

  /** 0 while nothing is selected, ramping to 1 as the morph completes. */
  selectProgress(elapsed) {
    if (this.selectedSlot == null) return 0;
    if (this._debugU !== null) return 1; // skip the morph; we want it formed
    return this.clamp((elapsed - this._selectT0) / this.KEY_MORPH_SECS, 0, 1);
  }

  /** Begins the unlock. Only valid on a key that has finished forming. */
  startUnlock(elapsed) {
    if (this.unlocking) return;
    // Bring the camera home. The door is a fixed backdrop that does NOT swing
    // with the free look, and the key's flight ends at the world origin —
    // which is only the keyhole's position from the default view. Left
    // rotated, the key would fly to somewhere off the lock entirely. The ease
    // has the whole clear-out and door fade-in to settle.
    this.resetView();
    this.unlocking = true;
    this._unlockT0 = elapsed;
    this._unlockFired = false;
    this.ensureDoorArt();
  }

  /** 0 until the unlock starts, then ramps to 1 as the door finishes opening. */
  unlockProgress(elapsed) {
    if (this._debugU !== null) return this._debugU;
    if (!this.unlocking) return 0;
    return this.clamp((elapsed - this._unlockT0) / this.UNLOCK_SECS, 0, 1);
  }

  /** Tears the whole sequence down, back to a plain orbiting ring. */
  resetUnlock() {
    this.unlocking = false;
    this._unlockFired = false;
    this.selectedSlot = null;
    this.selectedKey = null;
  }

  // The door art is costly to build (two full-size paint passes, plus the
  // normal map derived from them) and never changes, so it's made once for the
  // current viewport and thrown away only on resize. Called on *selection*
  // rather than on the click that unlocks, so the cost lands seconds before
  // the door is needed instead of as a hitch on the first frame of the fade.
  ensureDoorArt() {
    const { w, h } = this.dims;
    if (this.door3d?.ok) {
      this.door3d.ensure(
        w,
        h,
        this.selectedKey?.doorText || "",
        this.selectedKey,
        this.keyDoorScale(),
      );
      // The lock and the key belong to the dots scene, not the door's.
      this.dotsGL?.ensureLock(w, h, this.keyDoorScale(), this.selectedKey);
      return;
    }
    if (this.doorArt && this.doorArt.W === w && this.doorArt.H === h) return;
    this.doorArt = buildDoorArt(w, h, this.selectedKey?.doorText || "");
  }

  // Eases a phase window into its own 0..1, so each step of the sequence can
  // be written against its own local progress.
  phase(u, range) {
    return this.smoothstep(range[0], range[1], u);
  }

  // The key's frame during the unlock: it starts exactly where the orbiting
  // piece is and ends face-on at the keyhole, turned. Interpolating the FRAME
  // (origin, axes, scale) rather than each point keeps the key rigid — a
  // straight per-point lerp would squash it flat halfway through, since the
  // start and end orientations are far apart.
  keyUnlockFrame(f, u) {
    const { w, h } = this.dims;
    const len = f.slot.needleLen;

    // Start: the key riding its piece, expressed as an origin plus three axes.
    const startScale = (len / 2.4) * this.KEY_FIT;
    const la = len / 2 - f.slot.anchorAlong;
    const o0 = [
      f.px + la * f.ax,
      f.py + la * f.ay,
      f.pz + la * f.az,
    ];
    const x0 = [f.cx, f.cy, f.cz];
    const y0 = [-f.ax, -f.ay, -f.az]; // key y is down; needle `along` runs out
    const z0 = [f.ux, f.uy, f.uz];

    // End: square to the screen at the keyhole, rotated by the turn.
    const turn = this.phase(u, this.U_TURN) * this.KEY_TURN_ANGLE;
    const ct = Math.cos(turn),
      st = Math.sin(turn);
    const x1 = [ct, st, 0];
    const y1 = [-st, ct, 0];
    const z1 = [0, 0, 1];
    const endScale = (Math.min(w, h) * this.KEY_DOOR_SCALE) / 2.4;
    // Place the key so the point currently entering the lock lands in the
    // keyhole (world origin is screen centre, which is where the keyhole is).
    // Because that offset is expressed along the *rotated* y axis, the key
    // swings around the keyhole rather than about its own middle.
    // Offset along BOTH rotated axes: the shaft's axis is off the key's centre
    // (ornament hangs to one side), so ignoring x would aim the bounding box
    // at the keyhole rather than the stem.
    const pivot = this.keyPivotNow(u);
    const pivotX = this.selectedKey?.lock?.pivotX ?? 0;
    // The keyhole is not necessarily at screen centre — DOOR_LOCK_Y puts it
    // wherever the door art leaves a clear band. Without this the key flies
    // to the middle of the screen and the lock is somewhere else.
    const lockY = this.dotsGL?.lockScreenY() ?? (DOOR_LOCK_Y - 0.5) * h;
    // Land in FRONT of the lock plate, not on the door's own plane. The plate
    // stands proud of the surface, so ending at z = 0 puts the key behind it
    // for the whole late approach and then snaps it forward at the handoff.
    // Engine z runs away from the viewer; three's runs toward, hence negated.
    const zFront = -(this.dotsGL?.keyRestZ() ?? 0);
    const o1 = [
      -endScale * (pivot * y1[0] + pivotX * x1[0]),
      -endScale * (pivot * y1[1] + pivotX * x1[1]) + lockY,
      zFront,
    ];

    const t = this.phase(u, this.U_FLIGHT);
    // Orientation leads the journey. Blending both at the same rate drags the
    // key through edge-on around halfway, and a real solid seen edge-on is a
    // sliver — the flat 2D key never had this problem because it always drew
    // its full silhouette. Turning face-on in the first half of the flight
    // keeps it readable for the part anyone actually watches.
    const tA = this.clamp(t * 1.9, 0, 1);
    const mix3 = (a, b) => {
      const v = [
        this.lerp(a[0], b[0], tA),
        this.lerp(a[1], b[1], tA),
        this.lerp(a[2], b[2], tA),
      ];
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      return [v[0] / l, v[1] / l, v[2] / l];
    };
    // DEPTH ARRIVES FIRST. The lock fades in partway through the flight, and
    // a key still at ring depth when that happens is behind the plate — it
    // spends the rest of the crossing occluded and then pops through. Pulling
    // the key forward early means it is clear of the lock before the lock
    // exists, and the remaining travel is across the frame rather than into
    // it. Reads as "brought to the front, then carried across", which is also
    // the more legible of the two.
    const tZ = this.clamp(t * 2.2, 0, 1);
    const O = [
      this.lerp(o0[0], o1[0], t),
      this.lerp(o0[1], o1[1], t),
      this.lerp(o0[2], o1[2], tZ),
    ];
    const X = mix3(x0, x1);
    const Y = mix3(y0, y1);
    const Z = mix3(z0, z1);
    const s = this.lerp(startScale, endScale, t);
    return { O, X, Y, Z, s };
  }

  /** The unlock frame as a point mapper, for the 2D fallback renderer. */
  keyUnlockProject(f, u) {
    const { O, X, Y, Z, s } = this.keyUnlockFrame(f, u);
    return (kx, ky, kz) => {
      const ax = kx * s,
        ay = ky * s,
        az = kz * s;
      return this.project(
        O[0] + ax * X[0] + ay * Y[0] + az * Z[0],
        O[1] + ax * X[1] + ay * Y[1] + az * Z[1],
        O[2] + ax * X[2] + ay * Y[2] + az * Z[2],
      );
    };
  }

  /**
   * The same unlock frame as a basis for the GL mesh.
   *
   * Without this the key vanishes for the whole flight: the mesh only knew
   * how to sit on an orbiting piece, and the door's own copy doesn't appear
   * until the handoff at the end of the approach.
   */
  keyUnlockBasis(f, u) {
    const { O, X, Y, Z, s } = this.keyUnlockFrame(f, u);
    const conv = (x, y, z) => {
      const r = this.viewRotate(x, y, z);
      return [r.x, -r.y, -r.z];
    };
    return {
      o: conv(O[0], O[1], O[2]),
      x: conv(X[0] * s, X[1] * s, X[2] * s),
      // buildKeyMesh already flipped the key's authored y-down, so the mesh's
      // Y axis is the negative of the frame's.
      y: conv(-Y[0] * s, -Y[1] * s, -Y[2] * s),
      z: conv(Z[0] * s, Z[1] * s, Z[2] * s),
    };
  }

  // Cursor repel, shared by the star and orbit stages: pushes a dot away
  // from the pointer within `radius`, smoothed through sub.rox/roy so the
  // push eases in and out instead of snapping.
  repelFromPointer(sub, x, y, strength, radius, presence) {
    let tox = 0,
      toy = 0;
    if (this.pointer.active && strength > 0) {
      const dx = x - this.pointer.x,
        dy = y - this.pointer.y;
      const d = Math.hypot(dx, dy);
      if (d < radius) {
        const f = Math.pow(1 - d / radius, 1.7);
        const push = f * radius * 0.62 * strength * presence;
        if (d > 0.001) {
          tox = (dx / d) * push;
          toy = (dy / d) * push;
        } else {
          tox = Math.cos(sub.ph) * push; // dot is exactly under the cursor
          toy = Math.sin(sub.ph) * push;
        }
      }
    }
    sub.rox += (tox - sub.rox) * 0.16;
    sub.roy += (toy - sub.roy) * 0.16;
    return { x: x + sub.rox, y: y + sub.roy };
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
    window.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("dblclick", this.onDoubleClick);
    window.addEventListener("pointerleave", this.onPointerLeave);
    window.addEventListener("blur", this.onPointerLeave);
    const params = new URLSearchParams(window.location.search);
    const dbg = params.get("unlock");
    if (dbg !== null) this._debugU = this.clamp(parseFloat(dbg) || 0, 0, 1);
    const dbgT = params.get("t");
    if (dbgT !== null) this._debugT = this.clamp(parseFloat(dbgT) || 0, 0, 1);
    // Debug: ?yaw=0.7&pitch=0.4 starts the free look already swung round, so a
    // given viewpoint can be reproduced (or screenshotted) without dragging.
    const yaw = params.get("yaw");
    const pitch = params.get("pitch");
    if (yaw !== null) this.view.yaw = this.view.tYaw = parseFloat(yaw) || 0;
    if (pitch !== null) {
      this.view.pitch = this.view.tPitch = parseFloat(pitch) || 0;
    }
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
      // Door art is built for the old viewport size; drop it and let the
      // unlock rebuild it on demand. (Door3D.ensure() compares against the
      // size it last built for, so it invalidates itself.)
      this.doorArt = null;
      if (this.unlocking || this.selectedSlot != null) this.ensureDoorArt();
    }, 200);
  }

  // ---- Input handlers -----------------------------------------------------
  onPointerMove(e) {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = e.clientX - rect.left;
    this.pointer.y = e.clientY - rect.top;
    this.pointer.active = true;

    // Steering the camera. Once past the slop threshold this press is a drag,
    // not a click — the flag survives until pointerup so releasing after a
    // swing doesn't also select whatever happens to be under the cursor.
    if (this._drag) {
      const dx = e.clientX - this._drag.lastX;
      const dy = e.clientY - this._drag.lastY;
      this._drag.lastX = e.clientX;
      this._drag.lastY = e.clientY;
      this._drag.travel += Math.abs(dx) + Math.abs(dy);
      if (this._drag.travel > this.VIEW_DRAG_SLOP) {
        this._drag.moved = true;
        const v = this.view;
        if (this._drag.pan) {
          v.tPanX += dx * this.VIEW_PAN_SPEED;
          v.tPanY += dy * this.VIEW_PAN_SPEED;
        } else {
          v.tYaw += dx * this.VIEW_DRAG_SPEED;
          v.tPitch = this.clamp(
            v.tPitch - dy * this.VIEW_DRAG_SPEED,
            -this.VIEW_PITCH_LIMIT,
            this.VIEW_PITCH_LIMIT,
          );
        }
        this.canvas.style.cursor = "grabbing";
      }
      return; // no hover testing mid-drag; the scene is moving under the cursor
    }

    // Track which keyed spike is under the cursor, so hovering one can show
    // it's clickable. Without this the whole interaction is invisible: most
    // spikes have no key yet and clicking them does nothing at all.
    const live =
      this.stageDefs &&
      this.getStage(this.scrollT).kind === "orbitHold" &&
      this.selectedSlot == null;
    this.hoverSlot = live
      ? this.hitTestPieces(this.pointer.x, this.pointer.y, true)
      : -1;
    this.canvas.style.cursor =
      this.hoverSlot >= 0 ? "pointer" : this.canFreeLook() ? "grab" : "";
  }

  onPointerLeave() {
    if (this.pointer) this.pointer.active = false;
  }

  // A press in the orbit is ambiguous: it might be picking a spike, or it
  // might be the start of a camera swing. Resolve it by waiting — arm a drag
  // here, and let onPointerUp decide, since only movement tells them apart.
  onPointerDown(e) {
    if (this.canFreeLook()) {
      this._drag = {
        lastX: e.clientX,
        lastY: e.clientY,
        travel: 0,
        moved: false,
        // Shift, or any non-primary button, pans instead of rotating.
        pan: e.shiftKey || e.button !== 0,
      };
    }
  }

  onPointerUp(e) {
    const drag = this._drag;
    this._drag = null;
    if (this.canvas) this.canvas.style.cursor = "";
    // A drag was a camera move, not a pick. Bail before selecting anything.
    if (drag && drag.moved) return;
    this.pickPiece(e);
  }

  /** Double-click anywhere empty puts the camera back where it started. */
  onDoubleClick() {
    if (this.canFreeLook()) this.resetView();
  }

  // Picking a spike to turn into a key. Only live once the pieces have
  // finished detaching — clicking mid-flight would be a coin toss.
  pickPiece(e) {
    if (!this.canvas || !this.stageDefs || this.unlocking) return;
    if (this.getStage(this.scrollT).kind !== "orbitHold") return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const elapsed = this._lastElapsed || 0;

    if (this.selectedSlot != null) {
      // Clicking the key itself runs the unlock; clicking away puts it back.
      const hit = this.hitTestPieces(x, y);
      if (hit === this.selectedSlot && this.selectProgress(elapsed) >= 1) {
        this.startUnlock(elapsed);
      } else {
        this.selectPiece(-1, elapsed);
      }
      return;
    }
    this.selectPiece(this.hitTestPieces(x, y), elapsed);
  }

  // Converts the track element's scroll position into this.scrollT (0..1),
  // and fades the "Scroll" hint out over the first ~7% of scroll.
  onScroll() {
    // Debug: ?t=0.35 pins the timeline, for comparing a single stage.
    if (this._debugT !== null) {
      this.scrollT = this._debugT;
      if (this.hint) this.hint.style.opacity = "0";
      return;
    }
    if (this._debugU !== null) {
      // Park in the middle of orbitHold, wherever the page actually is.
      const st = this.stageDefs?.find((x) => x.kind === "orbitHold");
      this.scrollT = st ? (st.t0 + st.t1) / 2 : 1;
      if (this.hint) this.hint.style.opacity = "0";
      return;
    }
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
  // active and where that particle should be this frame, then draws it. Two
  // stage groups get their own branch, because in both a single particle is
  // drawn as several halftone sub-dots (p.starSub) rather than one dot:
  //   - the star stages (toStar/starHold), and
  //   - the orbit stages (toOrbit/orbitHold), which additionally iterate
  //     ray-by-ray in depth order rather than particle-by-particle.
  loop(ts) {
    if (!this.startTime) this.startTime = ts;
    const elapsed = (ts - this.startTime) / 1000;
    this._lastElapsed = elapsed; // pointer handlers need the animation clock
    const ctx = this.ctx;
    const { w, h } = this.dims;
    ctx.clearRect(0, 0, w, h);
    if (this.dotsGL) {
      this.dotsGL.begin(w, h, this.ORBIT_FOCAL, {
        x: this.view.panX,
        y: this.view.panY,
      });
    }
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
    const inOrbit = stage.kind === "toOrbit" || stage.kind === "orbitHold";
    // 0 = full accent colours (word stages), 1 = fully settled to ink (star
    // stages onward — the orbit inherits the star's settled ink).
    const starPresence =
      stage.kind === "toStar"
        ? this.clamp(stage.mix * 1.4, 0, 1)
        : stage.kind === "starHold" || inOrbit
          ? 1
          : 0;
    const repelStrength = props.cursorRepel ?? 1;
    const repelR = Math.max(90, Math.min(w, h) * 0.17); // cursor repel radius in px
    const inStar = stage.kind === "toStar" || stage.kind === "starHold";
    if (inStar) this.starFrame(elapsed);
    if (starPresence >= 0.999) ctx.fillStyle = this.INK; // fully settled: skip per-dot colour lookups

    // Ease the camera before anything reads it, so every projection this
    // frame agrees on where the viewer is standing. Scrolling back out of the
    // orbit returns it to the default framing — the star and word stages are
    // composed flat and have no free look of their own to inherit it.
    if (!inOrbit) {
      this.resetView();
      // Scrolling back out of the orbit puts everything back: a chosen key
      // returns to being an ordinary spike, and an unlock in flight is
      // abandoned rather than left running behind a hidden door — its clock
      // would keep advancing and eventually fire onUnlocked at a viewer who
      // has scrolled somewhere else entirely.
      if (this.unlocking) this.resetUnlock();
      else if (this.selectedSlot != null) this.selectPiece(-1, elapsed);
      // The GL key is a persistent object in a scene, not marks on a canvas
      // that gets cleared every frame, so leaving the stage that draws it is
      // not enough to make it go away. It has to be dismissed.
      this.dotsGL?.hideKey();
    }
    this.updateView();

    if (inOrbit && this.orbitGroups) {
      // Debug mode picks the first spike that actually has a key, so the
      // frozen frame has something to show.
      if (this._debugU !== null && this.selectedSlot == null && this.orbitSlots) {
        const k = this.orbitSlots.findIndex((sl) => keyForSpike(sl.spikeIdx));
        if (k >= 0) {
          this.selectPiece(k, elapsed);
          this.unlocking = true;
        }
      }
      this.starFrame(elapsed); // the un-detached remainder is still a star
      this.orbitFrame(elapsed, stage.kind === "toOrbit" ? stage.mix : 1);
      ctx.fillStyle = this.INK;

      const dot = (x, y, r, depth = 0) => {
        const rr = Math.max(0.45, r);
        if (this.dotsGL) {
          // Read the colour and alpha back off the 2D context rather than
          // threading them through every call site. They're already correct
          // there, and reading them guarantees the prototype is fed exactly
          // what the canvas version would have drawn — which is the only way
          // the comparison means anything.
          this.dotsGL.push(x, y, rr, ctx.fillStyle, ctx.globalAlpha, depth);
          return;
        }
        if (rr < 1.6) {
          ctx.fillRect(x - rr, y - rr, rr * 2, rr * 2);
        } else {
          ctx.beginPath();
          ctx.arc(x, y, rr, 0, Math.PI * 2);
          ctx.fill();
        }
      };

      // Morph state for the piece being turned into a key (0 when none is).
      // The key takes the needle's place inside the ring — same spot, same
      // orbit, new form — so nothing here moves or pauses the rest of the
      // scene. Dots travel into the key's outline first, then hand over to
      // the solid shape; the two crossfade so no frame shows neither.
      const sel = this.selectProgress(elapsed);
      const gather = this.smoothstep(0, 0.75, sel);
      const dotsFade = 1 - this.smoothstep(0.2, 0.72, sel);
      const keyFade = this.smoothstep(0.45, 0.95, sel);

      // Unlock sequence. The door goes down first so everything else layers
      // over it, and the pieces still on the ring sweep away as it rises.
      const u = this.unlockProgress(elapsed);
      // How far the 3D key has taken over from the 2D one (0 until the very
      // end of the flight). Read again further down to fade the 2D key out.
      this._keyHandoff = 0;
      if (u > 0) {
        const rise = this.phase(u, this.U_RISE);
        const approach = this.phase(u, this.U_APPROACH);
        const swing = this.phase(u, this.U_SWING);
        if (this.door3d?.ok) {
          // The 3D door lives on its own canvas *behind* this one, so it
          // isn't drawn here — it just gets told what to look like, and
          // renders itself at the end of the frame.
          //
          // alpha stays at 1 throughout: the door ARRIVES rather than fades
          // in. It starts below the floor of the room, so there is nothing to
          // hide, and a fade would undercut the illusion that it's a solid
          // thing entering a space.
          this.door3d.setState({
            alpha: 1,
            rise,
            approach,
            open: swing,
            plateAlpha: 1 - swing,
          });

          // Hand the key over to the 3D scene as its flight lands. The two
          // representations coincide exactly at that instant — the key is at
          // the world origin, where both projections are identity — so this
          // short crossfade covers a swap that has almost nothing to hide.
          // From here on the key is a mesh in the door's own scene, which is
          // the only way it can be occluded BY the door as it goes in.
          this._keyHandoff = this.smoothstep(
            this.U_FLIGHT[1] - 0.05,
            this.U_FLIGHT[1],
            u,
          );
          // The lock lives in the dots scene now (see lock3d.js), so it fades
          // with the door rather than being part of it.
          // The lock only exists once the door has arrived. It's drawn at
          // full-screen scale in the dots scene, so showing it while the door
          // is still small and far off would float a giant escutcheon in
          // mid-air. Fade it in over the last of the approach.
          const lockIn = this.smoothstep(0.72, 1, approach);
          this.dotsGL?.setLockAlpha(lockIn * (1 - swing));
        } else if (this.doorArt) {
          ctx.save();
          ctx.globalAlpha = approach; // 2D fallback has no room to fly in from
          drawDoor(ctx, this.doorArt, w, h, swing, 1 - swing);
          ctx.restore();
        }
      }
      const clearOut = this.phase(u, this.U_CLEAR);

      const drawPiece = (k) => {
        const f = this._orbitFrames[k];
        const stay = 1 - f.e;
        const chosen = k === this.selectedSlot && sel > 0;
        // Once unlocking, the chosen key leaves its orbit frame and flies the
        // scripted path to the keyhole.
        const keyProject = chosen
          ? u > 0
            ? this.keyUnlockProject(f, u)
            : this.keyProjectForPiece(f)
          : null;
        // Cursor repel is deliberately not applied during the orbit: the
        // pointer's job here is picking a spike, and dots dodging it fought
        // with that.
        for (const { sub } of this.orbitGroups[k]) {
          const op = this.orbitDotPos(sub, f);
          let x = op.x,
            y = op.y,
            r = sub.dotR * op.scale;
          // Shade each dot by its OWN depth, not the piece's. A single alpha
          // per piece leaves every needle internally flat; a gradient across
          // one needle is what actually shows its volume and which way it's
          // pointing. Attached pieces stay fully opaque, like the star.
          let alpha = this.lerp(
            1,
            this.clamp(
              1 - (1 - op.scale) * this.ORBIT_DEPTH_FADE,
              this.ORBIT_MIN_ALPHA,
              1,
            ),
            f.e,
          );

          if (chosen && sub.keyLocal) {
            const kp = keyProject(sub.keyLocal.x, sub.keyLocal.y, 0);
            x = this.lerp(x, kp.x, gather);
            y = this.lerp(y, kp.y, gather);
            alpha *= dotsFade;
          } else if (clearOut > 0) {
            // Everything that isn't the chosen key is flung out of frame,
            // away from the centre, clearing the stage for the door.
            const dx = x - cx,
              dy = y - cy;
            const d = Math.hypot(dx, dy) || 1;
            const push = clearOut * Math.max(w, h) * 1.15;
            x += (dx / d) * push;
            y += (dy / d) * push;
            alpha *= 1 - clearOut;
          } else if (k === this.hoverSlot) {
            // Hovering a spike that has a key: thicken and darken it so it
            // reads as the interactive one.
            alpha = Math.min(1, alpha * 1.6);
            r *= 1.3;
          }

          // orbitDotPos lands on the dot's *resting* star position at e=0,
          // but the attached star also sways (starPointFor). Carry that sway
          // across as a decaying offset so a piece doesn't visibly snap the
          // instant it starts to leave.
          if (stay > 0.001) {
            const anim = this.starPointFor(sub, elapsed);
            x += (anim.x - (this.starCx + sub.r0 * Math.cos(sub.theta))) * stay;
            y += (anim.y - (this.starCy + sub.r0 * Math.sin(sub.theta))) * stay;
          }
          if (alpha <= 0.004) continue;
          ctx.globalAlpha = alpha;
          dot(x, y, r, op.z);
        }

        // Drawn here, inside the piece's turn, so the solid key keeps its
        // place in the ring's far-to-near ordering like any other piece.
        // The key rides in the lock, so it goes with the door: fade it out as
        // the leaves swing rather than leaving it hanging in the gap.
        const keyAlpha =
          keyFade * (1 - this.phase(u, this.U_SWING)) * (1 - this._keyHandoff);

        // With GL dots the key is a mesh in the same scene, sharing their
        // depth buffer — no painter ordering, no second renderer, and the
        // dots in front of it genuinely occlude it. Only the ORBIT pose is
        // handled here; once the unlock starts the key belongs to the door's
        // scene, which owns the flight and the keyhole.
        if (this.dotsGL) {
          if (chosen) {
            // ONE mesh for the whole sequence — riding the ring, flying the
            // unlock path, and seated in the lock. Only the pose changes.
            // It used to be two meshes in two scenes, and they shaded
            // differently as the animation crossed between them, which read
            // as the key's reflection snapping.
            const alpha = keyFade * (1 - this.phase(u, this.U_SWING));
            if (this._keyHandoff >= 1) {
              this.dotsGL.setKeySeated({
                scale: this.keyDoorScale(),
                pivotX: this.selectedKey?.lock?.pivotX ?? 0,
                pivotY: this.keyPivotNow(u),
                insert: this.phase(u, this.U_INSERT),
                tilt: this.phase(u, this.U_INSERT) * this.KEY_INSERT_TILT,
                turn: this.phase(u, this.U_TURN) * this.KEY_TURN_ANGLE,
                alpha,
              });
            } else {
              const basis =
                u > 0 ? this.keyUnlockBasis(f, u) : this.keyBasisForPiece(f);
              this.dotsGL.setKey(this.selectedKey, basis, alpha);
            }
            this._glKeyShown = true;
          }
          return;
        }

        if (chosen && keyAlpha > 0.004) {
          const mid = keyProject(0, 0, 0); // key centre, for depth-scaled linework
          const lineScale = this.lerp(
            f.slot.needleLen * 0.006,
            Math.min(w, h) * 0.0016,
            this.phase(u, this.U_FLIGHT),
          );
          drawKey3D(ctx, this.selectedKey, keyProject, {
            alpha: keyAlpha,
            outlineWidth: Math.max(1, lineScale * mid.scale),
          });
        }
      };

      // The core and the spikes that never leave — drawn in plain star
      // formation, which is what keeps the star looking intact throughout.
      const drawResidue = () => {
        ctx.globalAlpha = 1;
        for (const { sub } of this.orbitResidue) {
          // The star lies flat at z = 0 in the orbit's space, so it swings
          // with the camera like everything else. Left in raw screen space it
          // would hang rigidly in front while the ring turned behind it.
          const sp = this.projectStarPoint(this.starPointFor(sub, elapsed));
          dot(sp.x, sp.y, sub.dotR * sp.scale, sp.z);
        }
      };

      // Far pieces, then the star core, then near pieces — the whole reason
      // the tilted ring reads as 3D rather than a flat overlapping mess.
      // (With GL dots this ordering no longer matters for correctness, since
      // the depth buffer resolves it; it's kept because the alpha-blended
      // dots still look better drawn back to front.)
      this._glKeyShown = false;
      let residueDrawn = false;
      for (const k of this._orbitOrder) {
        if (!residueDrawn && this._orbitFrames[k].z <= 0) {
          drawResidue();
          residueDrawn = true;
        }
        drawPiece(k);
      }
      if (!residueDrawn) drawResidue();
      // Nothing claimed the key this frame — deselected, or handed to the
      // door. The mesh persists between frames, so it has to be told.
      if (this.dotsGL && !this._glKeyShown) this.dotsGL.hideKey();
      if (this.dotsGL && u <= 0) this.dotsGL.setLockAlpha(0);

      // The door has finished swinging: hand off to whatever shows the page.
      if (u >= 1 && !this._unlockFired) {
        this._unlockFired = true;
        this.onUnlocked?.(this.selectedKey?.id);
      }

      ctx.globalAlpha = 1;
      this.finishFrame(this.unlocking);
      this.raf = requestAnimationFrame(this.loop);
      return;
    }

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
          const rp = this.repelFromPointer(
            sub,
            x,
            y,
            repelStrength,
            repelR,
            starPresence,
          );
          x = rp.x;
          y = rp.y;
          if (starPresence < 0.999) {
            ctx.fillStyle =
              p.colorSlot === -1
                ? this.INK
                : this.towardInk(palette[p.colorSlot], starPresence);
          }
          if (this.dotsGL) {
            this.dotsGL.push(x, y, r, ctx.fillStyle, 1);
          } else if (r < 1.6) {
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
      const fill = p.colorSlot === -1 ? this.INK : palette[p.colorSlot];
      if (this.dotsGL) {
        this.dotsGL.push(x, y, r, fill, 1);
      } else {
        ctx.beginPath();
        ctx.fillStyle = fill;
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    this.finishFrame(false);
    this.raf = requestAnimationFrame(this.loop);
  }

  /**
   * Flushes both WebGL layers — the prototype dot renderer and the door —
   * from whatever state this frame set on them.
   *
   * Called from every exit of loop(). The orbit branch returns early, so a
   * single call at the bottom would miss precisely the stage both layers are
   * shown in.
   *
   * @param {boolean} live whether an unlock is actually running right now.
   *   Anything else — scrolling back out of the orbit, dismissing the key
   *   page — hides the layer: unlike the 2D canvas it isn't cleared each
   *   frame, so a stale door would simply stay on screen.
   */
  finishFrame(live) {
    if (this.dotsGL) this.dotsGL.end();
    if (!this.door3d?.ok) return;
    if (!live) this.door3d.setState({ alpha: 0 });
    this.door3d.render();
  }

  /** Stops the loop and tears down listeners. Call from a mount effect's cleanup. */
  unmount() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this._rt);
    window.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("dblclick", this.onDoubleClick);
    window.removeEventListener("pointerleave", this.onPointerLeave);
    window.removeEventListener("blur", this.onPointerLeave);
  }
}
