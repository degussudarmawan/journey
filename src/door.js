/* ============================================================================
   DOOR — the full-screen ornamental double door the key unlocks.
   ============================================================================

   Two leaves of planked wood banded with iron straps and covered in scrolled
   ironwork, with a single keyhole escutcheon centred on the seam.

   The art is expensive to draw (hundreds of tapered strokes) but completely
   static, so each leaf is painted ONCE into an offscreen canvas and only
   re-blitted per frame. That's what makes it affordable to be generous with
   the ornament.

   Both leaves are painted in the same canonical orientation — hinge at the
   left edge, seam at the right — and the right leaf is then mirrored. So the
   swing maths below can treat "distance from the hinge" identically for both,
   and the ornament comes out symmetric about the seam for free.

   Opening is a fake 3D swing: each leaf is redrawn as a stack of vertical
   strips, each scaled by its own perspective factor. Canvas2D can't do a real
   projective transform on an image, but ~44 strips is indistinguishable from
   one at this size, and it costs 44 drawImage calls per leaf.
   ============================================================================ */

const IRON = "#24242c";
const IRON_SOFT = "#4a4a55";
const WOOD = "#ece9df";
const GRAIN = "#c7c2b4";

// ---- ornament primitives ---------------------------------------------------

/** A tapering spiral — the basic unit of wrought ironwork. */
function scroll(ctx, cx, cy, R, a0, turns, w0, w1, dir = 1) {
  const steps = 120;
  let prev = null;
  ctx.strokeStyle = IRON;
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
      ctx.lineWidth = w0 + (w1 - w0) * t;
      ctx.stroke();
    }
    prev = p;
  }
  return prev;
}

/** A tapering bezier vine, for the long sweeps between scrolls. */
function vine(ctx, nodes, w0, w1) {
  const steps = 90;
  let prev = null;
  ctx.strokeStyle = IRON;
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
    const t = i / steps;
    const p = at(t);
    if (prev) {
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(p.x, p.y);
      ctx.lineWidth = w0 + (w1 - w0) * t;
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
  ctx.fillStyle = IRON;
  for (const lobe of [-0.62, 0, 0.62]) {
    ctx.save();
    ctx.rotate(lobe);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(s * 0.5, -s * 0.34, s, 0);
    ctx.quadraticCurveTo(s * 0.5, s * 0.34, 0, 0);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

// ---- leaf painting ---------------------------------------------------------

function paintPlanks(ctx, w, h) {
  ctx.fillStyle = WOOD;
  ctx.fillRect(0, 0, w, h);
  // Vertical grain: closely spaced hatch lines, like the engraving.
  ctx.strokeStyle = GRAIN;
  for (let x = 2; x < w; x += 4) {
    const jitter = Math.sin(x * 12.9898) * 0.6;
    ctx.globalAlpha = 0.35 + (Math.sin(x * 7.77) * 0.5 + 0.5) * 0.4;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + jitter, 0);
    ctx.lineTo(x - jitter, h);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // Plank joins, a touch heavier.
  ctx.strokeStyle = "#a8a293";
  ctx.lineWidth = 1.5;
  for (let i = 1; i < 4; i++) {
    const x = (w / 4) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
}

/** Horizontal iron band with rivets and a flared, pointed inner end. */
function paintStrap(ctx, w, y, bh) {
  ctx.fillStyle = IRON;
  ctx.fillRect(0, y, w * 0.9, bh);
  // Flared spearhead at the seam end.
  ctx.beginPath();
  ctx.moveTo(w * 0.9, y - bh * 0.35);
  ctx.lineTo(w * 1.0, y + bh * 0.5);
  ctx.lineTo(w * 0.9, y + bh * 1.35);
  ctx.closePath();
  ctx.fill();
  // Hinge block at the outer end.
  ctx.fillRect(0, y - bh * 0.45, w * 0.075, bh * 1.9);
  // Rivets.
  ctx.fillStyle = IRON_SOFT;
  for (let x = w * 0.02; x < w * 0.88; x += w * 0.085) {
    ctx.beginPath();
    ctx.arc(x, y + bh * 0.5, Math.max(1.4, bh * 0.16), 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Fills one panel with a symmetric arrangement of scrolls and vines. */
function paintOrnament(ctx, x, y, w, h) {
  const S = Math.min(w, h);
  // A long spine sweeping from the outer edge toward the seam, with scrolled
  // ends — the backbone the smaller curls hang off.
  const spine = vine(
    ctx,
    [
      { x: x + w * 0.08, y: y + h * 0.5 },
      { x: x + w * 0.3, y: y + h * 0.08 },
      { x: x + w * 0.7, y: y + h * 0.92 },
      { x: x + w * 0.94, y: y + h * 0.5 },
    ],
    S * 0.028,
    S * 0.016,
  );
  leafTip(ctx, spine.x, spine.y, -0.5, S * 0.075);

  // Four quadrant scrolls, the dominant motif of the reference.
  scroll(ctx, x + w * 0.26, y + h * 0.26, S * 0.2, 2.6, 1.15, S * 0.03, S * 0.008, 1);
  scroll(ctx, x + w * 0.72, y + h * 0.28, S * 0.16, 0.6, 1.05, S * 0.026, S * 0.007, -1);
  scroll(ctx, x + w * 0.24, y + h * 0.74, S * 0.17, 3.4, 1.1, S * 0.027, S * 0.007, -1);
  scroll(ctx, x + w * 0.7, y + h * 0.76, S * 0.19, 2.0, 1.2, S * 0.029, S * 0.008, 1);

  // Smaller curls tucked between them, with leaf tips.
  const curls = [
    [0.46, 0.14, 0.08, 1.2],
    [0.5, 0.86, 0.085, -0.4],
    [0.14, 0.5, 0.07, 2.2],
    [0.86, 0.5, 0.075, 1.6],
  ];
  for (const [fx, fy, fr, a] of curls) {
    const end = scroll(
      ctx,
      x + w * fx,
      y + h * fy,
      S * fr,
      a,
      0.95,
      S * 0.016,
      S * 0.005,
      1,
    );
    leafTip(ctx, end.x, end.y, a + 1.4, S * 0.045);
  }
}

/** Paints one leaf, canonical orientation: hinge at left, seam at right. */
function paintLeaf(ctx, w, h, strapText) {
  paintPlanks(ctx, w, h);

  const bh = h * 0.042;
  const yTop = h * 0.1;
  const yBot = h * 0.8;
  paintStrap(ctx, w, yTop, bh);
  paintStrap(ctx, w, yBot, bh);

  // Ornament fills the big panel between the straps, and the skirt below.
  paintOrnament(ctx, w * 0.04, yTop + bh * 2.2, w * 0.92, yBot - yTop - bh * 3.4);
  paintOrnament(ctx, w * 0.06, yBot + bh * 2.2, w * 0.88, h - yBot - bh * 3.2);

  // Inscription along the straps. Not blackletter, but the letter-spaced
  // serif reads as engraved lettering at this size.
  if (strapText) {
    ctx.save();
    ctx.fillStyle = "#d8d4c8";
    ctx.font = `600 ${Math.round(bh * 0.5)}px "Playfair Display", serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    const spaced = strapText.split("").join(" ");
    ctx.fillText(spaced, w * 0.48, yTop + bh * 0.55);
    ctx.fillText(spaced, w * 0.48, yBot + bh * 0.55);
    ctx.restore();
  }

  // Outer frame edge.
  ctx.strokeStyle = IRON;
  ctx.lineWidth = Math.max(3, w * 0.012);
  ctx.strokeRect(0, 0, w * 2, h); // right edge falls outside: seam stays open
}

/** The lock plate: an ornate escutcheon with a single keyhole. */
function paintEscutcheon(ctx, w, h) {
  const cx = w / 2,
    cy = h / 2;
  ctx.fillStyle = IRON;
  // Shield body.
  ctx.beginPath();
  ctx.moveTo(cx, h * 0.02);
  ctx.bezierCurveTo(w * 0.98, h * 0.1, w * 0.94, h * 0.62, cx, h * 0.98);
  ctx.bezierCurveTo(w * 0.06, h * 0.62, w * 0.02, h * 0.1, cx, h * 0.02);
  ctx.fill();
  // Spiked flourishes around the rim.
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const r = w * 0.42;
    leafTip(ctx, cx + Math.cos(a) * r, cy + Math.sin(a) * r * 1.15, a, w * 0.16);
  }
  // The keyhole itself, punched back out to the wood colour.
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(cx, cy - h * 0.06, w * 0.11, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.05, cy - h * 0.03);
  ctx.lineTo(cx + w * 0.05, cy - h * 0.03);
  ctx.lineTo(cx + w * 0.085, cy + h * 0.2);
  ctx.lineTo(cx - w * 0.085, cy + h * 0.2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ---- public API ------------------------------------------------------------

export function buildDoorArt(W, H, strapText) {
  const lw = Math.ceil(W / 2);
  const mk = (w, h) => {
    const c = document.createElement("canvas");
    c.width = Math.max(1, w);
    c.height = Math.max(1, h);
    return c;
  };

  const left = mk(lw, H);
  paintLeaf(left.getContext("2d"), lw, H, strapText);

  // Right leaf: the same art mirrored, so the ornament is symmetric about the
  // seam AND the hinge still lands at art-x 0, letting both leaves share one
  // swing routine.
  const right = mk(lw, H);
  const rc = right.getContext("2d");
  rc.translate(lw, 0);
  rc.scale(-1, 1);
  rc.drawImage(left, 0, 0);

  const es = Math.round(Math.min(W, H) * 0.13);
  const escutcheon = mk(es, Math.round(es * 1.5));
  paintEscutcheon(
    escutcheon.getContext("2d"),
    escutcheon.width,
    escutcheon.height,
  );

  return { left, right, escutcheon, lw, H, W };
}

/**
 * Draws one leaf mid-swing.
 * @param {number} dir +1 if the leaf extends right of its hinge, -1 if left
 * @param {number} angle 0 = shut, larger = swung toward the viewer
 */
function drawLeafSwing(ctx, art, hingeX, dir, W, H, angle, focal) {
  const strips = 44;
  const cyDoor = H / 2;
  const cosA = Math.cos(angle),
    sinA = Math.sin(angle);
  const aw = art.width,
    ah = art.height;
  for (let i = 0; i < strips; i++) {
    const d0 = (i / strips) * W;
    const d1 = ((i + 1) / strips) * W;
    // Swinging toward the viewer is negative z, so the free edge grows.
    const p0 = focal / Math.max(focal * 0.3, focal - sinA * d0);
    const p1 = focal / Math.max(focal * 0.3, focal - sinA * d1);
    const x0 = hingeX + dir * cosA * d0 * p0;
    const x1 = hingeX + dir * cosA * d1 * p1;
    const pm = (p0 + p1) / 2;
    const dw = Math.abs(x1 - x0);
    if (dw < 0.01) continue;
    ctx.drawImage(
      art,
      (d0 / W) * aw,
      0,
      Math.max(1, ((d1 - d0) / W) * aw),
      ah,
      Math.min(x0, x1),
      cyDoor - (H / 2) * pm,
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
  // What's behind the door, revealed as it parts.
  const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W * 0.6);
    g.addColorStop(0, "#f7f7fb");
    g.addColorStop(1, "#d9d9e4");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const angle = open * (Math.PI * 0.58);
  const focal = Math.max(W, H) * 1.1;
  drawLeafSwing(ctx, art.left, 0, 1, W / 2, H, angle, focal);
  drawLeafSwing(ctx, art.right, W, -1, W / 2, H, angle, focal);

  if (plateAlpha > 0.01) {
    ctx.save();
    ctx.globalAlpha = plateAlpha;
    const ew = art.escutcheon.width,
      eh = art.escutcheon.height;
    ctx.drawImage(art.escutcheon, W / 2 - ew / 2, H / 2 - eh / 2, ew, eh);
    ctx.restore();
  }
}

/** Where the keyhole sits on screen — the key aims for this. */
export function keyholePoint(W, H) {
  return { x: W / 2, y: H / 2 };
}
