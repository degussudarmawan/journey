/* ============================================================================
   LILAC KEY — the key spike 5 (the long bottom ray) turns into.
   ============================================================================

   Authored in the pixel coordinates of the reference drawing (roughly 430 x
   1000, y down), then normalizeParts() recentres and rescales the whole thing
   so it drops into the scene at a predictable size. That means you can trace
   numbers straight off a reference image and not think about centring.

   An ornate key reads as three regions, and the parts below are grouped that
   way: the BOW (the decorative loop you hold), the SHAFT (the stem, with
   scrollwork and a keyhole), and the BIT (the teeth at the business end).

   Parts deliberately overlap rather than being unioned into one outline —
   union-ing polygons is a lot of machinery for no visual gain here, since
   every part shares one fill colour and the seams don't show.

   Each key is its own module so it can carry its own palette and ornament
   vocabulary; this one is a stylised read of the reference rather than a
   tracing of every squiggle.
   ============================================================================ */

import {
  ellipseContour,
  roundRectContour,
  bezierPolyline,
  strokeContour,
  normalizeParts,
} from "./geom";

const P = (x, y) => ({ x, y });

// ---- BOW: the looping ornament at the top ---------------------------------

// The hook that curls over the very top, tapering to a point at its tip.
const topCurl = strokeContour(
  bezierPolyline([
    P(108, 258),
    P(92, 176),
    P(150, 126),
    P(182, 162),
    P(202, 186),
    P(176, 210),
    P(142, 197),
  ]),
  27,
  [0.55, 0.35],
);

// Central ring, plus the two side lobes that read as wings.
const bowRing = {
  contour: ellipseContour(215, 300, 108, 88),
  holes: [ellipseContour(215, 302, 52, 40)],
  // The small dark eye sitting in the curl above.
  details: [{ contour: ellipseContour(150, 165, 10, 10) }],
};
const leftLobe = {
  contour: ellipseContour(108, 300, 68, 46),
  holes: [ellipseContour(104, 300, 34, 20)],
};
const rightLobe = {
  contour: ellipseContour(322, 300, 68, 46),
  holes: [ellipseContour(326, 300, 34, 20)],
};

// ---- SHAFT: the stem, its collar, scrollwork and keyhole ------------------

const collar = { contour: roundRectContour(146, 372, 236, 424, 14) };

const shaft = {
  contour: roundRectContour(152, 404, 200, 846, 12),
  // The keyhole: a round eye over a slot.
  holes: [
    ellipseContour(176, 726, 13, 13, 20),
    roundRectContour(169, 736, 183, 786, 6),
  ],
};

// Three scrolls curling off the stem — two left, one right — each a tapered
// stroke outlined into solid geometry.
const scrollCurl = (nodes) =>
  strokeContour(bezierPolyline(nodes), 21, [0.75, 0.3]);

const scrollLeftUpper = scrollCurl([
  P(154, 468),
  P(98, 476),
  P(94, 540),
  P(142, 546),
  P(172, 549),
  P(170, 506),
  P(142, 507),
]);
const scrollLeftLower = scrollCurl([
  P(154, 600),
  P(100, 610),
  P(96, 670),
  P(146, 674),
  P(174, 676),
  P(172, 633),
  P(146, 634),
]);
const scrollRight = scrollCurl([
  P(198, 502),
  P(252, 510),
  P(256, 572),
  P(208, 578),
  P(180, 580),
  P(182, 537),
  P(208, 538),
]);

// ---- BIT: the teeth ------------------------------------------------------
// Two horizontal teeth joined by a spine on the right, so the end reads as
// the blocky "E" of the reference.

const toothUpper = { contour: roundRectContour(196, 688, 316, 750, 16) };
const toothLower = { contour: roundRectContour(196, 790, 292, 828, 14) };
const bitSpine = { contour: roundRectContour(272, 688, 316, 828, 16) };
const terminal = { contour: ellipseContour(176, 852, 46, 44) };

const { parts, bounds } = normalizeParts([
  // Ordered back-to-front-ish for authoring clarity only; the renderer sorts
  // by actual projected depth every frame.
  { contour: topCurl },
  leftLobe,
  rightLobe,
  bowRing,
  collar,
  { contour: scrollLeftUpper },
  { contour: scrollLeftLower },
  { contour: scrollRight },
  shaft,
  toothUpper,
  bitSpine,
  toothLower,
  terminal,
]);

export const lilacKey = {
  id: "lilac",
  name: "Lilac",
  parts,
  bounds,
  // Extrusion depth, in the same normalised units as the geometry (total
  // height is 2.4), so the key is a slim slab rather than a chunky block.
  depth: 0.085,
  palette: {
    face: "#c3c6f0", // the flat lilac of the reference
    sideLit: "#a8ace0", // extruded wall turned toward the viewer
    sideDim: "#8f93cc", // wall turned away
    back: "#7f83bd",
    outline: "#20202a",
    detail: "#20202a",
  },
};
