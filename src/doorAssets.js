/* ============================================================================
   DOOR ASSETS — where you plug your own artwork into the 3D door.
   ============================================================================

   Leave both as null and door3d.js paints the door procedurally (see door.js).
   Set them and your images are used instead, with no code changes anywhere.

   ---------------------------------------------------------------------------
   HOW TO USE
   ---------------------------------------------------------------------------
   1. Draw ONE leaf — the LEFT one, hinge on the left edge, seam on the right.
      The right leaf is that same image mirrored, so the door is symmetric by
      construction and you only ever draw half of it.

   2. Export two images at the same pixel size, aligned pixel for pixel:

      colour — what the door looks like. Flat, evenly lit, no painted-in
               shadows or highlights: the 3D lighting adds those, and baked
               ones fight it and read as dirt.

      height — greyscale relief. WHITE = stands proud of the surface,
               BLACK = cut into it, MID GREY = the base plank level. This is
               what makes the carving catch the light. Blur it very slightly
               if the edges of your ornament come out razor-sharp; a couple of
               pixels of softness reads as a bevel.

      No height map? Set `height: null` and the door still works — it just
      renders flat, lit only by its silhouette.

   3. Drop the files in `public/door/` and point the paths below at them.
      Anything in `public/` is served from the site root, so
      `public/door/colour.png` is `"/door/colour.png"` here.

   ---------------------------------------------------------------------------
   NOTES
   ---------------------------------------------------------------------------
   - Size: 1024 x 1280 (4:5, slightly taller than wide) is a good default.
     One leaf covers half the viewport's width and all of its height, so on a
     typical desktop it works out near 0.8:1. The image is stretched to fit
     whatever the viewport actually is, so ornament drawn on a wildly
     different ratio will distort — 4:5 keeps that distortion small across
     the screen shapes people actually use.
   - Bigger than ~1500px wide costs load time for detail nobody sees.
   - Leave the keyhole OUT of the artwork. The lock plate is a separate piece
     drawn on top at the seam, because the unlock animation has to know where
     the keyhole is in order to fly the key into it.
   - PNG with transparency works; transparent areas become see-through door,
     which is almost certainly not what you want for the leaf itself.
   ============================================================================ */

export const DOOR_ASSETS = {
  /** @type {string | null} */
  colour: "/door/colour_2.png",
  /** @type {string | null} */
  height: "/door/height_2.png",
};

/**
 * WHERE THE KEYHOLE SITS, as a fraction of the door's height from the top.
 * 0.5 is dead centre.
 *
 * This has to be tuned to YOUR artwork — put it in whatever clear band the
 * ornament leaves, or the lock lands on top of the carving no matter how
 * neatly the two are drawn. The code clears a small field around it, but it
 * can't invent space that the design doesn't have.
 *
 * Currently 0.4: the gap between the top strap and the middle scrollwork in
 * the door art in public/door/. Move the ornament and you move this.
 *
 * Everything follows it — the plate, the bore, the cleared field, and the
 * point the key flies to.
 */
export const DOOR_LOCK_Y = 0.4;

/**
 * Relief depth. Raise it if your carving looks too shallow, lower it if the
 * lighting looks noisy or plasticky. Only affects the height map.
 */
export const DOOR_RELIEF = 2.6;

/**
 * Flip this if your ornament looks *sunken* when it should look raised —
 * some tools export height maps with the opposite convention.
 */
export const DOOR_RELIEF_INVERT = false;
