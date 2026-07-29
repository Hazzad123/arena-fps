// Health pickups.
//
// Drawn as a floating white cross on a green pad — no model needed, and a green
// cross is about as unambiguous as game iconography gets. It bobs and spins,
// because a stationary object on the floor of a busy map is invisible.
//
// In a match this is purely presentational: the server decides who heals and when
// (see tickPickups in room.js). The practice range has no server at all, though, so
// there it collects them locally — otherwise the two packs on the range spin
// prettily and can never be picked up, which is worse than not having them, because
// you can absolutely hurt yourself on the movement course.

import * as THREE from 'three';
import {
  HEALTH_PACK_RADIUS, HEALTH_PACK_HEAL, HEALTH_PACK_RESPAWN_MS, MAX_HEALTH,
  PLAYER_HEIGHT, PLAYER_RADIUS,
} from '@shared/constants.js';

const GREEN = 0x3fbf5f;
const PAD = 0x1d6b32;

export function createPickups(scene) {
  return { scene, entities: new Map(), map: null };
}

/** Rebuild for a map. Called on load and on rotation. */
export function loadPickups(pickups, map) {
  clearPickups(pickups);
  pickups.map = map;

  for (const pack of map.healthPacks ?? []) {
    const group = new THREE.Group();
    group.position.set(pack.pos[0], pack.pos[1], pack.pos[2]);

    // A dim disc on the floor, so you can see where it *was* while it's gone.
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(HEALTH_PACK_RADIUS, HEALTH_PACK_RADIUS, 0.06, 18),
      new THREE.MeshLambertMaterial({ color: PAD, transparent: true, opacity: 0.55 }),
    );
    pad.position.y = 0.04;
    group.add(pad);

    // The cross itself, on its own pivot so it can bob and spin independently.
    const spinner = new THREE.Group();
    spinner.position.y = 0.75;
    const mat = new THREE.MeshLambertMaterial({ color: GREEN, emissive: GREEN, emissiveIntensity: 0.5 });
    const bar = (w, h, d) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    spinner.add(bar(0.52, 0.17, 0.17));
    spinner.add(bar(0.17, 0.52, 0.17));
    group.add(spinner);

    pickups.scene.add(group);
    pickups.entities.set(pack.index, {
      group, spinner, pad, taken: false, retakeAt: 0, basePos: [...pack.pos],
    });
  }
}

export function setPickupTaken(pickups, index, taken) {
  const e = pickups.entities.get(index);
  if (!e) return;
  e.taken = taken;
  e.spinner.visible = !taken;
  e.pad.material.opacity = taken ? 0.18 : 0.55;
}

/** Apply a full "these are currently gone" list, for a joining client. */
export function syncPickups(pickups, takenIndices) {
  const taken = new Set(takenIndices ?? []);
  for (const index of pickups.entities.keys()) setPickupTaken(pickups, index, taken.has(index));
}

export function updatePickups(pickups, now) {
  const t = now / 1000;
  for (const e of pickups.entities.values()) {
    if (e.taken) continue;
    e.spinner.rotation.y = t * 1.6;
    e.spinner.position.y = 0.75 + Math.sin(t * 2.2) * 0.12;
  }
}

/**
 * Collect packs client-side. Practice range only — in a match the server owns this
 * and a client that healed itself would simply be wrong.
 *
 * Returns the amount healed, so the caller can play the sound and update the HUD.
 */
export function collectLocally(pickups, player, now) {
  if (player.health >= MAX_HEALTH || !player.alive) return 0;

  for (const [index, e] of pickups.entities) {
    if (e.taken) {
      if (e.retakeAt && now >= e.retakeAt) {
        e.retakeAt = 0;
        setPickupTaken(pickups, index, false);
      }
      continue;
    }
    const d = Math.hypot(
      player.pos[0] - e.basePos[0],
      (player.pos[1] + PLAYER_HEIGHT * 0.4) - e.basePos[1],
      player.pos[2] - e.basePos[2],
    );
    if (d > HEALTH_PACK_RADIUS + PLAYER_RADIUS) continue;

    const healed = Math.min(HEALTH_PACK_HEAL, MAX_HEALTH - player.health);
    player.health += healed;
    setPickupTaken(pickups, index, true);
    e.retakeAt = now + HEALTH_PACK_RESPAWN_MS;
    return healed;
  }
  return 0;
}

export function clearPickups(pickups) {
  for (const e of pickups.entities.values()) {
    pickups.scene.remove(e.group);
    e.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
  }
  pickups.entities.clear();
}
