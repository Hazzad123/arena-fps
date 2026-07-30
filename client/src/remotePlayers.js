// Other players: blocky figures assembled from boxes, plus floating name tags.
//
// Readability beats realism here. At a glance you need to know three things —
// where someone is, which way they're facing, and whether they're on your team.
// So: strong team colour on the torso, a clearly offset head, and a weapon block
// that sticks out in the direction they're looking.

import * as THREE from 'three';
import {
  PLAYER_HEIGHT, PLAYER_CROUCH_HEIGHT, TEAM_COLORS, FFA_COLOR,
  HITBOX_RADIUS, HITBOX_HEAD_PAD,
} from '@shared/constants.js';
import { EMOTES, FLAG, hasFlag } from '@shared/protocol.js';
import { getWeapon } from '@shared/weapons.js';
import { hasLineOfSight } from '@shared/collision.js';
import { loadModel, instantiate } from './models.js';

const SKIN = 0xc8a583;

// Animation is throttled by distance, not culled by it.
//
// Thirty players each carry a skinned clone with its own AnimationMixer, and
// updating all of them every frame is real CPU work — bone matrices for ~30 bones
// apiece — for bodies that are a few pixels tall. But they must stay *visible*: the
// island has 260m sightlines and the Anti-Materiel reaches 260m, so a body that
// vanishes at 90m would make long-range shooting impossible. Freezing the walk
// cycle of someone 120m away is imperceptible; deleting them is not.
const ANIM_NEAR = 40; // every frame
const ANIM_MID = 100; // every 3rd frame
const ANIM_FAR_EVERY = 10; // beyond that, every 10th

const CHARACTER_URL = 'models/characters/Character_Soldier.gltf';
const EMOTE_DURATION_MS = 1_750;

// The material the kit leaves for team colour. Everything else — skin, boots,
// webbing — stays as authored, so a blue and a red soldier still read as the same
// soldier rather than two different men.
const TEAM_MATERIAL = 'Character_Main';

// The character carries every gun in the kit as a child mesh, so "equip" is just
// deciding which one to show. Weapons with no counterpart borrow the nearest
// thing rather than leaving empty hands.
// Third-person guns are limited to the meshes baked inside the character glTF —
// they're parented to its hand bone, so they can only be things the rig already
// carries. There are seventeen weapons and eight of these, so anything without an
// exact match falls back to the nearest thing of its own type. A Bullpup shows as
// an AK in third person; from ten metres away, across a firefight, nobody is
// auditing the receiver.
const HELD_MESH = {
  rifle: 'AK',
  smg: 'SMG',
  pistol: 'Pistol',
  shotgun: 'Shotgun',
  sniper: 'Sniper',
  dmr: 'Sniper_2',
  lmg: 'ShortCannon',
  knife: 'Knife_1',
};
const HELD_BY_TYPE = {
  rifle: 'AK',
  smg: 'SMG',
  pistol: 'Pistol',
  shotgun: 'Shotgun',
  sniper: 'Sniper',
  lmg: 'ShortCannon',
  melee: 'Knife_1',
};

function heldMeshFor(weaponId) {
  if (HELD_MESH[weaponId]) return HELD_MESH[weaponId];
  const type = getWeapon(weaponId)?.type;
  return HELD_BY_TYPE[type] ?? 'AK';
}

const ALL_HELD = [...new Set([...Object.values(HELD_MESH), ...Object.values(HELD_BY_TYPE)])];

/**
 * Which clip suits a given state. The kit's 17 clips happen to line up almost
 * exactly with the flags already in the snapshot, which is why this is a lookup
 * and not an animation system.
 */
function clipFor({ dead, airborne, crouched, moving, sprinting, firing }) {
  if (dead) return 'Death';
  if (airborne) return 'Jump_Idle';
  if (crouched) return 'Duck';
  if (moving) {
    if (sprinting) return firing ? 'Run_Shoot' : 'Run';
    return firing ? 'Walk_Shoot' : 'Walk';
  }
  return firing ? 'Idle_Shoot' : 'Idle';
}

export function createRemotePlayers(scene) {
  // Loaded once and cloned per player. Fire-and-forget: until it arrives (or if
  // it never does) everyone is a box figure, which is playable, just plainer.
  const character = { model: null };
  loadModel(CHARACTER_URL).then((loaded) => {
    character.model = loaded;
  });
  return {
    scene,
    entities: new Map(),
    emotes: new Map(),
    labelLayer: createLabelLayer(),
    character,
  };
}

/** Queue a cosmetic animation even if the player's model has not appeared yet. */
export function playRemoteEmote(rp, id, emote, now = performance.now()) {
  if (!id || !Object.hasOwn(EMOTES, emote)) return false;
  rp.emotes.set(id, {
    clip: EMOTES[emote],
    name: emote,
    startedAt: now,
    until: now + EMOTE_DURATION_MS,
  });
  return true;
}

function createLabelLayer() {
  const el = document.createElement('div');
  el.id = 'nametags';
  Object.assign(el.style, {
    position: 'fixed',
    inset: '0',
    pointerEvents: 'none',
    zIndex: '9',
    overflow: 'hidden',
  });
  document.body.appendChild(el);
  return el;
}

function buildFigure(color) {
  const group = new THREE.Group();
  const mat = (c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });

  const teamMat = mat(color);
  const darkMat = mat(new THREE.Color(color).multiplyScalar(0.55));
  const skinMat = mat(SKIN);

  const add = (m, w, h, d, x, y, z) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  };

  // Built from the feet up, so y is height off the ground.
  const legL = add(darkMat, 0.22, 0.8, 0.24, -0.13, 0.4, 0);
  const legR = add(darkMat, 0.22, 0.8, 0.24, 0.13, 0.4, 0);
  add(teamMat, 0.56, 0.66, 0.34, 0, 1.13, 0); // torso
  add(teamMat, 0.16, 0.5, 0.18, -0.35, 1.2, 0); // left arm
  const armR = add(teamMat, 0.16, 0.5, 0.18, 0.35, 1.2, 0);
  const head = add(skinMat, 0.3, 0.3, 0.3, 0, 1.63, 0);
  // A visor block on the front of the head — the cheapest possible facing cue.
  add(mat(0x22262c), 0.32, 0.1, 0.06, 0, 1.65, -0.16);

  // Held weapon, parented so it swings with the aim pitch.
  const armPivot = new THREE.Group();
  armPivot.position.set(0.3, 1.35, 0);
  const weapon = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.14, 0.62), mat(0x3a3f45));
  weapon.position.set(0, -0.05, -0.32);
  weapon.castShadow = true;
  armPivot.add(weapon);
  group.add(armPivot);

  const boxMeshes = [...group.children];
  const parachute = buildParachute(color);
  group.add(parachute);

  return {
    group,
    armPivot,
    armR,
    head,
    weapon,
    legL,
    legR,
    mats: [teamMat, darkMat, skinMat],
    // Kept so the character model can hide them without disturbing the group.
    boxMeshes,
    parachute,
  };
}

function buildParachute(color) {
  const rig = new THREE.Group();
  rig.visible = false;

  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(2.15, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshLambertMaterial({
      color: new THREE.Color(color).lerp(new THREE.Color(0xf2d88a), 0.55),
      side: THREE.DoubleSide,
      flatShading: true,
    }),
  );
  canopy.position.y = 4.15;
  canopy.scale.z = 0.72;
  canopy.castShadow = true;
  rig.add(canopy);

  const cordMat = new THREE.LineBasicMaterial({ color: 0xd8d2bd });
  for (const [x, z] of [[-1.65, -0.7], [1.65, -0.7], [-1.65, 0.7], [1.65, 0.7]]) {
    const cord = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x, 4.05, z),
        new THREE.Vector3(x * 0.12, 1.3, z * 0.12),
      ]),
      cordMat,
    );
    rig.add(cord);
  }
  return rig;
}

/**
 * Swap an entity's box figure for the real character, once the model is here.
 *
 * The boxes are hidden rather than removed: this is decoration over a working
 * game, and nothing about hitboxes, collision or the network changes — those come
 * from the snapshot, not from whatever is drawn at that position.
 */
function attachCharacter(entity, loaded, color) {
  const root = instantiate(loaded);

  // Authored a shade over 1.8m; make it exactly the player's height so feet meet
  // the floor the physics uses.
  const box = new THREE.Box3().setFromObject(root);
  const height = box.max.y - box.min.y;
  if (height > 0) root.scale.setScalar(PLAYER_HEIGHT / height);

  // The kit authors its characters facing +Z. This game's forward at yaw 0 is -Z
  // (see aimDirection in localPlayer.js), so without this half turn every remote
  // player renders facing exactly away from where they are aiming and walking —
  // you see their back as they run at you.
  //
  // Corrected here on the model root rather than by changing the yaw applied to
  // entity.group, because that yaw is also what orients the fallback box figure,
  // the weapon pivot and the name-tag occlusion ray.
  root.rotation.y = Math.PI;

  const held = new Map();
  const teamMats = [];

  // The guns are *nodes*, and a node whose mesh has several materials arrives as
  // a Group of meshes named after the Blender primitives inside it (Cube004 and
  // friends). So the name has to be matched on every object, not just meshes —
  // matching meshes alone finds nothing, and a character then holds all sixteen
  // guns at once.
  root.traverse((node) => {
    if (ALL_HELD.includes(node.name)) {
      held.set(node.name, node);
      node.visible = false;
      return;
    }
    if (!node.isMesh && !node.isSkinnedMesh) return;
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    for (const m of mats) if (m.name === TEAM_MATERIAL) teamMats.push(m);
  });

  const mixer = new THREE.AnimationMixer(root);
  const clips = new Map();
  for (const clip of loaded.animations) clips.set(clip.name, clip);

  entity.group.add(root);
  for (const mesh of entity.boxMeshes) mesh.visible = false;

  entity.character = { root, mixer, clips, held, teamMats, action: null, clipName: null };
  setCharacterColor(entity, color);
  return entity.character;
}

function setCharacterColor(entity, color) {
  for (const m of entity.character.teamMats) m.color.setHex(color);
}

/** Crossfade to a clip, or do nothing if it's already the one playing. */
function playClip(character, name, { loop = true } = {}) {
  if (character.clipName === name) return;
  const clip = character.clips.get(name);
  if (!clip) return;

  const next = character.mixer.clipAction(clip);
  next.reset();
  next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  next.clampWhenFinished = !loop;
  next.fadeIn(0.15).play();

  if (character.action) character.action.fadeOut(0.15);
  character.action = next;
  character.clipName = name;
}

function showHeldWeapon(character, weaponId) {
  const wanted = weaponId ? heldMeshFor(weaponId) : null;
  if (character.heldName === wanted) return;
  character.heldName = wanted;
  for (const [name, mesh] of character.held) mesh.visible = name === wanted;
}

function makeLabel(layer, name) {
  const el = document.createElement('div');
  el.textContent = name;
  Object.assign(el.style, {
    position: 'absolute',
    transform: 'translate(-50%, -100%)',
    font: '600 12px Inter, system-ui, sans-serif',
    color: '#fff',
    textShadow: '0 1px 3px rgba(0,0,0,0.9)',
    whiteSpace: 'nowrap',
    padding: '1px 5px',
    borderRadius: '4px',
    background: 'rgba(10,12,16,0.45)',
    display: 'none',
  });
  layer.appendChild(el);
  return el;
}

function colorFor(mode, myTeam, theirTeam) {
  if (mode !== 'tdm' || !theirTeam) return FFA_COLOR;
  return theirTeam === myTeam ? TEAM_COLORS.A : TEAM_COLORS.B;
}

/**
 * Reconcile the scene with a sampled world state.
 *
 * `states` is the Map from net.sampleWorld(). Entities are created and destroyed
 * to match, so players joining and leaving mid-round is handled here.
 */
export function syncRemotePlayers(rp, states, { myId, mode, myTeam, roster, camera, solids, dt = 0 }) {
  const seen = new Set();
  const now = performance.now();
  for (const [id, emote] of rp.emotes) {
    if (emote.until <= now) rp.emotes.delete(id);
  }

  for (const [id, state] of states) {
    if (id === myId) continue;
    seen.add(id);

    const info = roster.get(id);
    let entity = rp.entities.get(id);

    if (!entity) {
      const figure = buildFigure(colorFor(mode, myTeam, info?.team));
      rp.scene.add(figure.group);
      entity = {
        ...figure,
        animTick: 0,
        label: makeLabel(rp.labelLayer, info?.name ?? '…'),
        team: info?.team ?? null,
        stridePhase: 0,
        lastPos: [...state.pos],
        character: null,
      };
      rp.entities.set(id, entity);
    }

    // The model may finish loading long after the first players appear, so this
    // is checked here rather than only at creation.
    if (!entity.character && rp.character.model) {
      attachCharacter(entity, rp.character.model, colorFor(mode, myTeam, info?.team));
    }

    // Team can change when the server rebalances.
    if (info && info.team !== entity.team) {
      entity.team = info.team;
      const c = colorFor(mode, myTeam, info.team);
      entity.mats[0].color.setHex(c);
      entity.mats[1].color.setHex(c).multiplyScalar(0.55);
      if (entity.character) setCharacterColor(entity, c);
    }
    if (info && entity.label.textContent !== info.name) entity.label.textContent = info.name;

    const emote = rp.emotes.get(id) ?? null;

    // ---- death ----
    // The body stays and plays the rig's Death clip rather than blinking out of
    // existence. Previously the group was hidden the instant the DEAD flag
    // arrived, so the clip — which the kit provides and clipFor already asks
    // for — was never seen once.
    const dead = hasFlag(state.flags, FLAG.DEAD);
    if (dead) {
      entity.parachute.visible = false;
      rp.emotes.delete(id);
      entity.label.style.display = 'none';
      entity.group.visible = true;
      // Freeze where they fell. The server stops updating a dead player's
      // position, so this is their last living pose.
      entity.group.position.set(state.pos[0], state.pos[1], state.pos[2]);

      if (entity.character) {
        entity.group.scale.y = 1;
        // LoopOnce and clamped, so it settles on the floor instead of looping.
        playClip(entity.character, 'Death', { loop: false });
        advanceAnimation(entity, camera, dt);
      } else {
        // Box figure has no clips, so tip it over instead.
        entity.group.rotation.x = Math.min(entity.group.rotation.x + dt * 4.5, Math.PI / 2);
      }
      continue;
    }

    // Back on their feet: undo anything the death pose changed.
    entity.group.rotation.x = 0;
    const parachuting = hasFlag(state.flags, FLAG.PARACHUTE);
    const driving = hasFlag(state.flags, FLAG.VEHICLE);
    entity.parachute.visible = parachuting;

    // ---- pose ----
    entity.group.position.set(state.pos[0], state.pos[1], state.pos[2]);
    entity.group.rotation.y = state.yaw;
    entity.armPivot.rotation.x = -state.pitch;

    // ---- how far they actually moved, which drives both animation paths ----
    const dx = state.pos[0] - entity.lastPos[0];
    const dz = state.pos[2] - entity.lastPos[2];
    const moved = Math.hypot(dx, dz);
    entity.lastPos[0] = state.pos[0];
    entity.lastPos[1] = state.pos[1];
    entity.lastPos[2] = state.pos[2];

    const crouched = hasFlag(state.flags, FLAG.CROUCH) || driving;

    if (entity.character) {
      // The rig has a Duck clip, so squashing the whole figure — which is what the
      // box version has to do — would be crouching twice.
      entity.group.scale.y = 1;
      showHeldWeapon(entity.character, emote || parachuting || driving ? null : state.weapon);
      if (emote) {
        playClip(entity.character, emote.clip, { loop: false });
      } else {
        playClip(entity.character, clipFor({
          dead: false,
          airborne: hasFlag(state.flags, FLAG.AIRBORNE),
          crouched,
          // Snapshots arrive at 20Hz and are interpolated, so a threshold on
          // distance moved is steadier than trusting a velocity we don't have.
          moving: moved > 0.004,
          sprinting: hasFlag(state.flags, FLAG.SPRINT),
          firing: hasFlag(state.flags, FLAG.FIRING),
        }));
      }
      advanceAnimation(entity, camera, dt);
    } else {
      const scaleY = driving ? 0.62 : crouched ? PLAYER_CROUCH_HEIGHT / PLAYER_HEIGHT : 1;
      entity.group.scale.y += (scaleY - entity.group.scale.y) * 0.3;

      // ---- leg swing, driven by how far they actually moved ----
      entity.stridePhase += moved * 3.2;
      const swing = moved > 0.001 ? Math.sin(entity.stridePhase) * 0.5 : 0;
      entity.legL.rotation.x = swing;
      entity.legR.rotation.x = -swing;
      applyFallbackEmote(entity, emote, now);
      if (parachuting || driving) entity.weapon.visible = false;
    }

    // ---- weapon model roughly matches what they're holding ----
    // Box figure only; the character shows the real gun from its own hand.
    if (!entity.character && state.weapon && entity.weaponId !== state.weapon) {
      entity.weaponId = state.weapon;
      const w = getWeapon(state.weapon);
      const len = state.weapon === 'knife' ? 0.3 : state.weapon === 'pistol' ? 0.32 : 0.62;
      entity.weapon.scale.z = len / 0.62;
      entity.weapon.position.z = -len / 2;
      entity.weapon.material.color.setHex(w.viewColor).multiplyScalar(1.4);
    }

    positionLabel(entity, camera, crouched, solids);
  }

  // Remove anyone no longer present.
  for (const [id, entity] of rp.entities) {
    if (seen.has(id)) continue;
    destroyEntity(rp, entity);
    rp.entities.delete(id);
    rp.emotes.delete(id);
  }
}

function applyFallbackEmote(entity, emote, now) {
  entity.armR.rotation.z = 0;
  entity.head.rotation.x = 0;
  entity.head.rotation.y = 0;
  entity.weapon.visible = !emote;
  if (!emote) return;

  const elapsed = (now - emote.startedAt) / 1000;
  if (emote.name === 'wave') {
    entity.armR.rotation.z = 2.15 + Math.sin(elapsed * 10) * 0.28;
  } else if (emote.name === 'yes') {
    entity.head.rotation.x = Math.sin(elapsed * 13) * 0.28;
  } else if (emote.name === 'no') {
    entity.head.rotation.y = Math.sin(elapsed * 13) * 0.42;
  }
}

/**
 * Step a character's animation, less often the further away it is. `dt` is
 * accumulated rather than dropped, so a throttled clip still runs at the right
 * speed — it just updates in coarser steps.
 */
function advanceAnimation(entity, camera, dt) {
  const character = entity.character;
  if (!character) return;

  entity.animDebt = (entity.animDebt ?? 0) + dt;

  const d = entity.group.position.distanceTo(camera.position);
  let every = 1;
  if (d > ANIM_MID) every = ANIM_FAR_EVERY;
  else if (d > ANIM_NEAR) every = 3;

  entity.animTick = (entity.animTick + 1) % every;
  if (entity.animTick !== 0) return;

  character.mixer.update(entity.animDebt);
  entity.animDebt = 0;
}

const tmpVec = new THREE.Vector3();
const rayFrom = [0, 0, 0];
const rayTo = [0, 0, 0];

// Where on the body to test for visibility, as a fraction of its height. The tag
// floats above the head, and testing only that one point makes it blink off
// whenever the anchor clips a doorframe the player is plainly standing in.
const SIGHT_SAMPLES = [0.92, 0.55, 0.2];

/**
 * Can we actually see this player?
 *
 * The figures are real meshes and depth-test themselves, but a name tag is a DOM
 * element drawn over the entire scene — so without this check every tag reads
 * straight through walls, which is a free wallhack. Friendly tags are occluded
 * too: friendly fire is off, so knowing exactly where a teammate is standing
 * behind a wall is information nobody needs.
 */
function canSee(camera, base, bodyHeight, solids) {
  rayFrom[0] = camera.position.x;
  rayFrom[1] = camera.position.y;
  rayFrom[2] = camera.position.z;

  for (const fraction of SIGHT_SAMPLES) {
    rayTo[0] = base.x;
    rayTo[1] = base.y + bodyHeight * fraction;
    rayTo[2] = base.z;
    if (hasLineOfSight(rayFrom, rayTo, solids)) return true;
  }
  return false;
}

function positionLabel(entity, camera, crouched, solids) {
  const bodyHeight = crouched ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;
  const base = entity.group.position;

  tmpVec.set(base.x, base.y + bodyHeight + 0.3, base.z);
  const distance = tmpVec.distanceTo(camera.position);
  tmpVec.project(camera);

  // Behind the camera, or far enough away that the tag is just clutter.
  if (tmpVec.z > 1 || distance > 70) {
    entity.label.style.display = 'none';
    return;
  }

  if (solids && !canSee(camera, base, bodyHeight, solids)) {
    entity.label.style.display = 'none';
    return;
  }

  entity.label.style.display = 'block';
  entity.label.style.left = `${((tmpVec.x + 1) / 2) * window.innerWidth}px`;
  entity.label.style.top = `${((1 - tmpVec.y) / 2) * window.innerHeight}px`;
  entity.label.style.opacity = String(Math.max(0.25, 1 - distance / 70));
}

function destroyEntity(rp, entity) {
  rp.scene.remove(entity.group);

  if (entity.character) {
    entity.character.mixer.stopAllAction();
    entity.character.mixer.uncacheRoot(entity.character.root);
  }

  entity.group.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    // Geometry is shared with the cached template on cloned characters, so only
    // the materials — which instantiate() copied per player — are ours to free.
    if (!entity.character || !entity.character.root.getObjectById(o.id)) o.geometry.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) m?.dispose();
  });

  for (const m of entity.mats) m.dispose();
  entity.label.remove();
}

export function clearRemotePlayers(rp) {
  for (const [, entity] of rp.entities) destroyEntity(rp, entity);
  rp.entities.clear();
  rp.emotes.clear();
}

/** Collision targets for our own shooting, built from the interpolated states. */
export function hitboxesFrom(states, myId) {
  const out = [];
  for (const [id, state] of states) {
    if (id === myId) continue;
    if (hasFlag(state.flags, FLAG.DEAD)) continue;
    const standing = hasFlag(state.flags, FLAG.CROUCH) ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;
    out.push({
      id,
      pos: state.pos,
      // Slightly taller and wider than the body actually is — see HITBOX_* in
      // constants.js for why being generous here is the right call.
      height: standing + HITBOX_HEAD_PAD,
      radius: HITBOX_RADIUS,
    });
  }
  return out;
}
