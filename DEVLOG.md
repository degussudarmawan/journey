# Dev log

Running record of changes: what changed, why, and **what it broke or might break**.
Newest first. Every entry should have a side-effects section — that's the part
worth reading in six months.

Legend: **✅ verified** = I actually looked at it rendering.
**⚠️ unverified** = built and reasoned about, but nobody has seen it.

---

## 2026-08-03 — The orbit is a space you can walk around in ✅

`src/spiralEngine.js`

The orbit stage was a 3D scene rendered from one fixed viewpoint. It's now a
3D scene you can look around inside.

- **Drag** — swing the camera (yaw + pitch, pitch clamped to 74°; past that
  the ring is edge-on and there's nothing to see)
- **Shift-drag** or right-drag — pan
- **Double-click** — return to the default framing
- Cursor shows `grab` / `grabbing` while free look is live

**How.** All three orbit projections (the needles, the star core they leave
behind, the key) now go through one `project(x, y, z)`. That single door is
the whole design: put the camera anywhere else and you have to remember to
apply it in each of them, and the one you miss stays welded to the screen
while everything else swings past it. `viewDepth()` is the same transform
without the divide, for painter ordering.

Identity until the first drag, so the default composition is untouched.

**Side effects**
- **Painter ordering now sorts on VIEW-space depth, not world z.** It had to:
  world z is only correct from the default camera, and swinging round behind
  the ring inverted the order so far pieces painted over near ones.
- **The star core was lifted into the space at z = 0.** Left in raw screen
  space it hung rigidly in front while the ring turned behind it.
- **Clicking is now resolved on pointerUP, not down.** A press is ambiguous —
  pick, or the start of a camera swing — and only movement tells them apart.
  A drag past 5px sets a flag that suppresses the pick on release.
- **`startUnlock` eases the camera home.** The door is a fixed backdrop that
  does *not* swing with the free look, and the key's flight ends at the world
  origin — which is the keyhole only from the default view. Left rotated, the
  key would fly to somewhere off the lock entirely. The clear-out and door
  fade-in give it time to settle.
- Scrolling out of the orbit resets the view; the star and word stages are
  composed flat and have no free look to inherit.
- **The detach sway carry-over is still a raw screen-space offset** (the
  `stay > 0.001` branch). Under a rotated camera it nudges in slightly the
  wrong direction. It's a small decaying transient during `toOrbit` only, so
  it's invisible in practice — but it is the one thing not going through
  `project()`.
- Debug: `?yaw=0.9&pitch=0.5` starts the view already swung, so a viewpoint
  can be reproduced or screenshotted without dragging.

---

## 2026-08-03 — Hole sized to what shows, plate sized to what hides ✅

`src/door3d.js`, `src/spiralEngine.js`

Reverses part of the entry below. Making the slot physically honest — wide
enough to admit the whole bit — was correct and **looked terrible**: this key's
bit is nearly 6× its stem's width, so the slot became a giant funnel with a
keyhole perched at the top. User's verdict, and they were right: "the before
update looks so much better tbh."

The mistake was conflating two different measurements. **The bit never had to
fit through the hole — it had to disappear**, and the plate is opaque, so the
depth buffer already hides anything behind it. So:

- **bore and slot** are sized from `lock.shaftHalf` — the stem is the only part
  anyone watches go in. Classic keyhole silhouette restored.
- **the plate** is sized from `lock.bitHalf` and `bitBottom`, broad and long
  enough that the bit stays behind it with nothing poking out of the
  silhouette.

Also dropped `KEY_TURN_ANGLE` from 83° to **54°**. The turn is about the shaft,
so the key's flat face swings toward edge-on and narrows as it goes — near a
right angle it's a sliver and reads as having vanished rather than turned. 54°
keeps ~60% of its width and still reads as a decisive turn.

**Side effects**
- `lock.bitHalf` and `lock.bitBottom` now drive **plate size**, not hole size.
  A key with a wide bit gets a bigger escutcheon — same per-key variation as
  before, different cause.
- Concealment depends on the plate outline reaching ~0.34 × `pw` at its widest.
  **Restyling `escutcheonShape` to a narrower silhouette will expose the bit**,
  and the 3.2 multiplier would need to go up to compensate.
- The 2D fallback door has no plate geometry, so nothing hides the bit there.
  Only visible if WebGL fails.

---

## 2026-08-03 — Keyhole sized from the key ✅ *(slot sizing superseded above)*

`src/keys/geom.js`, `src/keys/lilacKey.js`, `src/door3d.js`, `src/spiralEngine.js`

Symptom: the key was visibly larger than the hole it was going into.

Two causes, both from the lock's dimensions being **guessed as fractions of
the plate** instead of measured off the key:

1. `KEY_PIVOT_Y = 0.72` landed in the middle of the **teeth**. The lilac key's
   stem is `x: 152–200` (48 wide) but its teeth run `x: 196–316` (120 wide), so
   the widest part of the key was what sat in a slot sized for its narrowest.
   The seating depth is now declared per key as `lock.yEnter` — the top of the
   bit — so the bit goes inside and the stem sits in the bore.
2. **The key was standing in the lock crooked.** Position came from the
   bounding box's centre, but the bow and scrolls hang to one side, which drags
   that centre ~40px off the actual stem. There's now a `lock.pivotX` for the
   shaft's axis, applied in both the 3D pose and the 2D flight.

Keys declare a `lock` spec in their own authoring pixel coordinates and
`normalizeParts` carries it through the same transform as the geometry. The
door then derives bore, slot and plate size from it, scaled by `keyScale`,
which `ensure()` now takes as a fifth argument.

**Side effects**
- **`normalizeParts` gained a third parameter.** Existing calls still work; a
  key without a `lock` falls back to a small fixed keyhole that will very
  likely not fit it. **Every new key needs a `lock` block** — see the doc
  comment in `geom.js`.
- **The escutcheon now changes size with the key.** A key with a broad bit
  gets a bigger plate. Probably fine — arguably a feature, since each door is
  meant to feel like that key's door — but it is no longer a fixed element of
  the scene.
- The slot has to be wide enough for the bit, so on this key it's a broad
  funnel rather than a dainty keyhole. That's honest, not a bug: a skeleton
  key's bit really is several times its stem.
- `KEY_PIVOT_Y` is now only a fallback for keys with no `lock`.
- Plate height needs headroom below the slot (`-hole.yBot * 2.5`): the outline
  tapers to a point down there and a slot running past the taper cuts a visible
  notch out of the silhouette.

**Still open (aesthetic, your call)**
- The plate is a large plain teardrop with no ornament, against door art that
  is highly ornamented.
- The key's `#c3c6f0` is nearly the door ironwork's periwinkle, so it
  half-disappears into the art.

---

## 2026-08-03 — Debug hook, and fixing the lock properly ✅

### `?unlock=` URL parameter
`src/spiralEngine.js`

`http://localhost:5173/?unlock=0.72` jumps straight to the orbit with a key
selected and **freezes the unlock at that fraction** of its 4.6s sequence.
`0.55` = insertion starting, `0.72` = mid-turn, `0.9` = doors swinging.

Added because iterating on the door meant scrolling the whole track and
clicking twice, every time — and because it's the only way to drive the page
from headless Chrome for screenshots.

Touches five methods, all guarded on `_debugU !== null`:
`unlockProgress` and `selectProgress` return frozen values, `onScroll` parks
`scrollT` in the middle of `orbitHold`, `mount` parses the param, and the
orbit branch of `loop` auto-selects the first spike that has a key.

**Side effects**
- With the param present, **scrolling does nothing** — `onScroll` returns
  early. That's intended but disorienting if you forget the param is there.
- `selectProgress` returns 1, so the dots→key morph is skipped entirely. You
  cannot debug the morph with this flag.
- No effect at all when the param is absent. Safe to leave in.

### The lock was broken in four ways
`src/door3d.js`, `src/key3d.js`, `src/spiralEngine.js`

Symptom: the key was "blocked by something black" and never entered the hole.

1. **The plate had no keyhole.** `keyholeShape()` existed and the comment
   claimed it was cut through the plate, but it was never pushed onto
   `escutcheonShape`'s `.holes`. The plate was a solid slab, so the key had
   nowhere to go — it perched on the front, then the plate's top lobe hid the
   shaft, leaving only the bow visible above the edge.
2. **The key sat behind the plate.** `_keyZIn` put the seated key *behind* the
   door face, so the plate occluded the shaft. Now at the plate's mid-depth:
   the pitched shaft climbs clear of the front face as it rises out of the
   hole, while anything below the hole is already inside.
3. **The keyhole was narrower than the key's own shaft.** Sized for looks
   rather than for the key that has to pass through it. Slot half-width is now
   `0.11 * pw`, proportioned to the shaft.
4. **Everything was far too small.** Plate `0.085 → 0.13` of `min(W,H)`, key
   `KEY_DOOR_SCALE 0.15 → 0.32`, pitch eased `54° → 40°` so more of the key
   stays readable.

**Side effects**
- `KEY_DOOR_SCALE` also feeds the 2D key during its flight, so **the flight
  now ends with a much larger key**. Looks fine, but it's a shared constant —
  changing it for the lock changes the approach too.
- The key's `#c3c6f0` lilac is now almost exactly the door ornament's
  periwinkle, so it half-disappears into the art. Palette clash, not a bug.
  Warm the key (brass) or cool the plate.
- Plate at 0.13 covers noticeably more of the door art than before.

---

## 2026-08-02 — 3D keyhole and key insertion ⚠️ *(superseded by the above)*

`src/key3d.js` (new), `src/door3d.js`, `src/spiralEngine.js`

The keyhole became real geometry: an extruded shield with the keyhole as a
void, and a socket boring in behind it — the keyhole profile extruded backwards
and rendered `BackSide`, which turns a solid into a cavity you can see the
walls and floor of.

The key became a three.js mesh at the end of its flight. `lilacKey.js`'s
contours (with holes) feed straight into `ExtrudeGeometry` — the same data the
2D renderer extrudes by hand.

**Why the handoff is at the end of the flight:** the 2D engine projects with
`f/(f+z)` at `ORBIT_FOCAL`; the three camera uses its own focal length. They
disagree everywhere **except at z = 0, where both are exactly 1**. The flight
ends face-on at the keyhole, which is the world origin — so the swap is
seamless by construction, not by tuning two numbers to match.

Insertion is a pitch into the door + a slide along the shaft + a spin about the
shaft, as three nested frames.

**Side effects**
- Two representations of the same key now exist. Any change to a key's
  geometry affects both `keyRenderer.js` and `key3d.js`.
- The socket needs `depthTest: false` *and* `depthWrite: false`, sequenced by
  explicit `renderOrder` (leaf → socket → plate → key). The door leaf is a
  solid slab with no hole in it, so without this the leaf's front face wins
  and the keyhole looks painted on. **Fragile:** adding anything else
  transparent near the lock will need a renderOrder too.
- `renderOrder` does **not** inherit from a `Group` — it must be set on the
  meshes. Cost me a debugging round.
- An earlier version used a rotating clipping plane to swallow the key. Removed
  once the pitch made real depth occlusion work. `localClippingEnabled` was
  removed with it.

---

## 2026-08-02 — Metals were rendering black ⚠️

`src/door3d.js`

The lock plate rendered as a solid black blob. **A metal's base colour is its
specular tint, not a diffuse paint** — at high metalness there is no diffuse
term at all, so `0x3a3a46` meant "a mirror reflecting 22% of what it sees,"
which is black however much light you add.

Two fixes: a prefiltered environment map (a 256×128 gradient through
`PMREMGenerator`) so metal has something to reflect, and a base colour raised
to a mid tone (`0x9298ad`, roughly iron's real ~55% reflectance).

**Side effects**
- `scene.environment` applies to **every** PBR material in the scene, so the
  door leaves got brighter and shinier too. Compensated with
  `envMapIntensity: 0.5` on the leaf face and metalness `0.95 → 0.8`.
- Same bug later found on the key — fixed by dropping its metalness to 0.2
  instead, since it should read as painted lilac, not polished metal.

---

## 2026-07-31 — Door migrated to three.js ⚠️

`src/door3d.js` (new), `src/doorAssets.js` (new), `src/door.js`, `src/Spiral.jsx`

The 2D door faked its swing by slicing the leaf bitmap into vertical strips and
scaling each one, because Canvas2D only does affine transforms. That can never
give the panels real thickness, real perspective, or any lighting — and
lighting is the entire reason carved ornament reads as carved.

Now a three.js scene on its own WebGL canvas *behind* the particle canvas.
Coordinates are deliberately "screen pixels as world units": the camera is
placed so the plane z = 0 spans exactly the viewport, origin at screen centre —
matching what the 2D engine already assumes, so the keyhole lands at world
(0,0) and the key-flight animation needed no changes.

Carving is a **normal map**, not geometry. `door.js` runs the same painting code
twice under two palettes — colour, and a greyscale height field — and
`door3d.js` derives a normal map (Sobel) plus a packed roughness/metalness map
from the height pass.

**Side effects**
- **Bundle: 227 kB → 756 kB raw, 206 kB gzipped.** three is ~150 kB of that.
- `door.js`'s painters now read from a swappable palette (`C`) instead of
  module constants. Any new ornament must use a palette colour or it won't get
  relief.
- **The old `IRON`/`WOOD`/`GRAIN` constants were reset.** They'd been left at
  `#ffe25f` / `#f0c2ec` / `#040454` — yellow, pink, navy. Now
  `DOOR_PALETTE.colour` at the top of `door.js`.
- The 2D `drawDoor` path is kept as a fallback when WebGL is unavailable, so
  door art changes must work in both.
- `Door3D` creates and owns its own canvas inside a container `<div>` rather
  than being handed one — a StrictMode double-mount would otherwise try to bind
  a second WebGL context to the same element. `unmount` calls
  `forceContextLoss()`; contexts are capped per page and dev remounts leak them.
- Relief has no silhouette: at a grazing angle the door edge stays perfectly
  flat. Invisible at these angles, but it's the trade for zero triangles.

### Authoring pipeline
`DOOR_ART.md` (new), `src/doorAssets.js`

Point `DOOR_ASSETS` at your own `colour` + `height` PNGs in `public/door/` and
none of the procedural painting runs. `DOOR_ART.md` is the full guide.

**Side effects**
- Loads async with a fallback; a bad path logs a warning and keeps the painted
  door. Vite's dev server returns **200 for missing files** (SPA fallback), so
  a 200 does not mean the file exists — open the URL and look at it.
- **Corrected earlier guidance:** I first said the leaf aspect should be ~1:2.
  Wrong. A leaf is half the viewport wide but its *full* height, so on a normal
  desktop it's nearer 0.8:1. Use **1024 × 1280**.

---

## 2026-07-30 — Door art rewrite ✅

`src/door.js`

Fixed art that was asymmetric, sparse, and visibly corrupted.

- **Right leaf was scrambled** by a double mirror: a pre-mirrored canvas *and*
  strips walked in reverse. Strip positions flipped while their contents
  didn't, shredding the art into blocks. Now one leaf is painted and the right
  side is the same canvas through a mirrored transform — symmetric by
  construction rather than by two code paths agreeing.
- **Ornament was sparse** — a fixed handful of motifs floating on a wide door.
  Now tiled on a near-square grid with rosette bosses over the interior joins.
- **A scribble along the bottom** was a second ornament panel computed to ~6%
  of the door's height, squashing motifs into noise. Removed; straps moved to
  0.075/0.855 so the main field gets real room.

**Side effects**
- The seam edge is deliberately left unframed, so the two leaves meet without a
  double-thick line down the middle.

---

## Environment notes

- **Node 22 required for the build.** The default shell `node` is v20.11.1 and
  Vite 8 fails on it with `does not provide an export named 'styleText'`:
  ```
  export PATH="$HOME/.nvm/versions/node/v22.17.0/bin:$PATH"
  ```
- Screenshots for verification:
  ```
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --headless=new --enable-unsafe-swiftshader --hide-scrollbars \
    --window-size=1280,800 --virtual-time-budget=6000 \
    --screenshot=out.png "http://localhost:5173/?unlock=0.72"
  ```
  `--enable-unsafe-swiftshader` is required — headless has no GPU, and without
  it there's no WebGL context and the door silently falls back to 2D.
