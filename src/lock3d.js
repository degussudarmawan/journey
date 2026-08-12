/* ============================================================================
   LOCK 3D — the escutcheon and its keyhole, as real geometry.
   ============================================================================

   Lives in the DOTS scene, not the door's, and that placement is the whole
   reason this module exists separately.

   The key has to be occluded by two different things at two different moments:
   by the orbiting dots while it rides the ring, and by this plate while it
   enters the hole. A mesh can only be in one scene, so if the lock stayed with
   the door, the key had to exist twice — once per scene — and the two copies
   shaded differently as they crossed. That reads as the key's reflection
   snapping mid-animation, because it is exactly that.

   Moving the lock here means one key mesh, in one scene, under one set of
   lights, for the entire sequence. The door leaves stay on their own canvas
   behind; they never needed to interleave with the key by depth, because the
   plate is always in front of them and fades out before they swing.

   Everything is positioned in VIEW space, so it stays put on screen while the
   free look swings the orbit around it — the same as the door does.
   ============================================================================ */

import * as THREE from "three";
import { DOOR_LOCK_Y } from "./doorAssets";

// Both shapes are built with the ORIGIN AT THE KEYHOLE rather than at the
// plate's centre. The keyhole is the one point everything else has to agree
// about — the key aims for it and pivots about it — so making it the origin
// removes an offset from every one of those calculations.

/** The lock plate: a shield with the keyhole cut clean through it. */
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

/** The keyhole itself: a bore with a tapered ward slot hanging below it. */
function keyholeShape(hole) {
  const { r, halfTop, halfBot, yBot } = hole;
  // Meet the circle exactly where the slot's sides cross it, so the two merge
  // into one silhouette instead of reading as a disc with a tab.
  const yJoin = -Math.sqrt(Math.max(0, r * r - halfTop * halfTop));
  const s = new THREE.Shape();
  s.absarc(
    0,
    0,
    r,
    Math.atan2(yJoin, halfTop),
    Math.PI * 2 + Math.atan2(yJoin, -halfTop),
    false,
  );
  s.lineTo(-halfBot, yBot);
  s.lineTo(halfBot, yBot);
  s.closePath();
  return s;
}

/**
 * Works out how big the lock has to be for a given key.
 *
 * THE HOLE IS SIZED TO WHAT SHOWS; THE PLATE IS SIZED TO WHAT MUST HIDE.
 * Conflating those wrecks the look. The obvious move is to make the slot admit
 * the whole bit — what a real warded keyhole does — but a bit several times
 * the stem's width turns the slot into a giant funnel with a keyhole at the
 * top of it. Correct, and awful.
 *
 * The bit doesn't have to fit through the hole, it has to *disappear*, and the
 * plate is opaque. So the bore is sized to the stem, which is the only part
 * anyone watches go in, and the plate is made broad enough to swallow the bit.
 */
export function lockMetrics(keyDef, keyScale, W, H) {
  const lk = keyDef?.lock;
  const hole = lk
    ? {
        r: lk.shaftHalf * 1.45 * keyScale, // bore: the stem, with clearance
        halfTop: lk.shaftHalf * 1.1 * keyScale,
        halfBot: lk.shaftHalf * 1.8 * keyScale, // a modest ward flare
        // Short. The key stops at the bore, so slot below it is empty dark
        // that reads as a second object under the key rather than the hole it
        // is standing in.
        yBot: -lk.shaftHalf * 3.4 * keyScale,
      }
    : { r: 14, halfTop: 8, halfBot: 14, yBot: -46 }; // keyless spikes
  // Wide enough that the bit stays behind it. escutcheonShape's outline
  // reaches about 0.34 * pw at its widest, hence the 3.2.
  const bitHalf = (lk?.bitHalf ?? 0) * keyScale;
  const pw = Math.max(Math.round(Math.min(W, H) * 0.075), Math.round(bitHalf * 3.2));
  // Long enough that the bit's tip stays behind it too — the outline's bottom
  // sits at -0.55 * ph, so it must clear the key's deepest point with margin.
  const bitDrop = (lk ? lk.bitBottom - lk.pivotY : 0) * keyScale;
  const ph = Math.max(pw * 1.45, bitDrop * 2.1, -hole.yBot * 2.5);
  return {
    hole,
    pw,
    ph,
    pd: pw * 0.13, // how far the plate stands off the door
    sd: pw * 0.75, // how deep the keyhole bores in
    // The keyhole's height, in three's y-up world. Not the centre of the
    // screen: DOOR_LOCK_Y puts it in whatever clear band the art leaves.
    lockY: -(DOOR_LOCK_Y - 0.5) * H,
  };
}

/**
 * Builds the plate and its socket.
 * @returns {{group: THREE.Group, materials: THREE.Material[], dispose: Function}}
 */
export function buildLock(m, leafDepth) {
  const geoms = [];
  const group = new THREE.Group();
  group.position.set(0, m.lockY, leafDepth / 2);

  const ironMat = new THREE.MeshStandardMaterial({
    // A metal's base colour is its SPECULAR TINT, not a diffuse paint: at high
    // metalness there is no diffuse term at all, so a dark colour yields a
    // dark mirror however much light you add. Iron reflects ~55%, so this has
    // to be a mid tone and gets its darkness from the scene instead.
    color: 0x9298ad,
    metalness: 0.85,
    roughness: 0.28,
    envMapIntensity: 1.4,
    transparent: true,
  });
  const plateGeo = new THREE.ExtrudeGeometry(
    escutcheonShape(m.pw, m.ph, m.hole),
    {
      depth: m.pd,
      bevelEnabled: true,
      bevelThickness: m.pd * 0.45,
      bevelSize: m.pd * 0.45,
      bevelSegments: 4,
      curveSegments: 24,
    },
  );
  geoms.push(plateGeo);

  // The socket is the keyhole profile extruded backwards and rendered from the
  // INSIDE (BackSide), which turns a solid into a cavity: you see its walls
  // recede and its floor, and they shade as the lighting changes.
  //
  // In the door's scene this needed depthTest off, because the door leaf is a
  // solid slab occupying that space and its front face won. Here there is no
  // leaf — the leaves are on the canvas behind — so ordinary depth works, and
  // the socket's own far cap supplies the dark floor.
  const socketMat = new THREE.MeshStandardMaterial({
    color: 0x1b1b24,
    metalness: 0.45,
    roughness: 0.85,
    transparent: true,
    side: THREE.BackSide,
  });
  const socketGeo = new THREE.ExtrudeGeometry(keyholeShape(m.hole), {
    depth: m.sd,
    bevelEnabled: false,
    curveSegments: 24,
  });
  geoms.push(socketGeo);

  const socket = new THREE.Mesh(socketGeo, socketMat);
  socket.position.z = -m.sd; // bore inward from the door's surface
  group.add(socket, new THREE.Mesh(plateGeo, ironMat));

  const materials = [ironMat, socketMat];
  return {
    group,
    materials,
    dispose() {
      for (const g of geoms) g.dispose();
      for (const mat of materials) mat.dispose();
    },
  };
}
