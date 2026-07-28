// glTF model loading.
//
// Everything here is optional decoration. The game was built out of box
// primitives and still runs on them: every caller keeps its procedural version
// and swaps in a model only once one has actually arrived. A 404, a corrupt file
// or a slow connection costs you the nice guns, not the match.
//
// Models are CC0 from Quaternius (Toon Shooter Game Kit). They're fetched at
// runtime from /models rather than bundled, so 3MB of geometry never blocks the
// first paint.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

const loader = new GLTFLoader();

/** url -> Promise<{ scene, animations } | null> */
const cache = new Map();
const failed = new Set();

/**
 * The kit ships PBR materials, but the rest of the game is Lambert under a
 * two-light rig with no environment map, where PBR reads as murky and flat.
 * Converting keeps one art direction and drops a pile of shader work we get
 * nothing for.
 */
function toLambert(material) {
  const lambert = new THREE.MeshLambertMaterial({
    color: material.color?.clone() ?? new THREE.Color(0xffffff),
    map: material.map ?? null,
    transparent: material.transparent,
    opacity: material.opacity,
    side: material.side,
    vertexColors: material.vertexColors,
  });
  lambert.name = material.name;
  // Emissive materials in the kit are lights and signage — keep them lit rather
  // than letting them fall dark with the rest of the surface.
  if (material.emissive && material.emissive.getHex() !== 0x000000) {
    lambert.emissive = material.emissive.clone();
    lambert.emissiveIntensity = material.emissiveIntensity ?? 1;
  }
  return lambert;
}

function prepare(scene) {
  scene.traverse((node) => {
    if (!node.isMesh && !node.isSkinnedMesh) return;
    node.castShadow = true;
    node.receiveShadow = true;
    node.material = Array.isArray(node.material)
      ? node.material.map(toLambert)
      : toLambert(node.material);
  });
  return scene;
}

/**
 * Load a model, once. Resolves to null rather than rejecting — callers are
 * expected to carry on without it, so a failure isn't exceptional.
 */
export function loadModel(url) {
  if (cache.has(url)) return cache.get(url);

  const promise = loader
    .loadAsync(url)
    .then((gltf) => ({ scene: prepare(gltf.scene), animations: gltf.animations ?? [] }))
    .catch((err) => {
      // Once per URL: a broken path shouldn't scroll the console for the whole match.
      if (!failed.has(url)) {
        failed.add(url);
        console.warn(`[models] ${url} unavailable, using the built-in shape instead:`, err.message);
      }
      return null;
    });

  cache.set(url, promise);
  return promise;
}

/** Already-resolved model, or null. For the frame loop, which can't await. */
export function peekModel(url) {
  const entry = cache.get(url);
  return entry?.resolved ?? null;
}

/**
 * Start loading and remember the result for peekModel. Fire-and-forget: nothing
 * waits on it, things just start looking better a moment after they appear.
 */
export function preload(urls) {
  for (const url of urls) {
    const promise = loadModel(url);
    if (promise.resolved !== undefined) continue;
    promise.then((model) => {
      promise.resolved = model;
    });
  }
}

/** An independent copy, safe for skinned meshes and their skeletons. */
export function instantiate(model) {
  const root = cloneSkinned(model.scene);
  // Cloned materials so one player's team colour can't bleed into everyone else's.
  root.traverse((node) => {
    if (!node.isMesh && !node.isSkinnedMesh) return;
    node.material = Array.isArray(node.material)
      ? node.material.map((m) => m.clone())
      : node.material.clone();
  });
  return root;
}

/** Uniform scale that makes a model exactly `targetHeight` tall. */
export function scaleToHeight(object, targetHeight) {
  const box = new THREE.Box3().setFromObject(object);
  const height = box.max.y - box.min.y;
  if (height <= 0) return 1;
  const scale = targetHeight / height;
  object.scale.setScalar(scale);
  return scale;
}

/** Longest horizontal dimension, used to point a gun down its own barrel. */
export function measure(object) {
  const box = new THREE.Box3().setFromObject(object);
  return {
    size: box.getSize(new THREE.Vector3()),
    center: box.getCenter(new THREE.Vector3()),
    box,
  };
}
