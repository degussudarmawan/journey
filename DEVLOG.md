# Dev log

Running record of changes: what changed, why, and **what it broke or might break**.
Newest first. Every entry should have a side-effects section — that's the part
worth reading in six months.

Legend: **✅ verified** = I actually looked at it rendering.
**⚠️ unverified** = built and reasoned about, but nobody has seen it.

---

## 2026-08-25 — Crow feathers instead of dots, behind `?dots=feather` ⚠️

`src/featherGL.js` (new), `src/dotsGL.js`, `src/Spiral.jsx`

User: "I wanna see how it looks like if we change the dots in the spiral into
crow black feather... but dont delete the current one cuz i just wanna see how
it look like". So: a look-see, strictly additive, nothing removed.

Built as a second pair of shaders rather than a branch inside the existing
ones. `VERT`/`FRAG` in `dotsGL.js` are untouched byte-for-byte; `_makeMaterial()`
picks between them and the feather pair. The whole experiment is one new file
plus the material swap — deleting it is deleting `featherGL.js` and five lines.

The feather is a **procedural mask inside the point sprite**, not a texture:
the dots span three orders of magnitude across the funnel, and a bitmap would
be mush at both ends. Shape is a bowed shaft, asymmetric vanes (narrow leading,
broad trailing), barb stripes running out-and-back from the rachis, a few
unzipped splits at the edge, and a blue→green→violet oil-slick that strengthens
toward the tip — crow black being a very dark base under a sheen, not flat
black.

Two things this had to solve that a dot doesn't have:

- **Orientation, with no call-site changes.** Every stage is composed around a
  centre, so `atan(position.y, position.x) + π/2` is the direction the field is
  actually travelling — feathers stream along the arms for free. Variation
  comes from a smooth spatial phase, deliberately *not* a hash: a hash of a
  moving position pops each time a dot crosses a cell.
- **A sprite big enough to hold it.** A feather is ~4:1, so a sprite sized to
  the dot fits a feather a quarter the dot's length. The quad grows by
  `spread` (3.4x) and alpha is compensated back down — `sqrt` of the area
  ratio, not the full ratio the dot shader uses, since the mask only inks a
  fraction of the quad.

### Side effects

- **Fill rate.** Sprites 3.4x wider are ~12x the fill, and the near orbit
  needles are already large. Expect this to be heavier than the dots. Untested
  on this machine — no headless GL here.
- **Under ~5px of quad it draws the ordinary dot instead**, at the dot's real
  size inside the grown quad. Without that the mask aliases to nothing and the
  far half of the funnel disappears — which reads as a broken renderer, not as
  feathers. There is a visible character change at that threshold; it's a
  prototype, so it's left hard rather than blended.
- **Overlap ordering** is the same transparent-with-depthWrite bargain the
  dots already make, but feathers are much bigger, so any artefact is more
  visible.
- `renderer.debug.onShaderError` is now hooked **while in feather mode only**,
  and clears itself on fallback. If the feather shader fails to compile it
  logs once and swaps back to the dots next frame, rather than leaving a black
  screen. Nothing else in the app sets that hook today; if something ever does,
  this will fight it.
- Knobs are live on the query string, so tuning needs no rebuild:
  `?dots=feather&spread=3.4&width=0.13&sheen=0.55&gain=1.35&flutter=0.16&tint=0.1`

⚠️ **Unverified — nobody has seen this render.** No headless browser on this
machine, so the GLSL has been read carefully but never compiled. The fallback
hook above exists precisely because I couldn't check.

---

## 2026-08-14 — Randomly black dots: a palette shorter than its slots ✅

`src/spiralEngine.js`, `src/dotsGL.js`

User: "why r u bringing back the black sampling". Their word for it was exact —
it *was* sampling, and it was returning black.

`App.jsx` passes `accentPalette={['#f1f10e']}`: one colour. But `colorSlot` is
rolled once at build time against a **fixed count of four**, so slots 1..3
index past the end and read as `undefined`. Assigning `undefined` to
`fillStyle` is a **silent no-op** — the context keeps whatever it held — so
`ColorCache` sampled black on a fresh context and then cached that under the
`undefined` key forever.

That is also the "random black dots" reported days earlier, which I misdiagnosed
as size jitter and "fixed" by deleting `SPIRAL_DOT_JITTER`. The jitter was
innocent. This had been live since the palette was cut to one colour.

- `slotColor(slot, palette)` wraps the index into the palette's real length, so
  every slot resolves to a real colour whatever length it is. Used by the main
  draw and the star branch.
- `ColorCache` now sets a known magenta before attempting the parse, so a
  colour that fails to parse shows up as obvious magenta rather than as a
  mystery black that looks like a rendering bug.

**Side effects**
- With a one-colour palette the 40% of particles that aren't `INK` all get that
  same colour, so the field is effectively two-tone. Not a bug — but the
  variety only comes back by adding palette entries.
- **Slot count and palette length are still independent.** `colorSlot` is baked
  in `buildGrid` and the palette is a live prop; wrapping at draw time is what
  keeps them safe, so anything new that reads `palette[...]` directly
  reintroduces this.

---

## 2026-08-14 — Landing polka dots, and disintegration ✅

`src/spiralEngine.js`

Reference supplied for the landing page: big dots, generous gaps. The dots
weren't just small — the **pitch** was wrong, and the dot-to-gap ratio was
already about right at ~0.14.

**The constraint:** the landing grid IS the particle pool for every later
stage. Thinning it to get the spacing would strip the words and the starburst
of the particles they're built from. So the landing draws a **sparse subset** —
one dot per `LANDING_STRIDE^2` — and the rest of the pool is hidden until the
explosion.

- `LANDING_STRIDE = 5`, kept **odd**: the grid is bricked, so an even stride
  picks rows offset the same way and the stagger disappears.
- The brick had to be **re-derived at the subset's scale**. Inheriting the
  grid's own half-pitch stagger gave a 14px nudge against a 140px gap — a 10%
  wobble that reads as misalignment, not pattern. Alternate landing rows now
  shift by half a stride.
- `GRID_DOT_FRAC` (0.15) sizes the dot against the LANDING pitch;
  `GRID_DOT_FRAC_DENSE` (0.16) against the full grid pitch, seen mid-explosion.

**Then the transition, in three passes** — each fixing what the last revealed:

1. Hidden dots faded in **at their own grid cells**, so the full 46-column
   lattice materialised beneath the 9-column polka dots. Two regular patterns
   at different scales in one space read as *two layers* however the opacity is
   tuned.
2. Started them stacked at their **parent's centre** instead, growing from zero
   size rather than fading — fading in is still *appearing*, just softly;
   growing from a point means no frame where a dot exists without having come
   from somewhere. Better, but it's a disc *spraying*, not coming apart.
3. **Disintegration**: every particle in a cell — the landing dot included — is
   a fragment scattered across the parent's face. The disc IS its pieces, so it
   comes to bits rather than emitting them.

**Side effects**
- Fragments are placed within `landingR - fragR`, bounding the whole PIECE
  rather than its centre. Scattering centres across the full radius lets each
  fragment hang its own radius past the edge, and the resting polka dots come
  out as lumpy clusters instead of circles.
- The landing dot **holds its size briefly** before shrinking to a fragment. It
  is the clean circle the eye is already tracking, and it covers the pieces
  while they are still packed tightly enough for their silhouette to matter.
- **Size settles faster than position** (`m * 2.4`). A fragment must be ~2x the
  spiral's dot size to help cover its polka dot at rest, so carrying that size
  the whole way sends visible chunks into a field of much finer dots. This is a
  real tension — `fragR` is forced by coverage, `SPIRAL_DOT_BASE` by the funnel
  — so they can't be one number; decoupling *when* each applies resolves it.
- The explosion is staggered by `delayFrac`, so the split ripples out from the
  centre rather than every dot bursting at once.
- Over-coverage factor `1.7` in `fragR`: below it the resting dots start
  reading as gravel rather than circles.

---

## 2026-08-14 — Comet trails on the moving dots ✅

`src/spiralEngine.js`

Each dot now emits a few samples of where it actually was, drawn before its
head so the head paints over its own tail.

**Why sampling the past beats the usual approaches.** Positions here are
*analytic* — a function of `elapsed`, not accumulated state — so evaluating
where a dot was is exactly as cheap as where it is. That rules out the two
things people normally reach for:

- **No trail buffer.** The "skip the clear, wash the canvas with a translucent
  fill" trick would smear the door and the key too, and fight the depth buffer.
- **No stored history.** Nothing to go stale on a resize, a stage change, or a
  scrub of the timeline.

And because each sample is a *real former position*, the tail's length IS the
dot's speed rather than a decoration on top of it. Outer dots sweep a far
bigger circle in the same time and streak visibly; inner ones barely smear; a
stationary dot has no tail at all — so trails vanish by themselves as the dots
settle into a word, with no special-casing.

`TRAIL_STEPS` 5, `TRAIL_SECS` 0.16, `TRAIL_STRENGTH` 0.55, `TRAIL_TAPER` 0.35.

**Side effects**
- **Point budget is now ~6x the particle count** (~8.5k of `MAX_DOTS` 24000).
  Past roughly `TRAIL_STEPS = 15` it overflows and `push()` silently drops
  dots — it returns early rather than growing the buffer.
- Head and tail go through one `emit()` so they can't drift apart, and share
  one `z` so the tail stays inside the funnel instead of skating across it.
- Scoped to the spiral/word stages. The orbit's needles move too, but they're
  thousands of halftone sub-dots — trails there are a budget question, not a
  one-line change.

---

## 2026-08-14 — Haze spread across the field, not just the core ✅

`src/spiralEngine.js`

User: "the fade only works on the inner circle". Correct — the haze was keyed
to `z`, and `SPIRAL_Z_CURVE = 1.6` deliberately keeps the outer arms shallow.
So across the entire outer half opacity only moved 0.74 → 1.0, and the whole
range dumped into the core: a dim patch in the middle rather than a field
receding.

Size still follows real depth — that's what makes the funnel a funnel — but
**haze now runs on radius**, which spreads the same amount of fade evenly over
everything on screen. It's the authored cue of the two, so it's the one free
to be keyed to whatever reads best.

Also removed the per-particle dot size jitter: with size now purely
depth-driven, random variation on top just scatters oversized specks that read
as noise rather than distance.

**Side effects**
- Dead constants deleted: `SPIRAL_DOT_INNER`, `SPIRAL_DOT_OUTER`,
  `SPIRAL_DOT_CURVE`, `SPIRAL_DOT_JITTER`, `SPIRAL_FADE_OUTER`.
- Size and haze are now driven by *different* inputs (z vs radius) on purpose.
  That was a bug the last three times it happened by accident — the difference
  is that one of them is physical and the other is a stylistic overlay.

---

## 2026-08-06 — The door has a doorway ✅

`src/door3d.js`, `src/dotsGL.js`, `src/spiralEngine.js`

Added a frame: jambs, a heavier lintel, a heavier sill again where it meets
the floor. Extruded and bevelled, casting onto the leaves it surrounds.

The leaves used to be exactly the viewport, which is why there was no border
to have — the door bled off every edge. They were set to fill **`DOOR_FILL`
(0.9)** of it, with the frame taking the rest.

> **Reverted the same day: `DOOR_FILL` is back to 1.** Insetting the leaves put
> a border on screen at full approach, but it also meant the arrival no longer
> ended with the artwork at full size — user: *"why is it not full screen when
> zoom in? this part shud stay the same as before"*. The frame lives OUTSIDE
> the leaves again, so it does its job while the door stands off in the room
> and passes beyond the viewport as the door comes forward. The plumbing below
> stayed: `DOOR_FILL` is still threaded through everything, it just evaluates
> to 1, so the choice is a one-line change rather than a re-derivation.

**That 0.9 is the thing to be careful with.** The leaves and the screen used to
be the same rectangle, and a lot of code quietly assumed it. Anything
positioned "as a fraction of the door" is now a fraction of the *door*:

- `lockMetrics` is passed the leaf size, not the viewport
- `clearLockField` maps its ellipse against the leaf
- `keyDoorScale()` scales by `DOOR_FILL`
- the key's flight reads its target from **`dotsGL.lockScreenY()`** instead of
  deriving it again from viewport height

That last one is the pattern that keeps paying off here: the same value
computed independently in two places is what has put the key and the keyhole
in different spots every single time the door's proportions changed. Now the
lock is built once and everything else asks it.

**Side effects**
- The frame is visible at BOTH ends of the journey now — reading the object as
  a door while it stands off in the room, and giving it an edge once it fills
  the frame. Earlier it was outside the viewport at full approach.
- `DOOR_FILL` is exported from `door3d` and imported by `dotsGL` and the
  engine. Three modules now share it; changing it moves the lock, the key's
  scale and the cleared field together, which is the point.
- The door keeps the viewport's aspect, so at a distance it reads as a wide
  doorway rather than a tall one. A portrait door would need the leaves to
  stop matching the screen's shape, which reopens everything above.

---

## 2026-08-06 — The spiral's depth is real, not painted ✅

`src/spiralEngine.js`

User asked whether the funnel could be genuine 3D rather than an illusion. It
can, and cheaply — the dots already render through a perspective camera; they
were just being pushed at `depth = 0` with the depth hand-drawn on top.

Each particle now has a true `spiralZ` (rim at the screen plane, throat
`SPIRAL_DEPTH` behind it) and the same perspective divide the orbit uses does
the rest. **Size and inward pull now come from one number**, so a particle at
the throat is both smaller and closer to the centre by exactly the same factor.
That coupling is what an illusion can't reproduce: a flat disc with small dots
in the middle reads as small dots, while a funnel converges as it shrinks.

Six near-identical stage branches collapsed into one. Each stage supplies a
flat target (grid or word) and a number `m` for how far into the funnel it has
travelled; position, size and haze all derive from that. The old branches each
hand-tuned their own size and alpha crossfades — which is exactly how the size
and the fade ended up on different ramps and disagreeing.

Then tuned for contrast, because correct wasn't the same as legible: at ~5x
between near and far dots both still read as "a small dot". `SPIRAL_DEPTH`
3400 → 5200, `SPIRAL_DOT_BASE` 3.4 → 6.2, `SPIRAL_FADE_INNER` 0.42 → 0.22.

**Side effects**
- **Deleted** `SPIRAL_DOT_INNER` / `OUTER` / `CURVE` and `p.spiralFade`. One
  dot size (`SPIRAL_DOT_BASE`) measured at the plane; perspective grades it.
- Haze stays authored — perspective gives you no atmospheric falloff — but is
  driven by true distance now rather than a stand-in for it.
- `SPIRAL_FILL` no longer controls the funnel, only how wide the field is.
  Depth is `SPIRAL_DEPTH` against `ORBIT_FOCAL`, so **changing the orbit's
  focal length now also changes the spiral's depth**. They share one camera;
  that's the price of it being one real space.
- Earlier attempts keyed the ramps to `visRadius` (the largest fully-visible
  radius). That clamps at the screen edge, pinning everything beyond it to
  maximum size — a flat band filling the outer frame with the whole gradient
  crushed into the middle. User caught it. Moot now, but worth not repeating.

---

## 2026-08-06 — Teleporting needles, and the spiral properly full-screen ✅

`src/dotsGL.js`, `src/spiralEngine.js`, `src/door3d.js`

**0. I broke the page.** A scripted range-deletion meant to remove the dead
lock shapes from `door3d.js` also took `envCanvas()` with it. The build passed
— an undefined free variable is a *runtime* ReferenceError, not a compile
error — so nothing caught it until the whole component threw and the site went
blank. Restored. Second time a scripted edit has caused a problem; targeted
edits only.

**1. Near needles teleported past the eye.** `orbitPersp()` floors its
denominator so a piece swinging close to the camera can't divide by nothing.
`dotsGL.push()` mirrored that as a clamp on the SCALE — which breaks the round
trip, because it unprojects with the clamped scale and the GPU then
re-projects with the true depth. The moment the clamp engages the two disagree,
violently, since that's exactly where the true scale is running away. Now the
DEPTH is clamped instead, so one number describes the dot and unproject and
project stay inverses.

**2. The spiral was small and flat again.** My previous "fix" traded the wrong
thing away. The real constraint isn't the radius, it's that **the size ramp has
to finish inside the frame**: keyed to the full radius, its top end lands
off-screen and all you ever see is the small, flat inner part — which is why
shrinking the radius made the gradient visible but killed the coverage, and
growing it did the reverse.

Radius is back on the diagonal (`SPIRAL_FILL = 0.56`) so the arms carry past
the corners, and the size ramp is measured against `visRadius` — the largest
radius still fully on screen — and clamps there. Full coverage AND the whole
grit-to-boulder range visible, which were never actually in conflict.

**Side effects**
- Dots beyond `visRadius` are all at maximum size. Correct here (they're rim
  either way) but it does mean `SPIRAL_FILL` no longer affects how big the
  biggest dots are — only how far the field extends.

---

## 2026-08-06 — Spiral fills the screen, and dots size by radius ✅

`src/spiralEngine.js`, `src/door3d.js`

The spiral was a small disc of evenly-sized dots. It now reads as a funnel seen
down its axis: grit at the core swelling to rocks at the rim, so **size alone
carries the depth**. Nothing moves in z — the eye just reads "smaller and
denser" as "further away".

- `SPIRAL_FILL` 0.4 → **0.78** of the short edge
- `SPIRAL_DOT_INNER` 0.4px → `SPIRAL_DOT_OUTER` 4.2px, linear in radius
- Grid pitch `w/46` → **`w/62`** (N ≈ 1400 → 2370)

**A wrong turn worth recording.** My first attempt measured the radius against
the screen's DIAGONAL, reasoning that the arms should reach the corners. That
is exactly backwards: it put the rim *past* the corners, so the entire outer
half of the funnel — the big dots, the part carrying the effect — sat
off-screen, and all that remained on screen was the small, sparse core. It
looked *worse* than before while the numbers said it was twice as big. Only
dumping `maxRadius` and the outermost particle's actual radius into
`document.title` settled it; three rounds of squinting at screenshots had me
convinced the code wasn't running at all.

**Side effects**
- **Density had to follow the radius.** The grid's particle count is also the
  spiral's particle count, so nearly doubling the outer radius over the same
  count left the arms as scattered specks. More particles also means a finer
  opening grid and more star sub-dots — still well inside `MAX_DOTS`.
- `spiralDotR` is separate from `dustR` on purpose. `dustR` also draws the
  WORDS, where position has nothing to do with spiral radius, and a 10x size
  spread there would just look lumpy. The two crossfade during
  `toWord`/`toSpiral` so neither look leaks into the other.
- Removed `escutcheonShape`/`keyholeShape` from `door3d.js` — dead since the
  lock moved to `lock3d.js`, and duplicated geometry definitions are precisely
  the thing that drifts apart.

---

## 2026-08-06 — The dots never had depth turned on ✅

`src/dotsGL.js`, `src/spiralEngine.js`

**1. The key always drew over the dots.** The dots material still carried
`depthTest: false, depthWrite: false` — correct for the prototype, where the
header said in as many words that *real depth is the prize for migrating, not
something to prototype*. I migrated and never turned it on. So the key painted
over every dot regardless of where it sat in the ring, and a key on the ring's
FAR side still covered the near needles: the orbit stopped reading as an orbit.

Both flags now on. `depthWrite` matters as much as `depthTest` — without it
the dots test against the key but never record themselves, so the key is never
hidden *by* them, only they by it. The fragment shader also discards
near-invisible fragments now, since a barely-there dot would otherwise stamp
the depth buffer and punch a hole in whatever is behind it.

**2. The key passed behind the lock mid-flight.** The lock fades in partway
through the crossing, and a key still at ring depth when that happens is behind
the plate for the rest of the flight, then pops through. Depth now arrives
first (`tZ = t * 2.2`): the key is pulled clear of the lock before the lock
exists, and the remaining travel is *across* the frame rather than into it.

**Side effects**
- Dots are alpha-blended AND write depth, which is normally a bad combination:
  a dot drawn early occludes a dot behind it even where it's semi-transparent.
  Invisible here because the marks are small and near-opaque, and the discard
  threshold keeps the soft edges out of the buffer. If halos ever show up
  around dots, that pairing is the cause.
- Front-loading depth means the key comes toward the viewer, then travels
  across. Reads as "brought forward, then carried over" — deliberate, and the
  more legible of the two orderings, but it is not a straight line.

---

## 2026-08-06 — The door arrives in a room instead of fading in ✅

`src/door3d.js`, `src/spiralEngine.js`

Re-choreographed the unlock. The door used to fade up in place, which reads as
a cut. It now treats the whitespace as a **room**: it slides up out of the
floor, comes to rest standing at a distance behind the still-orbiting pieces,
and only then travels forward until it fills the frame — at which point the
existing insert/turn/swing takes over unchanged.

`UNLOCK_SECS` 4.6 → **6.4**, and the phases restaged:

| phase | when | what |
|---|---|---|
| `U_RISE` | 0.00–0.26 | door slides up out of the floor, far off |
| `U_CLEAR` | 0.20–0.36 | remaining pieces sweep away |
| `U_APPROACH` | 0.28–0.54 | door travels forward to fill the frame |
| `U_FLIGHT` | 0.34–0.62 | key crosses to the keyhole |
| `U_INSERT` / `U_TURN` / `U_SWING` | 0.62–1.00 | unchanged |

Overlaps are deliberate — each move starts before the last has quite settled,
so it reads as one continuous action rather than a list of steps. The flight
runs *with* the approach, not after it, so key and door move inward together.

**The door travels to the viewer, not the viewer to the door.** From the front
those are the same picture, and moving one object is far less to keep in step
than moving a camera that everything else is positioned against.

**Side effects**
- `alpha` is now pinned at 1 for the whole sequence. The door starts below the
  floor, so there's nothing to hide, and a fade would undercut the illusion
  that it's a solid thing entering a space. `U_DOOR_IN` is gone.
- The leaves moved into their own `doorGroup` so the door can travel;
  **the backdrop deliberately stayed out of it**, since it represents what lies
  beyond the doorway and must not travel with the door. It's also hidden until
  `open > 0` — left visible it papers over the room the door stands in.
- The lock fades in over the last quarter of the approach. It's drawn at
  full-screen scale in the dots scene, so showing it earlier would float a
  giant escutcheon in mid-air next to a small distant door.
- The key looks large against the far door during the approach. That's correct
  perspective, not a bug — it's near the viewer and the door is across the
  room.
- The 2D fallback still fades; it has no room to fly in from.

---

## 2026-08-06 — Flight was landing behind the plate ✅

`src/spiralEngine.js`, `src/dotsGL.js`

Second half of the same bug, in a different phase. `keyUnlockFrame`'s endpoint
had **z = 0** — the door's own plane. But the lock plate stands proud of that
surface, so the key spent the whole late approach behind it and then snapped
forward at the handoff to the seated pose.

The flight now ends at `dotsGL.keyRestZ()`, the same z the seated pose starts
from, so the two phases meet instead of jumping.

**Side effects**
- The engine now asks `dotsGL` where the lock's front face is. A CPU-side
  animation reading a number out of the renderer isn't lovely, but the
  alternative is the engine recomputing plate geometry it has no other reason
  to know about — and *that* is exactly the kind of duplicate that let these
  two phases disagree in the first place.
- `keyRestZ()` returns 0 before the lock is built. Harmless: nothing flies
  until a key is selected, and selecting one builds the lock.

---

## 2026-08-06 — Key was lying behind the lock ✅

`src/dotsGL.js`

The seated key's pivot sat at the plate's **mid-depth** (`pd * 0.5`). But the
extrusion runs out to `1.45 * pd` once the bevel is counted, and the key only
climbs in z as it rises out of the hole — so a long stretch of shaft was buried
under the plate's front face. The key read as lying behind the lock instead of
standing in it.

Pivot moved to `pd * 1.15`, just inside the front face. Everything below the
hole is still hidden, which is the part that should be.

Also pinned `renderOrder` on the lock and the key. Both are transparent (they
fade with the door) and three sorts the transparent pass by centroid distance,
which flips as the key tilts past the plate. The depth buffer still does the
real occlusion; this just stops the sort order from having a vote.

**Side effects**
- The key sinks visibly less far now. It's the difference between "in the
  lock" and "swallowed by it", but if the insertion wants to feel deeper,
  `_keyZIn` is the number and `1.15` is the floor before the shaft starts
  disappearing again.

---

## 2026-08-05 — Fallout from the single-mesh refactor ✅

`src/dotsGL.js`, `src/spiralEngine.js`

**1. State leaked between the two pose modes.** One mesh now serves both, but
they drive *different properties*: the orbit/flight pose writes a matrix on the
object, the seated pose writes scale and rotations on the pivots. Whatever one
set stayed set when the other took over — and `keyPivot.scale` is around 100,
so the next basis pose multiplied its own scale by that again. A key a hundred
times too big.

`_resetKeyFrames()` now clears every frame to identity before either mode
applies its transform, which makes them independent rather than merely ordered.
Two modes sharing one object is fine; two modes sharing one object and each
assuming the other's leftovers is not.

**2. The key was oversized against its plate.** `KEY_DOOR_SCALE` 0.32 → 0.26.

**3. The flight passed through edge-on.** Position and orientation were blended
at the same rate, which drags the key through edge-on around halfway — and a
real solid seen edge-on is a sliver. The flat 2D key never had this problem
because it always drew its full silhouette regardless of angle. Orientation now
leads (`tA = t * 1.9`), so the key turns face-on in the first half of the
approach and stays readable for the part anyone watches.

**Side effects**
- Front-loading the orientation means the key is face-on well before it
  arrives, so the last half of the flight is pure translation. Reads as
  "presented, then delivered" — deliberate, but it is a different rhythm from
  a uniform blend.
- `_resetKeyFrames` runs per frame. Nine property writes; nothing.

---

## 2026-08-04 — One key mesh, not two ✅

`src/lock3d.js` (new), `src/dotsGL.js`, `src/door3d.js`, `src/spiralEngine.js`

User spotted it: "the light reflection suddenly changing so weird." There were
**two** key meshes — one in the dots scene for the orbit and flight, one in the
door's for the seat and turn — and the two scenes had different lighting (an
environment map and a fill light on one side only). The key changed material
as it crossed. Not subtle once you know to look.

The structural cause: a mesh can only be in one scene, and the key has to be
occluded by *dots* while it orbits and by the *plate* while it enters. So the
fix wasn't to match the lighting, it was to stop needing two scenes for the
key at all — **the lock moved to the dots scene** (`lock3d.js`), and the key
now lives there permanently under one set of lights.

The door leaves stayed behind on their own canvas. They never needed to
interleave with the key by depth: the plate is always in front of them, and
fades out before they swing.

**Side effects**
- **The plate's real cast shadow is gone** — it isn't in the leaves' scene any
  more. Replaced with a painted contact shadow baked into the cleared field.
  Cheaper, and indistinguishable at this angle, but it will not track the
  light if the rig ever changes.
- The socket dropped its `depthTest: false` / `renderOrder` hack. That existed
  only because the door leaf was a solid slab in the same scene winning the
  depth test; there's no leaf here, so ordinary depth works and the socket's
  own far cap supplies the dark floor. **A genuinely simpler result.**
- `dotsGL`'s lighting was raised to match `door3d`'s exactly (env map, key,
  fill, ambient) so the plate and the leaves still read as one piece of
  ironmongery across the two canvases. That pairing is now the thing to keep
  in sync — one object, two scenes, same failure mode as before if they drift.
- `door3d` is leaves + backdrop only. It still computes `lockMetrics`, but
  purely to know where to clear the artwork.
- `LEAF_DEPTH_FRAC` is exported and shared: the plate stands off that surface
  and has to agree with it.

---

## 2026-08-04 — Lock position is a knob, not a constant ✅

`src/doorAssets.js`, `src/door3d.js`, `src/spiralEngine.js`, `src/door.js`

The lock was hard-coded to the door's vertical centre, which on this artwork
lands squarely on the middle scrollwork. Clearing a field around it helped but
couldn't fix it — **the code can't invent space the design doesn't have.**
Where the lock goes is a property of the artwork, so it belongs with the
artwork.

New `DOOR_LOCK_Y` in `doorAssets.js`: the keyhole's height as a fraction of
the door, 0.5 being dead centre. Set to **0.4**, the gap between the top strap
and the middle scrollwork in the current art.

**Side effects**
- **Four things had to follow it**, and missing any one leaves the key flying
  at a lock that isn't there:
  - the plate group (`door3d._lockY`)
  - the seated key (`setKey`'s pivot)
  - the cleared ornament field (`clearLockField`'s ellipse centre)
  - the key's flight endpoint (`keyUnlockFrame`'s `o1`)
  Plus `keyholePoint` and the escutcheon placement in the 2D fallback.
- **The world origin is no longer the keyhole.** That assumption was baked in
  everywhere and is now wrong — anything new that aims at the lock must add
  the offset rather than targeting (0, 0).
- Move the ornament in the artwork and this needs moving too. It is not
  derived from the art, just aimed at it.

---

## 2026-08-04 — The lock is part of the door now ✅

`src/door3d.js`

The escutcheon floated over the ornament — the ironwork ran straight under it,
so the lock read as a separate object dropped on the door instead of part of
it. My earlier answer ("leave a gap in your artwork") was the wrong place to
solve it: real ironwork is laid out AROUND the lock, and the code can do that
for whatever art happens to be loaded.

`clearLockField()` copies each leaf map and clears an ellipse at the seam,
centred on the lock. The fill colour is **sampled from rings just outside the
cleared area**, so it matches its surroundings whether that's the procedural
planking or a custom PNG — no hard-coded colour that only works for one door.
Feathered at the rim, since a hard-edged patch is just a different pasted-on
shape. Applied to colour and height alike, so the relief is cleared too.

The ellipse is centred on the seam edge, so each leaf carries half and the two
together make one clearing.

**Side effects**
- **Lock sizing moved above the leaves** in `_build`. The leaf artwork now
  depends on the lock's dimensions, so it can't be computed after them.
- Sampling reads pixels at three radii, not one ring: a single ring can land
  entirely on ornament or entirely between it, and either way the patch comes
  out visibly lighter or darker than its field.
- Custom art is **copied, not mutated** — `this.assets` is cached across
  resizes and would otherwise accumulate a clearing every rebuild.
- Costs two extra full-size canvas copies per door build. Only on
  resize/selection, never per frame.

---

## 2026-08-04 — Three unlock bugs ✅

`src/spiralEngine.js`, `src/door3d.js`

**1. The key vanished for the whole flight.** The GL mesh was gated to
`u <= 0`, so it hid the moment the unlock began — and the door's own copy
doesn't appear until the handoff near the end of the approach. Between those
two there was simply no key. The 2D renderer used to cover that window and no
longer runs.

`keyUnlockProject` was split: `keyUnlockFrame` computes the frame, then
`keyUnlockProject` wraps it as a point mapper (2D fallback) and
`keyUnlockBasis` as a basis (GL mesh). Same frame, two consumers, so the
flight can't diverge between them again.

**2. Key and keyhole didn't fit.** The slot ran ~7× the shaft's half-width
deep, but the key stops at the bore — so every pixel below it was empty dark
that read as a second object sitting under the key rather than the hole it
stands in. Slot shortened to 3.4×, bore and flare tightened to match.

**3. The plate read as a sticker on the door art.** Enabled shadow mapping:
the plate casts, the leaves receive. Nothing else anchors a raised object to
the surface it rises from — the eye reads contact from the shadow, not from
matching colour or lighting.

**Side effects**
- The shadow frustum is sized to the LOCK, not the door. A directional light's
  shadow camera covers a fixed box, and one spanning the whole door would
  spend its 1024px map on planking and leave the plate a shadow a few pixels
  wide. Only the lock casts, so only the lock is covered.
- Shadow map adds a second render pass per frame. Trivial here — one light,
  a handful of meshes.
- **The plate still overlaps the door ornament**, and that part is
  composition, not code: the artwork has dense scrollwork right where the lock
  goes. The shadow makes it read as *on top of* rather than *cut into*, which
  is the honest relationship. To fix it properly, leave a clear oval at the
  centre-seam of `colour.png` / `height.png` for the plate to sit in.

---

## 2026-08-04 — WebGL is now the default renderer ✅

`src/Spiral.jsx`

Flipped after seeing the key comparison. GL renders the dots and the key on
every page load; `?dots=2d` forces the old path for side-by-side checks.

**Canvas2D is kept as an automatic fallback**, not deleted. If `DotsGL.mount()`
fails there is no WebGL context to be had, `engine.dotsGL` stays null, and the
2D path takes over on its own with no flag and no error. That costs nothing —
the code is already written — and the alternative is a blank page on hardware
that can't give us a context.

So `keyRenderer.js` stays too. But **GL is now the source of truth**: new keys
are authored and judged against the mesh renderer only. Nobody should be
checking a key looks right in both.

**Side effects**
- The 2D canvas still clears every frame and then draws nothing. Harmless, and
  it's what makes the fallback a one-line switch rather than a rewrite.
- **Watch the edge-on legibility.** A flat sticker reads as a key from every
  angle because it's lying about being 3D; a real solid seen edge-on looks
  like an edge. Most visible when a key is on the far or near side of the
  orbit. Fixes if it grates, both small: widen the key's extrusion depth, or
  add a rim-light pass so the silhouette stays crisp against the background.

---

## 2026-08-04 — Migration: perspective camera + the key as a mesh ✅

`src/dotsGL.js`, `src/spiralEngine.js`

User's push: why wait, since everything gets easier once it's all one 3D
space? Correct — and my "you're mid-way through door art" objection was weak,
since the door is PNGs plus `door3d.js` and never touches the dot path.

**Perspective camera.** `dotsGL` was orthographic, which has no depth for
anything to test against. It now sits at exactly `ORBIT_FOCAL` from the z = 0
plane with its field of view derived from that distance, so the GPU's divide
and the engine's `f / (f + z)` are *the same function* rather than two things
tuned to resemble each other. One consequence falls out for free: z = 0 maps
1:1 to CSS pixels, so the flat stages (grid, spiral, words) are unchanged
without a special case.

**Dots carry depth.** `push()` now takes the view-space z and unprojects the
screen position back to a world point. That indirection is deliberate: call
sites nudge dots around in screen space (the clear-out fly-away, the cursor
repel), and unprojecting at each dot's own depth reinterprets those nudges
correctly instead of forcing all of them to be rewritten in world space.

**The key is a mesh in the dots' scene**, sharing their depth buffer. It stops
being painted between whole pieces and starts being resolved per pixel against
every dot around it. `keyBasisForPiece()` reads the pose off the same piece
frame the dots use — mesh X to the needle's width axis, Y to its long axis, Z
to its thickness.

Verified: orbit and word stages pixel-match the canvas version; the key sits
correctly on its needle as a lit solid.

**Side effects**
- **The GL key has no outline.** The 2D renderer strokes a dark silhouette;
  the mesh has bevels and lighting instead. A real visual difference — to my
  eye better, reads as a solid object rather than a sticker — but it *is* a
  change, and it's the one thing to look at before flipping the default.
- Lights added to the dots scene for the key. The dots ignore them entirely
  (ShaderMaterial, no lighting terms).
- Painter ordering is now cosmetic rather than load-bearing: the depth buffer
  resolves correctness. Kept because alpha-blended dots still look better
  drawn back to front.
- The GL key covers the **orbit pose only**. Once the unlock starts the key
  belongs to the door's scene, which owns the flight and the keyhole. Two
  scenes still, but one *renderer* and one key geometry.
- Canvas remains the default and is byte-for-byte untouched — every change is
  behind `if (this.dotsGL)`.

**Left to finish the migration**
1. Flip GL to default.
2. Delete `keyRenderer.js` and the Canvas2D dot path (~200 lines gone).
3. Optional: replace the hand-rolled free look with `OrbitControls`, now that
   a real camera exists.

---

## 2026-08-03 — GL dot prototype now covers every stage ✅

`src/spiralEngine.js`

User's verdict on the prototype: "tbh they look the same." That was the only
question blocking the migration, so the aesthetic risk is settled.

Routed the remaining stages (grid, spiral, words) through the GL path too, so
`?dots=gl` is now an end-to-end comparison with no renderer seam at the star
boundary. Confirmed against Canvas2D at a spiral stage: same weight, same
density, indistinguishable.

Also added **`?t=0.30`** — pins `scrollT` so a single stage can be held still
and compared. Sits alongside `?unlock=` and `?yaw=`/`?pitch=`.

**Deliberately NOT done:** moving the key into the GL scene. That's where the
value is — one key representation instead of two, compounding over the seven
keys still to author — but it isn't a file move. The engine currently does its
own projection: `project()` performs the perspective divide and `orbitDotPos`
returns SCREEN coordinates. For the GPU to resolve depth between key and dots
it needs raw world coordinates and a perspective camera, so `orbitDotPos`
changes what it returns and every reader adapts — hit testing, the detach
lerp, the star-point lifting. Worth doing, not worth starting mid-way through
door artwork.

**Side effects**
- `?t=` bypasses the hint fade, so "SCROLL" stays visible in debug shots.
  Cosmetic, debug-only.
- Canvas remains the default. GL is still opt-in.

---

## 2026-08-03 — PROTOTYPE: halftone dots as WebGL points ✅

`src/dotsGL.js` (new), `src/spiralEngine.js`, `src/Spiral.jsx`

Not a migration — an experiment to answer one question before committing to
one: **does a GL point sprite look like a Canvas2D dot?** Toggle with
`?dots=gl`; default is unchanged.

Everything except the rasteriser is held constant. The camera is orthographic
and **1:1 with screen pixels**, fed exactly the coordinates the 2D renderer
would have drawn at, and colour/alpha are read back off the 2D context at each
call site rather than threaded through. Same numbers in, different rasteriser
out — otherwise the comparison flatters whichever one you tuned last.

### Result: viable, and the one real difference is fixable

First pass came out visibly **smaller and grittier** than Canvas2D — more white
showing through, forms reading sandy rather than inky. Cause found:

> Most of these dots are **under a pixel across**. A point sprite can't be
> smaller than one pixel, so asking for 0.9px and getting 1px silently *adds*
> ink, while the hard edge removes the soft falloff Canvas2D gives a
> fractional `fillRect`.

Fixed by never drawing below 2px and giving the extra area back in alpha
(squared, since coverage goes as the square of the width). That closed most of
the gap. What remains is a slight hardness at the dot edges — close enough that
you'd need the two side by side to call it.

**Verdict: the aesthetic risk of the full migration is low.** The dot look
survives, and the remaining gap is a shader tweak, not a dead end.

**Side effects**
- Bundle 756 kB → **798 kB** raw (220 kB gzipped) while the prototype is in
  the tree. Deleting `dotsGL.js` returns it; committing to the migration would
  more than pay it back by deleting `keyRenderer.js`.
- `renderDoor3D` renamed **`finishFrame`** — it now flushes both WebGL layers,
  and the old name lied about that.
- Only the **star and orbit** stages route through GL. Word/spiral stages still
  draw to canvas, so with `?dots=gl` the handoff at the star boundary is
  visible. Expected: that boundary is the thing the migration removes.
- The key still draws on the 2D canvas in both modes, so it does not interleave
  by depth with GL dots. Real depth is the *prize* for migrating, not something
  worth prototyping.
- The `oklch()` palette can't be parsed by `THREE.Color`, so colours resolve
  through a 1×1 canvas and a cache. Roundabout, but it's the only parser
  guaranteed to understand every colour the app already uses.

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
