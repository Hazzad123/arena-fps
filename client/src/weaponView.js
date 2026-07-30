// First-person weapon models, tracers and impact effects.
//
// Every gun exists twice: as boxes built in code, and as a glTF model fetched at
// runtime. The boxes are what you see until the model arrives, and what you keep
// if it never does. What actually sells a shooter isn't polygon count anyway,
// it's the motion — the kick when you fire, the sway when you turn, the way the
// gun settles when you stop — and all of that is applied to the group both
// versions live in, so it works either way.

import * as THREE from 'three';
import { getWeapon, ALL_WEAPON_IDS } from '@shared/weapons.js';
import { loadModel, instantiate } from './models.js';

// Where each weapon's model comes from, driven off the `model` field in the
// weapon table so adding a gun is one edit rather than three.
//
// Two packs, two conventions, and neither is guessable from the geometry:
//   glTF (Toon Shooter kit) — guns lie along -X, the knife points +Y
//   OBJ  (Quaternius pack)  — guns lie along +X
// Getting the sign wrong points the barrel at your own eye, so it's declared.
const MODEL_SOURCES = {
  gltf: { dir: 'models/guns', ext: 'gltf', forward: '-x' },
  obj: { dir: 'models/guns-obj', ext: 'obj', forward: '+x' },
};

/**
 * The box shapes are the fallback for when a model doesn't download. There are
 * seventeen guns and eight hand-built shapes, so a gun without its own borrows
 * the one for its type — a new shotgun looks like the shotgun rather than like
 * nothing at all. Means adding a weapon needs no entry here.
 */
const TYPE_ARCHETYPE = {
  rifle: 'rifle',
  smg: 'smg',
  shotgun: 'shotgun',
  sniper: 'sniper',
  lmg: 'lmg',
  pistol: 'pistol',
  melee: 'knife',
};

function archetypeFor(weaponId) {
  if (SHAPES[weaponId]) return weaponId;
  return TYPE_ARCHETYPE[getWeapon(weaponId).type] ?? 'rifle';
}

function shapeFor(weaponId) {
  return SHAPES[archetypeFor(weaponId)];
}

function muzzleFor(weaponId) {
  return MUZZLE[archetypeFor(weaponId)] ?? MUZZLE.rifle;
}

/** `model: 'obj:AssaultRifle_1'` -> a url and the axis it was modelled along. */
function modelSpecFor(weaponId) {
  const spec = getWeapon(weaponId).model;
  if (!spec) return null;
  const [kind, file] = spec.split(':');
  const source = MODEL_SOURCES[kind];
  if (!source || !file) return null;
  // The knife is the one model in either pack that stands upright.
  const forward = file.startsWith('Knife') ? '+y' : source.forward;
  return { url: `${source.dir}/${file}.${source.ext}`, forward };
}

// Each part is [x, y, z, w, h, d, colorMultiplier, part?]. Local space: the gun
// points down -Z, like the camera.
//
// The optional `part` tag marks a piece the reload animation moves: 'mag' for a
// detachable magazine, 'pump' for the shotgun's fore-end, 'bolt' for the sniper.
const SHAPES = {
  rifle: [
    [0, 0, -0.1, 0.09, 0.12, 0.5, 1.0], // receiver
    [0, -0.12, -0.02, 0.07, 0.16, 0.1, 0.8, 'mag'],
    [0, 0.005, -0.42, 0.045, 0.045, 0.34, 0.85], // barrel
    [0, 0.09, -0.12, 0.035, 0.05, 0.16, 0.7], // carry handle
    [0, -0.02, 0.19, 0.07, 0.11, 0.2, 0.75], // stock
    [0, -0.09, -0.26, 0.05, 0.1, 0.13, 0.8], // foregrip
  ],
  smg: [
    [0, 0, -0.08, 0.085, 0.11, 0.34, 1.0],
    [0, -0.13, -0.01, 0.055, 0.18, 0.08, 0.8, 'mag'],
    [0, 0.005, -0.31, 0.04, 0.04, 0.22, 0.85],
    [0, 0.075, -0.1, 0.03, 0.035, 0.12, 0.7],
    [0, -0.04, 0.13, 0.05, 0.07, 0.14, 0.75],
  ],
  pistol: [
    [0, 0, -0.06, 0.055, 0.1, 0.22, 1.0],
    [0, -0.11, 0.02, 0.05, 0.15, 0.07, 0.8, 'mag'],
    [0, 0.005, -0.2, 0.03, 0.03, 0.09, 0.85],
  ],
  shotgun: [
    [0, 0, -0.1, 0.085, 0.1, 0.44, 1.0],
    [0, 0.005, -0.46, 0.05, 0.05, 0.4, 0.85], // long barrel
    [0, -0.055, -0.4, 0.045, 0.045, 0.3, 0.7], // tube magazine
    [0, -0.03, 0.18, 0.075, 0.1, 0.22, 0.75],
    [0, -0.085, -0.28, 0.06, 0.07, 0.16, 0.65, 'pump'],
  ],
  sniper: [
    [0, 0, -0.12, 0.08, 0.11, 0.56, 1.0],
    [0, 0.005, -0.56, 0.042, 0.042, 0.42, 0.85],
    [0, 0.1, -0.16, 0.05, 0.05, 0.3, 0.55], // scope tube
    [0, 0.1, -0.31, 0.07, 0.07, 0.05, 0.45], // objective lens
    [0, -0.04, 0.22, 0.075, 0.12, 0.28, 0.75],
    [0, -0.11, -0.02, 0.055, 0.12, 0.07, 0.8, 'mag'],
    [0.055, 0.045, 0.02, 0.03, 0.03, 0.1, 0.6, 'bolt'],
  ],
  lmg: [
    [0, 0, -0.08, 0.1, 0.13, 0.54, 1.0], // receiver
    [0, -0.14, -0.04, 0.11, 0.19, 0.2, 0.8, 'mag'], // belt box
    [0, 0.01, -0.46, 0.05, 0.05, 0.42, 0.85], // heavy barrel
    [0, 0.085, -0.5, 0.05, 0.035, 0.12, 0.7], // front sight
    [0, -0.03, 0.21, 0.08, 0.12, 0.24, 0.75], // stock
    [0, -0.12, -0.52, 0.04, 0.16, 0.04, 0.6], // bipod leg
    [0, 0.085, -0.1, 0.04, 0.04, 0.2, 0.7], // top rail
  ],
  dmr: [
    [0, 0, -0.11, 0.085, 0.115, 0.52, 1.0],
    [0, -0.12, -0.02, 0.06, 0.15, 0.1, 0.8, 'mag'],
    [0, 0.005, -0.5, 0.04, 0.04, 0.36, 0.85],
    [0, 0.095, -0.14, 0.045, 0.05, 0.24, 0.55], // low-profile scope
    [0, 0.095, -0.27, 0.06, 0.06, 0.04, 0.45],
    [0, -0.025, 0.2, 0.075, 0.11, 0.22, 0.75],
    [0, -0.085, -0.3, 0.05, 0.09, 0.14, 0.7], // handguard
  ],
  knife: [
    [0, -0.02, -0.16, 0.022, 0.075, 0.3, 1.0], // blade
    [0, -0.05, 0.04, 0.045, 0.055, 0.14, 0.5], // grip
  ],
};

// Where the barrel tip sits, for muzzle flash placement.
const MUZZLE = {
  rifle: [0, 0.005, -0.6],
  smg: [0, 0.005, -0.43],
  pistol: [0, 0.005, -0.25],
  shotgun: [0, 0.005, -0.67],
  sniper: [0, 0.005, -0.78],
  lmg: [0, 0.01, -0.68],
  dmr: [0, 0.005, -0.69],
  knife: [0, 0, -0.3],
};

// Far enough forward that the stock isn't nearly touching the near plane, and
// scaled down so the gun reads as held rather than worn.
const HIP = new THREE.Vector3(0.17, -0.2, -0.92);
// Aimed: centred horizontally but sitting LOW, so the receiver occupies the
// bottom of the frame and the crosshair looks over the top of it. Putting the
// gun's centreline on the crosshair (which is what "align the sights" naively
// suggests) parks the receiver directly over whatever you're shooting at.
const ADS = new THREE.Vector3(0.0, -0.19, -0.9);
const VIEW_SCALE = 1.02;
// Shrink a little while aimed, so it intrudes even less.
const ADS_SCALE = 0.82;
// Imported models vary wildly in height and bulk even after being fitted to
// the procedural weapon's length. These values normalize their first-person
// screen footprint while preserving the intended pistol/SMG/rifle hierarchy.
const WEAPON_VIEW_SCALE = {
  pistol: 1.06,
  revolver: 1.06,
  machinepistol: 1.04,
  smg: 1.03,
  smg_compact: 1.05,
  smg_heavy: 1.02,
  rifle: 1.03,
  carbine: 1.04,
  bullpup: 1.03,
  shotgun: 1.02,
  sawnoff: 1.06,
  autoshotgun: 1.02,
  sniper: 1.03,
  dmr: 1.03,
  antimateriel: 1.02,
  lmg: 1.01,
  knife: 1.1,
};
// Keep a restrained three-quarter angle: enough to read the receiver and stock,
// but well short of the old pose that made long guns lean hard to the right.
const BASE_YAW = -0.2;
const WEAPON_POSE_YAW = {
  pistol: -0.21,
  revolver: -0.22,
  machinepistol: -0.2,
  shotgun: -0.2,
  autoshotgun: -0.2,
  dmr: -0.21,
  sniper: -0.21,
  antimateriel: -0.22,
  lmg: -0.2,
};
// Every source pack uses a different unit scale. First-person guns are fitted to
// a real silhouette length, uniformly, so a scope stays round and a stock does
// not turn into a pancake.
const MODEL_LENGTH = {
  pistol: 0.38,
  revolver: 0.42,
  machinepistol: 0.44,
  smg: 0.64,
  smg_compact: 0.6,
  smg_heavy: 0.69,
  rifle: 1.0,
  carbine: 0.9,
  bullpup: 0.88,
  shotgun: 1.05,
  sawnoff: 0.7,
  autoshotgun: 0.96,
  sniper: 1.25,
  dmr: 1.08,
  antimateriel: 1.34,
  lmg: 1.05,
  knife: 0.46,
};
const WEAPON_HIP_OFFSET = {
  pistol: [0.025, 0.02, 0.08],
  revolver: [0.025, 0.015, 0.07],
  machinepistol: [0.02, 0.01, 0.04],
  rifle: [0.015, 0, -0.18],
  carbine: [0.015, 0, -0.14],
  bullpup: [0.015, 0, -0.13],
  sawnoff: [0.01, 0.015, -0.04],
  shotgun: [-0.025, 0.035, -0.34],
  autoshotgun: [-0.025, 0.03, -0.3],
  sniper: [0.03, 0.035, -0.43],
  dmr: [0.01, 0.035, -0.34],
  antimateriel: [0.02, 0.035, -0.5],
  lmg: [-0.035, 0.025, -0.32],
};
const BASE_PITCH = 0.02;

// The viewmodel gets its own scene and camera, rendered as a second pass on top
// of the world. Three reasons, all of which bite you if you parent the gun to
// the main camera instead:
//   - a 110° world FOV distorts a gun held 40cm from your face into a canoe;
//     a fixed 50° view FOV keeps it looking the same at any FOV setting
//   - it can never clip through a wall you're standing against
//   - it needs its own lighting, not the map's (a gun in shadow reads as a bug)
const VIEW_FOV = 50;

export function createWeaponView() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    VIEW_FOV,
    window.innerWidth / window.innerHeight,
    0.01,
    5,
  );
  scene.add(camera);

  // Fixed studio lighting so the gun reads clearly on every map.
  scene.add(new THREE.HemisphereLight(0xdfffee, 0x273128, 1.15));
  // Flat dark MTL colours need a little frontal fill. Without it, faces turned
  // away from the key light collapse to black even though their material colour
  // loaded correctly.
  scene.add(new THREE.AmbientLight(0xffffff, 0.52));
  const key = new THREE.DirectionalLight(0xffefd0, 1.65);
  key.position.set(-0.6, 1, 0.75);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x46ffae, 0.72);
  rim.position.set(1, -0.3, -0.6);
  scene.add(rim);

  const root = new THREE.Group();
  scene.add(root);

  const models = {};
  for (const id of ALL_WEAPON_IDS) {
    const parts = shapeFor(id);
    const group = new THREE.Group();
    const base = new THREE.Color(getWeapon(id).viewColor);
    const moving = {};

    for (const [x, y, z, w, h, d, mult, part] of parts) {
      const mat = new THREE.MeshLambertMaterial({
        // Lifted well above the stored colour: gunmetal that reads correctly on
        // a wall in daylight reads as a black hole in the corner of the screen.
        color: base.clone().multiplyScalar(mult * 2.2),
        flatShading: true,
      });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y, z);
      group.add(mesh);
      if (part) {
        // Remember where it belongs, so the animation is always relative to rest.
        moving[part] = { mesh, rest: mesh.position.clone() };
      }
    }

    // Muzzle flash: a cheap additive blob, hidden until a shot goes off.
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 8, 6),
      new THREE.MeshBasicMaterial({
        color: 0xffd27a,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    flash.position.set(...muzzleFor(id));
    flash.visible = false;
    group.add(flash);

    group.visible = false;
    root.add(group);
    // The volume the boxes occupy, computed straight from the numbers above
    // rather than from the scene graph. It has to be in the group's own local
    // space, and asking three for a bounding box would give world space — the
    // root's scale and the group's per-frame position baked in.
    const bounds = new THREE.Box3();
    for (const [x, y, z, w, h, d] of parts) {
      bounds.expandByPoint(new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2));
      bounds.expandByPoint(new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2));
    }

    models[id] = {
      group,
      flash,
      moving,
      muzzle: new THREE.Vector3(...muzzleFor(id)),
      // The boxes, so a loaded model can take their place, and the space they
      // occupy, which is what it gets fitted to.
      boxes: group.children.filter((c) => c !== flash),
      bounds,
      usingModel: false,
    };
  }

  loadGunModels(models);

  return {
    scene,
    camera,
    root,
    models,
    currentId: null,
    // Animation state
    kick: 0,
    kickVel: 0,
    sway: new THREE.Vector2(),
    swayTarget: new THREE.Vector2(),
    flashUntil: 0,
    lowerAmount: 0,
  };
}

// Rotations that bring a model's authored forward axis round to -Z, which is the
// direction the camera looks. A missing entry here doesn't throw — it silently
// leaves the gun lying sideways, and because fitGunModel then scales by the depth
// of a model that has almost none, the result is a gun three metres wide sitting
// off the edge of the screen. Which is exactly what the Quaternius pack did until
// '+x' was added.
const FORWARD_ROTATION = {
  '-x': (o) => {
    o.rotation.y = -Math.PI / 2;
  },
  '+x': (o) => {
    o.rotation.y = Math.PI / 2;
  },
  '+y': (o) => {
    o.rotation.x = -Math.PI / 2;
  },
};

/**
 * Fit a loaded gun into the space its box version occupies, then swap them.
 *
 * Matching the box's bounding box rather than picking a scale by eye is what
 * makes this safe: the hip and aimed poses, the muzzle offset, the reload dip and
 * the walking bob are all tuned against that volume, so a model that fills the
 * same volume inherits every one of them without a single number changing.
 */
function fitGunModel(model, loaded, forward, weaponId) {
  const orientation = new THREE.Group();
  orientation.add(instantiate(loaded));
  FORWARD_ROTATION[forward]?.(orientation);
  // Scaling belongs outside the orientation transform. If scale.z is placed on
  // the rotated node, a model authored along X gets stretched sideways instead
  // of down the barrel after that X axis is turned toward camera -Z.
  const pivot = new THREE.Group();
  pivot.add(orientation);

  // Detached, so its world matrix is its local one and the box comes back in the
  // space it will be added into.
  pivot.updateMatrixWorld(true);
  const current = new THREE.Box3().setFromObject(pivot);

  const currentSize = current.getSize(new THREE.Vector3());
  if (currentSize.z <= 0) return null;

  // A gun should be longer than it is wide once it's facing the right way. If it
  // isn't, its forward axis was never rotated — better to keep the boxes than to
  // scale a sideways model by its non-existent depth.
  if (currentSize.z < Math.max(currentSize.x, currentSize.y) * 0.8) {
    console.warn('[weaponView] model looks mis-oriented; keeping the box version');
    return null;
  }

  pivot.scale.setScalar((MODEL_LENGTH[weaponId] ?? model.bounds.getSize(new THREE.Vector3()).z) / currentSize.z);
  pivot.updateMatrixWorld(true);

  const scaled = new THREE.Box3().setFromObject(pivot);
  const targetCentre = model.bounds.getCenter(new THREE.Vector3());
  pivot.position.sub(scaled.getCenter(new THREE.Vector3())).add(targetCentre);

  // Preserve authored colour separation but stop near-black OBJ materials from
  // losing all detail in the corner of the screen.
  pivot.traverse((node) => {
    if (!node.isMesh) return;
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (!material?.color) continue;
      const lightness = material.color.r + material.color.g + material.color.b;
      if (lightness < 0.55) material.color.lerp(new THREE.Color(0x61736a), 0.38);
      if ('emissive' in material) {
        material.emissive = material.color.clone().multiplyScalar(0.035);
        material.emissiveIntensity = 1;
      }
    }
  });

  return pivot;
}

function loadGunModels(models) {
  for (const id of Object.keys(models)) {
    const spec = modelSpecFor(id);
    const model = models[id];
    if (!spec || !model) continue;
    const { url, forward } = spec;

    loadModel(url).then((loaded) => {
      if (!loaded) return; // keep the boxes
      const fitted = fitGunModel(model, loaded, forward, id);
      if (!fitted) return;

      model.group.add(fitted);
      // Hidden rather than removed: poseReload still drives the magazine and
      // pump parts, and if anything above went wrong we can put them back.
      for (const box of model.boxes) box.visible = false;
      model.usingModel = true;
    });
  }
}

/** Second render pass, on top of the world, sharing the depth-cleared buffer. */
export function renderWeaponView(view, renderer) {
  renderer.autoClear = false;
  renderer.clearDepth();
  renderer.render(view.scene, view.camera);
  renderer.autoClear = true;
}

export function resizeWeaponView(view) {
  view.camera.aspect = window.innerWidth / window.innerHeight;
  view.camera.updateProjectionMatrix();
}

export function setViewWeapon(view, id) {
  if (view.currentId === id) return;
  if (view.currentId && view.models[view.currentId]) {
    view.models[view.currentId].group.visible = false;
  }
  view.currentId = id;
  const m = view.models[id];
  if (m) m.group.visible = true;
  // A switch reads as the new gun being raised into place.
  view.lowerAmount = 1;
}

export function weaponViewFire(view, now, weapon) {
  view.kickVel -= 3.4 * (weapon.recoil.up / 1.4);
  view.flashUntil = now + 38;
  const m = view.models[view.currentId];
  if (m && weapon.id !== 'knife') {
    m.flash.visible = true;
    m.flash.scale.setScalar(0.7 + Math.random() * 0.7);
    m.flash.rotation.z = Math.random() * Math.PI;
  }
}

const easeInOut = (t) => t * t * (3 - 2 * t);

/**
 * Pose the moving parts for a reload and return the offset to apply to the whole
 * gun. `progress` runs 0..1 across the weapon's reloadMs.
 *
 * Mag-fed weapons drop the magazine, bring a fresh one up and seat it. The
 * shotgun cycles its pump once per shell instead, and the sniper works its bolt
 * at the end. Parts always animate relative to their stored rest position, so an
 * interrupted reload can't leave a magazine hanging in mid-air.
 */
function poseReload(model, progress, weapon) {
  const moving = model.moving;
  for (const key in moving) {
    moving[key].mesh.position.copy(moving[key].rest);
    moving[key].mesh.rotation.set(0, 0, 0);
  }

  if (progress <= 0 || progress >= 1) return { drop: 0, roll: 0, yaw: 0 };

  // The gun dips and rolls over, so you're looking at the magazine well while
  // the hands work — and, usefully, so the reload physically gets out of the way
  // of the middle of the screen.
  const dip = Math.sin(Math.PI * progress);
  const pose = { drop: dip * 0.09, roll: dip * 0.44, yaw: dip * 0.2 };

  if (weapon.id === 'shotgun' && moving.pump) {
    const shells = Math.max(1, Math.min(8, weapon.mag));
    const cycle = (progress * shells) % 1;
    moving.pump.mesh.position.z = moving.pump.rest.z + Math.sin(cycle * Math.PI) * 0.11;
  } else if (moving.mag) {
    const mag = moving.mag;
    let dy = 0;
    let rot = 0;
    if (progress >= 0.2 && progress < 0.45) {
      const t = (progress - 0.2) / 0.25; // falls away
      dy = -easeInOut(t) * 0.3;
      rot = t * 0.55;
    } else if (progress >= 0.45 && progress < 0.72) {
      const t = (progress - 0.45) / 0.27; // fresh one comes up
      dy = -0.3 + easeInOut(t) * 0.3;
      rot = (1 - t) * 0.55;
    } else if (progress >= 0.72 && progress < 0.82) {
      const t = (progress - 0.72) / 0.1; // slap it home
      dy = -Math.sin(t * Math.PI) * 0.025;
    }
    mag.mesh.position.y = mag.rest.y + dy;
    mag.mesh.rotation.x = rot;
  }

  if (moving.bolt && progress > 0.8) {
    const t = (progress - 0.8) / 0.2;
    moving.bolt.mesh.position.z = moving.bolt.rest.z + Math.sin(t * Math.PI) * 0.09;
  }

  return pose;
}

export function updateWeaponView(view, dt, now, player, lookDelta) {
  const m = view.models[view.currentId];
  if (!m) return;
  const weapon = getWeapon(view.currentId);

  // ---- recoil kick: a spring back to rest ----
  view.kickVel += -view.kick * 220 * dt; // stiffness
  view.kickVel *= Math.max(0, 1 - 14 * dt); // damping
  view.kick += view.kickVel * dt;

  // ---- sway: the gun lags behind the camera when you turn ----
  view.swayTarget.set(
    THREE.MathUtils.clamp(-lookDelta.dx * 2.4, -0.06, 0.06),
    THREE.MathUtils.clamp(lookDelta.dy * 2.4, -0.05, 0.05),
  );
  view.sway.lerp(view.swayTarget, Math.min(1, 9 * dt));

  // ---- raise animation after a switch ----
  view.lowerAmount += (0 - view.lowerAmount) * Math.min(1, 7 * dt);

  // ---- reload ----
  const reloadMs = weapon.reloadMs || 1;
  const reloadProgress =
    player.reloadingUntil > now ? 1 - (player.reloadingUntil - now) / reloadMs : 0;
  const reload = poseReload(m, reloadProgress, weapon);

  // ---- position: hip vs aimed ----
  // Reloading pulls you out of the aimed pose, which is both how it looks in
  // every shooter and the reason the animation doesn't obscure your aim.
  const t = player.adsProgress * (1 - Math.min(1, reloadProgress * 2.2));
  const pos = HIP.clone().lerp(ADS, t);
  const hipOffset = WEAPON_HIP_OFFSET[view.currentId];
  if (hipOffset) {
    pos.x += hipOffset[0] * (1 - t);
    pos.y += hipOffset[1] * (1 - t);
    pos.z += hipOffset[2] * (1 - t);
  }
  pos.x += view.sway.x * (1 - t * 0.75);
  pos.y += view.sway.y * (1 - t * 0.75);
  pos.y -= reload.drop;

  // Scale the weapon around its own pivot. Scaling `view.root` also scales HIP
  // and ADS — the gun and its distance from the camera change together, leaving
  // its apparent size almost identical. That made VIEW_SCALE a misleading no-op
  // and is why several detailed models filled far more of the screen than their
  // fallback shapes suggested.
  const modelScale = WEAPON_VIEW_SCALE[view.currentId] ?? 1;
  m.group.scale.setScalar((VIEW_SCALE + (ADS_SCALE - VIEW_SCALE) * t) * modelScale);

  // Walking bob, damped hard when aiming.
  const speed = Math.hypot(player.vel[0], player.vel[2]);
  if (player.onGround && speed > 0.7) {
    const bob = (1 - t * 0.8) * Math.min(speed / 9, 1) * 0.014;
    pos.x += Math.sin(player.bobPhase) * bob;
    pos.y += Math.abs(Math.cos(player.bobPhase)) * -bob;
  }

  pos.z += view.kick * 0.05;
  pos.y += view.lowerAmount * -0.22;

  m.group.position.copy(pos);
  m.group.rotation.set(
    BASE_PITCH + view.kick * 0.09,
    (WEAPON_POSE_YAW[view.currentId] ?? BASE_YAW) * (1 - t) + reload.yaw,
    reload.roll,
  );

  // A scoped sniper hides the model entirely — you're looking down the optic, and
  // the scope overlay provides the reticle instead.
  const scoped = isScoped(view.currentId, player.adsProgress) && reloadProgress === 0;
  m.group.visible = !scoped && player.alive && !player.parachuting && player.vehicleId === null;

  if (now > view.flashUntil) m.flash.visible = false;
}

/** True when the view should switch to a scope overlay rather than a viewmodel. */
export function isScoped(weaponId, adsProgress) {
  return (weaponId === 'sniper' || weaponId === 'antimateriel') && adsProgress > 0.75;
}

/**
 * Muzzle position in *world* space, for spawning tracers from the barrel rather
 * than from the middle of your face.
 *
 * The viewmodel lives in its own scene whose camera sits at the origin, so a
 * position there is already camera-relative — pushing it through the world
 * camera's matrix lands it in the world.
 */
export function muzzleWorldPosition(view, worldCamera, out = new THREE.Vector3()) {
  const m = view.models[view.currentId];
  if (!m) return out.copy(worldCamera.position);
  out.copy(m.muzzle);
  m.group.updateWorldMatrix(true, false);
  m.group.localToWorld(out);
  worldCamera.updateMatrixWorld();
  return out.applyMatrix4(worldCamera.matrixWorld);
}

// ---------------------------------------------------------------------------
// Tracers
//
// A pool of thin stretched boxes. Pooled because a shotgun burst spawns eight
// at once and an SMG can spawn fifteen a second — allocating per shot would
// have the garbage collector stuttering the frame rate.
// ---------------------------------------------------------------------------

const TRACER_COUNT = 48;

export function createTracers(scene) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const pool = [];

  for (let i = 0; i < TRACER_COUNT; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
    pool.push({ mesh, mat, until: 0, life: 0 });
  }

  return { pool, next: 0 };
}

export function spawnTracer(tracers, from, to, color, now, thickness = 0.022) {
  const slot = tracers.pool[tracers.next];
  tracers.next = (tracers.next + 1) % tracers.pool.length;

  const a = new THREE.Vector3(from[0], from[1], from[2]);
  const b = new THREE.Vector3(to[0], to[1], to[2]);
  const dist = a.distanceTo(b);
  if (dist < 0.05) return;

  slot.mesh.position.copy(a).add(b).multiplyScalar(0.5);
  slot.mesh.scale.set(thickness, thickness, dist);
  slot.mesh.lookAt(b);
  slot.mat.color.setHex(color);
  slot.mat.opacity = 0.85;
  slot.life = 0.07;
  slot.until = now + slot.life * 1000;
  slot.mesh.visible = true;
}

export function updateTracers(tracers, now) {
  for (const slot of tracers.pool) {
    if (!slot.mesh.visible) continue;
    const remaining = (slot.until - now) / 1000;
    if (remaining <= 0) {
      slot.mesh.visible = false;
      slot.mat.opacity = 0;
      continue;
    }
    slot.mat.opacity = 0.85 * (remaining / slot.life);
  }
}

// ---------------------------------------------------------------------------
// Impacts
// ---------------------------------------------------------------------------

const IMPACT_COUNT = 32;

export function createImpacts(scene) {
  const geo = new THREE.SphereGeometry(0.045, 6, 4);
  const pool = [];
  for (let i = 0; i < IMPACT_COUNT; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    scene.add(mesh);
    pool.push({ mesh, mat, until: 0, baseScale: 1 });
  }
  return { pool, next: 0 };
}

const IMPACT_MS = 150;

export function spawnImpact(impacts, point, now, color = 0xffd9a0, isFlesh = false) {
  const slot = impacts.pool[impacts.next];
  impacts.next = (impacts.next + 1) % impacts.pool.length;

  slot.mesh.position.set(point[0], point[1], point[2]);
  // Base scale is stored rather than inferred from the mesh: reading the live
  // scale back to decide the multiplier makes the growth compound every frame,
  // and the puff swells to cover the whole screen within a second.
  slot.baseScale = isFlesh ? 1.5 : 1;
  slot.mesh.scale.setScalar(slot.baseScale);
  slot.mat.color.setHex(isFlesh ? 0xc0392b : color);
  slot.mat.opacity = 0.9;
  slot.until = now + IMPACT_MS;
  slot.mesh.visible = true;
}

// ---------------------------------------------------------------------------
// Explosions
//
// A fireball plus a light flash. Pooled like everything else, because a chain of
// barrels going off produces several at once.
// ---------------------------------------------------------------------------

const EXPLOSION_COUNT = 6;
const EXPLOSION_MS = 620;

export function createExplosions(scene) {
  const geo = new THREE.SphereGeometry(1, 14, 10);
  const pool = [];
  for (let i = 0; i < EXPLOSION_COUNT; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffa23c,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    scene.add(mesh);

    // A real light makes the blast wash over the surrounding geometry, which is
    // most of what sells it.
    const light = new THREE.PointLight(0xffa040, 0, 16, 2);
    light.visible = false;
    scene.add(light);

    pool.push({ mesh, mat, light, until: 0, radius: 1 });
  }
  return { pool, next: 0 };
}

export function spawnExplosion(explosions, at, radius, now) {
  const slot = explosions.pool[explosions.next];
  explosions.next = (explosions.next + 1) % explosions.pool.length;

  slot.radius = radius;
  slot.mesh.position.set(at[0], at[1], at[2]);
  slot.mesh.scale.setScalar(radius * 0.2);
  slot.mat.opacity = 0.95;
  slot.mat.color.setHex(0xfff0b0);
  slot.mesh.visible = true;

  slot.light.position.set(at[0], at[1] + 0.4, at[2]);
  slot.light.distance = radius * 3;
  slot.light.intensity = 26;
  slot.light.visible = true;

  slot.until = now + EXPLOSION_MS;
}

export function updateExplosions(explosions, now) {
  for (const slot of explosions.pool) {
    if (!slot.mesh.visible) continue;
    const remaining = slot.until - now;
    if (remaining <= 0) {
      slot.mesh.visible = false;
      slot.light.visible = false;
      slot.light.intensity = 0;
      continue;
    }
    // t runs 0 -> 1 over the life of the blast.
    const t = 1 - remaining / EXPLOSION_MS;
    // Expands fast then holds, and cools from white through orange to red.
    slot.mesh.scale.setScalar(slot.radius * (0.2 + Math.sqrt(t) * 0.95));
    slot.mat.opacity = 0.95 * (1 - t) ** 1.6;
    slot.mat.color.setRGB(1, Math.max(0.15, 0.94 - t * 1.1), Math.max(0.05, 0.69 - t * 1.5));
    slot.light.intensity = 26 * (1 - t) ** 2;
  }
}

export function updateImpacts(impacts, now) {
  for (const slot of impacts.pool) {
    if (!slot.mesh.visible) continue;
    const remaining = slot.until - now;
    if (remaining <= 0) {
      slot.mesh.visible = false;
      continue;
    }
    const t = remaining / IMPACT_MS;
    slot.mat.opacity = 0.9 * t;
    slot.mesh.scale.setScalar(slot.baseScale * (1 + (1 - t) * 2.2));
  }
}
