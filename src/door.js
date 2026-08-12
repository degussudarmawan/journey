/* ============================================================================
   DOOR — artwork for the full-screen ornamental double door the key unlocks.
   ============================================================================

   This module paints ONE leaf (hinge at left, seam at right) into offscreen
   canvases. It does not draw to the screen itself; door3d.js turns these
   canvases into textures on a real 3D door, and drawDoor() below is the 2D
   fallback used only when WebGL is unavailable.

   The same painting code is run twice under different palettes:

     - the COLOUR pass produces the visible artwork, and
     - the HEIGHT pass produces a greyscale relief map (white = proud of the
       surface, black = cut into it) which door3d.js converts into a normal
       map, so the ironwork is genuinely lit rather than just drawn dark.

   That is the whole trick behind the carving: one set of painters, two
   palettes, and the lighting does the rest. Anything you add to the ornament
   automatically gets relief for free, as long as you draw it with a palette
   colour rather than a hard-coded one.

   ---------------------------------------------------------------------------
   REPLACING THIS WITH YOUR OWN ART
   Point src/doorAssets.js at your own colour + height images and none of the
   painting below runs at all. See that file for the export requirements.
   ---------------------------------------------------------------------------
   ============================================================================ */

import { DOOR_LOCK_Y } from "./doorAssets";

/**
 * The two palettes. Every painter reads from the active one (`C`), never from
 * a literal, which is what lets the height pass reuse the colour pass's code.
 *
 * In the height palette, think in millimetres of relief: `iron` stands proud
 * of the planks, `seam` is the groove between planks, `text` is engraved.
 */
export const DOOR_PALETTE = {
  colour: {
    iron: "#2a2a33",
    ironSoft: "#4d4d5c", // rivet heads: a touch lighter than the strap
    wood: "#efeade",
    grain: "#d8d1c0",
    seam: "#a8a293",
    text: "#d8d4c8",
  },
  height: {
    iron: "#e6e6e6",
    ironSoft: "#ffffff", // rivets are the highest thing on the door
    wood: "#6a6a6a",
    grain: "#5f5f5f",
    seam: "#2a2a2a", // plank gaps cut in
    text: "#4a4a4a", // engraved, so below the strap it sits on
  },
};

// The palette in force for the current paint pass. Swapped by withPalette().
let C = DOOR_PALETTE.colour;

function withPalette(palette, fn) {
  const prev = C;
  C = palette;
  try {
    fn();
  } finally {
    C = prev;
  }
}

// ---- ornament primitives ---------------------------------------------------

/** A tapering spiral — the basic unit of wrought ironwork. */
function scroll(ctx, cx, cy, R, a0, turns, w0, w1, dir = 1) {
  const steps = 110;
  let prev = null;
  ctx.strokeStyle = C.iron;
  ctx.lineCap = "round";
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = a0 + dir * t * turns * Math.PI * 2;
    const r = R * (1 - 0.86 * t);
    const p = { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
    if (prev) {
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(p.x, p.y);
      ctx.lineWidth = Math.max(0.4, w0 + (w1 - w0) * t);
      ctx.stroke();
    }
    prev = p;
  }
  return prev;
}

/** A tapering bezier vine, for the long sweeps between scrolls. */
function vine(ctx, nodes, w0, w1) {
  const steps = 80;
  let prev = null;
  ctx.strokeStyle = C.iron;
  ctx.lineCap = "round";
  const at = (t) => {
    const m = 1 - t;
    return {
      x:
        m * m * m * nodes[0].x +
        3 * m * m * t * nodes[1].x +
        3 * m * t * t * nodes[2].x +
        t * t * t * nodes[3].x,
      y:
        m * m * m * nodes[0].y +
        3 * m * m * t * nodes[1].y +
        3 * m * t * t * nodes[2].y +
        t * t * t * nodes[3].y,
    };
  };
  for (let i = 0; i <= steps; i++) {
    const p = at(i / steps);
    if (prev) {
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(p.x, p.y);
      ctx.lineWidth = Math.max(0.4, w0 + (w1 - w0) * (i / steps));
      ctx.stroke();
    }
    prev = p;
  }
  return prev;
}

/** The little trefoil leaves that sprout off the ironwork. */
function leafTip(ctx, x, y, a, s) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  ctx.fillStyle = C.iron;
  for (const lobe of [-0.6, 0, 0.6]) {
    ctx.save();
    ctx.rotate(lobe);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(s * 0.5, -s * 0.32, s, 0);
    ctx.quadraticCurveTo(s * 0.5, s * 0.32, 0, 0);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/** A six-petal boss, used to cover the joins between motifs. */
function rosette(ctx, cx, cy, r) {
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    leafTip(
      ctx,
      cx + Math.cos(a) * r * 0.42,
      cy + Math.sin(a) * r * 0.42,
      a,
      r * 0.62,
    );
  }
  // The centre boss is the tallest point of the motif, so it reads as a
  // domed stud in the relief pass rather than a flat disc.
  ctx.fillStyle = C.ironSoft;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.2, 0, Math.PI * 2);
  ctx.fill();
}

/** One motif: an S-spine ending in a tight spiral at each end. */
function scrollMotif(ctx, cx, cy, s, flip) {
  const d = flip ? -1 : 1;
  vine(
    ctx,
    [
      { x: cx - s * 0.95, y: cy + d * s * 0.3 },
      { x: cx - s * 0.35, y: cy - d * s * 0.8 },
      { x: cx + s * 0.35, y: cy + d * s * 0.8 },
      { x: cx + s * 0.95, y: cy - d * s * 0.3 },
    ],
    s * 0.14,
    s * 0.07,
  );
  const e1 = scroll(
    ctx,
    cx - s * 0.95,
    cy + d * s * 0.3,
    s * 0.42,
    d > 0 ? 1.1 : -1.1,
    1.15,
    s * 0.13,
    s * 0.035,
    -d,
  );
  const e2 = scroll(
    ctx,
    cx + s * 0.95,
    cy - d * s * 0.3,
    s * 0.42,
    d > 0 ? -2.05 : 2.05,
    1.15,
    s * 0.13,
    s * 0.035,
    -d,
  );
  leafTip(ctx, e1.x, e1.y, 0.7 * d, s * 0.2);
  leafTip(ctx, e2.x, e2.y, Math.PI - 0.7 * d, s * 0.2);
  // A sprig off the middle of the spine.
  leafTip(ctx, cx, cy - d * s * 0.06, d > 0 ? -1.5 : 1.5, s * 0.24);
}

/**
 * Fills a panel with tiled scrollwork. Tiling on a near-square grid is what
 * keeps the field dense at any door proportion — laying out a fixed handful
 * of motifs leaves big empty gaps on a wide screen.
 */
function paintOrnament(ctx, x, y, w, h) {
  if (w <= 8 || h <= 8) return;
  const cols = Math.max(1, Math.round(w / (Math.min(w, h) * 0.62)));
  const cellW = w / cols;
  const rows = Math.max(1, Math.round(h / cellW));
  const cellH = h / rows;
  const s = Math.min(cellW, cellH) * 0.46;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = x + cellW * (c + 0.5);
      const cy = y + cellH * (r + 0.5);
      scrollMotif(ctx, cx, cy, s, (r + c) % 2 === 1);
    }
  }
  // Bosses over the grid's interior joins, so the tiling reads as one piece
  // of ironwork rather than a row of stamps.
  for (let r = 1; r < rows; r++) {
    for (let c = 1; c < cols; c++) {
      rosette(ctx, x + cellW * c, y + cellH * r, s * 0.38);
    }
  }
  // Corner spirals to carry the ornament into the panel's corners.
  const corners = [
    [x + cellW * 0.28, y + cellH * 0.24, 2.4],
    [x + w - cellW * 0.28, y + cellH * 0.24, 0.7],
    [x + cellW * 0.28, y + h - cellH * 0.24, 3.6],
    [x + w - cellW * 0.28, y + h - cellH * 0.24, -0.7],
  ];
  for (const [ax, ay, a0] of corners) {
    const e = scroll(ctx, ax, ay, s * 0.5, a0, 1.1, s * 0.1, s * 0.03, 1);
    leafTip(ctx, e.x, e.y, a0 + 1.2, s * 0.18);
  }
}

// ---- leaf painting ---------------------------------------------------------

function paintPlanks(ctx, w, h) {
  ctx.fillStyle = C.wood;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = C.grain;
  ctx.lineWidth = 1;
  for (let x = 2; x < w; x += 4) {
    const jitter = Math.sin(x * 12.9898) * 0.6;
    ctx.globalAlpha = 0.3 + (Math.sin(x * 7.77) * 0.5 + 0.5) * 0.4;
    ctx.beginPath();
    ctx.moveTo(x + jitter, 0);
    ctx.lineTo(x - jitter, h);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = C.seam;
  ctx.lineWidth = 1.5;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo((w / 4) * i, 0);
    ctx.lineTo((w / 4) * i, h);
    ctx.stroke();
  }
}

/** Horizontal iron band with rivets and a flared, pointed inner end. */
function paintStrap(ctx, w, y, bh) {
  ctx.fillStyle = C.iron;
  ctx.fillRect(0, y, w * 0.88, bh);
  ctx.beginPath(); // spearhead at the seam end
  ctx.moveTo(w * 0.88, y - bh * 0.4);
  ctx.lineTo(w, y + bh * 0.5);
  ctx.lineTo(w * 0.88, y + bh * 1.4);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(0, y - bh * 0.5, w * 0.07, bh * 2); // hinge block, outer end
  ctx.fillStyle = C.ironSoft;
  for (let x = w * 0.02; x < w * 0.86; x += w * 0.08) {
    ctx.beginPath();
    ctx.arc(x, y + bh * 0.5, Math.max(1.4, bh * 0.15), 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Paints one leaf, canonical orientation: hinge at left, seam at right. */
function paintLeaf(ctx, w, h, strapText) {
  paintPlanks(ctx, w, h);

  const bh = h * 0.05;
  const yTop = h * 0.075;
  const yBot = h * 0.855;
  paintStrap(ctx, w, yTop, bh);
  paintStrap(ctx, w, yBot, bh);

  // One large field between the straps. An extra panel below the bottom strap
  // only has a few percent of the height to work with and squashes the motifs
  // into scribble, so the skirt is left as plain planking.
  paintOrnament(
    ctx,
    w * 0.05,
    yTop + bh * 1.9,
    w * 0.92,
    yBot - yTop - bh * 3.1,
  );

  if (strapText) {
    ctx.save();
    ctx.fillStyle = C.text;
    ctx.font = `600 ${Math.round(bh * 0.44)}px "Playfair Display", serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    const spaced = strapText.split("").join(" ");
    ctx.fillText(spaced, w * 0.46, yTop + bh * 0.55);
    ctx.fillText(spaced, w * 0.46, yBot + bh * 0.55);
    ctx.restore();
  }

  // Frame: outer edge only. The seam edge is left open so the two leaves meet
  // without a double-thick line down the middle.
  ctx.fillStyle = C.iron;
  const fw = Math.max(3, w * 0.014);
  ctx.fillRect(0, 0, fw, h);
  ctx.fillRect(0, 0, w, fw);
  ctx.fillRect(0, h - fw, w, fw);
}

/** The lock plate: an ornate escutcheon with a single keyhole. */
function paintEscutcheon(ctx, w, h) {
  const cx = w / 2;
  // Spiked flourishes first, so the plate body covers their roots.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
    leafTip(
      ctx,
      cx + Math.cos(a) * w * 0.3,
      h * 0.45 + Math.sin(a) * h * 0.28,
      a,
      w * 0.2,
    );
  }
  ctx.fillStyle = C.iron;
  ctx.beginPath(); // shield body
  ctx.moveTo(cx, h * 0.03);
  ctx.bezierCurveTo(w * 0.95, h * 0.12, w * 0.88, h * 0.64, cx, h * 0.97);
  ctx.bezierCurveTo(w * 0.12, h * 0.64, w * 0.05, h * 0.12, cx, h * 0.03);
  ctx.fill();

  // Punch the keyhole clean through the plate.
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(cx, h * 0.42, w * 0.13, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.055, h * 0.46);
  ctx.lineTo(cx + w * 0.055, h * 0.46);
  ctx.lineTo(cx + w * 0.1, h * 0.72);
  ctx.lineTo(cx - w * 0.1, h * 0.72);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ---- public API ------------------------------------------------------------

function mk(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Fraction of the escutcheon's height at which the keyhole sits. */
export const ESCUTCHEON_KEYHOLE_Y = 0.42;

/**
 * Paints every texture the 3D door needs, for one leaf plus the lock plate.
 * Colour and height are the *same drawing* under two palettes, so they line
 * up pixel for pixel and the relief always matches the artwork.
 *
 * @returns {{leaf: {colour: HTMLCanvasElement, height: HTMLCanvasElement},
 *            plate: {colour: HTMLCanvasElement, height: HTMLCanvasElement},
 *            W: number, H: number}}
 */
export function buildDoorMaps(W, H, strapText) {
  const lw = Math.ceil(W / 2);
  const leaf = { colour: mk(lw, H), height: mk(lw, H) };
  withPalette(DOOR_PALETTE.colour, () =>
    paintLeaf(leaf.colour.getContext("2d"), lw, H, strapText),
  );
  withPalette(DOOR_PALETTE.height, () =>
    paintLeaf(leaf.height.getContext("2d"), lw, H, strapText),
  );

  const ew = Math.round(Math.min(W, H) * 0.11);
  const eh = Math.round(ew * 1.6);
  const plate = { colour: mk(ew, eh), height: mk(ew, eh) };
  withPalette(DOOR_PALETTE.colour, () =>
    paintEscutcheon(plate.colour.getContext("2d"), ew, eh),
  );
  withPalette(DOOR_PALETTE.height, () =>
    paintEscutcheon(plate.height.getContext("2d"), ew, eh),
  );

  return { leaf, plate, W, H };
}

/* ---------------------------------------------------------------------------
   2D FALLBACK
   Everything below is only reached when a WebGL context can't be created.
   It draws the leaf bitmap as a stack of vertical strips, each scaled by its
   own perspective factor — Canvas2D can't do a real projective transform on
   an image, but ~44 strips is a convincing stand-in at this size.
   --------------------------------------------------------------------------- */

export function buildDoorArt(W, H, strapText) {
  const maps = buildDoorMaps(W, H, strapText);
  return {
    leaf: maps.leaf.colour,
    escutcheon: maps.plate.colour,
    W,
    H,
  };
}

/**
 * Draws one leaf mid-swing, hinged at x = 0 and extending right. The caller
 * mirrors the whole context to get the other leaf.
 * @param {number} angle 0 = shut, larger = swung toward the viewer
 */
function drawLeafSwing(ctx, art, W, H, angle, focal) {
  const strips = 44;
  const sinA = Math.sin(angle);
  const cosA = Math.cos(angle);
  const aw = art.width;
  for (let i = 0; i < strips; i++) {
    const d0 = (i / strips) * W;
    const d1 = ((i + 1) / strips) * W;
    // Swinging toward the viewer is negative z, so the free edge grows.
    const p0 = focal / Math.max(focal * 0.3, focal - sinA * d0);
    const p1 = focal / Math.max(focal * 0.3, focal - sinA * d1);
    const x0 = cosA * d0 * p0;
    const x1 = cosA * d1 * p1;
    const pm = (p0 + p1) / 2;
    const dw = x1 - x0;
    if (dw < 0.01) continue;
    ctx.drawImage(
      art,
      (d0 / W) * aw,
      0,
      Math.max(1, ((d1 - d0) / W) * aw),
      art.height,
      x0,
      H / 2 - (H / 2) * pm,
      dw + 1, // hairline overlap, else seams show between strips
      H * pm,
    );
  }
}

/**
 * @param {number} open 0 = shut, 1 = fully swung open
 * @param {number} plateAlpha opacity of the keyhole plate (fades as it parts)
 */
export function drawDoor(ctx, art, W, H, open, plateAlpha = 1) {
  // What lies behind the door, revealed as it parts.
  const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W * 0.6);
  g.addColorStop(0, "#f7f7fb");
  g.addColorStop(1, "#d6d6e2");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const angle = open * (Math.PI * 0.58);
  const focal = Math.max(W, H) * 1.1;

  drawLeafSwing(ctx, art.leaf, W / 2, H, angle, focal);

  // The right leaf is the same art through a mirrored transform — exact
  // symmetry, and the strip contents flip along with their positions.
  ctx.save();
  ctx.translate(W, 0);
  ctx.scale(-1, 1);
  drawLeafSwing(ctx, art.leaf, W / 2, H, angle, focal);
  ctx.restore();

  if (plateAlpha > 0.01) {
    ctx.save();
    ctx.globalAlpha = plateAlpha;
    const { escutcheon: es } = art;
    ctx.drawImage(
      es,
      W / 2 - es.width / 2,
      H * DOOR_LOCK_Y - es.height * ESCUTCHEON_KEYHOLE_Y,
      es.width,
      es.height,
    );
    ctx.restore();
  }
}

/** Where the keyhole sits on screen — the key aims for this. */
export function keyholePoint(W, H) {
  return { x: W / 2, y: H * DOOR_LOCK_Y };
}
