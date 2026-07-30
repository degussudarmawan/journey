/* ============================================================================
   GEOM — contour builders for key shapes.
   ============================================================================

   Every key is described as a set of *parts*, and every part is a closed
   contour (plus optional holes) given as a flat list of {x, y} points. Plain
   point lists rather than Path2D/beziers, because the renderer has to extrude
   them into 3D: it needs to walk each edge to build side walls, which you
   can't do with an opaque path object.

   Curves are therefore flattened here, at build time, once.
   ============================================================================ */

export function ellipseContour(cx, cy, rx, ry, n = 36) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return pts;
}

export function roundRectContour(x0, y0, x1, y1, r, perCorner = 5) {
  const rr = Math.min(r, Math.min(x1 - x0, y1 - y0) / 2);
  const pts = [];
  const arc = (cx, cy, a0, a1) => {
    for (let i = 0; i <= perCorner; i++) {
      const a = a0 + (a1 - a0) * (i / perCorner);
      pts.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
    }
  };
  arc(x1 - rr, y0 + rr, -Math.PI / 2, 0);
  arc(x1 - rr, y1 - rr, 0, Math.PI / 2);
  arc(x0 + rr, y1 - rr, Math.PI / 2, Math.PI);
  arc(x0 + rr, y0 + rr, Math.PI, Math.PI * 1.5);
  return pts;
}

/**
 * Flattens a chain of cubic beziers into a polyline.
 * @param {Array<{x,y}>} nodes - p0, c1, c2, p1, c1, c2, p2, ... (each further
 *   segment reuses the previous endpoint, so 3 nodes per extra segment)
 */
export function bezierPolyline(nodes, perSeg = 10) {
  const pts = [{ ...nodes[0] }];
  for (let s = 0; s + 3 < nodes.length + 0; s += 3) {
    const p0 = nodes[s],
      c1 = nodes[s + 1],
      c2 = nodes[s + 2],
      p1 = nodes[s + 3];
    if (!p1) break;
    for (let i = 1; i <= perSeg; i++) {
      const t = i / perSeg,
        m = 1 - t;
      pts.push({
        x: m * m * m * p0.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * p1.x,
        y: m * m * m * p0.y + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t * t * t * p1.y,
      });
    }
  }
  return pts;
}

/**
 * Turns an OPEN polyline into a closed contour of the given width — i.e. it
 * outlines a stroke so it can be filled and extruded like any other solid
 * part. This is how the key's ornamental curls become real geometry instead
 * of being stuck as canvas strokes (which can't be extruded).
 *
 * Offsets each point along its normal to build a left and a right edge, then
 * joins them into one loop. Fine for the gentle curves keys are made of; it
 * would self-intersect on a hairpin turn.
 *
 * @param {[number, number]} taper - width multiplier at the start and end, so
 *   a curl can come to a soft point rather than a blunt stub.
 */
export function strokeContour(path, width, taper = [1, 1]) {
  const n = path.length;
  const left = [],
    right = [];
  for (let i = 0; i < n; i++) {
    const prev = path[Math.max(0, i - 1)];
    const next = path[Math.min(n - 1, i + 1)];
    let tx = next.x - prev.x,
      ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    // Ease the taper in over the first/last fifth of the run.
    const f = n > 1 ? i / (n - 1) : 0;
    const startW = 1 - (1 - taper[0]) * Math.max(0, 1 - f / 0.2);
    const endW = 1 - (1 - taper[1]) * Math.max(0, 1 - (1 - f) / 0.2);
    const w = (width / 2) * startW * endW;
    const nx = -ty * w,
      ny = tx * w;
    left.push({ x: path[i].x + nx, y: path[i].y + ny });
    right.push({ x: path[i].x - nx, y: path[i].y - ny });
  }
  return left.concat(right.reverse());
}

/**
 * Measures every part, then rewrites all coordinates so the shape is centred
 * on the origin and `targetHeight` tall. Lets a key be authored in whatever
 * pixel coordinates were convenient (traced off a reference image, say) and
 * still drop into the scene at a predictable size and centring.
 */
export function normalizeParts(parts, targetHeight = 2.4) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const eachContour = (fn) => {
    for (const part of parts) {
      fn(part.contour);
      for (const hole of part.holes || []) fn(hole);
      for (const d of part.details || []) fn(d.contour);
    }
  };
  eachContour((c) => {
    for (const p of c) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
  });
  const s = targetHeight / (y1 - y0 || 1);
  const cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2;
  eachContour((c) => {
    for (const p of c) {
      p.x = (p.x - cx) * s;
      p.y = (p.y - cy) * s;
    }
  });
  return {
    parts,
    bounds: {
      x0: (x0 - cx) * s,
      y0: (y0 - cy) * s,
      x1: (x1 - cx) * s,
      y1: (y1 - cy) * s,
    },
  };
}
