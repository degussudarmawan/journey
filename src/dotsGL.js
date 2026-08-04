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

const MAX_DOTS = 24000; // ~1.6k particles x 4 halftone sub-dots, with headroom

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
    this.ctx.clearRect(0, 0, 1, 1);
    this.ctx.fillStyle = css;
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
    if (vSize >= 3.2) {
      float d = length(gl_PointCoord - vec2(0.5));
      float aa = fwidth(d);
      float m = 1.0 - smoothstep(0.5 - aa, 0.5, d);
      if (m <= 0.0) discard;
      gl_FragColor = vec4(vTint, vAlpha * m);
      return;
    }
    gl_FragColor = vec4(vTint, vAlpha);
  }
`;

export class DotsGL {
  /** @param {HTMLElement} container element to hang the GL canvas inside. */
  constructor(container) {
    this.container = container;
    this.ok = false;
    this.count = 0;
    this.colors = new ColorCache();
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

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { pixelRatio: { value: this.pixelRatio } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    // Lights, because the key is a lit solid sharing this scene. The dots
    // ignore them entirely — they're a ShaderMaterial with no lighting terms.
    this.scene.add(
      new THREE.AmbientLight(0xffffff, 0.75),
      (() => {
        const l = new THREE.DirectionalLight(0xfff4e6, 1.6);
        l.position.set(-0.5, 0.9, 1);
        return l;
      })(),
    );

    this.ok = true;
    return true;
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
  setKey(keyDef, basis, alpha) {
    if (!this.ok) return;
    if (!keyDef || alpha <= 0.004) {
      if (this.keyObj) this.keyObj.visible = false;
      return;
    }
    if (this._keyId !== keyDef.id) {
      if (this.key) {
        this.scene.remove(this.keyObj);
        this.key.dispose();
      }
      this.key = buildKeyMesh(keyDef);
      this.keyObj = this.key.object;
      // Depth-tested against the dots, and writing depth so they're hidden
      // behind it in turn.
      for (const m of this.key.materials) {
        m.depthTest = true;
        m.depthWrite = true;
      }
      this.scene.add(this.keyObj);
      this._keyId = keyDef.id;
    }
    this.keyObj.visible = true;
    this.keyObj.matrixAutoUpdate = false;
    const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
    this.keyObj.matrix.makeBasis(V(basis.x), V(basis.y), V(basis.z));
    this.keyObj.matrix.setPosition(V(basis.o));
    for (const m of this.key.materials) m.opacity = alpha;
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
    const scale = f / Math.max(f * 0.25, f + depth); // mirrors orbitPersp()
    this.pos[i * 3] = (x - this.cx - (this.pan?.x || 0)) / scale;
    // Screen y runs down, three's world y runs up.
    this.pos[i * 3 + 1] = -(y - this.cy - (this.pan?.y || 0)) / scale;
    // ...and the engine's +z is away from the viewer, three's is toward.
    this.pos[i * 3 + 2] = -depth;
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
    this.key?.dispose();
    this.geometry?.dispose();
    this.material?.dispose();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss?.();
    this.canvas?.remove();
    this.canvas = null;
    this.ok = false;
  }
}
