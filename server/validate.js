// Server-side sanity checking.
//
// Read the authority section of the plan before changing anything here. Movement
// is client-authoritative and hits are client-reported, so this file is NOT
// anti-cheat — a determined coworker with devtools open can still beat it. What
// it does do is reject nonsense: NaNs, teleports, shots through walls, shots
// from impossible ranges, and the accidental corruption that comes from a
// half-broken client.
//
// The upgrade path if it ever matters is in the plan: move simulation
// server-side and add prediction plus reconciliation.

import {
  MAX_VALIDATED_SPEED,
  MAX_HIT_DISTANCE_SLACK,
  LOS_ORIGIN_TOLERANCE,
  PLAYER_HEIGHT,
  PLAYER_CROUCH_HEIGHT,
  PLAYER_RADIUS,
  EYE_OFFSET,
  PITCH_LIMIT,
  HITBOX_HEAD_PAD,
  HEAD_ZONE_FROM_TOP,
  LEG_ZONE_FROM_BOTTOM,
  HEADSHOT_MULTIPLIER,
  LEG_MULTIPLIER,
} from '../shared/constants.js';
import { hasLineOfSight } from '../shared/collision.js';
import { maybeWeapon, damageAtDistance } from '../shared/weapons.js';

const MAX_TELEPORT = 4.0; // metres of slack before we call it a teleport
const MAX_SHOT_ORIGIN_DRIFT = 2.5;
const HIT_ZONES = new Set(['head', 'body', 'legs']);

function finite(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function finiteVec3(v) {
  return Array.isArray(v) && v.length === 3 && v.every(finite);
}

/**
 * Accept, clamp or reject a client's reported position.
 *
 * Returns { ok, pos, reason }. A rejected update leaves the server's last known
 * position in place rather than dropping the player — a brief stall looks much
 * better than a rubber-band across the map.
 */
export function validateMove(player, incoming, map, dtSeconds, maxSpeed = MAX_VALIDATED_SPEED) {
  if (!finiteVec3(incoming.pos) || !finite(incoming.yaw) || !finite(incoming.pitch)) {
    return { ok: false, reason: 'malformed' };
  }

  const b = map.bounds;
  for (let a = 0; a < 3; a++) {
    if (incoming.pos[a] < b.min[a] - 2 || incoming.pos[a] > b.max[a] + 2) {
      return { ok: false, reason: 'out-of-bounds' };
    }
  }

  // Speed check. Generous: a client on a bad connection legitimately sends
  // bursty updates, and we'd rather let a fast-looking-but-honest move through
  // than stutter someone on hotel wifi.
  const last = player.pos;
  const dx = incoming.pos[0] - last[0];
  const dy = incoming.pos[1] - last[1];
  const dz = incoming.pos[2] - last[2];
  const horizontal = Math.hypot(dx, dz);

  const window = Math.max(dtSeconds, 0.05);
  const allowed = maxSpeed * window + MAX_TELEPORT;

  if (horizontal > allowed) {
    return { ok: false, reason: 'too-fast' };
  }
  // Vertical gets much more slack: falling off Rooftops is fast and legitimate.
  if (Math.abs(dy) > allowed * 4 + 20) {
    return { ok: false, reason: 'vertical' };
  }

  return {
    ok: true,
    pos: incoming.pos,
    // Local yaw is allowed to accumulate as someone keeps turning, but the
    // snapshot must stay bounded. A huge finite angle otherwise makes the
    // client's shortest-path interpolation loop effectively forever.
    yaw: Math.atan2(Math.sin(incoming.yaw), Math.cos(incoming.yaw)),
    pitch: Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, incoming.pitch)),
  };
}

/**
 * Validate one client-reported hit and work out the damage.
 *
 * Returns { ok, damage, reason }.
 */
export function validateHit({ room, shooter, victim, weaponId, zone, map }) {
  const weapon = maybeWeapon(weaponId);
  if (!weapon) return { ok: false, reason: 'unknown-weapon' };

  // You can only shoot what you're holding.
  if (!shooter.inventory.includes(weaponId)) {
    return { ok: false, reason: 'weapon-not-held' };
  }
  if (!victim.alive || !shooter.alive) return { ok: false, reason: 'not-alive' };
  if (victim.spawnProtectedUntil > Date.now()) return { ok: false, reason: 'spawn-protected' };
  if (!HIT_ZONES.has(zone)) return { ok: false, reason: 'unknown-zone' };

  const shooterEye = eyeOf(shooter);
  const targets = hitValidationPoints(victim, zone).map((point) => ({
    point,
    distance: Math.hypot(
      point[0] - shooterEye[0],
      point[1] - shooterEye[1],
      point[2] - shooterEye[2],
    ),
  }));

  // Range, with slack for the gap between the client's view and ours.
  const inRange = targets.filter(
    ({ distance }) => distance <= weapon.range * MAX_HIT_DISTANCE_SLACK,
  );
  if (inRange.length === 0) {
    return { ok: false, reason: 'out-of-range' };
  }

  // Wall check. This is the one that matters — it's what stops someone
  // reporting hits on a player two rooms away. Check the reported zone rather
  // than only the body's centre: a roof edge can legitimately hide a player's
  // torso while leaving their head or shoulders exposed.
  const visible = inRange.find(({ point }) =>
    hasLineOfSight(shooterEye, point, map.solids, LOS_ORIGIN_TOLERANCE),
  );
  if (!visible) {
    return { ok: false, reason: 'no-line-of-sight' };
  }

  const { distance } = visible;
  let damage = damageAtDistance(weapon, distance);
  if (damage <= 0) return { ok: false, reason: 'zero-damage' };

  if (zone === 'head') damage *= HEADSHOT_MULTIPLIER;
  else if (zone === 'legs') damage *= LEG_MULTIPLIER;

  return { ok: true, damage: Math.round(damage), distance, weapon };
}

/**
 * Cap how much damage a single trigger pull can claim, so a corrupted or
 * tampered client can't report a hundred pellets from one shotgun shell.
 */
export function capPelletCount(weaponId, reported) {
  const weapon = maybeWeapon(weaponId);
  if (!weapon) return 0;
  return Math.min(reported, weapon.pellets);
}

/** Reject a client claiming to shoot faster than the weapon allows. */
export function validateFireRate(player, weaponId, now) {
  const weapon = maybeWeapon(weaponId);
  if (!weapon) return false;
  // 15% tolerance absorbs clock skew and jitter between the two machines.
  const interval = (60_000 / weapon.rpm) * 0.85;
  const last = player.lastShotAt ?? 0;
  if (now - last < interval) return false;
  player.lastShotAt = now;
  return true;
}

/**
 * Keep a cosmetic tracer useful without trusting arbitrary vectors from the
 * client. A nearby reported eye preserves the shooter's current movement/bob;
 * malformed or implausibly remote origins fall back to the server's player state.
 */
export function sanitiseShotTrace(player, reportedOrigin, reportedDirection) {
  const eye = eyeOf(player);
  const originDistance = finiteVec3(reportedOrigin)
    ? Math.hypot(
      reportedOrigin[0] - eye[0],
      reportedOrigin[1] - eye[1],
      reportedOrigin[2] - eye[2],
    )
    : Infinity;
  const origin = originDistance <= MAX_SHOT_ORIGIN_DRIFT ? [...reportedOrigin] : eye;

  if (finiteVec3(reportedDirection)) {
    const length = Math.hypot(...reportedDirection);
    if (finite(length) && length > 1e-6) {
      return {
        origin,
        direction: reportedDirection.map((component) => component / length),
      };
    }
  }

  const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, player.pitch));
  const cp = Math.cos(pitch);
  return {
    origin,
    direction: [
      -Math.sin(player.yaw) * cp,
      Math.sin(pitch),
      -Math.cos(player.yaw) * cp,
    ],
  };
}

function heightOf(player) {
  return player.crouching ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;
}

function eyeOf(player) {
  return [player.pos[0], player.pos[1] + heightOf(player) - EYE_OFFSET, player.pos[2]];
}

function hitValidationPoints(player, zone) {
  const [x, y, z] = player.pos;
  const height = heightOf(player);
  const centre = [x, y + height * 0.55, z];

  if (zone === 'head') {
    return [
      [x, y + height - EYE_OFFSET, z],
      [x, y + height + HITBOX_HEAD_PAD, z],
    ];
  }

  if (zone === 'body') {
    return [
      [x, y + height + HITBOX_HEAD_PAD - HEAD_ZONE_FROM_TOP - 0.01, z],
      centre,
      [x, y + LEG_ZONE_FROM_BOTTOM + 0.01, z],
    ];
  }

  if (zone === 'legs') {
    return [
      [x, y + LEG_ZONE_FROM_BOTTOM - 0.01, z],
      [x, y + Math.min(0.25, height * 0.2), z],
    ];
  }

  return [centre];
}

export { heightOf, eyeOf, PLAYER_RADIUS };
