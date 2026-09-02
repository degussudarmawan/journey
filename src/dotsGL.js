/* ============================================================================
   DOTS GL — prototype: the halftone dots as WebGL points instead of Canvas2D.
   ============================================================================

   This exists to answer one question before committing to a rewrite: does a
   GL point sprite look like a Canvas2D dot? Everything else is deliberately
   held constant so that's the only thing being compared.

   In particular the camera is ORTHOGRAPHIC AND 1:1 WITH SCREEN PIXELS, and it
   is fed exactly the coordinates the 2D renderer would have drawn at. That is
   the whole point of the prototype: no new projection, no new camera model,
   no repositioning — same numbers, different rasteriser. If the two look the
   same, the aesthetic risk of the full migration is zero and the remaining
   work is mechanical. If they don't, we've found that out for a day's work
   instead of a week's.

   What this deliberately does NOT do:
     - depth. Points are drawn in submission order with depth testing off,
       exactly like the painter ordering the 2D version already does. Real
       depth is the *prize* for migrating, not something to prototype.
     - the key, the door, the sketch layer. Still Canvas2D, still layered.

   Toggle with ?dots=gl. Default stays on Canvas2D.
   ============================================================================ */

import * as THREE from "three";
import { buildKeyMesh } from "./key3d";
import { buildLock, lockMetrics } from "./lock3d";
import { DOOR_FILL, LEAF_DEPTH_FRAC } from "./door3d";
import { FEATHER_VERT, FEATHER_FRAG } from "./featherGL";

const MAX_DOTS = 24000; // ~1.6k particles x 4 halftone sub-dots, with headroom

/** A stand-in "room" for the metal to reflect. Matches door3d's exactly. */
function envCanvas() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
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
 * CSS colour -> linear RGB, via a 1x1 canvas.
 *
 * Roundabout, but it's the only parser guaranteed to understand every colour
 * the rest of the app uses. The palette is authored in `oklch()`, which
 * THREE.Color cannot parse at all — and hand-rolling an oklch converter to
 * feed a prototype would be answering a question nobody asked.
 *
 * Cached per string, so this runs a handful of times, not per dot per frame.
 */
class ColorCache {
  constructor() {
    this.map = new Map();
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvas.height = 1;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
  }
  get(css) {
    let c = this.map.get(css);
    if (c) return c;
    // Assigning an unparseable value to fillStyle is a SILENT no-op — the
    // context keeps whatever it had, so a bad colour samples as either black
    // (fresh context) or the last good colour, and then caches under that key
    // forever. Setting a known value first makes the failure visible as that
    // value instead of as a mystery.
    this.ctx.fillStyle = "#ff00ff";
    this.ctx.fillStyle = css;
    this.ctx.clearRect(0, 0, 1, 1);
    this.ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = this.ctx.getImageData(0, 0, 1, 1).data;
    // sRGB -> linear, because the renderer outputs sRGB and would otherwise
    // wash every dot out relative to the canvas version.
    const lin = (v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    c = [lin(r), lin(g), lin(b)];
    this.map.set(css, c);
    return c;
  }
}

const VERT = /* glsl */ `
  attribute float size;
  attribute float alpha;
  attribute vec3 tint;
  varying float vAlpha;
  varying vec3 vTint;
  varying float vSize;
  uniform float pixelRatio;
  void main() {
    vTint = tint;
    vSize = size;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

    // SUB-PIXEL COVERAGE. Most of these dots are under a pixel across, and a
    // point sprite cannot be smaller than one — so asking for 0.9px and
    // getting 1px silently *adds* ink, while the hard edge removes the soft
    // falloff Canvas2D gives a fractional fillRect. Net effect: dots that read
    // smaller and grittier than the 2D version, which is exactly what the
    // first comparison showed.
    //
    // Fix: never draw below MIN_PX, and give back the extra area in alpha.
    // Coverage goes as the square of the width, so the ratio is squared too.
    // This is the standard trick for sub-pixel point rendering and it's what
    // makes the two rasterisers agree.
    float px = size * pixelRatio;
    float drawn = max(px, 2.0);
    gl_PointSize = drawn;
    vAlpha = alpha * min(1.0, (px * px) / (drawn * drawn));
  }
`;

const FRAG = /* glsl */ `
  varying float vAlpha;
  varying vec3 vTint;
  varying float vSize;
  void main() {
    // Mirrors the 2D renderer's rule exactly: below ~3px across it draws a
    // filled SQUARE, because a tiny antialiased circle turns to grey mush and
    // a square stays crisp. Reproducing that here is what makes this a fair
    // comparison rather than a flattering one.
    // Now that dots write depth, a nearly-invisible fragment would still
    // stamp the buffer and punch a hole in whatever is behind it. Drop them.
    if (vAlpha < 0.06) discard;
    if (vSize >= 3.2) {
      float d = length(gl_PointCoord - vec2(0.5));
      float aa = fwidth(d);
      float m = 1.0 - smoothstep(0.5 - aa, 0.5, d);
      if (m <= 0.02) discard;
      gl_FragColor = vec4(vTint, vAlpha * m);
      return;
    }
    gl_FragColor = vec4(vTint, vAlpha);
  }
`;

export class DotsGL {
  /**
   * @param {HTMLElement} container element to hang the GL canvas inside.
   * @param {object|null} feather when set (?dots=feather), swaps the point
   *   sprite's shaders for the crow-feather ones. An experiment — see
   *   featherGL.js. Null keeps the dots exactly as they are; nothing else in
   *   this class knows the difference.
   */
  constructor(container, feather = null) {
    this.container = container;
    this.ok = false;
    this.count = 0;
    this.colors = new ColorCache();
    this.feather = feather;
  }

  mount() {
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, {
      position: "absolute",
      inset: "0",
      display: "block",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
    });
    this.container.appendChild(this.canvas);
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        alpha: true,
        antialias: true,
      });
    } catch {
      this.canvas.remove();
      this.canvas = null;
      return false;
    }
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setClearAlpha(0);

    this.scene = new THREE.Scene();
    // Perspective, not orthographic — a flat camera has no depth for the key
    // to test against. Placed at exactly ORBIT_FOCAL from the z = 0 plane and
    // given a matching field of view, which makes z = 0 map 1:1 to CSS pixels
    // and reproduces the engine's own `f / (f + z)` divide precisely. See
    // begin() for the arithmetic.
    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 40000);

    this.pos = new Float32Array(MAX_DOTS * 3);
    this.tint = new Float32Array(MAX_DOTS * 3);
    this.size = new Float32Array(MAX_DOTS);
    this.alpha = new Float32Array(MAX_DOTS);

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute("tint", new THREE.BufferAttribute(this.tint, 3));
    g.setAttribute("size", new THREE.BufferAttribute(this.size, 1));
    g.setAttribute("alpha", new THREE.BufferAttribute(this.alpha, 1));
    // Never let three cull us: the bounding sphere is stale by construction
    // because the buffers change every frame.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.geometry = g;

    this.material = this._makeMaterial();

    // A feather shader that fails to compile would otherwise be a black
    // screen and a wall of GL log — so catch it and fall back to the dots on
    // the next frame. Swapping here would mean changing the material three is
    // in the middle of setting up, hence the flag.
    if (this.feather) {
      this.renderer.debug.onShaderError = (gl, program, vs, fs) => {
        const log =
          gl.getShaderInfoLog(fs) || gl.getShaderInfoLog(vs) || "(no log)";
        console.error(
          "[featherGL] feather shader failed to compile — falling back to " +
            "the dots. Remove ?dots=feather to silence this.\n" +
            log,
        );
        this._featherFailed = true;
      };
    }

    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    // Lighting for the lit solids sharing this scene — the key and the lock.
    // The dots ignore all of it: they're a ShaderMaterial with no lighting
    // terms. These values deliberately match door3d's, so the plate here and
    // the leaves on the canvas behind read as the same piece of ironmongery
    // under the same light.
    const envSrc = new THREE.CanvasTexture(envCanvas());
    envSrc.mapping = THREE.EquirectangularReflectionMapping;
    envSrc.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromEquirectangular(envSrc).texture;
    envSrc.dispose();
    pmrem.dispose();

    const keyLight = new THREE.DirectionalLight(0xfff3e2, 2.1);
    keyLight.position.set(-0.55, 0.8, 1);
    const fill = new THREE.DirectionalLight(0x93a6ff, 0.55);
    fill.position.set(0.9, -0.3, 0.6);
    this.scene.add(keyLight, fill, new THREE.AmbientLight(0xffffff, 0.5));

    this.ok = true;
    return true;
  }

  /**
   * The point-sprite material for whichever look is active.
   *
   * Extracted so the feather experiment can be abandoned mid-flight (see the
   * shader-error hook in mount()) without the dot configuration existing in
   * two places and drifting apart.
   */
  _makeMaterial() {
    const f = this.feather;
    return new THREE.ShaderMaterial({
      vertexShader: f ? FEATHER_VERT : VERT,
      fragmentShader: f ? FEATHER_FRAG : FRAG,
      uniforms: f
        ? {
            pixelRatio: { value: this.pixelRatio },
            uTime: { value: 0 },
            uSpread: { value: f.spread },
            uWidth: { value: f.width },
            uSheen: { value: f.sheen },
            uGain: { value: f.gain },
            uFlutter: { value: f.flutter },
            uTintMix: { value: f.tint },
          }
        : { pixelRatio: { value: this.pixelRatio } },
      transparent: true,
      // Real depth, which is the entire point of moving the dots here. Left
      // off (as it was through the prototype) nothing can occlude the key: it
      // draws over every dot regardless of where it is in the ring, so a key
      // on the ring's FAR side still paints over the near needles and the
      // orbit stops reading as an orbit at all.
      //
      // depthWrite matters as much as depthTest — without it the dots test
      // against the key but never record themselves, so the key is never
      // hidden BY them, only they by it.
      depthTest: true,
      depthWrite: true,
    });
  }

  /**
   * Places the key in this scene, as a real mesh sharing the dots' depth
   * buffer. That sharing is the whole point of the migration: the key stops
   * being painted between whole pieces and starts being resolved per pixel
   * against every dot around it.
   *
   * @param {object|null} keyDef null to hide the key
   * @param {{o: number[], x: number[], y: number[], z: number[]}} basis
   *   origin and axes from keyBasisForPiece()
   */
  /**
   * Builds (or rebuilds) the key mesh and the lock it enters.
   *
   * ONE key mesh serves the whole sequence — orbiting, flying, and seated in
   * the lock. It used to exist twice, once per scene, and the two copies shaded
   * differently as the animation crossed between them: the reflection visibly
   * snapped. Both now live here, under one set of lights.
   *
   * The mesh hangs off two nested frames for the seated pose:
   *   keyPivot — sits at the keyhole; TILTS the key to face into the door
   *   keySpin  — rotates about the shaft: the actual turning of the key
   * ...and is driven directly by a matrix for the orbit pose, where it has to
   * follow an arbitrary needle frame rather than a tilt and a spin.
   */
  ensureLock(W, H, keyScale, keyDef) {
    // Must match the door's leaf thickness: the plate stands off that surface.
    const leafDepth = Math.max(6, H * LEAF_DEPTH_FRAC);
    if (!this.ok || !keyDef) return;
    // The lock belongs to the DOOR, not the screen, and the door no longer
    // fills the screen — the frame takes the rest. Measuring against the
    // viewport here would drift the keyhole off the artwork's cleared field.
    const DW = W * DOOR_FILL;
    const DH = H * DOOR_FILL;
    const sig = `${W}x${H}:${keyDef.id}:${Math.round(keyScale * 100)}`;
    if (this._lockSig === sig) return;
    this._lockSig = sig;
    this._teardownLock();

    const m = lockMetrics(keyDef, keyScale, DW, DH);
    this.lock = buildLock(m, leafDepth);
    this.scene.add(this.lock.group);

    this.key = buildKeyMesh(keyDef);
    for (const mat of this.key.materials) {
      mat.depthTest = true;
      mat.depthWrite = true;
    }
    // Both are transparent (they fade with the door), and three sorts the
    // transparent pass by centroid distance — which flips as the key tilts
    // past the plate. Pinning the order stops that from deciding which is in
    // front; the depth buffer still does the real occlusion.
    this.lock.group.renderOrder = 1;
    this.key.object.traverse((o) => {
      o.renderOrder = 2;
    });
    this.keySpin = new THREE.Group();
    this.keySpin.add(this.key.object);
    this.keyPivot = new THREE.Group();
    this.keyPivot.add(this.keySpin);
    this.keyPivot.visible = false;
    this.scene.add(this.keyPivot);

    // Must clear the plate's FRONT face, bevel included — the extrusion runs
    // from -bevelThickness to depth + bevelThickness, so "pd" alone is still
    // buried inside it and the plate simply draws over the key.
    this._keyZOut = leafDepth / 2 + m.pd * 1.3 + Math.max(5, m.pd * 0.6);
    // Seated: the point in the hole sits just inside the plate's FRONT face,
    // not at its mid-depth. The extrusion runs to 1.45 * pd once the bevel is
    // counted, so a pivot at 0.5 * pd leaves a long stretch of shaft below the
    // front surface — and since the key only climbs in z as it rises from the
    // hole, that stretch is buried and the key reads as lying behind the lock
    // rather than standing in it. Everything below the hole is still hidden,
    // which is the part that should be.
    this._keyZIn = leafDepth / 2 + m.pd * 1.15;
    this._lockY = m.lockY;
  }

  /**
   * How far in front of the door the key rests before it enters, in three's
   * z. The flight has to end here, not at z = 0 — the plate stands proud of
   * the door surface, so a key arriving at the door's own plane arrives
   * BEHIND the lock and is occluded for the whole late approach.
   */
  keyRestZ() {
    return this._keyZOut ?? 0;
  }

  /**
   * The keyhole's height in ENGINE coordinates (y down, origin screen centre)
   * — where the key has to fly to.
   *
   * Read from the built lock rather than recomputed by the caller. The same
   * value derived in two places is what put the key and the keyhole in
   * different spots every time the door's proportions changed.
   */
  lockScreenY() {
    return -(this._lockY ?? 0);
  }

  /** Hides the key. */
  hideKey() {
    if (this.keyPivot) this.keyPivot.visible = false;
  }

  /** Sets the lock's opacity — it fades out with the door as the leaves part. */
  setLockAlpha(a) {
    if (!this.lock) return;
    this.lock.group.visible = a > 0.01;
    for (const m of this.lock.materials) m.opacity = a;
  }

  /**
   * Poses the key from an arbitrary basis — riding a needle, or mid-flight.
   * @param {{o: number[], x: number[], y: number[], z: number[]}} basis
   */
  setKey(keyDef, basis, alpha) {
    if (!this.ok || !this.keyPivot || alpha <= 0.004) {
      this.hideKey();
      return;
    }
    this.keyPivot.visible = true;
    this._resetKeyFrames();
    this.key.object.matrixAutoUpdate = false;
    const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
    this.key.object.matrix.makeBasis(V(basis.x), V(basis.y), V(basis.z));
    this.key.object.matrix.setPosition(V(basis.o));
    for (const m of this.key.materials) m.opacity = alpha;
  }

  /**
   * Poses the key seated in the lock: pitched into the door, slid along its
   * shaft, turning. Everything is in the key's own authored units (total
   * height 2.4); `scale` converts to screen pixels.
   */
  setKeySeated(s) {
    if (!this.ok || !this.keyPivot || s.alpha <= 0.004) {
      this.hideKey();
      return;
    }
    this.keyPivot.visible = true;
    this._resetKeyFrames();
    this.key.object.matrixAutoUpdate = true;
    // Offset by the SHAFT AXIS, not the key's centre: the bow and scrolls hang
    // to one side, so centring the bounding box stands the key in crooked.
    this.key.object.position.set(-s.pivotX, s.pivotY, 0);
    this.keyPivot.scale.setScalar(s.scale);
    this.keyPivot.position.set(
      0,
      this._lockY,
      this._keyZOut + (this._keyZIn - this._keyZOut) * s.insert,
    );
    // Pitching about X swings the bit away from the viewer and into the door,
    // leaving the bow out front. It stops short of a right angle on purpose:
    // a key aimed exactly down the view axis projects to a bare line, its
    // whole length collapsing to nothing.
    this.keyPivot.rotation.set(s.tilt, 0, 0);
    // Turning happens about the shaft, so it stays a real turn at any tilt.
    this.keySpin.rotation.set(0, s.turn, 0);
    for (const m of this.key.materials) m.opacity = s.alpha;
  }

  /**
   * Clears every frame back to identity before a pose is applied.
   *
   * The two posing modes drive DIFFERENT properties — the basis writes a
   * matrix on the object, the seated pose writes scale and rotations on the
   * pivots — so whatever one set stays set when the other takes over. The
   * scale was the dangerous one: seated leaves `keyPivot.scale` at ~100, and
   * the next basis pose multiplies its own scale by that again, which is a
   * key a hundred times too big. Resetting everything first makes the modes
   * independent instead of merely ordered.
   */
  _resetKeyFrames() {
    this.keyPivot.position.set(0, 0, 0);
    this.keyPivot.rotation.set(0, 0, 0);
    this.keyPivot.scale.setScalar(1);
    this.keySpin.position.set(0, 0, 0);
    this.keySpin.rotation.set(0, 0, 0);
    this.keySpin.scale.setScalar(1);
    this.key.object.position.set(0, 0, 0);
    this.key.object.rotation.set(0, 0, 0);
    this.key.object.scale.setScalar(1);
  }

  _teardownLock() {
    if (this.lock) {
      this.scene.remove(this.lock.group);
      this.lock.dispose();
      this.lock = null;
    }
    if (this.keyPivot) {
      this.scene.remove(this.keyPivot);
      this.key.dispose();
      this.key = null;
      this.keyPivot = null;
      this.keySpin = null;
    }
  }

  /**
   * Starts a frame.
   *
   * @param {number} focal the engine's ORBIT_FOCAL — the camera is placed
   *   exactly this far from the z = 0 plane, and its field of view derived
   *   from it, so the GPU's divide and the engine's `f / (f + z)` are the
   *   same function rather than two things tuned to look alike.
   * @param {{x: number, y: number}} pan screen-space pan from the free look
   */
  begin(w, h, focal, pan) {
    if (!this.ok) return;
    if (this._featherFailed) {
      this._featherFailed = false;
      this.feather = null;
      this.renderer.debug.onShaderError = null;
      const dead = this.material;
      this.material = this._makeMaterial();
      this.points.material = this.material;
      dead.dispose();
    }
    // The feather shader rocks its sprites over time. Clocked from here
    // rather than from the caller's `elapsed` so the experiment costs the
    // engine no signature change at all — it doesn't need to be in step with
    // anything, it only needs to advance.
    if (this.feather) {
      this.material.uniforms.uTime.value = performance.now() / 1000;
    }
    this.focal = focal;
    this.cx = w / 2;
    this.cy = h / 2;
    this.pan = pan;
    if (this._w !== w || this._h !== h || this._focal !== focal) {
      this._w = w;
      this._h = h;
      this._focal = focal;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      // Half the viewport subtends this angle at distance `focal`, which is
      // what makes one world unit at z = 0 equal one CSS pixel.
      this.camera.fov = (2 * Math.atan(h / 2 / focal) * 180) / Math.PI;
      this.camera.position.set(0, 0, focal);
      this.camera.lookAt(0, 0, 0);
      this.camera.updateProjectionMatrix();
    }
    // Pan is a pure screen-space slide, so it shifts the projection window
    // rather than moving anything in the scene — which is exactly what the
    // engine's CPU projection does with it.
    if (pan && (pan.x || pan.y)) {
      this.camera.setViewOffset(w, h, -pan.x, -pan.y, w, h);
    } else {
      this.camera.clearViewOffset();
    }
    this.count = 0;
  }

  /**
   * Queues one dot.
   *
   * Takes the SCREEN position the 2D renderer would have drawn at, plus the
   * view-space depth it came from, and inverts the projection to recover the
   * world point. Roundabout-looking, but it's what keeps this a drop-in: call
   * sites nudge dots around in screen space (the clear-out fly-away, the
   * cursor repel), and unprojecting at the dot's own depth reinterprets those
   * nudges correctly instead of forcing every one of them to be rewritten in
   * world space.
   *
   * @param {string} css fill colour, as the 2D context reports it
   * @param {number} depth view-space z; 0 for the flat stages
   */
  push(x, y, r, css, alpha, depth = 0) {
    if (!this.ok || this.count >= MAX_DOTS) return;
    const i = this.count++;
    const f = this.focal;
    // CLAMP THE DEPTH, NOT THE SCALE.
    //
    // orbitPersp() floors its denominator so a piece swinging near the camera
    // can't divide by nothing and explode. Mirroring that as a clamp on the
    // SCALE alone breaks the round trip: this unprojects using the clamped
    // scale, then the GPU re-projects using the true depth, and the moment the
    // clamp bites the two disagree — violently, because that is exactly where
    // the true scale is running away. The dot jumps somewhere else entirely,
    // which is what made near needles teleport as they came past the eye.
    //
    // Clamping the depth to the point where the floor would have engaged keeps
    // one number describing the dot, so unproject and project stay inverses.
    const dz = Math.max(depth, -f * 0.75);
    const scale = f / (f + dz);
    this.pos[i * 3] = (x - this.cx - (this.pan?.x || 0)) / scale;
    // Screen y runs down, three's world y runs up.
    this.pos[i * 3 + 1] = -(y - this.cy - (this.pan?.y || 0)) / scale;
    // ...and the engine's +z is away from the viewer, three's is toward.
    this.pos[i * 3 + 2] = -dz; // the clamped depth, so this inverts `scale`
    const c = this.colors.get(css);
    this.tint[i * 3] = c[0];
    this.tint[i * 3 + 1] = c[1];
    this.tint[i * 3 + 2] = c[2];
    this.size[i] = r * 2; // gl_PointSize is a full width; r is a radius
    this.alpha[i] = alpha;
  }

  /** Uploads this frame's dots and draws them. */
  end() {
    if (!this.ok) return;
    const n = this.count;
    for (const name of ["position", "tint", "size", "alpha"]) {
      const attr = this.geometry.getAttribute(name);
      // Only re-upload the slice actually used — at 24k slots and a few
      // thousand live dots, uploading the whole buffer every frame is most of
      // the cost of the entire renderer.
      attr.clearUpdateRanges?.();
      attr.addUpdateRange?.(0, n * attr.itemSize);
      attr.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, n);
    this.renderer.render(this.scene, this.camera);
  }

  unmount() {
    this._teardownLock();
    this.geometry?.dispose();
    this.material?.dispose();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss?.();
    this.canvas?.remove();
    this.canvas = null;
    this.ok = false;
  }
}
