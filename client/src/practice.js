// The practice range: single player, no server, no round timer.
//
// Targets are simulated entirely here. It's the fastest way to get a feel for
// the guns, and during development it's the harness for checking movement and
// gunplay without needing anyone else connected.

import * as THREE from 'three';
import { raycastBoxes } from '@shared/collision.js';
import { damageAtDistance } from '@shared/weapons.js';

const RESET_DELAY_MS = 2200;
const KNOCKDOWN_MS = 260;

const COLORS = {
  face: 0xd8d2c4,
  ring: 0xc0483c,
  bull: 0xe0a63c,
  post: 0x4a4a52,
  down: 0x5a5a62,
};

export function createRange(scene, map) {
  const targets = map.targets.map((def, i) => createTarget(scene, def, i));
  return {
    targets,
    scene,
    stats: { hits: 0, shots: 0, streak: 0, best: 0 },
    startedAt: performance.now(),
  };
}

function createTarget(scene, def, index) {
  const size = def.size ?? 0.55;
  const group = new THREE.Group();

  // The plate: a face with a ring and a bullseye, so you can see where you hit.
  const plate = new THREE.Group();
  const mk = (w, h, d, color, z) => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshLambertMaterial({ color, flatShading: true }),
    );
    m.position.z = z;
    m.castShadow = true;
    return m;
  };
  plate.add(mk(size * 2, size * 2, 0.1, COLORS.face, 0));
  plate.add(mk(size * 1.15, size * 1.15, 0.12, COLORS.ring, -0.02));
  plate.add(mk(size * 0.45, size * 0.45, 0.14, COLORS.bull, -0.04));
  // Hinge at the base so a hit knocks it flat instead of it vanishing.
  plate.position.y = size;
  group.add(plate);

  const post = new THREE.Mesh(
    new THREE.BoxGeometry(0.09, 1.0, 0.09),
    new THREE.MeshLambertMaterial({ color: COLORS.post, flatShading: true }),
  );
  post.position.y = -0.5;
  post.castShadow = true;
  group.add(post);

  scene.add(group);

  const target = {
    def,
    index,
    group,
    plate,
    size,
    pos: [0, 0, 0],
    up: true,
    knockedAt: 0,
    resetAt: 0,
    // Pop-ups start staggered so they don't all appear in unison.
    cycleOffset: (index * 0.37) % 1,
    box: { min: [0, 0, 0], max: [0, 0, 0], color: 0, tag: 'target' },
  };

  positionTarget(target, 0);
  return target;
}

/** Where a target should be at time `t` seconds, per its kind. */
function positionTarget(target, t) {
  const d = target.def;
  const p = target.pos;

  switch (d.kind) {
    case 'slide': {
      // Ease in/out at the turns rather than snapping direction — much better
      // tracking practice than linear ping-pong.
      const phase = ((t / d.period) + target.cycleOffset) % 1;
      const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;
      const eased = tri * tri * (3 - 2 * tri);
      for (let i = 0; i < 3; i++) p[i] = d.from[i] + (d.to[i] - d.from[i]) * eased;
      break;
    }
    case 'bob': {
      const phase = (t / d.period + target.cycleOffset) * Math.PI * 2;
      p[0] = d.pos[0];
      p[1] = d.pos[1] + Math.sin(phase) * d.amplitude;
      p[2] = d.pos[2];
      break;
    }
    default: {
      const src = d.pos ?? d.from;
      p[0] = src[0];
      p[1] = src[1];
      p[2] = src[2];
    }
  }

  target.group.position.set(p[0], p[1], p[2]);

  // Hitbox tracks the plate, not the post.
  const s = target.size;
  target.box.min[0] = p[0] - s;
  target.box.min[1] = p[1];
  target.box.min[2] = p[2] - 0.12;
  target.box.max[0] = p[0] + s;
  target.box.max[1] = p[1] + s * 2;
  target.box.max[2] = p[2] + 0.12;
}

export function updateRange(range, now) {
  const t = (now - range.startedAt) / 1000;

  for (const target of range.targets) {
    positionTarget(target, t);

    // ---- pop-up cycle ----
    if (target.def.kind === 'popup' && target.resetAt === 0) {
      const cycle = target.def.upTime + target.def.downTime;
      const phase = (t + target.cycleOffset * cycle) % cycle;
      const shouldBeUp = phase < target.def.upTime;
      if (shouldBeUp !== target.up) setUp(target, shouldBeUp);
    }

    // ---- knockdown animation and reset ----
    if (!target.up) {
      const sinceKnock = now - target.knockedAt;
      const fall = Math.min(1, sinceKnock / KNOCKDOWN_MS);
      target.plate.rotation.x = -fall * (Math.PI / 2) * 0.92;

      if (target.resetAt > 0 && now >= target.resetAt) {
        target.resetAt = 0;
        setUp(target, true);
      }
    } else if (target.plate.rotation.x !== 0) {
      // Spring back up quickly.
      target.plate.rotation.x = Math.min(0, target.plate.rotation.x + 0.35);
      if (target.plate.rotation.x > -0.01) target.plate.rotation.x = 0;
    }
  }
}

function setUp(target, up) {
  target.up = up;
  target.group.visible = up || target.def.kind !== 'popup';
  if (!up) {
    target.knockedAt = performance.now();
  } else {
    target.plate.rotation.x = 0;
  }
}

/**
 * Nearest target along a ray. Only standing targets count — a knocked-down
 * plate shouldn't eat your bullets.
 */
export function raycastTargets(range, origin, dir, maxDist) {
  let best = null;
  for (const target of range.targets) {
    if (!target.up) continue;
    const hit = raycastBoxes(origin, dir, [target.box], maxDist);
    if (!hit) continue;
    if (best && hit.t >= best.t) continue;
    best = { t: hit.t, target, point: [
      origin[0] + dir[0] * hit.t,
      origin[1] + dir[1] * hit.t,
      origin[2] + dir[2] * hit.t,
    ] };
  }
  return best;
}

export function registerHit(range, target, now, distance, weapon) {
  // Report damage so the falloff numbers are legible while tuning weapons.
  const damage = Math.round(damageAtDistance(weapon, distance));

  range.stats.hits += 1;
  range.stats.streak += 1;
  range.stats.best = Math.max(range.stats.best, range.stats.streak);

  setUp(target, false);
  target.resetAt = now + RESET_DELAY_MS;

  return { damage };
}

export function registerShot(range, hitAnything) {
  range.stats.shots += 1;
  if (!hitAnything) range.stats.streak = 0;
}

export function resetRange(range) {
  range.stats.hits = 0;
  range.stats.shots = 0;
  range.stats.streak = 0;
  range.stats.best = 0;
  for (const target of range.targets) {
    target.resetAt = 0;
    setUp(target, true);
  }
}

export function disposeRange(range) {
  for (const target of range.targets) {
    range.scene.remove(target.group);
    target.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
  }
  range.targets.length = 0;
}
