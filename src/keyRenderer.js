/* ============================================================================
   KEY RENDERER — draws a key definition as a solid, extruded 3D shape.
   ============================================================================

   A key is a flat outline given a thickness: every part becomes a prism with
   a front face, a back face, and a wall running around each edge. Rendering
   is a painter's algorithm — back face, then walls, then front face, with
   parts sorted by depth — which is all this needs, since the parts are
   near-coplanar and share one colour, so genuine z-buffering would buy
   nothing visible.

   Walls are batched into two paths by which way they face, and each is filled
   once. Filling per-edge instead would mean well over a thousand fill() calls
   a frame; two tones also happen to match the flat, graphic look of the
   reference better than a smooth gradient would.

   The caller supplies `project`, so this file never needs to know how the key
   is positioned or spun — the engine owns that.
   ============================================================================ */

/** Adds a flattened contour to a Path2D using already-projected points. */
function addProjected(path, pts) {
  if (!pts.length) return;
  path.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
  path.closePath();
}

const projectContour = (contour, z, project) =>
  contour.map((p) => project(p.x, p.y, z));

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} keyDef - from src/keys/*
 * @param {(x:number, y:number, z:number) => {x:number, y:number}} project
 *   maps a point in the key's local space to screen space
 * @param {object} opts
 * @param {number} opts.alpha - overall opacity, for fading the key in
 * @param {number} opts.outlineWidth - in screen px
 */
export function drawKey3D(ctx, keyDef, project, opts = {}) {
  const { alpha = 1, outlineWidth = 1.5 } = opts;
  const { palette, depth } = keyDef;
  const zFront = -depth / 2; // -z is toward the viewer
  const zBack = depth / 2;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = palette.outline;

  // Project every part once, then render in whole-key passes: all back faces,
  // all walls, all front faces. Doing back-walls-front per part instead lets a
  // nearer part's back face paint over a farther part's front face, which is
  // what produced offset "ghost" copies at oblique angles. Passes also make
  // depth-sorting the parts unnecessary — they're near-coplanar and share one
  // colour, so order within a pass can't show.
  const projected = keyDef.parts.map((part) => {
    const rings = [part.contour, ...(part.holes || [])];
    return {
      part,
      front: rings.map((r) => projectContour(r, zFront, project)),
      back: rings.map((r) => projectContour(r, zBack, project)),
    };
  });

  const pathOf = (rings) => {
    const p = new Path2D();
    for (const r of rings) addProjected(p, r);
    return p;
  };

  // Outline every part, then fill every part — never stroke-then-fill one part
  // at a time. Parts overlap (they're not boolean-unioned), so a per-part
  // outline draws seams straight through the middle of the key. Stroking all
  // of them underneath first means each neighbour's fill buries the shared
  // edges, and only the silhouette of the union survives. The stroke is drawn
  // double width since the fill eats its inner half.
  const outlineThenFill = (paths, fillStyle) => {
    ctx.lineWidth = outlineWidth * 2;
    for (const p of paths) ctx.stroke(p);
    ctx.fillStyle = fillStyle;
    for (const p of paths) ctx.fill(p, "evenodd");
  };

  // Back faces — only visible around the silhouette, but they stop the key
  // reading as hollow when it turns steeply.
  outlineThenFill(
    projected.map((p) => pathOf(p.back)),
    palette.back,
  );

  // Extruded walls, batched into a lit and a dim path so the whole key costs
  // two fills rather than one per edge.
  const lit = new Path2D();
  const dim = new Path2D();
  for (const { front, back } of projected) {
    for (let r = 0; r < front.length; r++) {
      const f = front[r];
      const b = back[r];
      for (let j = 0; j < f.length; j++) {
        const k = (j + 1) % f.length;
        // Split walls by which way they face, using the signed area of the
        // projected quad. Working in screen space means this holds for any
        // orientation the caller hands us — the key rides a piece's orbit
        // frame, so there's no fixed "up" to reason about.
        const area =
          (f[k].x - f[j].x) * (b[k].y - f[j].y) -
          (b[k].x - f[j].x) * (f[k].y - f[j].y);
        const target = area >= 0 ? lit : dim;
        target.moveTo(f[j].x, f[j].y);
        target.lineTo(f[k].x, f[k].y);
        target.lineTo(b[k].x, b[k].y);
        target.lineTo(b[j].x, b[j].y);
        target.closePath();
      }
    }
  }
  ctx.fillStyle = palette.sideDim;
  ctx.fill(dim);
  ctx.fillStyle = palette.sideLit;
  ctx.fill(lit);

  // Front faces, with holes punched out by the even-odd rule.
  outlineThenFill(
    projected.map((p) => pathOf(p.front)),
    palette.face,
  );

  // Engraved detail sits on the front plane only.
  ctx.fillStyle = palette.detail;
  for (const { part } of projected) {
    for (const d of part.details || []) {
      const dp = new Path2D();
      addProjected(dp, projectContour(d.contour, zFront, project));
      ctx.fill(dp);
    }
  }

  ctx.restore();
}

/**
 * Rasterises the key and reads back points that land on it — the same trick
 * sampleWordPoints() uses in spiralEngine.js for text. Used to give every dot
 * of the exploding spike a destination inside the key silhouette, so the dots
 * visibly gather into the key's form before the solid one takes over.
 *
 * Returns `count` points in the key's local coordinate space, recycling them
 * if the key rasterises to fewer pixels than there are dots.
 *
 * @param {(i:number) => number} rand - deterministic 0..1 source
 */
export function sampleKeyLocalPoints(keyDef, count, rand) {
  const b = keyDef.bounds;
  const H = 420;
  const scale = H / (b.y1 - b.y0 || 1);
  const W = Math.max(1, Math.ceil((b.x1 - b.x0) * scale));

  const off = document.createElement("canvas");
  off.width = W;
  off.height = H;
  const c = off.getContext("2d");
  c.fillStyle = "#000";
  for (const part of keyDef.parts) {
    const path = new Path2D();
    const rings = [part.contour, ...(part.holes || [])];
    for (const ring of rings) {
      addProjected(
        path,
        ring.map((p) => ({ x: (p.x - b.x0) * scale, y: (p.y - b.y0) * scale })),
      );
    }
    c.fill(path, "evenodd");
  }

  const img = c.getImageData(0, 0, W, H).data;
  const pts = [];
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      if (img[(y * W + x) * 4 + 3] > 120) {
        pts.push({ x: b.x0 + x / scale, y: b.y0 + y / scale });
      }
    }
  }
  for (let i = pts.length - 1; i > 0; i--) {
    const j = Math.floor(rand(i) * (i + 1));
    const t = pts[i];
    pts[i] = pts[j];
    pts[j] = t;
  }

  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = pts.length ? pts[i % pts.length] : { x: 0, y: 0 };
  }
  return out;
}
