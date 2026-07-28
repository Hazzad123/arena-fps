// Other players: blocky figures assembled from boxes, plus floating name tags.
//
// Readability beats realism here. At a glance you need to know three things —
// where someone is, which way they're facing, and whether they're on your team.
// So: strong team colour on the torso, a clearly offset head, and a weapon block
// that sticks out in the direction they're looking.

import * as THREE from 'three';
import { PLAYER_HEIGHT, PLAYER_CROUCH_HEIGHT, TEAM_COLORS, FFA_COLOR } from '@shared/constants.js';
import { FLAG, hasFlag } from '@shared/protocol.js';
import { getWeapon } from '@shared/weapons.js';

const SKIN = 0xc8a583;

export function createRemotePlayers(scene) {
  return { scene, entities: new Map(), labelLayer: createLabelLayer() };
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
  add(skinMat, 0.3, 0.3, 0.3, 0, 1.63, 0); // head
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

  return { group, armPivot, weapon, legL, legR, mats: [teamMat, darkMat, skinMat] };
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
export function syncRemotePlayers(rp, states, { myId, mode, myTeam, roster, camera }) {
  const seen = new Set();

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
        label: makeLabel(rp.labelLayer, info?.name ?? '…'),
        team: info?.team ?? null,
        stridePhase: 0,
        lastPos: [...state.pos],
      };
      rp.entities.set(id, entity);
    }

    // Team can change when the server rebalances.
    if (info && info.team !== entity.team) {
      entity.team = info.team;
      const c = colorFor(mode, myTeam, info.team);
      entity.mats[0].color.setHex(c);
      entity.mats[1].color.setHex(c).multiplyScalar(0.55);
    }
    if (info && entity.label.textContent !== info.name) entity.label.textContent = info.name;

    const dead = hasFlag(state.flags, FLAG.DEAD);
    entity.group.visible = !dead;
    entity.label.style.display = dead ? 'none' : 'block';
    if (dead) continue;

    // ---- pose ----
    entity.group.position.set(state.pos[0], state.pos[1], state.pos[2]);
    entity.group.rotation.y = state.yaw;
    entity.armPivot.rotation.x = -state.pitch;

    const crouched = hasFlag(state.flags, FLAG.CROUCH);
    const scaleY = crouched ? PLAYER_CROUCH_HEIGHT / PLAYER_HEIGHT : 1;
    entity.group.scale.y += (scaleY - entity.group.scale.y) * 0.3;

    // ---- leg swing, driven by how far they actually moved ----
    const dx = state.pos[0] - entity.lastPos[0];
    const dz = state.pos[2] - entity.lastPos[2];
    const moved = Math.hypot(dx, dz);
    entity.lastPos[0] = state.pos[0];
    entity.lastPos[1] = state.pos[1];
    entity.lastPos[2] = state.pos[2];

    entity.stridePhase += moved * 3.2;
    const swing = moved > 0.001 ? Math.sin(entity.stridePhase) * 0.5 : 0;
    entity.legL.rotation.x = swing;
    entity.legR.rotation.x = -swing;

    // ---- weapon model roughly matches what they're holding ----
    if (state.weapon && entity.weaponId !== state.weapon) {
      entity.weaponId = state.weapon;
      const w = getWeapon(state.weapon);
      const len = state.weapon === 'knife' ? 0.3 : state.weapon === 'pistol' ? 0.32 : 0.62;
      entity.weapon.scale.z = len / 0.62;
      entity.weapon.position.z = -len / 2;
      entity.weapon.material.color.setHex(w.viewColor).multiplyScalar(1.4);
    }

    positionLabel(entity, camera, crouched);
  }

  // Remove anyone no longer present.
  for (const [id, entity] of rp.entities) {
    if (seen.has(id)) continue;
    destroyEntity(rp, entity);
    rp.entities.delete(id);
  }
}

const tmpVec = new THREE.Vector3();

function positionLabel(entity, camera, crouched) {
  const height = (crouched ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT) + 0.3;
  tmpVec.set(entity.group.position.x, entity.group.position.y + height, entity.group.position.z);

  const distance = tmpVec.distanceTo(camera.position);
  tmpVec.project(camera);

  // Behind the camera, or far enough away that the tag is just clutter.
  if (tmpVec.z > 1 || distance > 70) {
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
  entity.group.traverse((o) => {
    if (o.isMesh) o.geometry.dispose();
  });
  for (const m of entity.mats) m.dispose();
  entity.weapon.material.dispose();
  entity.label.remove();
}

export function clearRemotePlayers(rp) {
  for (const [, entity] of rp.entities) destroyEntity(rp, entity);
  rp.entities.clear();
}

/** Collision targets for our own shooting, built from the interpolated states. */
export function hitboxesFrom(states, myId) {
  const out = [];
  for (const [id, state] of states) {
    if (id === myId) continue;
    if (hasFlag(state.flags, FLAG.DEAD)) continue;
    out.push({
      id,
      pos: state.pos,
      height: hasFlag(state.flags, FLAG.CROUCH) ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT,
      radius: 0.4,
    });
  }
  return out;
}
