/* ============================================================================
   FEATHER GL — experiment: the halftone dots as crow feathers.
   ============================================================================

   A look-see, not a decision. Everything here is additive: dotsGL.js keeps its
   own shaders byte-for-byte and picks these instead only when the feather mode
   is asked for. Deleting the experiment is deleting this file and five lines
   over there.

   Toggle with ?dots=feather. Default stays on the round dots.

   The shape is procedural — a mask evaluated inside each point sprite — rather
   than a texture, because the dots span three orders of magnitude in size
   across the funnel and a bitmap feather would be mush at one end and mush at
   the other. Procedural also means the knobs below are live: append them to
   the URL and reload rather than editing and rebuilding.

     ?dots=feather&spread=3.4&width=0.13&sheen=0.55&gain=1.35&flutter=0.16&tint=0.10

   WHY THE SPRITE HAS TO GROW (`spread`). A dot is round, so a square sprite
   just wide enough to hold it is the right sprite. A feather is roughly four
   times longer than it is wide, so a sprite sized to the dot has room for a
   feather a quarter of the dot's length — which is a speck. The quad grows by
   `spread` and the feather is drawn inside it at the dot's original weight,
   with the alpha compensated back down so the field doesn't turn to soot.

   WHAT THIS COSTS. Sprites `spread`x wider are `spread`^2 the fill, and the
   near needles in the orbit are already large. Expect it to be heavier than
   the dots; that's the price of asking the question.
   ============================================================================ */

/** Defaults, all overridable from the query string. */
export const FEATHER_DEFAULTS = {
  // Sprite growth. See the note above — this is the one that decides whether
  // you're looking at feathers or at fat dots.
  spread: 3.4,
  // Half-width of the widest part of the vane, in sprite units (the sprite is
  // 1.0 across). 0.13 -> a feather a bit under 4:1, which is about a crow's
  // covert. Raise it toward 0.2 for something more like a wing primary.
  width: 0.13,
  // How much oil-slick shows. 0 is flat soot, 1 is a beetle.
  sheen: 0.55,
  // Alpha compensation for the grown sprite. Under 1 the field goes thin,
  // over 1.6 the overlaps go muddy.
  gain: 1.35,
  // Radians of gentle rocking, so the field breathes instead of sitting.
  flutter: 0.16,
  // How much of the palette accent survives into the black. Crow feathers are
  // near-black, but keeping a whisper of the accent stops the word and spiral
  // stages from losing their colour identity entirely.
  tint: 0.1,
};

/**
 * Reads the feather mode (and its knobs) out of a query string.
 *
 * @param {string} search e.g. window.location.search
 * @returns {object|null} options for DotsGL, or null if not in feather mode
 */
export function featherOptionsFromSearch(search) {
  const q = new URLSearchParams(search);
  if (q.get("dots") !== "feather") return null;
  const num = (key, fallback) => {
    const raw = q.get(key);
    if (raw === null || raw === "") return fallback;
    const v = Number(raw);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    spread: num("spread", FEATHER_DEFAULTS.spread),
    width: num("width", FEATHER_DEFAULTS.width),
    sheen: num("sheen", FEATHER_DEFAULTS.sheen),
    gain: num("gain", FEATHER_DEFAULTS.gain),
    flutter: num("flutter", FEATHER_DEFAULTS.flutter),
    tint: num("tint", FEATHER_DEFAULTS.tint),
  };
}

export const FEATHER_VERT = /* glsl */ `
  attribute float size;
  attribute float alpha;
  attribute vec3 tint;
  varying float vAlpha;
  varying float vDotAlpha;
  varying vec3 vTint;
  varying float vPx;
  varying float vAng;
  varying float vPh;
  uniform float pixelRatio;
  uniform float uTime;
  uniform float uSpread;
  uniform float uGain;
  uniform float uFlutter;

  void main() {
    vTint = tint;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

    // ORIENTATION, FOR FREE. Every stage in this piece is composed around a
    // centre — the grid bobs about it, the spiral turns about it, the star
    // and the orbit radiate from it — so the tangent at a point is the
    // direction the field is actually travelling there. Feathers laid along
    // it stream with the swirl instead of pointing at random, and no call
    // site has to be taught to pass an angle.
    float ang = atan(position.y, position.x) + 1.57079633;

    // A smooth spatial phase, NOT a hash. A hash of a moving position pops
    // every time the dot crosses a cell boundary; this varies slowly across
    // the field, so neighbours agree and nothing snaps.
    float ph = position.x * 0.0131 + position.y * 0.0173;
    ang += 0.30 * sin(ph * 7.0);              // not all perfectly parallel
    ang += uFlutter * sin(uTime * 1.6 + ph);  // and they breathe
    vAng = ang;
    vPh = ph;

    float px = size * pixelRatio;
    float drawn = max(px * uSpread, 3.0);
    gl_PointSize = drawn;
    vPx = drawn;

    // Two alphas, because two shapes are drawn in here. The feather inks only
    // a fraction of its grown quad, so compensating for the full area ratio
    // the way the dot shader does would erase the field — the square root
    // splits the difference, and uGain trims what's left by eye.
    vAlpha = alpha * min(1.0, sqrt((px * px) / (drawn * drawn)) * uGain);
    // ...and the fallback dot below the feather-legible size is the dot
    // shader's own bargain, unchanged, so the far grit reads as it does now.
    float dotDrawn = max(px, 2.0);
    vDotAlpha = alpha * min(1.0, (px * px) / (dotDrawn * dotDrawn));
  }
`;

export const FEATHER_FRAG = /* glsl */ `
  varying float vAlpha;
  varying float vDotAlpha;
  varying vec3 vTint;
  varying float vPx;
  varying float vAng;
  varying float vPh;
  uniform float uSpread;
  uniform float uWidth;
  uniform float uSheen;
  uniform float uTintMix;

  void main() {
    vec2 p = gl_PointCoord - 0.5;

    // TOO SMALL TO BE A FEATHER. Under about five pixels of quad the mask
    // aliases to nothing and the far half of the funnel simply disappears —
    // which would make this look like a broken renderer rather than like
    // feathers. Those keep the dot shader's behaviour, drawn at the dot's
    // REAL size inside the grown quad, so the funnel still recedes into grit.
    if (vPx < 5.0) {
      if (max(abs(p.x), abs(p.y)) > 0.5 / uSpread) discard;
      if (vDotAlpha < 0.06) discard;
      gl_FragColor = vec4(vTint * uTintMix + vec3(0.018, 0.018, 0.026), vDotAlpha);
      return;
    }

    // Into feather space: tip up the +y axis, quill at the base.
    p.y = -p.y; // sprite y runs down
    float c = cos(vAng), s = sin(vAng);
    vec2 q = mat2(c, s, -s, c) * p;

    float t = q.y * 1.05 + 0.5; // 0 at the quill, 1 at the tip
    if (t < 0.0 || t > 1.0) discard;

    // Real feathers bow. The shaft leans away from the base rather than
    // running dead straight, which is most of what stops this reading as a
    // leaf.
    float d = q.x - 0.085 * t * t;

    // The vane is widest about a third of the way up, tapers to a point at
    // the tip, and thins to a bare quill at the base. Constant folded so the
    // peak of the profile is 1.0 and uWidth means what it says.
    float prof = pow(max(smoothstep(0.0, 0.30, t), 1e-4), 0.65)
               * pow(max(1.0 - t, 1e-4), 0.55);
    float hw = uWidth * prof * 1.22;

    // Asymmetric vanes — narrow to the leading edge, broad to the trailing.
    // Symmetry is the other thing that reads as a leaf.
    float edge = d < 0.0 ? hw * 0.66 : hw;
    float aa = fwidth(d) + 1e-4;
    float mask = 1.0 - smoothstep(edge - aa, edge + aa, abs(d));
    if (mask <= 0.01) discard;

    float v = abs(d) / max(edge, 1e-4); // 0 at the shaft, 1 at the vane edge

    // Barbs: fine stripes running out from the shaft and back toward the
    // quill, which is the direction they actually grow.
    float barb = fract(t * 26.0 - v * 5.0 + vPh * 3.0);
    float vane = 0.80 + 0.20 * smoothstep(0.35, 0.85, barb);

    // ...and a few splits, where the barbs have come unzipped. Only out at
    // the edge — a split running into the shaft would cut the feather in two.
    float split = smoothstep(0.02, 0.06, fract(t * 4.7 + vPh * 2.0));
    vane *= 1.0 - (1.0 - split) * smoothstep(0.40, 1.0, v) * 0.7;

    // The rachis, catching the light.
    float rach = 1.0 - smoothstep(0.0, max(hw * 0.16, 0.006), abs(d));

    // CROW BLACK IS NOT FLAT BLACK. It's a near-black base under an oil-slick
    // that shifts blue -> green -> violet across the vane and strengthens
    // toward the tip. Built on top of the palette tint rather than replacing
    // it, so the word and spiral stages keep a whisper of their accent
    // instead of the whole field going to soot. These are LINEAR values —
    // ColorCache already converted the palette out of sRGB.
    vec3 base = vTint * uTintMix;
    vec3 irid = mix(
      vec3(0.06, 0.10, 0.34),                      // blue
      vec3(0.05, 0.20, 0.15),                      // green
      0.5 + 0.5 * sin(t * 5.2 + v * 3.0 + vPh * 4.0)
    );
    irid = mix(
      irid,
      vec3(0.16, 0.06, 0.26),                      // violet
      0.5 + 0.5 * sin(t * 2.6 - vPh * 3.0)
    );
    float sheen = uSheen * smoothstep(0.15, 1.0, v) * (0.35 + 0.65 * t);
    vec3 col = base + irid * sheen + vec3(0.10, 0.10, 0.11) * rach * 0.6;

    float a = vAlpha * mask * vane;
    // Dots write depth here, so a nearly-invisible fragment would still stamp
    // the buffer and punch a hole in whatever is behind it. Drop them.
    if (a < 0.02) discard;
    gl_FragColor = vec4(col, a);
  }
`;
