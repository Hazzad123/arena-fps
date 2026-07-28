// Turns compiled map geometry into something you can look at.
//
// The entire level is one InstancedMesh over a unit cube — every wall, crate and
// stair step is the same geometry with a different matrix and colour. A whole
// map is one draw call, which is why we can get away with no asset pipeline and
// still hold frame rate on a work laptop's integrated GPU.

import * as THREE from 'three';
import { VIEW_DISTANCE } from '@shared/constants.js';

const UNIT_CUBE = new THREE.BoxGeometry(1, 1, 1);

export function createWorld(renderer) {
  const scene = new THREE.Scene();

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
  scene.add(hemi);

  // A small unconditional ambient term. Hemisphere light alone leaves surfaces
  // that face straight down — the whole underside of an indoor map's roof —
  // effectively unlit, and a black ceiling reads as a missing polygon.
  const fill = new THREE.AmbientLight(0xffffff, 0.35);
  scene.add(fill);

  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  return { scene, hemi, sun, current: null };
}

/**
 * Swap the world over to a map. Disposes whatever was there before — rounds
 * rotate maps, so this runs repeatedly across a session and must not leak.
 */
export function loadMap(world, map) {
  unloadMap(world);

  const solids = map.solids;
  const mesh = new THREE.InstancedMesh(
    UNIT_CUBE,
    new THREE.MeshLambertMaterial({ flatShading: true }),
    solids.length,
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const m = new THREE.Matrix4();
  const colour = new THREE.Color();

  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    const sx = s.max[0] - s.min[0];
    const sy = s.max[1] - s.min[1];
    const sz = s.max[2] - s.min[2];
    m.makeScale(sx, sy, sz);
    m.setPosition((s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2, (s.min[2] + s.max[2]) / 2);
    mesh.setMatrixAt(i, m);

    colour.setHex(s.color);
    // Nudge each instance's brightness a little so large flat expanses of the
    // same colour don't read as one solid mass.
    const jitter = 0.94 + ((i * 2654435761) % 1000) / 1000 * 0.12;
    colour.multiplyScalar(jitter);
    mesh.setColorAt(i, colour);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  world.scene.add(mesh);

  // ---- atmosphere ----
  world.scene.background = new THREE.Color(map.skyColor);
  world.scene.fog = new THREE.FogExp2(map.fogColor, map.fogDensity ?? 0.01);
  world.hemi.intensity = map.ambientLight ?? 0.6;
  // Downward-facing surfaces take the hemisphere's ground colour, and on an
  // indoor map that includes the entire underside of the roof. Too dark a value
  // renders the ceiling pure black, which reads as a hole rather than a roof.
  world.hemi.groundColor = new THREE.Color(map.fogColor).multiplyScalar(0.85);

  // ---- sun and shadow volume sized to the map ----
  const b = map.bounds;
  const spanX = b.max[0] - b.min[0];
  const spanZ = b.max[2] - b.min[2];
  const radius = Math.max(spanX, spanZ) * 0.72;
  const centre = [(b.min[0] + b.max[0]) / 2, b.min[1], (b.min[2] + b.max[2]) / 2];

  const dir = map.sunDirection ?? [0.4, 1, 0.3];
  const dlen = Math.hypot(...dir) || 1;
  world.sun.intensity = map.sunIntensity ?? 0.9;
  world.sun.position.set(
    centre[0] + (dir[0] / dlen) * radius,
    centre[1] + (dir[1] / dlen) * radius,
    centre[2] + (dir[2] / dlen) * radius,
  );
  world.sun.target.position.set(centre[0], centre[1], centre[2]);

  const cam = world.sun.shadow.camera;
  cam.left = -radius;
  cam.right = radius;
  cam.top = radius;
  cam.bottom = -radius;
  cam.near = 0.5;
  cam.far = radius * 3;
  cam.updateProjectionMatrix();

  world.current = { map, mesh };
  return mesh;
}

export function unloadMap(world) {
  if (!world.current) return;
  const { mesh } = world.current;
  world.scene.remove(mesh);
  mesh.material.dispose();
  mesh.dispose();
  world.current = null;
}

export function createCamera(fov) {
  return new THREE.PerspectiveCamera(fov, window.innerWidth / window.innerHeight, 0.05, VIEW_DISTANCE);
}

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  return renderer;
}
