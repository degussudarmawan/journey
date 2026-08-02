# Drawing the door

How to make the artwork for the 3D door yourself, from nothing.

You are producing **two PNG files**. That's it. No 3D software, no modelling.

| file | what it is |
|---|---|
| `colour.png` | what the door looks like — flat, evenly lit |
| `height.png` | greyscale relief: **white = sticks out**, **black = cut in**, **mid grey = flat plank level** |

They must be the **same pixel size** and line up **exactly**, pixel for pixel. The height map is what makes the carving catch the light and throw highlights as the door swings — without it the door is just a picture.

**Draw the LEFT leaf only.** Hinge on the left edge, seam (where the two halves meet) on the right. The right leaf is your image mirrored, so the door is symmetric by construction and you only ever draw half of it.

**Size:** 1024 × 1280 px. See the note at the bottom on why.

---

## 1. Pick a tool

| tool | cost | get it | good for |
|---|---|---|---|
| **Figma** ← start here | free | figma.com, browser | you probably already know it; recolouring for the height pass is trivial |
| **Inkscape** | free | inkscape.org | real vector ornament tools — auto-tracing and tiled clones are genuinely great here |
| **Photopea** | free | photopea.com, browser | Photoshop clone, nothing to install, if you'd rather paint than draw shapes |
| **Krita** | free | krita.org | proper painting brushes, if you want a hand-drawn look |

**Use a vector tool (Figma or Inkscape), not a painting tool.** Three reasons, and the second one is the important one:

1. Ornate curves stay crisp at any size.
2. **You can recolour a whole layer in one click** — which is the entire trick for making the height map, see step 3.
3. Symmetry and repeating motifs are a boolean op instead of careful brushwork.

If you paint the colour map in Krita by hand, you'll have to paint the height map by hand too, aligned pixel-perfectly. That is genuinely painful. Vector makes it a 2-minute job.

---

## 2. Do a 5-minute smoke test *before* drawing anything

Seriously, do this first. Confirm the pipeline works before you invest hours in art.

1. Make **`colour.png`** — 1024 × 1280, filled flat beige. Nothing else.
2. Make **`height.png`** — same size, filled **mid grey `#808080`**, then three **white circles** on it.
3. `mkdir -p public/door`, save both files there.
4. In `src/doorAssets.js`:
   ```js
   export const DOOR_ASSETS = {
     colour: "/door/colour.png",
     height: "/door/height.png",
   };
   ```
5. With `npm run dev` running: scroll to the orbiting rays, click the bottom ray to turn it into a key, then click the key.

You should see a beige door with **three domes bulging out of it**, lit from the upper left.

- Domes look **pressed in** instead of bulging? Set `DOOR_RELIEF_INVERT = true` in the same file.
- No domes at all, just flat beige? The height file isn't loading — check the browser console for the warning, and check the path.
- Nothing appears at all? Your colour file isn't loading either. Check `public/door/` really is inside `spiral-react/`.

Once three circles work, everything else is just more shapes.

---

## 3. The one trick that makes this easy

**Draw the door ONCE. Export it twice.**

Group your shapes by *material* — all the ironwork in one group, all the planks in another, and so on. Then:

- Export as-is → that's `colour.png`.
- Duplicate the whole frame, recolour each group to its grey value, export → that's `height.png`.

Because it's the same geometry, the two maps line up perfectly and always will. If you later move a scroll 3px, you fix it in both by fixing it once and re-exporting.

Use these values to start (they match what the procedural door uses, so you can mix and match):

| material | colour | height grey | why |
|---|---|---|---|
| planks (background) | `#efeade` | `#6a6a6a` | the base surface everything else is measured from |
| gaps between planks | `#a8a293` | `#2a2a2a` | grooves, cut in |
| iron straps & ornament | `#2a2a33` | `#e6e6e6` | bolted on top, stands proud |
| rivet heads | `#4d4d5c` | `#ffffff` | the highest points on the whole door |
| engraved lettering | `#d8d4c8` | `#4a4a4a` | *below* the strap it sits on |

Note the last row: engraving is **darker than its surroundings** in the height map, even though it's lighter in the colour map. Height and colour are answering different questions. Keep asking "how far out does this stick?", not "how dark is this?"

---

## 4. Step by step in Figma

1. **Frame**, `1024 × 1280`. Name it `colour`.
2. **Drop your reference image in**, stretch it to fill the frame, set opacity ~30%, and **lock the layer** (right-click → Lock). You'll trace on top of it. Remember you only want the *left half* of the reference door.
3. **Planks**: a rectangle filling the frame, `#efeade`. Then vertical lines at `#a8a293` for the gaps between boards.
4. **Ornament**: the Pen tool (`P`) for the scrolls and vines. Draw them as **strokes**, then `Object → Outline Stroke` when you're happy — that converts the stroke into a real filled shape, which is what you want for a clean height map.
5. **Straps**: horizontal bars near the top and bottom, `#2a2a33`. Give the seam end a spearhead point (a triangle, union it with the bar).
6. **Rivets**: small circles, `#4d4d5c`, evenly spaced along each strap.
7. **Frame edge**: a border on the **top, left and bottom only**. Leave the **right edge bare** — that's the seam, and a border there gives you a double-thick line down the middle of the door.
8. Put each material in its own **named group**. This is what makes step 3 fast.
9. Select the frame → Export → **PNG, 1×** → `colour.png`.

Then the height pass:

10. Duplicate the frame, rename it `height`.
11. Delete the reference image layer.
12. Select each group in turn and set its fill to the grey from the table.
13. Export → `height.png`.

Drop both in `public/door/`, overwriting your smoke-test files. Vite reloads automatically.

---

## 5. The fast path in Inkscape

If tracing by hand sounds miserable, Inkscape can do most of the work:

- **`Path → Trace Bitmap`** on your reference photo turns the ornament into vector shapes automatically. Try "Brightness cutoff" and drag the threshold until the ironwork separates from the wood. This gets you a usable ornament in about thirty seconds. Clean up the stray bits, and you're most of the way there.
- **`Edit → Clone → Create Tiled Clones`** repeats one motif across a grid with optional mirroring — exactly how real ironwork is laid out, and how the procedural version in `door.js` does it.
- **`Path → Union`** on overlapping scrolls merges them into one shape, so they read as a single piece of iron rather than stacked strokes.

Export via `File → Export`, PNG, with the width set to 1024.

---

## 6. Making it look good

- **No shadows or highlights in the colour map.** The 3D lighting adds those. Painted-in ones fight the real lighting and read as dirt. Flat, even colour only.
- **Blur the height map 1–2 px** before exporting (Figma: Layer Blur on the frame). Razor-sharp height edges give razor-sharp lighting, which looks like cut paper. A couple of pixels of softness reads as a bevelled edge and is the single biggest quality win available.
- **Relief too shallow or too strong?** `DOOR_RELIEF` in `src/doorAssets.js`. Default `2.6`. Raise for deeper carving, lower if the lighting starts looking noisy or plasticky.
- **Wood grain**: subtle noise in the colour map, and *very* subtle in the height map. Strong grain in the height map makes the whole door look like sandpaper.
- **Density matters more than detail.** Sparse ornament on a big door looks unfinished. Fill the field.

## 7. Rules you can't break

- **Leave the keyhole out of your artwork.** The lock plate is drawn separately on top at the seam, because the unlock animation has to know exactly where the keyhole is to fly the key into it.
- **No transparency in the leaf.** Transparent pixels become see-through door.
- **Left leaf only.** Anything you put at the right edge appears mirrored against itself down the centre of the door.
- **Both files, same dimensions.** Different sizes will misalign the relief from the artwork.

## 8. About that size

One leaf covers **half the viewport's width and all of its height**. On a 1920×1080 screen that's 960×1080 — roughly square. On a 1512×982 MacBook it's 756×982, or about 0.77:1.

So the right shape is **slightly taller than wide**, and 1024×1280 (4:5) sits in the middle of the range of screens people actually use. The image is stretched to fit whatever the viewport really is, so ornament drawn at a wildly different ratio will visibly distort — but 4:5 keeps that small everywhere.

---

**Don't want to draw at all?** Leave `DOOR_ASSETS` as `null` and the door is painted procedurally by `src/door.js`. The colours are in `DOOR_PALETTE` at the top of that file, and the ornament layout is `paintOrnament`.
