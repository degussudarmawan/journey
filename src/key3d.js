/* ============================================================================
   KEY 3D — the key as real geometry, for the moment it enters the lock.
   ============================================================================

   The key is drawn two completely different ways during its life:

     - riding the orbit, and morphing out of the dots, it's the hand-rolled
       2D projection in keyRenderer.js. That works, looks right, and has no
       business being rewritten.
     - from the end of its flight onward it becomes this: a three.js mesh
       living in the door's scene.

   The handoff is what makes the second one worth doing. Once the key is a
   mesh in the same scene as the door, the depth buffer decides what hides
   what — so the key can genuinely go INTO the lock instead of being painted
   on top of a picture of one. No amount of 2D compositing gets you that,
   because the two canvases share no depth information at all.

   WHY THE HANDOFF IS EXACTLY AT THE END OF THE FLIGHT
   The 2D engine projects with `f / (f + z)` at f = ORBIT_FOCAL; the three.js
   camera projects with its own focal length, derived from the field of view.
   Those disagree everywhere EXCEPT at z = 0, where both are exactly 1. The
   key's flight ends face-on at the keyhole, which is the world origin — so
   swapping representations at that instant is seamless by construction,
   rather than by tuning two numbers to match.
   ============================================================================ */

import * as THREE from "three";

/**
 * Builds a key definition (from src/keys/) into a 3D object.
 *
 * The parts are already closed contours with holes — the same data the 2D
 * renderer extrudes by hand — so they map straight onto THREE.Shape, and
 * ExtrudeGeometry does the walls and bevels that keyRenderer.js has to
 * construct manually.
 *
 * @returns {{object: THREE.Group, materials: THREE.Material[],
 *            dispose: () => void}}
 */
export function buildKeyMesh(keyDef) {
  const group = new THREE.Group();
  const geometries = [];
  const d = keyDef.depth;

  // Keys are authored y-DOWN (screen convention, bow at the top); three.js is
  // y-up. Flipping here means everything downstream can think in ordinary 3D
  // terms instead of carrying the inversion around.
  const toVec2 = (pts) => pts.map((p) => new THREE.Vector2(p.x, -p.y));

  // Low metalness on purpose. At high metalness the base colour becomes a
  // pure specular tint and the key renders as whatever it reflects — which
  // turned this key grey. Keeping it mostly dielectric is what preserves the
  // lilac the palette actually specifies.
  const face = new THREE.MeshStandardMaterial({
    color: keyDef.palette.face,
    metalness: 0.2,
    roughness: 0.4,
    transparent: true,
  });
  const wall = new THREE.MeshStandardMaterial({
    color: keyDef.palette.sideDim,
    metalness: 0.25,
    roughness: 0.5,
    transparent: true,
  });
  const detail = new THREE.MeshStandardMaterial({
    color: keyDef.palette.detail,
    metalness: 0.3,
    roughness: 0.6,
    transparent: true,
  });
  const materials = [face, wall, detail];
  // transparent + depthWrite:false would let a far part of the key paint over
  // a near one — the same ghosting the 2D renderer had to be restructured to
  // avoid. Keeping depth writes on lets the depth buffer sort the parts, and
  // the only cost is that a mid-fade key self-occludes slightly, for the few
  // frames anyone can see it.
  for (const m of materials) m.depthWrite = true;

  const extrude = (contour, holes, depth) => {
    const shape = new THREE.Shape(toVec2(contour));
    for (const hole of holes || []) shape.holes.push(new THREE.Path(toVec2(hole)));
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: true,
      // A bevel this small doesn't read as a chamfer — it reads as the edge
      // catching the light, which is the difference between "solid metal"
      // and "cut from paper".
      bevelThickness: depth * 0.22,
      bevelSize: depth * 0.22,
      bevelSegments: 2,
      curveSegments: 1, // contours arrive pre-flattened; nothing left to subdivide
    });
    geo.translate(0, 0, -depth / 2); // centre the slab on z = 0
    geometries.push(geo);
    return geo;
  };

  for (const part of keyDef.parts) {
    // ExtrudeGeometry emits two material groups: 0 for the front and back
    // caps, 1 for the extruded side walls.
    group.add(new THREE.Mesh(extrude(part.contour, part.holes, d), [face, wall]));

    // Engraved marks sit just proud of the front face so they don't z-fight
    // with it.
    for (const det of part.details || []) {
      const mesh = new THREE.Mesh(extrude(det.contour, null, d * 0.35), detail);
      mesh.position.z = d / 2;
      group.add(mesh);
    }
  }

  return {
    object: group,
    materials,
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
