// Battle royale client: the zone wall and the ground loot.
//
// Both are drawn from what the server says. The zone is one open-ended cylinder —
// a single translucent mesh, so an object 90m across costs one draw call — and the
// loot is a small pool of floating guns.

import * as THREE from 'three';
import { getWeapon } from '@shared/weapons.js';

const TIER_COLOR = { common: 0xbfc6cf, rare: 0x4a9ad9, epic: 0xb060d9 };

export function createBattleRoyale(scene) {
  // Open-ended so you can see through the far side, double-sided so it reads from
  // inside and out, and depthWrite off so it never occludes a player behind it.
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 60, 64, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0x5fc8ff,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  wall.visible = false;
  wall.frustumCulled = false;
  scene.add(wall);

  return {
    scene,
    wall,
    zone: null,
    loot: new Map(),
    active: false,
  };
}

export function setZone(br, zone) {
  br.zone = zone;
  br.active = true;
  br.wall.visible = true;
}

export function clearBattleRoyale(br) {
  br.active = false;
  br.zone = null;
  br.wall.visible = false;
  for (const e of br.loot.values()) {
    br.scene.remove(e.group);
    e.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
  }
  br.loot.clear();
}

/** Replace the whole loot set — sent on join and at round start. */
export function setLoot(br, items) {
  for (const e of br.loot.values()) br.scene.remove(e.group);
  br.loot.clear();
  upsertLoot(br, items);
}

/** Add or replace ground loot. Replacements are the gun another player dropped. */
export function upsertLoot(br, items) {
  for (const item of items ?? []) {
    const previous = br.loot.get(item.i);
    if (previous) {
      br.scene.remove(previous.group);
      previous.group.traverse((o) => {
        if (o.isMesh) {
          o.geometry.dispose();
          o.material.dispose();
        }
      });
    }

    const group = new THREE.Group();
    group.position.set(item.p[0], item.p[1], item.p[2]);

    const colour = TIER_COLOR[item.t] ?? TIER_COLOR.common;
    // A tier-coloured plinth with a floating block on it. The gun models are too
    // small to read from any distance; the colour is the information.
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.5, 0.08, 14),
      new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.6 }),
    );
    plinth.position.y = 0.05;
    group.add(plinth);

    const marker = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.16, 0.16),
      new THREE.MeshLambertMaterial({ color: colour, emissive: colour, emissiveIntensity: 0.45 }),
    );
    marker.position.y = 0.7;
    group.add(marker);

    // A thin beam, so loot is findable across a 260m map.
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 6, 6, 1, true),
      new THREE.MeshBasicMaterial({
        color: colour, transparent: true, opacity: 0.22, depthWrite: false,
      }),
    );
    beam.position.y = 3;
    group.add(beam);

    br.scene.add(group);
    br.loot.set(item.i, { group, marker, weaponId: item.w, tier: item.t, pos: item.p });
  }
}

export function removeLoot(br, indices) {
  for (const index of indices ?? []) {
    const e = br.loot.get(index);
    if (!e) continue;
    br.scene.remove(e.group);
    br.loot.delete(index);
  }
}

/** Nearest loot within reach, for the "press E" prompt. */
export function nearestLoot(br, pos, maxDist) {
  let best = null;
  for (const [index, e] of br.loot) {
    const d = Math.hypot(pos[0] - e.pos[0], pos[1] - e.pos[1], pos[2] - e.pos[2]);
    if (d > maxDist) continue;
    if (!best || d < best.d) best = { index, d, name: getWeapon(e.weaponId).name, tier: e.tier };
  }
  return best;
}

export function updateBattleRoyale(br, now, dt) {
  if (!br.active) return;

  if (br.zone) {
    const z = br.zone;
    br.wall.position.set(z.centre[0], 0, z.centre[1]);
    br.wall.scale.set(z.radius, 1, z.radius);
    // Brighter while it is actually closing, so the movement is noticeable.
    br.wall.material.opacity = z.state === 'shrink' ? 0.3 : 0.14;
  }

  const t = now / 1000;
  for (const e of br.loot.values()) {
    e.marker.rotation.y = t * 1.3;
    e.marker.position.y = 0.7 + Math.sin(t * 2 + e.pos[0]) * 0.08;
  }
}

/** True when the player is outside the safe circle. */
export function isOutsideZone(br, pos) {
  if (!br.zone) return false;
  const dx = pos[0] - br.zone.centre[0];
  const dz = pos[2] - br.zone.centre[1];
  return Math.hypot(dx, dz) > br.zone.radius;
}
