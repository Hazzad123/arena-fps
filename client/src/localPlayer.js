// The player you control.
//
// Movement is a Quake-style accelerate/friction model rather than "set velocity
// to input". It costs a few more lines and it's the difference between a
// controller that feels like a shooter and one that feels like a spreadsheet:
// you keep a little momentum, strafing has weight, and air control is limited
// but present.
//
// This runs on the client and is authoritative for our own position — see the
// plan's authority section. The server only sanity-checks it.

import * as THREE from 'three';
import {
  PLAYER_HEIGHT,
  PLAYER_CROUCH_HEIGHT,
  CROUCH_TRANSITION_SPEED,
  PLAYER_RADIUS,
  EYE_OFFSET,
  PITCH_LIMIT,
  WALK_SPEED,
  SPRINT_SPEED,
  CROUCH_SPEED,
  GROUND_ACCEL,
  GROUND_FRICTION,
  AIR_CONTROL,
  AIR_FRICTION,
  GRAVITY,
  JUMP_VELOCITY,
  MAX_FALL_SPEED,
  MAX_HEALTH,
  FALL_DAMAGE_MIN_SPEED,
  FALL_DAMAGE_PER_SPEED,
  PARACHUTE_FALL_SPEED,
  PARACHUTE_GLIDE_SPEED,
  VEHICLE_MAX_SPEED,
  VEHICLE_REVERSE_SPEED,
  VEHICLE_ACCEL,
  VEHICLE_TURN_SPEED,
} from '@shared/constants.js';
import {
  clampHorizontalSpeed, moveAndCollide, playerOverlapsAny, pushOutOfSolids,
} from '@shared/collision.js';
import { getWeapon, fireIntervalMs } from '@shared/weapons.js';
import { input, moveAxes, consumeLook, consumePressed } from './input.js';

export function createLocalPlayer() {
  return {
    pos: [0, 0, 0],
    vel: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    onGround: false,
    crouching: false,
    crouchAmount: 0,
    height: PLAYER_HEIGHT,
    radius: PLAYER_RADIUS,

    health: MAX_HEALTH,
    alive: true,
    parachuting: false,
    vehicleId: null,
    vehicleSpeed: 0,
    vehicleSteer: 0,

    // Weapons
    inventory: ['rifle', 'pistol', 'knife'],
    slotIndex: 0,
    ammo: {}, // weaponId -> rounds in mag
    reloadingUntil: 0,
    lastShotAt: 0,
    switchingUntil: 0,

    // Recoil is applied to the real aim angles and then recovered, so it
    // genuinely throws your shots off rather than just wobbling the view.
    recoilPitch: 0,
    recoilYaw: 0,

    // Cosmetic
    bobPhase: 0,
    bobAmount: 0,
    adsProgress: 0,

    lastFallSpeed: 0,
  };
}

export function setLoadout(p, weaponIds) {
  p.inventory = [...weaponIds];
  p.slotIndex = 0;
  p.ammo = {};
  for (const id of weaponIds) p.ammo[id] = getWeapon(id).mag;
  p.reloadingUntil = 0;
  p.lastShotAt = 0;
}

export function currentWeapon(p) {
  return getWeapon(p.inventory[p.slotIndex] ?? p.inventory[0]);
}

export function spawnAt(p, point, solids, yaw = 0) {
  p.pos = [point[0], point[1], point[2]];
  p.vel = [0, 0, 0];
  p.yaw = yaw;
  p.pitch = 0;
  p.onGround = false;
  p.crouching = false;
  p.crouchAmount = 0;
  p.height = PLAYER_HEIGHT;
  p.health = MAX_HEALTH;
  p.alive = true;
  p.parachuting = false;
  p.vehicleId = null;
  p.vehicleSpeed = 0;
  p.vehicleSteer = 0;
  p.recoilPitch = 0;
  p.recoilYaw = 0;
  // Belt and braces against an authoring slip putting a spawn in a wall.
  if (playerOverlapsAny(p.pos, p.height, p.radius, solids)) {
    pushOutOfSolids(p.pos, p.height, p.radius, solids);
  }
}

export function eyeHeight(p) {
  return p.height - EYE_OFFSET;
}

export function eyePosition(p, out = [0, 0, 0]) {
  out[0] = p.pos[0];
  out[1] = p.pos[1] + eyeHeight(p) + p.bobAmount;
  out[2] = p.pos[2];
  return out;
}

/** Forward unit vector including recoil offset — this is where shots go. */
export function aimDirection(p, out = [0, 0, 0]) {
  const pitch = clampPitch(p.pitch + p.recoilPitch);
  const yaw = p.yaw + p.recoilYaw;
  const cp = Math.cos(pitch);
  out[0] = -Math.sin(yaw) * cp;
  out[1] = Math.sin(pitch);
  out[2] = -Math.cos(yaw) * cp;
  return out;
}

function clampPitch(v) {
  return Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, v));
}

// ---------------------------------------------------------------- simulation

export function updateLocalPlayer(p, dt, solids, opts = {}) {
  const { frozen = false, lethalFallY = null } = opts;
  const weapon = currentWeapon(p);

  applyLook(p);
  updateAds(p, dt, weapon);
  recoverRecoil(p, dt, weapon);

  if (frozen) {
    // Countdown players are already at their real spawn (or hanging beneath
    // their BR canopy). Hold that exact presentation until "Go".
    p.vel[0] = 0;
    p.vel[1] = 0;
    p.vel[2] = 0;
    return { fallDamage: 0, died: false };
  }

  if (!p.alive) {
    // Still integrate gravity so bodies settle rather than hanging in the air.
    p.vel[0] = 0;
    p.vel[2] = 0;
    p.vel[1] = Math.max(-MAX_FALL_SPEED, p.vel[1] + GRAVITY * dt);
    moveAndCollide(p, dt, solids, p.height, p.radius);
    return { fallDamage: 0, died: false };
  }

  if (p.parachuting) {
    const axes = moveAxes();
    const sin = Math.sin(p.yaw);
    const cos = Math.cos(p.yaw);
    const wishX = axes.x * cos - axes.z * sin;
    const wishZ = -axes.x * sin - axes.z * cos;
    const wishLen = Math.hypot(wishX, wishZ);
    p.vel[0] = wishLen > 0 ? (wishX / wishLen) * PARACHUTE_GLIDE_SPEED : 0;
    p.vel[2] = wishLen > 0 ? (wishZ / wishLen) * PARACHUTE_GLIDE_SPEED : 0;
    p.vel[1] = Math.max(-PARACHUTE_FALL_SPEED, p.vel[1] + GRAVITY * dt);
    const result = moveAndCollide(p, dt, solids, p.height, p.radius);
    if (result.landed && p.onGround) {
      p.parachuting = false;
      p.vel[0] *= 0.35;
      p.vel[2] *= 0.35;
    }
    p.bobAmount = 0;
    return { fallDamage: 0, died: false };
  }

  if (p.vehicleId !== null) {
    return updateVehicleMovement(p, dt, solids, lethalFallY);
  }

  updateCrouch(p, dt, solids);

  // ---- horizontal acceleration ----
  const axes = moveAxes();
  const sin = Math.sin(p.yaw);
  const cos = Math.cos(p.yaw);
  // Local -Z is forward, +X is right.
  const wishX = axes.x * cos - axes.z * sin;
  const wishZ = -axes.x * sin - axes.z * cos;
  const wishLen = Math.hypot(wishX, wishZ);

  let wishSpeed = targetSpeed(p, axes, weapon);
  const dirX = wishLen > 0 ? wishX / wishLen : 0;
  const dirZ = wishLen > 0 ? wishZ / wishLen : 0;
  if (wishLen === 0) wishSpeed = 0;

  applyFriction(p, dt);
  accelerate(p, dirX, dirZ, wishSpeed, dt);
  // Air acceleration is projection-based for responsive steering. Clamp the
  // resulting magnitude so a wall cannot strip the inward velocity while each
  // jump adds more sideways speed.
  clampHorizontalSpeed(p, SPRINT_SPEED * weapon.moveMult);

  // ---- vertical ----
  if (p.onGround && input.jump && !p.crouching) {
    p.vel[1] = JUMP_VELOCITY;
    p.onGround = false;
  }
  p.vel[1] = Math.max(-MAX_FALL_SPEED, p.vel[1] + GRAVITY * dt);

  const fallSpeedBefore = p.vel[1];
  const result = moveAndCollide(p, dt, solids, p.height, p.radius);

  updateViewBob(p, dt);

  // ---- fall damage ----
  let fallDamage = 0;
  if (result.landed && fallSpeedBefore < -FALL_DAMAGE_MIN_SPEED) {
    const excess = Math.abs(fallSpeedBefore) - FALL_DAMAGE_MIN_SPEED;
    fallDamage = Math.round(excess * FALL_DAMAGE_PER_SPEED);
  }

  // ---- the void, on maps that have one ----
  let died = false;
  if (lethalFallY !== null && p.pos[1] < lethalFallY) died = true;

  return { fallDamage, died };
}

function updateVehicleMovement(p, dt, solids, lethalFallY) {
  const axes = moveAxes();
  const throttle = axes.z > 0.1 ? 1 : axes.z < -0.1 ? -1 : 0;
  const target = throttle > 0
    ? VEHICLE_MAX_SPEED
    : throttle < 0 ? -VEHICLE_REVERSE_SPEED : 0;
  const rate = throttle ? VEHICLE_ACCEL : VEHICLE_ACCEL * 1.8;
  const delta = Math.max(-rate * dt, Math.min(rate * dt, target - p.vehicleSpeed));
  p.vehicleSpeed += delta;

  // Ease steering input instead of applying the keyboard's instant -1/0/1
  // changes directly to the chassis. It removes the twitch at key-down/key-up
  // without making the rover feel disconnected.
  const steerAlpha = 1 - Math.exp(-10 * dt);
  p.vehicleSteer += (axes.x - p.vehicleSteer) * steerAlpha;
  const speedFactor = Math.min(1, Math.abs(p.vehicleSpeed) / 4);
  const reverse = p.vehicleSpeed < 0 ? -1 : 1;
  p.yaw -= p.vehicleSteer * VEHICLE_TURN_SPEED * speedFactor * reverse * dt;
  if (p.yaw > Math.PI) p.yaw -= Math.PI * 2;
  if (p.yaw < -Math.PI) p.yaw += Math.PI * 2;

  p.vel[0] = -Math.sin(p.yaw) * p.vehicleSpeed;
  p.vel[2] = -Math.cos(p.yaw) * p.vehicleSpeed;
  p.vel[1] = Math.max(-MAX_FALL_SPEED, p.vel[1] + GRAVITY * dt);

  const beforeX = p.pos[0];
  const beforeZ = p.pos[2];
  moveAndCollide(p, dt, solids, p.height, p.radius);
  const moved = Math.hypot(p.pos[0] - beforeX, p.pos[2] - beforeZ);
  if (Math.abs(p.vehicleSpeed) > 1 && moved < Math.abs(p.vehicleSpeed) * dt * 0.25) {
    // A hard collision used to retain 35% speed. Acceleration immediately put
    // that speed back into the wall, creating a visible stop/start vibration.
    p.vehicleSpeed = 0;
    p.vel[0] = 0;
    p.vel[2] = 0;
  }

  p.crouching = false;
  p.crouchAmount = 0;
  p.height = PLAYER_HEIGHT;
  p.adsProgress += (0 - p.adsProgress) * Math.min(1, 12 * dt);
  p.bobAmount += (0 - p.bobAmount) * Math.min(1, 12 * dt);

  return {
    fallDamage: 0,
    died: lethalFallY !== null && p.pos[1] < lethalFallY,
  };
}

function targetSpeed(p, axes, weapon) {
  let speed = WALK_SPEED;
  // Sprint only forwards — backpedalling at 9m/s looks and feels wrong.
  if (input.sprint && axes.z > 0.5 && !input.ads && p.crouchAmount < 0.2) speed = SPRINT_SPEED;
  // Blend toward crouch speed as you go down, so the slowdown matches what the
  // camera is doing rather than snapping at the halfway point.
  speed = speed + (CROUCH_SPEED - speed) * p.crouchAmount;

  speed *= weapon.moveMult;
  if (input.ads) speed *= 0.55;
  if (!p.onGround) speed = Math.max(speed, WALK_SPEED);
  return speed;
}

function applyFriction(p, dt) {
  const speed = Math.hypot(p.vel[0], p.vel[2]);
  if (speed < 0.001) {
    p.vel[0] = 0;
    p.vel[2] = 0;
    return;
  }
  const f = p.onGround ? GROUND_FRICTION : AIR_FRICTION;
  const drop = speed * f * dt;
  const scale = Math.max(0, speed - drop) / speed;
  p.vel[0] *= scale;
  p.vel[2] *= scale;
}

function accelerate(p, dirX, dirZ, wishSpeed, dt) {
  if (wishSpeed <= 0) return;
  const current = p.vel[0] * dirX + p.vel[2] * dirZ;
  const add = wishSpeed - current;
  if (add <= 0) return;

  const accel = GROUND_ACCEL * (p.onGround ? 1 : AIR_CONTROL);
  const step = Math.min(accel * wishSpeed * dt, add);
  p.vel[0] += dirX * step;
  p.vel[2] += dirZ * step;
}

/**
 * Crouch, interpolated rather than snapped.
 *
 * The real collision height moves — not just the camera — so the smaller hitbox
 * arrives progressively as you go down, and the eye height follows for free
 * because eyeHeight() derives from p.height. Standing back up is gated on
 * headroom at each increment, so ducking into the practice range's low tunnel
 * and releasing crouch leaves you crouched instead of clipping through the roof.
 */
function updateCrouch(p, dt, solids) {
  const target = input.crouch ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;
  const step = CROUCH_TRANSITION_SPEED * dt;

  if (target < p.height) {
    p.height = Math.max(target, p.height - step);
  } else if (target > p.height) {
    const next = Math.min(target, p.height + step);
    if (!playerOverlapsAny(p.pos, next, p.radius, solids)) p.height = next;
  }

  // 0 = fully upright, 1 = fully crouched. Drives movement speed and the
  // network flag, so both track the animation instead of jumping at the ends.
  p.crouchAmount = (PLAYER_HEIGHT - p.height) / (PLAYER_HEIGHT - PLAYER_CROUCH_HEIGHT);
  p.crouching = p.crouchAmount > 0.5;
}

function applyLook(p) {
  const { dx, dy } = consumeLook();
  p.yaw -= dx;
  p.pitch = clampPitch(p.pitch - dy);
  // Keep yaw bounded so it doesn't drift to huge floats over a long session.
  if (p.yaw > Math.PI) p.yaw -= Math.PI * 2;
  if (p.yaw < -Math.PI) p.yaw += Math.PI * 2;
}

function updateAds(p, dt, weapon) {
  const target = input.ads && weapon.adsZoom > 1.01 ? 1 : 0;
  const rate = 7.5;
  p.adsProgress += (target - p.adsProgress) * Math.min(1, rate * dt);
}

function recoverRecoil(p, dt, weapon) {
  const rate = weapon.recoil.recoverPerSec;
  const k = Math.min(1, rate * dt);
  p.recoilPitch += (0 - p.recoilPitch) * k;
  p.recoilYaw += (0 - p.recoilYaw) * k;
}

function updateViewBob(p, dt) {
  const speed = Math.hypot(p.vel[0], p.vel[2]);
  if (p.onGround && speed > 0.7) {
    p.bobPhase += dt * (4.2 + speed * 0.75);
    const amp = Math.min(speed / SPRINT_SPEED, 1) * 0.045;
    p.bobAmount = Math.sin(p.bobPhase * 2) * amp;
  } else {
    p.bobAmount += (0 - p.bobAmount) * Math.min(1, 9 * dt);
  }
}

// ------------------------------------------------------------------ weapons

export function ammoInMag(p) {
  const id = p.inventory[p.slotIndex];
  return p.ammo[id] ?? 0;
}

export function isReloading(p, now) {
  return now < p.reloadingUntil;
}

export function startReload(p, now) {
  const weapon = currentWeapon(p);
  if (weapon.mag === Infinity) return false;
  if (isReloading(p, now)) return false;
  if (ammoInMag(p) >= weapon.mag) return false;
  p.reloadingUntil = now + weapon.reloadMs;
  return true;
}

export function finishReloadIfDue(p, now) {
  if (p.reloadingUntil === 0 || now < p.reloadingUntil) return false;
  p.reloadingUntil = 0;
  const id = p.inventory[p.slotIndex];
  // Reserve ammo is intentionally infinite: hunting for ammo boxes isn't the
  // game we're building, and running dry mid-fight in a 3 minute round is
  // just annoying.
  p.ammo[id] = getWeapon(id).mag;
  return true;
}

export function switchTo(p, index, now) {
  if (index < 0 || index >= p.inventory.length || index === p.slotIndex) return false;
  p.slotIndex = index;
  p.reloadingUntil = 0;
  p.switchingUntil = now + 260;
  return true;
}

/**
 * Try to fire. Returns an array of pellet directions (already spread) plus the
 * origin, or null if the trigger did nothing.
 */
export function tryFire(p, now, firePressedThisFrame) {
  if (!p.alive) return null;
  const weapon = currentWeapon(p);

  if (now < p.switchingUntil) return null;
  if (isReloading(p, now)) return null;
  if (now - p.lastShotAt < fireIntervalMs(weapon)) return null;

  const wantsToShoot = weapon.auto ? input.firing : firePressedThisFrame;
  if (!wantsToShoot) return null;

  if (ammoInMag(p) <= 0) {
    startReload(p, now);
    return null;
  }

  p.lastShotAt = now;
  if (weapon.mag !== Infinity) p.ammo[p.inventory[p.slotIndex]] -= 1;

  // Direction is read BEFORE recoil is applied. aimDirection() includes the
  // accumulated recoil offset, so kicking first meant every shot was thrown off
  // by the kick it had just caused — the sniper's 6° of rise put its own round
  // 6° above the crosshair, every single time, which at 50m is five metres high.
  //
  // Recoil is supposed to spoil your *next* shot, not the one you just fired.
  const origin = eyePosition(p);
  const base = aimDirection(p);
  const spreadDeg = lerp(weapon.spread, weapon.adsSpread, p.adsProgress) * movementSpreadMultiplier(p);

  applyRecoil(p, weapon);

  const dirs = [];
  for (let i = 0; i < weapon.pellets; i++) {
    dirs.push(spreadDirection(base, spreadDeg));
  }

  return { origin: [...origin], dirs, weapon, spreadDeg };
}

function movementSpreadMultiplier(p) {
  const speed = Math.hypot(p.vel[0], p.vel[2]);
  let mult = 1 + (speed / SPRINT_SPEED) * 0.6;
  if (!p.onGround) mult *= 1.7; // jump-shooting should not be reliable
  mult *= 1 - 0.3 * p.crouchAmount; // steadier the lower you get
  return mult;
}

function applyRecoil(p, weapon) {
  const deg = Math.PI / 180;
  p.recoilPitch += weapon.recoil.up * deg;
  p.recoilYaw += (Math.random() - 0.5) * 2 * weapon.recoil.side * deg;
}

function spreadDirection(base, spreadDeg) {
  if (spreadDeg <= 0.0001) return [...base];

  const maxAngle = spreadDeg * (Math.PI / 180);
  // Uniform over the cone's disc, so shots cluster centrally rather than
  // piling up at the rim.
  const angle = maxAngle * Math.sqrt(Math.random());
  const roll = Math.random() * Math.PI * 2;

  const v = new THREE.Vector3(base[0], base[1], base[2]).normalize();
  // Any vector not parallel to v works as a basis seed.
  const seed = Math.abs(v.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(v, seed).normalize();
  const up = new THREE.Vector3().crossVectors(right, v).normalize();

  const offset = Math.tan(angle);
  v.addScaledVector(right, Math.cos(roll) * offset);
  v.addScaledVector(up, Math.sin(roll) * offset);
  v.normalize();

  return [v.x, v.y, v.z];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Apply the current view to a three.js camera. */
export function applyToCamera(p, camera, baseFov) {
  eyePosition(p, TMP);
  camera.position.set(TMP[0], TMP[1], TMP[2]);

  const pitch = clampPitch(p.pitch + p.recoilPitch);
  camera.rotation.set(0, 0, 0);
  camera.rotateY(p.yaw + p.recoilYaw);
  camera.rotateX(pitch);

  const weapon = currentWeapon(p);
  const targetFov = baseFov / lerp(1, weapon.adsZoom, p.adsProgress);
  if (Math.abs(camera.fov - targetFov) > 0.01) {
    camera.fov = targetFov;
    camera.updateProjectionMatrix();
  }
}

const TMP = [0, 0, 0];

/** Handle the keyboard actions that only affect our own weapon state. */
/**
 * Press a slot key. Several guns can share a slot now — there are three rifles
 * and one number 5 — so pressing it again cycles through them rather than always
 * landing on the first. In a match your loadout has one gun per slot, so nothing
 * changes there; it's the practice range, which hands you all seventeen, where
 * this is the difference between reaching every gun and reaching eight of them.
 */
export function switchToSlot(p, slot, now) {
  const matches = [];
  for (const [i, id] of p.inventory.entries()) {
    if (getWeapon(id).slot === slot) matches.push(i);
  }
  if (matches.length === 0) return false;

  const here = matches.indexOf(p.slotIndex);
  // Already on one of them: step to the next. Otherwise take the first.
  const next = here >= 0 ? matches[(here + 1) % matches.length] : matches[0];
  return switchTo(p, next, now);
}

export function handleWeaponInput(p, now) {
  finishReloadIfDue(p, now);

  if (input.weaponSlot > 0) {
    switchToSlot(p, input.weaponSlot, now);
    input.weaponSlot = 0;
  } else if (input.weaponCycle !== 0 && p.inventory.length > 1) {
    const next = (p.slotIndex + Math.sign(input.weaponCycle) + p.inventory.length)
      % p.inventory.length;
    switchTo(p, next, now);
  }
  input.weaponCycle = 0;

  if (consumePressed('reload')) startReload(p, now);
}
