/* ============================================================================
   DOOR 3D — the unlockable door, rendered as real geometry.
   ============================================================================

   Lives on its own WebGL canvas layered *behind* the particle canvas, so the
   dots and the key keep being drawn in 2D on top of it. The two layers share
   nothing but a screen: this module owns a three.js scene and renders it once
   per frame when the engine asks.

   WHY 3D AND NOT MORE CANVAS2D
   The 2D version (drawDoor in door.js, still there as a fallback) fakes the
   swing by slicing the leaf bitmap into vertical strips and scaling each one,
   because Canvas2D only does affine transforms. That can never give the
   panels real thickness, real perspective, or any lighting at all — and
   lighting is the entire reason carved ornament reads as carved.

   COORDINATES
   Deliberately "screen pixels as world units": the camera is placed so that
   the plane z = 0 spans exactly the viewport, one world unit per CSS pixel,
   with the origin at screen centre. That matches the convention the 2D engine
   already uses, so the keyhole sits at world (0, 0) — which is screen centre —
   and the existing key-flight animation needs no changes to aim at it.

   HOW THE CARVING WORKS
   No modelling. Each leaf is a plain box; all the relief comes from a normal
   map derived from the greyscale height image (see door.js, or your own art
   via doorAssets.js). Normal mapping perturbs the surface normal per pixel
   without adding a single triangle, which is why the ornament can be as
   intricate as you like at no geometric cost. The trade-off is that relief is
   an illusion in the shading only: it never shows up in the silhouette, so
   at a grazing angle the door edge stays perfectly flat. At this scale and
   these angles, that's invisible.
   ============================================================================ */

import * as THREE from "three";
import { buildDoorMaps } from "./door";
import { lockMetrics } from "./lock3d";
import {
  DOOR_ASSETS,
  DOOR_LOCK_Y,
  DOOR_RELIEF,
  DOOR_RELIEF_INVERT,
} from "./doorAssets";

const FOV = 42; // vertical field of view, degrees
/**
 * How much of the viewport the door LEAVES fill once the door has finished
 * approaching.
 *
 * 1 on purpose: the arrival is meant to end with the leaves BEING the screen,
 * so the artwork is finally readable at full size. The frame is built outside
 * them, which means it does its job while the door stands off in the room —
 * reading the object as a door rather than a floating rectangle — and then
 * passes beyond the viewport as the door comes forward. A frame still visible
 * at the end would be eating the artwork exactly when it's worth looking at.
 *
 * Below 1 the leaves stop being the screen, and everything positioned "as a
 * fraction of the door" becomes a fraction of THIS rather than of the
 * viewport — the lock metrics, the cleared field, the key's scale and its
 * flight target all read it. It is wired through so the choice stays open;
 * just don't assume the two rectangles are the same again.
 */
export const DOOR_FILL = 1;
export const LEAF_DEPTH_FRAC = 0.014; // leaf thickness, as a fraction of door height
const OPEN_ANGLE = Math.PI * 0.62; // how far the leaves swing when fully open
const NORMAL_MAP_SCALE = 0.5; // relief is low-frequency; half-res is plenty

// ---- texture helpers -------------------------------------------------------

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function imageToCanvas(img) {
  const c = makeCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
  c.getContext("2d").drawImage(img, 0, 0);
  return c;
}

/**
 * Converts a greyscale height field into a tangent-space normal map.
 *
 * Sobel gradients give the slope in each direction; the surface normal is
 * then (-dh/du, -dh/dv, 1) normalised and packed into RGB. Note the sign on
 * the green channel: canvas y runs downward while texture v runs upward
 * (CanvasTexture flips on upload), so dv = -dy — which is why ny comes out
 * positive here. Get that backwards and every carving reads as an engraving.
 */
function heightToNormal(src, strength) {
  const w = Math.max(2, Math.round(src.width * NORMAL_MAP_SCALE));
  const h = Math.max(2, Math.round(src.height * NORMAL_MAP_SCALE));
  const out = makeCanvas(w, h);
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);

  const px = ctx.getImageData(0, 0, w, h).data;
  const dst = ctx.createImageData(w, h);
  const sign = DOOR_RELIEF_INVERT ? -1 : 1;
  const at = (x, y) => {
    const cx = x < 0 ? 0 : x >= w ? w - 1 : x;
    const cy = y < 0 ? 0 : y >= h ? h - 1 : y;
    return px[(cy * w + cx) * 4] / 255;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = at(x - 1, y - 1),
        tt = at(x, y - 1),
        tr = at(x + 1, y - 1);
      const ll = at(x - 1, y),
        rr = at(x + 1, y);
      const bl = at(x - 1, y + 1),
        bb = at(x, y + 1),
        br = at(x + 1, y + 1);
      const dx = tr + 2 * rr + br - (tl + 2 * ll + bl);
      const dy = bl + 2 * bb + br - (tl + 2 * tt + tr);
      const nx = -dx * strength * sign;
      const ny = dy * strength * sign;
      const len = Math.hypot(nx, ny, 1) || 1;
      const i = (y * w + x) * 4;
      dst.data[i] = (nx / len) * 127.5 + 127.5;
      dst.data[i + 1] = (ny / len) * 127.5 + 127.5;
      dst.data[i + 2] = (1 / len) * 127.5 + 127.5;
      dst.data[i + 3] = 255;
    }
  }
  ctx.putImageData(dst, 0, 0);
  return out;
}

/**
 * Packs roughness and metalness into one texture from the same height field:
 * three reads roughness from the green channel and metalness from the blue,
 * so a single image can drive both. Tall = iron (smooth, metallic), low =
 * wood (rough, dielectric), which is true of this door by construction.
 */
function heightToSpec(src) {
  const w = Math.max(2, Math.round(src.width * NORMAL_MAP_SCALE));
  const h = Math.max(2, Math.round(src.height * NORMAL_MAP_SCALE));
  const out = makeCanvas(w, h);
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const dst = ctx.createImageData(w, h);
  for (let i = 0; i < px.length; i += 4) {
    const v = px[i] / 255;
    dst.data[i] = 0;
    dst.data[i + 1] = (1 - v * 0.75) * 255; // roughness
    dst.data[i + 2] = v * v * 255; // metalness, biased so wood stays dielectric
    dst.data[i + 3] = 255;
  }
  ctx.putImageData(dst, 0, 0);
  return out;
}

// ---- lock geometry ---------------------------------------------------------
//
// Both shapes are built with the ORIGIN AT THE KEYHOLE rather than at the
// plate's centre. The keyhole is the one point everything else has to agree
// about — the key aims for it, the key pivots about it, and the clipping
// plane passes through it — so making it the origin removes an offset from
// every one of those calculations instead of repeating it in each.

/**
 * The lock plate: a shield with the keyhole cut clean through it.
 *
 * The hole is the whole point — without it the plate is a solid slab and the
 * key has nowhere to go, so it ends up perched on the front looking pasted on.
 */
function escutcheonShape(pw, ph, hole) {
  const s = new THREE.Shape();
  const top = ph * 0.39;
  const bot = -ph * 0.55;
  s.moveTo(0, top);
  s.bezierCurveTo(pw * 0.45, ph * 0.3, pw * 0.38, -ph * 0.22, 0, bot);
  s.bezierCurveTo(-pw * 0.38, -ph * 0.22, -pw * 0.45, ph * 0.3, 0, top);
  s.holes.push(keyholeShape(hole));
  return s;
}

/**
 * The keyhole itself: a bore with a tapered ward slot hanging below it.
 *
 * Proportioned so the slot is about as wide as the KEY'S SHAFT. A keyhole
 * sized for looks alone ends up narrower than the key that has to pass
 * through it, and then the key visibly doesn't fit its own lock.
 */
function keyholeShape(hole) {
  const { r, halfTop, halfBot, yBot } = hole;
  // Meet the circle exactly where the slot's sides cross it, so the two
  // merge into one silhouette instead of reading as a disc with a tab.
  const yJoin = -Math.sqrt(Math.max(0, r * r - halfTop * halfTop));
  const aRight = Math.atan2(yJoin, halfTop);
  const s = new THREE.Shape();
  s.absarc(0, 0, r, aRight, Math.PI * 2 + Math.atan2(yJoin, -halfTop), false);
  s.lineTo(-halfBot, yBot);
  s.lineTo(halfBot, yBot);
  s.closePath();
  return s;
}

/**
 * A stand-in "room" for metal to reflect: bright above, dark below, with a
 * horizon. Metalness in a physically-based renderer means "show me your
 * surroundings instead of a diffuse colour" — so a metal lit only by direct
 * lights, with no environment, renders very nearly BLACK. That isn't a bug in
 * the lighting, it's the whole point of the model. This is the cheapest
 * possible fix: 256x128 pixels of gradient, prefiltered once at startup.
 */
function envCanvas() {
  const c = makeCanvas(256, 128);
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.46, "#ccd0e0");
  g.addColorStop(0.54, "#6e7284");
  g.addColorStop(1, "#262830");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 128);
  return c;
}

/**
 * Returns a copy of a leaf map with the lock's footprint cleared to plain
 * planking.
 *
 * Without this the ornament runs straight under the escutcheon and the lock
 * reads as a separate object dropped on top of the door rather than part of
 * it. Real ironwork is laid out AROUND the lock; this does that for whatever
 * artwork happens to be loaded, instead of asking the artwork to leave a gap.
 *
 * The fill colour is sampled from a ring just outside the cleared area, so it
 * matches its surroundings whether that's the procedural planking or a custom
 * PNG. Feathered at the rim, because a hard-edged patch is just a different
 * pasted-on shape.
 *
 * The ellipse is centred on the SEAM edge, so each leaf carries half of it and
 * the two together make one clearing around the lock.
 */
function clearLockField(src, W, H, halfW, halfH) {
  const out = makeCanvas(src.width, src.height);
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);

  // The leaf map covers a leaf of W/2 x H world pixels, whatever its own
  // resolution is — custom art won't match the viewport.
  const rx = halfW * (src.width / (W / 2));
  const ry = halfH * (src.height / H);
  const cx = src.width; // the seam
  const cy = src.height * DOOR_LOCK_Y;

  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  // Sample over several radii, not one ring: a single ring can land entirely
  // on ornament or entirely between it, and either way the patch comes out
  // visibly lighter or darker than the field it's sitting in.
  for (const k of [1.15, 1.35, 1.6]) {
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const px = Math.round(cx + Math.cos(a) * rx * k);
      const py = Math.round(cy + Math.sin(a) * ry * k);
      if (px < 0 || py < 0 || px >= src.width || py >= src.height) continue;
      const d = ctx.getImageData(px, py, 1, 1).data;
      r += d[0];
      g += d[1];
      b += d[2];
      n++;
    }
  }
  if (!n) return out;
  const fill = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;

  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
  grad.addColorStop(0, fill);
  grad.addColorStop(0.7, fill);
  grad.addColorStop(1, fill.replace("rgb(", "rgba(").replace(")", ",0)"));
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = grad;
  ctx.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);

  // Contact shadow, painted rather than cast. The plate lives in the dots
  // scene now, so it can't throw a real shadow onto these leaves — but
  // without one it floats, and the eye reads contact from the shadow more
  // than from anything else. Offset down and right to match the key light.
  const sx = cx + rx * 0.1;
  const sy = cy + ry * 0.12;
  const sh = ctx.createRadialGradient(sx, sy, 0, sx, sy, Math.max(rx, ry) * 0.95);
  sh.addColorStop(0, "rgba(0,0,0,0.34)");
  sh.addColorStop(0.55, "rgba(0,0,0,0.16)");
  sh.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = sh;
  ctx.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);
  ctx.restore();
  return out;
}

/** What lies behind the door, revealed as it parts. */
function backdropCanvas() {
  const c = makeCanvas(512, 512);
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(256, 256, 0, 256, 256, 300);
  g.addColorStop(0, "#fbfbff");
  g.addColorStop(0.55, "#e2e2ee");
  g.addColorStop(1, "#b9b9cb");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  return c;
}

function tex(canvas, { srgb = false } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Same texture, flipped in u — how the right leaf reuses the left's art. */
function mirrored(t) {
  const m = t.clone();
  m.repeat.x = -1;
  m.offset.x = 1;
  m.needsUpdate = true;
  return m;
}

// ---- the door --------------------------------------------------------------

export class Door3D {
  /**
   * @param {HTMLElement} container element to hang the WebGL canvas inside.
   *   Door3D creates and owns that canvas rather than being handed one, so a
   *   StrictMode double-mount gets a clean element each time — binding a
   *   second WebGL context to a canvas that already has one is a coin toss.
   */
  constructor(container) {
    this.container = container;
    this.canvas = null;
    this.ok = false;
    this.built = null; // {W, H, text} the current geometry was built for
    this.assets = null; // user artwork from doorAssets.js, once loaded
    this.state = { alpha: 0, rise: 1, approach: 1, open: 0, plateAlpha: 1 };
    this._alphaApplied = -1;
    this._disposables = [];
  }

  /** @returns {boolean} false if WebGL is unavailable — caller falls back to 2D. */
  mount() {
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, {
      position: "absolute",
      inset: "0",
      display: "block",
      width: "100%",
      height: "100%",
      opacity: "0", // faded in by render(); see setState
      pointerEvents: "none",
    });
    this.container.appendChild(this.canvas);
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        alpha: true,
        antialias: true,
        powerPreference: "high-performance",
      });
    } catch {
      this.canvas.remove();
      this.canvas = null;
      return false; // no WebGL: door.js's 2D path takes over
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearAlpha(0);
    // Shadows exist for one reason: to stop the lock plate reading as a
    // sticker laid over the door art. Nothing else anchors a raised object to
    // the surface it's raised from — matching colours and lighting doesn't do
    // it, because the eye reads contact from the shadow, not the shading.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 1, 40000);

    const envSrc = new THREE.CanvasTexture(envCanvas());
    envSrc.mapping = THREE.EquirectangularReflectionMapping;
    envSrc.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromEquirectangular(envSrc).texture;
    envSrc.dispose();
    pmrem.dispose();

    // Key light from the upper left, so the ornament's relief has a
    // consistent direction to throw its highlights and shadows against.
    const key = new THREE.DirectionalLight(0xfff3e2, 2.1);
    key.position.set(-0.55, 0.8, 1);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0006;
    this.keyLight = key; // shadow frustum is sized to the lock in _build()
    const fill = new THREE.DirectionalLight(0x93a6ff, 0.55);
    fill.position.set(0.9, -0.3, 0.6);
    this.scene.add(key, fill, new THREE.AmbientLight(0xffffff, 0.5));

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.ok = true;
    this._loadAssets();
    return true;
  }

  // Custom artwork, if doorAssets.js points at any. Loads in the background
  // and swaps in when ready; the procedural door renders in the meantime.
  _loadAssets() {
    const { colour, height } = DOOR_ASSETS;
    if (!colour) return;
    const loader = new THREE.ImageLoader();
    const load = (url) =>
      url
        ? new Promise((res) => loader.load(url, res, undefined, () => res(null)))
        : Promise.resolve(null);
    Promise.all([load(colour), load(height)]).then(([c, hgt]) => {
      if (!c) {
        console.warn(`[door3d] couldn't load ${colour}; using the painted door`);
        return;
      }
      this.assets = {
        colour: imageToCanvas(c),
        height: hgt ? imageToCanvas(hgt) : null,
      };
      this.built = null; // force a rebuild with the new art
    });
  }

  /** Rebuilds if the viewport or the door's inscription has changed. */
  ensure(W, H, strapText = "", keyDef = null, keyScale = 1) {
    if (!this.ok) return;
    if (
      this.built &&
      this.built.W === W &&
      this.built.H === H &&
      this.built.text === strapText &&
      this.built.keyId === (keyDef?.id ?? null)
    ) {
      return;
    }
    this._build(W, H, strapText, keyDef, keyScale);
    this.built = { W, H, text: strapText, keyId: keyDef?.id ?? null };
  }

  _build(W, H, strapText, keyDef, keyScale) {
    this._teardownScene();
    this.renderer.setSize(W, H, false); // false: React owns the CSS size
    this.camera.aspect = W / H;
    // Place the camera so the plane z = 0 spans exactly H world units
    // vertically — i.e. one world unit per CSS pixel, origin at screen centre.
    const dist = H / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    this._camDist = dist;
    this.camera.position.set(0, 0, dist);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();

    const maps = buildDoorMaps(W, H, strapText);
    // User artwork replaces the painted leaf, but the lock plate always comes
    // from door.js — the unlock animation depends on where its keyhole is.
    const leafColour = this.assets?.colour || maps.leaf.colour;
    const leafHeight = this.assets
      ? this.assets.height // null is legitimate: flat but correctly lit
      : maps.leaf.height;

    const track = (x) => {
      this._disposables.push(x);
      return x;
    };

    // ---- lock sizing ----
    // The lock's own geometry now lives in the dots scene (see lock3d.js), so
    // the key can be ONE mesh under ONE set of lights for the whole sequence.
    // Its dimensions are still needed here, though: the leaf artwork has to
    // have the lock's footprint cleared out of it.
    // The leaves stop short of the viewport so the frame has somewhere to be.
    // EVERY door-relative measurement below is a fraction of these, not of the
    // screen — the two stopped being the same thing when the frame arrived.
    const DW = W * DOOR_FILL;
    const DH = H * DOOR_FILL;
    const lockM = lockMetrics(keyDef, keyScale, DW, DH);

    // ---- leaves ----
    const leafW = DW / 2;
    const depth = Math.max(6, H * LEAF_DEPTH_FRAC);
    const geo = track(new THREE.BoxGeometry(leafW, DH, depth));

    // Clear the ornament out from under the lock, so the ironwork reads as
    // laid out around it rather than running behind it. A shade larger than
    // the plate, leaving a thin margin of plain planking that shows the two
    // belong to the same surface.
    const fieldW = lockM.pw * 0.72;
    const fieldH = lockM.ph * 0.62;
    const clearedColour = clearLockField(leafColour, DW, DH, fieldW, fieldH);
    const clearedHeight = leafHeight
      ? clearLockField(leafHeight, DW, DH, fieldW, fieldH)
      : null;

    const colourTex = track(tex(clearedColour, { srgb: true }));
    const normalTex = clearedHeight
      ? track(tex(heightToNormal(clearedHeight, DOOR_RELIEF)))
      : null;
    const specTex = clearedHeight
      ? track(tex(heightToSpec(clearedHeight)))
      : null;

    const edge = track(
      new THREE.MeshStandardMaterial({
        color: 0x24242c,
        roughness: 0.45,
        metalness: 0.75,
      }),
    );

    const faceMat = (mirror) => {
      const m = track(
        new THREE.MeshStandardMaterial({
          map: mirror ? track(mirrored(colourTex)) : colourTex,
          roughness: specTex ? 0.9 : 0.7,
          metalness: specTex ? 0.8 : 0.2,
          envMapIntensity: 0.5,
        }),
      );
      if (normalTex) {
        m.normalMap = mirror ? track(mirrored(normalTex)) : normalTex;
        // Mirroring a normal map flips the meaning of its x channel, so the
        // highlights would fall on the wrong side of every scroll without
        // this. It's the one thing you can't fix with UVs alone.
        m.normalScale = new THREE.Vector2(mirror ? -1 : 1, 1);
      }
      if (specTex) {
        m.roughnessMap = mirror ? track(mirrored(specTex)) : specTex;
        m.metalnessMap = m.roughnessMap;
      }
      return m;
    };

    // BoxGeometry's material groups run [+x, -x, +y, -y, +z, -z]; index 4 is
    // the face turned toward the viewer, and the only one that needs artwork.
    const mats = (mirror) => {
      const front = faceMat(mirror);
      return [edge, edge, edge, edge, front, edge];
    };

    // Each leaf hangs off a pivot group placed at its hinge — the outer edge
    // of the screen — with the mesh itself offset inward by half its width.
    // Rotating the pivot then swings the leaf about the hinge rather than
    // about its own centre, which is what a door actually does.
    this.leftPivot = new THREE.Group();
    this.leftPivot.position.set(-DW / 2, 0, 0);
    const left = new THREE.Mesh(geo, mats(false));
    left.position.x = leafW / 2;
    left.receiveShadow = true; // takes the lock plate's shadow
    this.leftPivot.add(left);

    this.rightPivot = new THREE.Group();
    this.rightPivot.position.set(DW / 2, 0, 0);
    const right = new THREE.Mesh(geo, mats(true));
    right.position.x = -leafW / 2;
    right.receiveShadow = true;
    this.rightPivot.add(right);

    // The leaves ride their own group so the whole door can be MOVED — up from
    // the floor, then forward toward the viewer. The backdrop deliberately
    // stays out of it: it represents what lies beyond the doorway, so it must
    // not travel with the door.
    this.doorGroup = new THREE.Group();
    this.doorGroup.add(this.leftPivot, this.rightPivot);

    // ---- frame ----
    // A doorway around the leaves: jambs, a heavier lintel, and a heavier
    // threshold still. Built OUTSIDE the leaves rather than inset into them,
    // which is what lets it do its job at both ends of the journey — it reads
    // the door as a door while it stands off in the room, then falls beyond
    // the viewport once the door has come forward and the leaves are meant to
    // BE the screen. Inset instead and it would eat the artwork exactly when
    // the artwork is finally readable, and drag the keyhole off-centre with it.
    const jamb = Math.min(W, H) * 0.055;
    const lintel = jamb * 1.35; // classical doorways are top-heavy
    const sill = jamb * 2.1; // and heavier again where they meet the floor
    const frameShape = new THREE.Shape();
    frameShape.moveTo(-DW / 2 - jamb, -DH / 2 - sill);
    frameShape.lineTo(DW / 2 + jamb, -DH / 2 - sill);
    frameShape.lineTo(DW / 2 + jamb, DH / 2 + lintel);
    frameShape.lineTo(-DW / 2 - jamb, DH / 2 + lintel);
    frameShape.closePath();
    const opening = new THREE.Path();
    opening.moveTo(-DW / 2, -DH / 2);
    opening.lineTo(-DW / 2, DH / 2);
    opening.lineTo(DW / 2, DH / 2);
    opening.lineTo(DW / 2, -DH / 2);
    opening.closePath();
    frameShape.holes.push(opening);

    const frameDepth = depth * 2.6; // stands proud of the leaves it surrounds
    const frameGeo = track(
      new THREE.ExtrudeGeometry(frameShape, {
        depth: frameDepth,
        bevelEnabled: true,
        bevelThickness: jamb * 0.16,
        bevelSize: jamb * 0.16,
        bevelSegments: 2,
      }),
    );
    frameGeo.translate(0, 0, -frameDepth / 2); // straddle the leaves
    const frame = new THREE.Mesh(
      frameGeo,
      track(
        new THREE.MeshStandardMaterial({
          color: 0x4a4759,
          metalness: 0.55,
          roughness: 0.45,
          envMapIntensity: 1.0,
        }),
      ),
    );
    frame.castShadow = true; // onto the leaves, which already receive
    this.doorGroup.add(frame);

    this.root.add(this.doorGroup);
    this._riseFrom = -H * 2; // fully below the frame, even at its far depth
    // How far back the door hovers before it approaches. About one and a half
    // camera distances, which lands it near 40% of full size — reads as a real
    // object standing off in the room rather than a shrunken overlay.
    this._farZ = -this._camDist * 1.55;

    // ---- backdrop ----
    // Oversized and set well back, so it still covers the frame once the
    // leaves are wide open and the camera can see past them.
    const back = new THREE.Mesh(
      track(new THREE.PlaneGeometry(W * 3, H * 3)),
      track(
        new THREE.MeshBasicMaterial({ map: track(tex(backdropCanvas(), { srgb: true })) }),
      ),
    );
    back.position.z = -H * 0.75;
    // Only ever seen through an opening door. Left visible it would paper over
    // the room the door is supposed to be standing in.
    back.visible = false;
    this.backdrop = back;
    this.root.add(back);

  }

  /**
   * @param {object} s
   * @param {number} [s.alpha]  0..1 fade of the whole layer
   * @param {number} [s.rise]   0 = below the floor, 1 = risen into the room
   * @param {number} [s.approach] 0 = standing off in the room, 1 = filling
   *   the frame. The door travels to the viewer rather than the viewer to it;
   *   from the front the two are the same picture, and moving one object is
   *   far less to keep in step than moving a camera that everything else is
   *   positioned against.
   * @param {number} [s.open]   0 = shut, 1 = wide
   * @param {number} [s.plateAlpha] opacity of the lock plate
   */
  setState(s) {
    for (const k of ["alpha", "rise", "approach", "open", "plateAlpha"]) {
      if (s[k] !== undefined) this.state[k] = s[k];
    }
  }

  render() {
    if (!this.ok) return;
    const a = this.state.alpha;
    // Fading the whole layer in CSS beats fading every material: one
    // compositor property instead of a transparency pass over the whole door.
    if (a !== this._alphaApplied) {
      this.canvas.style.opacity = String(a);
      this._alphaApplied = a;
    }
    if (a <= 0.001 || !this.built) return;

    // Slide up out of the floor, then travel forward into the frame. Two
    // separate journeys rather than one blended move: the door has to come to
    // a visible rest standing in the room before it starts approaching, and a
    // single interpolation would round that corner off into a diagonal drift.
    if (this.doorGroup) {
      const rise = this.state.rise;
      const approach = this.state.approach;
      this.doorGroup.position.y = this._riseFrom * (1 - rise);
      this.doorGroup.position.z = this._farZ * (1 - approach);
    }
    if (this.backdrop) this.backdrop.visible = this.state.open > 0.001;

    const angle = this.state.open * OPEN_ANGLE;
    if (this.leftPivot) this.leftPivot.rotation.y = -angle;
    if (this.rightPivot) this.rightPivot.rotation.y = angle;
    this.renderer.render(this.scene, this.camera);
  }

  _teardownScene() {
    if (this.root) this.root.clear();
    for (const d of this._disposables) d.dispose?.();
    this._disposables = [];
    this.leftPivot = this.rightPivot = null;
  }

  unmount() {
    this._teardownScene();
    this.renderer?.dispose();
    // Hand the context back to the browser explicitly. There's a hard cap on
    // how many live WebGL contexts a page gets, and dispose() alone doesn't
    // release one — with StrictMode remounting in dev, leaking them adds up
    // fast. Safe because the canvas is dropped along with it.
    this.renderer?.forceContextLoss?.();
    this.canvas?.remove();
    this.canvas = null;
    this.ok = false;
  }
}
