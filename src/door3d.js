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
import { buildKeyMesh } from "./key3d";
import { DOOR_ASSETS, DOOR_RELIEF, DOOR_RELIEF_INVERT } from "./doorAssets";

const FOV = 42; // vertical field of view, degrees
const LEAF_DEPTH_FRAC = 0.014; // leaf thickness, as a fraction of door height
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
function escutcheonShape(pw, ph) {
  const s = new THREE.Shape();
  const top = ph * 0.39;
  const bot = -ph * 0.55;
  s.moveTo(0, top);
  s.bezierCurveTo(pw * 0.45, ph * 0.3, pw * 0.38, -ph * 0.22, 0, bot);
  s.bezierCurveTo(-pw * 0.38, -ph * 0.22, -pw * 0.45, ph * 0.3, 0, top);
  s.holes.push(keyholeShape(pw, ph));
  return s;
}

/**
 * The keyhole itself: a bore with a tapered ward slot hanging below it.
 *
 * Proportioned so the slot is about as wide as the KEY'S SHAFT. A keyhole
 * sized for looks alone ends up narrower than the key that has to pass
 * through it, and then the key visibly doesn't fit its own lock.
 */
function keyholeShape(pw, ph) {
  const r = pw * 0.2;
  const halfTop = pw * 0.11; // where the slot meets the bore
  const halfBot = pw * 0.13; // it flares as it descends
  const yBot = -ph * 0.34;
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
    this.state = { alpha: 0, open: 0, plateAlpha: 1 };
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
  ensure(W, H, strapText = "", keyDef = null) {
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
    this._build(W, H, strapText, keyDef);
    this.built = { W, H, text: strapText, keyId: keyDef?.id ?? null };
  }

  _build(W, H, strapText, keyDef) {
    this._teardownScene();
    this.renderer.setSize(W, H, false); // false: React owns the CSS size
    this.camera.aspect = W / H;
    // Place the camera so the plane z = 0 spans exactly H world units
    // vertically — i.e. one world unit per CSS pixel, origin at screen centre.
    const dist = H / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
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

    // ---- leaves ----
    const leafW = W / 2;
    const depth = Math.max(6, H * LEAF_DEPTH_FRAC);
    const geo = track(new THREE.BoxGeometry(leafW, H, depth));

    const colourTex = track(tex(leafColour, { srgb: true }));
    const normalTex = leafHeight
      ? track(tex(heightToNormal(leafHeight, DOOR_RELIEF)))
      : null;
    const specTex = leafHeight ? track(tex(heightToSpec(leafHeight))) : null;

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
    this.leftPivot.position.set(-W / 2, 0, 0);
    const left = new THREE.Mesh(geo, mats(false));
    left.position.x = leafW / 2;
    this.leftPivot.add(left);

    this.rightPivot = new THREE.Group();
    this.rightPivot.position.set(W / 2, 0, 0);
    const right = new THREE.Mesh(geo, mats(true));
    right.position.x = -leafW / 2;
    this.rightPivot.add(right);

    this.root.add(this.leftPivot, this.rightPivot);

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
    this.root.add(back);

    // ---- lock ----
    // Real geometry, not a picture of a lock: the plate is an extruded shield
    // with the keyhole as an actual void through it, and a socket recedes
    // behind that void so the hole has an inside.
    const pw = Math.round(Math.min(W, H) * 0.13);
    const ph = pw * 1.45;
    const pd = pw * 0.13; // how far the plate stands off the door
    const sd = pw * 0.75; // how deep the keyhole bores in
    this.plate = new THREE.Group();
    this.plate.position.set(0, 0, depth / 2); // keyhole on the world origin

    const ironMat = track(
      new THREE.MeshStandardMaterial({
        // A metal's base colour is its SPECULAR TINT, not a diffuse paint:
        // at metalness 1 there is no diffuse term at all, so a dark colour
        // yields a dark mirror no matter how much light you add. The old
        // 0x3a3a46 was the black blob. Real iron reflects ~55%, so it has to
        // be a mid tone here and gets its darkness from the scene instead.
        color: 0x9298ad,
        metalness: 0.85,
        roughness: 0.28,
        envMapIntensity: 1.4,
        transparent: true,
      }),
    );
    const plate = new THREE.Mesh(
      track(
        new THREE.ExtrudeGeometry(escutcheonShape(pw, ph), {
          depth: pd,
          bevelEnabled: true,
          bevelThickness: pd * 0.45,
          bevelSize: pd * 0.45,
          bevelSegments: 4,
          curveSegments: 24,
        }),
      ),
      ironMat,
    );

    // The socket is the keyhole profile extruded backwards and rendered from
    // the INSIDE (BackSide), which turns a solid into a cavity — you see its
    // walls receding and its floor, and they shade as the lighting changes.
    //
    // depthTest is off because the door leaf is a solid slab occupying that
    // space: without it the leaf's front face wins and the hole looks painted
    // on. renderOrder then does the sequencing by hand — leaf, socket, plate,
    // key — which is safe precisely because the socket's silhouette is the
    // keyhole, so it can only ever show through the plate's own void.
    const socketMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x1b1b24,
        metalness: 0.45,
        roughness: 0.85,
        transparent: true,
        side: THREE.BackSide,
        depthTest: false,
        // Must not write depth either. The key is occluded by the DOOR LEAF's
        // depth as it sinks in — that is what makes it vanish into the
        // surface — and a socket writing depth would break that.
        depthWrite: false,
      }),
    );
    const socket = new THREE.Mesh(
      track(
        new THREE.ExtrudeGeometry(keyholeShape(pw, ph), {
          depth: sd,
          bevelEnabled: false,
          curveSegments: 24,
        }),
      ),
      socketMat,
    );
    socket.position.z = -sd; // bore inward from the door's surface
    socket.renderOrder = 1;
    plate.renderOrder = 2;
    this.plate.add(socket, plate);
    this._plateMats = [ironMat, socketMat];

    this.root.add(this.plate);

    // ---- key ----
    if (keyDef) {
      const built = buildKeyMesh(keyDef);
      this._key = built;
      this._disposables.push(built);
      // Three nested frames, because insertion is three separate motions and
      // stacking them keeps each one a single number:
      //   keyPivot — sits at the keyhole; TILTS the key to face into the door
      //   keySpin  — rotates about the shaft: the actual turning of the key
      //   object   — slides ALONG the shaft: how deep it has gone in
      this.keyPivot = new THREE.Group();
      this.keySpin = new THREE.Group();
      this.keySpin.add(built.object);
      this.keyPivot.add(this.keySpin);
      this.keyPivot.visible = false;
      // renderOrder is per-object and does NOT inherit from a Group, so this
      // has to reach the meshes themselves. The key must come after the
      // socket, which draws with depthTest off and would otherwise paint its
      // dark interior straight over the shaft standing in the hole.
      built.object.traverse((o) => {
        o.renderOrder = 3;
      });
      // Must clear the plate's FRONT face, bevel included — the extrusion runs
      // from -bevelThickness to depth+bevelThickness, so "depth/2 + pd" is
      // still buried inside it and the plate simply drew over the key. That
      // was the black thing in front of it.
      this._keyZOut = depth / 2 + pd * 1.3 + Math.max(5, pd * 0.6);
      // Seated: the point in the hole sits at the plate's MID-DEPTH, not
      // behind it. The key is pitched over, so the shaft climbs in z as it
      // rises out of the hole — from mid-depth it clears the plate's front
      // face almost immediately, while anything below the hole is already
      // inside. Park it further back and the plate hides the shaft too, which
      // leaves only the bow poking over the top edge like a badge.
      this._keyZIn = depth / 2 + pd * 0.5;
      this.root.add(this.keyPivot);
    }
  }

  /**
   * Poses the key for this frame. Everything is in the key's own authored
   * units (total height 2.4); `scale` converts to screen pixels.
   *
   * @param {object} s
   * @param {boolean} s.show    whether the 3D key has taken over from the 2D one
   * @param {number}  s.scale   world units per key unit
   * @param {number}  s.pivotY  the point along the key currently at the keyhole
   * @param {number}  s.insert  0 = flat against the door, 1 = fully seated
   * @param {number}  s.tilt    radians to pitch the key into the door
   * @param {number}  s.turn    radians of rotation about the shaft
   * @param {number}  s.alpha   opacity
   */
  setKey(s) {
    if (!this.keyPivot) return;
    this.keyPivot.visible = !!s.show && s.alpha > 0.01;
    if (!this.keyPivot.visible) return;

    // How far along the shaft the lock has swallowed. Sliding the key along
    // its own axis is what "inserting" means; the tilt below is what aims
    // that axis into the door.
    this._key.object.position.set(0, s.pivotY, 0);
    this.keyPivot.scale.setScalar(s.scale);
    this.keyPivot.position.set(
      0,
      0,
      this._keyZOut + (this._keyZIn - this._keyZOut) * s.insert,
    );

    // Pitching about X swings the bit away from the viewer and into the door,
    // leaving the bow out front — the pose you actually see on a key in a
    // lock. It stops short of 90 degrees on purpose: a key pointing exactly
    // down the view axis projects to a bare horizontal line, since its whole
    // length collapses to nothing. Short of that, perspective makes the near
    // bow large and the buried end small, which is what sells the depth.
    this.keyPivot.rotation.x = s.tilt;
    // Turning happens about the shaft, so it stays a real turn at any tilt.
    this.keySpin.rotation.y = s.turn;

    for (const m of this._key.materials) m.opacity = s.alpha;
  }

  /**
   * @param {{alpha?: number, open?: number, plateAlpha?: number}} s
   *   alpha 0..1 fade of the whole door, open 0 = shut / 1 = wide,
   *   plateAlpha 0..1 opacity of the lock plate.
   */
  setState(s) {
    if (s.alpha !== undefined) this.state.alpha = s.alpha;
    if (s.open !== undefined) this.state.open = s.open;
    if (s.plateAlpha !== undefined) this.state.plateAlpha = s.plateAlpha;
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

    const angle = this.state.open * OPEN_ANGLE;
    if (this.leftPivot) this.leftPivot.rotation.y = -angle;
    if (this.rightPivot) this.rightPivot.rotation.y = angle;
    if (this._plateMats) {
      const pa = this.state.plateAlpha;
      for (const m of this._plateMats) m.opacity = pa;
      this.plate.visible = pa > 0.01;
    }
    this.renderer.render(this.scene, this.camera);
  }

  _teardownScene() {
    if (this.root) this.root.clear();
    for (const d of this._disposables) d.dispose?.();
    this._disposables = [];
    this.leftPivot = this.rightPivot = this.plate = null;
    this.keyPivot = null;
    this._key = null;
    this._keyClip = null;
    this._plateMats = null;
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
