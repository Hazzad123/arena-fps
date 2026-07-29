// Turns compiled map geometry into something you can look at.
//
// The entire level is one InstancedMesh over a unit cube — every wall, crate and
// stair step is the same geometry with a different matrix and colour. A whole
// map is one draw call, which is why we can get away with no asset pipeline and
// still hold frame rate on a work laptop's integrated GPU.

import * as THREE from 'three';
import { VIEW_DISTANCE } from '@shared/constants.js';
import { loadModel, instantiate } from './models.js';

const UNIT_CUBE = new THREE.BoxGeometry(1, 1, 1);

// ---------------------------------------------------------------- surfaces
//
// The whole level is one InstancedMesh, which is why it's cheap — but every
// instance shares one material, and a box's UVs run 0..1 per face regardless of
// how big the box is. Put a texture on that and a 60m floor gets a single
// stretched tile.
//
// So the big surfaces are lifted out and drawn as individual meshes, each with
// its own material whose UV repeat comes from that box's actual size. There are
// only ever a handful of them per map — a floor, some walls, a roof — so the draw
// call count barely moves.

// Hand-painted textures rather than photographic ones, which is the whole reason
// these work: the models are flat-shaded toon and a photograph of a wall next to
// them looks like two different games. `metres` is world size per tile, kept
// generous so the pattern reads as surface rather than as tiling.
//
// `tint` is how much of the map's authored colour to mix in. The painted textures
// already carry their colour, so it's low — just enough that a red spawn wall is
// still recognisably red. `concrete` is the desaturated one and takes the map's
// colour almost whole.
const TEXTURES = {
  brick: { file: 'brick', metres: 5, tint: 0.3 },
  blockwork: { file: 'blockwork', metres: 5, tint: 0.3 },
  cobbles: { file: 'cobbles', metres: 4, tint: 0.25 },
  redbrick: { file: 'redbrick', metres: 5, tint: 0.2 },
  concrete: { file: 'concrete', metres: 6, tint: 0.88 },
};

/** Metres of world per texture tile, so tiling is consistent at any box size. */
const textureCache = new Map();

function getTexture(name) {
  if (textureCache.has(name)) return textureCache.get(name);
  const spec = TEXTURES[name];
  const entry = {
    metres: spec.metres,
    tint: spec.tint,
    // Cloning an unloaded Texture marks the clone for upload before it has any
    // image data, which produces a warning for every textured surface. Wait for
    // the source image, then clone it into each surface below.
    ready: new THREE.TextureLoader().loadAsync(`textures/${spec.file}.jpg`)
      .then((tex) => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
      })
      .catch(() => null),
  };
  textureCache.set(name, entry);
  return entry;
}

/**
 * Which texture a solid should wear, from its shape.
 *
 * Done by shape rather than by tagging every box in every map: a map author
 * shouldn't have to label a floor as a floor, and it means maps added later are
 * textured without touching them. An explicit `surface:name` tag wins if a map
 * does want to be specific.
 */
function surfaceFor(solid, map) {
  if (solid.tag?.startsWith('surface:')) return solid.tag.slice(8);

  const w = solid.max[0] - solid.min[0];
  const h = solid.max[1] - solid.min[1];
  const d = solid.max[2] - solid.min[2];
  const footprint = w * d;

  // Big and flat: a floor, a roof panel or a deck. Checked before the wall test,
  // because a 30x12 slab is a floor whatever its thickness — and Rooftops builds
  // its roofs 2.5m thick, which a tighter limit here skipped entirely.
  if (h <= 3 && footprint >= 60) return map.groundTexture ?? 'concrete';
  // Big and upright: a wall.
  if (h >= 2.5 && Math.max(w, d) >= 10 && Math.min(w, d) <= 3) return map.wallTexture ?? 'concrete';
  return null;
}

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
  renderer.shadowMap.type = THREE.PCFShadowMap;

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

  const props = new THREE.Group();
  world.scene.add(props);

  const surfaces = buildSurfaces(map, mesh);
  world.scene.add(surfaces);

  world.current = {
    map, mesh, props, surfaces,
    generation: ++loadGeneration,
    propByIndex: new Map(),
  };

  dressMap(world, map, mesh, props, world.current.generation);
  scatterProps(world, map, props, world.current.generation);

  return mesh;
}

/**
 * Draw the map's large surfaces as textured meshes, and hide the instances they
 * replace. Same geometry, same position, same collision — the box is simply
 * scaled to nothing in the instanced mesh so you see the textured version.
 */
function buildSurfaces(map, mesh) {
  const group = new THREE.Group();
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  let replaced = 0;

  map.solids.forEach((solid, index) => {
    // Props draw their own model; don't texture them as well.
    if (solid.tag === 'crate' || solid.tag?.startsWith('prop:')) return;
    if (solid.tag?.startsWith('barrel:')) return;
    const name = surfaceFor(solid, map);
    if (!name || !TEXTURES[name]) return;

    const tex = getTexture(name);
    const w = solid.max[0] - solid.min[0];
    const h = solid.max[1] - solid.min[1];
    const d = solid.max[2] - solid.min[2];

    // Repeat comes from the two dimensions of the box's largest face, in the
    // order that face's UVs actually run. Sorting the dimensions and using the
    // top two is not the same thing: a 60x142 floor then gets 35 repeats across
    // its 60m width and 15 along its 142m length, and the texture visibly smears
    // down the room. BoxGeometry's convention is U along X then Z, V along Y then
    // Z, so which axis is thin decides the pair.
    const thinnest = Math.min(w, h, d);
    let repeatU;
    let repeatV;
    if (thinnest === h) {
      [repeatU, repeatV] = [w, d]; // floor or roof: looking at the ±Y faces
    } else if (thinnest === d) {
      [repeatU, repeatV] = [w, h]; // wall facing along Z
    } else {
      [repeatU, repeatV] = [d, h]; // wall facing along X
    }
    repeatU = Math.max(1, Math.round(repeatU / tex.metres));
    repeatV = Math.max(1, Math.round(repeatV / tex.metres));

    // Mix the map's authored colour in by the texture's own weight: a painted
    // brick brings its colour with it and only wants a hint of the palette, while
    // the desaturated concrete wants nearly all of it.
    const tint = new THREE.Color(0xffffff).lerp(new THREE.Color(solid.color), tex.tint);

    const material = new THREE.MeshLambertMaterial({ color: tint });

    const box = new THREE.Mesh(UNIT_CUBE, material);
    box.scale.set(w, h, d);
    box.position.set(
      (solid.min[0] + solid.max[0]) / 2,
      (solid.min[1] + solid.max[1]) / 2,
      (solid.min[2] + solid.max[2]) / 2,
    );
    box.castShadow = true;
    box.receiveShadow = true;
    group.add(box);

    tex.ready.then((source) => {
      // A map can rotate while the image request is in flight. An orphaned box
      // means its material has already been disposed; do not resurrect it or
      // leak a cloned texture into the next round.
      if (!source || !group.parent || !box.parent) return;
      const map2 = source.clone();
      map2.repeat.set(repeatU, repeatV);
      material.map = map2;
      material.needsUpdate = true;
    });

    mesh.setMatrixAt(index, hidden);
    replaced++;
  });

  if (replaced > 0) mesh.instanceMatrix.needsUpdate = true;
  return group;
}

// Bumped on every map load so an in-flight model arriving after a map rotation
// can tell it's late and drop its work rather than decorating the new map with
// the old one's crates.
let loadGeneration = 0;

const PROP_URL = (file) => `models/props/${file}.gltf`;

// Cargo that stands in for a tagged crate box. Alternating gives a stack some
// variety without needing the maps to say which is which.
const CRATE_MODELS = ['Crate', 'CardboardBoxes_3', 'Crate', 'WoodPlanks'];

/**
 * Draw models in place of the boxes tagged for them.
 *
 * The box stays exactly where it was and keeps colliding; it's simply scaled to
 * nothing so you see the crate instead of the grey cube. That's the whole trick,
 * and it's why this can't affect movement, hit registration, the server's view of
 * the map or the navigation tests: none of them ever look at what's drawn.
 */
async function dressMap(world, map, mesh, props, generation) {
  // Two kinds of tag: `crate`, which cycles through cargo for variety, and
  // `prop:File`, where the map has asked for one specific model.
  const wanted = [];
  map.solids.forEach((s, i) => {
    if (s.tag === 'crate') wanted.push({ index: i, file: null });
    else if (s.tag?.startsWith('prop:')) wanted.push({ index: i, file: s.tag.slice(5) });
    // Explosive barrels are drawn the same way, but kept in a registry so the
    // one that just blew up can be found again by index.
    else if (s.tag?.startsWith('barrel:')) wanted.push({ index: i, file: s.tag.slice(7) });
  });
  if (wanted.length === 0) return;

  const files = [...new Set([...CRATE_MODELS, ...wanted.map((w) => w.file).filter(Boolean)])];
  const loaded = new Map(
    (await Promise.all(files.map((f) => loadModel(PROP_URL(f))))).map((m, i) => [files[i], m]),
  );
  // A map rotation happened while these were downloading.
  if (world.current?.generation !== generation) return;

  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  let placed = 0;

  for (const { index, file } of wanted) {
    const solid = map.solids[index];
    const model = loaded.get(file ?? CRATE_MODELS[placed % CRATE_MODELS.length]);
    if (!model) continue;

    const instance = instantiate(model);
    box.setFromObject(instance);
    box.getSize(size);
    if (size.x <= 0 || size.y <= 0 || size.z <= 0) continue;

    // Fill the box on every axis independently. Crates are boxy, so stretching
    // one to a slightly non-cubic solid reads as a different crate, not a bug.
    instance.scale.set(
      (solid.max[0] - solid.min[0]) / size.x,
      (solid.max[1] - solid.min[1]) / size.y,
      (solid.max[2] - solid.min[2]) / size.z,
    );

    // Re-measure after scaling to find where the model's own origin sits, which
    // is not necessarily its centre.
    instance.updateMatrixWorld(true);
    box.setFromObject(instance).getCenter(centre);
    instance.position.set(
      (solid.min[0] + solid.max[0]) / 2 - centre.x,
      (solid.min[1] + solid.max[1]) / 2 - centre.y,
      (solid.min[2] + solid.max[2]) / 2 - centre.z,
    );
    // A quarter turn here and there so a row of crates isn't a row of clones.
    instance.rotation.y = (index % 4) * (Math.PI / 2);

    props.add(instance);
    world.current?.propByIndex?.set(index, instance);
    mesh.setMatrixAt(index, hidden);
    placed++;
  }

  mesh.instanceMatrix.needsUpdate = true;
}

// Wall dressing.
//
// `standoff` is how far the prop's centre sits from the wall face, and `flat`
// means the model's long side should run along the wall rather than out into the
// room — the difference between pipes climbing a wall and pipes sticking out of
// it. Everything here is kept small or flush: these are drawn, not collided
// with, so anything big enough to read as cover would be a lie.
// No ExplodingBarrel here on purpose. Barrels are now real, destructible map
// objects placed by hand (see barrel() in maps/helpers.js). Scattering
// identical-looking ones that *don't* explode would teach players the wrong
// lesson about which barrels are worth shooting.
const GROUND_PROPS = [
  { file: 'Pipes', height: 4.2, standoff: 0.35, flat: true },
  { file: 'Barrier_Single', height: 1.1, standoff: 0.9 },
  { file: 'TrashContainer', height: 1.35, standoff: 0.95, flat: true },
  { file: 'Pallet', height: 0.9, standoff: 0.35, flat: true },
  { file: 'CardboardBoxes_1', height: 0.55, standoff: 0.7 },
  { file: 'TrafficCone', height: 0.6, standoff: 1.1 },
  { file: 'GasTank', height: 1.6, standoff: 0.6 },
  { file: 'SackTrench', height: 1.0, standoff: 0.8, flat: true },
];

// Bolted high up, out of reach of even a jump, so these cost nothing at all.
const HIGH_PROPS = [
  { file: 'Sign', height: 1.0, standoff: 0.25, flat: true },
  { file: 'Pipes', height: 3.0, standoff: 0.3, flat: true },
];

/** Deterministic 0..1 from two integers, so a map dresses the same every round. */
function hash01(a, b) {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * Find the map's walls and stand things against them.
 *
 * Placement is derived from the geometry rather than authored per map, so every
 * map — including any added later — gets dressed, and it's seeded by index rather
 * than randomised so a room doesn't rearrange itself between rounds.
 */
async function scatterProps(world, map, props, generation) {
  const bounds = map.bounds;
  const centre = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[2] + bounds.max[2]) / 2];

  // A wall: tall, long in one horizontal axis, thin in the other.
  const walls = map.solids.filter((s) => {
    const w = s.max[0] - s.min[0];
    const h = s.max[1] - s.min[1];
    const d = s.max[2] - s.min[2];
    if (h < 2.5) return false;
    const thin = Math.min(w, d);
    const long = Math.max(w, d);
    return thin <= 2 && long >= 8;
  });
  if (walls.length === 0) return;

  const spawns = Object.values(map.spawns ?? {}).flat();
  const clearOfSpawns = (x, z) =>
    spawns.every((p) => Math.hypot(p[0] - x, p[2] - z) > 5);

  const files = [...new Set([...GROUND_PROPS, ...HIGH_PROPS].map((p) => p.file))];
  const loaded = new Map(
    (await Promise.all(files.map((f) => loadModel(PROP_URL(f))))).map((m, i) => [files[i], m]),
  );
  if (world.current?.generation !== generation) return;

  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  const centreOf = new THREE.Vector3();

  /**
   * `alongX` is the wall's direction. A flat prop is turned so its long side
   * follows the wall; anything else gets a free spin so a row of barrels isn't a
   * row of identical barrels.
   */
  const place = (spec, x, y, z, alongX, spin) => {
    const model = loaded.get(spec.file);
    if (!model) return;
    const instance = instantiate(model);

    box.setFromObject(instance).getSize(size);
    if (size.y <= 0) return;
    instance.scale.setScalar(spec.height / size.y);

    if (spec.flat) {
      const longSideIsX = size.x >= size.z;
      instance.rotation.y = longSideIsX === alongX ? 0 : Math.PI / 2;
    } else {
      instance.rotation.y = spin;
    }

    // Rotate before measuring, then sit it ON y rather than centred on it.
    instance.updateMatrixWorld(true);
    box.setFromObject(instance);
    box.getCenter(centreOf);
    instance.position.set(x - centreOf.x, y - box.min.y, z - centreOf.z);
    props.add(instance);
  };

  walls.forEach((wall, wi) => {
    const alongX = wall.max[0] - wall.min[0] >= wall.max[2] - wall.min[2];
    const long = alongX ? wall.max[0] - wall.min[0] : wall.max[2] - wall.min[2];
    const steps = Math.floor(long / 7);
    if (steps < 1) return;

    // Which side of the wall faces the arena.
    const wallMid = alongX
      ? (wall.min[2] + wall.max[2]) / 2
      : (wall.min[0] + wall.max[0]) / 2;
    const inward = Math.sign((alongX ? centre[1] : centre[0]) - wallMid) || 1;
    const thin = alongX ? 2 : 0;
    const face = inward > 0 ? wall.max[thin] : wall.min[thin];

    // Only the perimeter. Interior walls are fighting space, and a barrel in a
    // doorway is a barrel in the way. Asked of the wall rather than of the prop:
    // an outer wall can be 2m thick and stand 2m inside the declared bounds, so
    // measuring from the prop rejects the whole perimeter.
    const outerFace = inward > 0 ? wall.min[thin] : wall.max[thin];
    const toBounds = Math.min(
      Math.abs(outerFace - bounds.min[thin]),
      Math.abs(outerFace - bounds.max[thin]),
    );
    if (toBounds > 3) return;

    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const alongPos = (alongX ? wall.min[0] : wall.min[2]) + t * long;
      const r = hash01(wi, i);

      // Leave gaps: a wall lined end to end with barrels looks authored by a
      // script, which it is, and shouldn't look it.
      if (r < 0.35) continue;

      const spec = GROUND_PROPS[Math.floor(hash01(wi, i + 91) * GROUND_PROPS.length)];
      const at = (offset) => ({
        x: alongX ? alongPos : face + inward * offset,
        z: alongX ? face + inward * offset : alongPos,
      });

      const ground = at(spec.standoff);
      if (!clearOfSpawns(ground.x, ground.z)) continue;

      // The wall's own base is the floor it stands on. The map's lower bound is
      // not: on maps with a lethal drop it's the bottom of the void, which put
      // every prop eleven metres under the level.
      const groundY = wall.min[1];
      const wallTop = wall.max[1];

      place(spec, ground.x, groundY, ground.z, alongX, hash01(wi, i + 53) * Math.PI * 2);

      // And something high on the same stretch, if the wall is tall enough for it
      // to be genuinely out of reach.
      if (wallTop - groundY > 6 && hash01(wi, i + 7) > 0.55) {
        const high = HIGH_PROPS[Math.floor(hash01(wi, i + 29) * HIGH_PROPS.length)];
        const up = at(high.standoff);
        place(high, up.x, groundY + 3.6 + hash01(wi, i + 3) * 1.2, up.z, alongX, 0);
      }
    }
  });
}

function disposeGroup(group) {
  group.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) m?.dispose();
  });
}

export function unloadMap(world) {
  if (!world.current) return;
  const { mesh, props, surfaces } = world.current;
  world.scene.remove(mesh);
  mesh.material.dispose();
  mesh.dispose();
  if (props) {
    world.scene.remove(props);
    // Geometry belongs to the cached template and is reused by the next map.
    disposeGroup(props);
  }
  if (surfaces) {
    world.scene.remove(surfaces);
    // Materials and their cloned textures are per-map; the source textures the
    // clones came from stay cached for the next one.
    for (const child of surfaces.children) {
      child.material.map?.dispose();
      child.material.dispose();
    }
  }
  world.current = null;
}

/**
 * Turn a barrel into a burnt-out husk.
 *
 * It stays where it is and keeps colliding, because the collision box lives in
 * the shared, cached map data that every room on the server reads — mutating it
 * for one match would silently change the level for all of them. A spent barrel
 * being cover you can still hide behind is also just fine: it reads as debris,
 * and the important thing (it can't be detonated again) is server state.
 */
export function scorchBarrel(world, index) {
  const instance = world.current?.propByIndex?.get(index);
  if (!instance || instance.userData.scorched) return;
  instance.userData.scorched = true;

  instance.traverse((node) => {
    if (!node.isMesh && !node.isSkinnedMesh) return;
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    // Cloned before recolouring: the loader shares materials between instances,
    // so recolouring in place would blacken every barrel on the map at once.
    const replaced = mats.map((m) => {
      const c = m.clone();
      c.color.multiplyScalar(0.16);
      return c;
    });
    node.material = Array.isArray(node.material) ? replaced : replaced[0];
  });

  // Squat down a little, as if it's been blown open.
  instance.scale.y *= 0.72;
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
