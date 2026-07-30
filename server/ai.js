// In-process AI players.
//
// Distinct from server/bot.js, which is a *test harness*: separate OS processes
// connecting over WebSockets to exercise the real protocol. That's the right tool
// for load testing and exactly the wrong tool for filling a battle royale lobby
// with 25 opponents — you can't spawn 25 node processes because someone clicked a
// button.
//
// These live inside the room. They're ordinary entries in room.players with
// `ws: null` and an `ai` block, so snapshots, damage, scoring and the scoreboard
// all treat them like anyone else. The room steps them each tick instead of
// waiting for a client to send state.
//
// Consequence worth knowing: room.players.size is no longer the number of people
// present. Anything that means "is anyone actually here" must use humanCount().

import {
  PLAYER_HEIGHT, PLAYER_RADIUS, WALK_SPEED, SPRINT_SPEED, GRAVITY, MAX_FALL_SPEED,
  JUMP_VELOCITY, MAX_HEALTH, PARACHUTE_FALL_SPEED, PARACHUTE_GLIDE_SPEED,
} from '../shared/constants.js';
import { FLAG } from '../shared/protocol.js';
import {
  moveAndCollide, hasLineOfSight, playerOverlapsAny, raycastBoxes,
} from '../shared/collision.js';
import { getWeapon, fireIntervalMs, damageAtDistance } from '../shared/weapons.js';

const NAMES = [
  'Ash', 'Bram', 'Cinder', 'Dov', 'Ember', 'Flint', 'Grist', 'Hale', 'Ivo',
  'Jarl', 'Kite', 'Lark', 'Moss', 'Nix', 'Onyx', 'Pike', 'Quill', 'Rune',
  'Slate', 'Tern', 'Vale', 'Wick', 'Yarrow', 'Zeal', 'Brack', 'Corvid',
  'Dross', 'Ferrous', 'Gale', 'Harrow',
];

/**
 * Difficulty. Rather than giving AI perfect aim and then handicapping the damage
 * — which feels like being shot by a cheat — the knobs are all *human* failings:
 * they take time to notice you, their aim wanders, and they need to reacquire
 * after you move. An AI that misses believably is much better company than one
 * that hits always but for less.
 */
export const AI_SKILL = {
  easy: { reaction: 0.55, aimError: 3.4, aimSpeed: 3.2, burstMs: [420, 900], loseTargetMs: 1400, accuracy: 0.55 },
  normal: { reaction: 0.34, aimError: 1.9, aimSpeed: 5.5, burstMs: [260, 620], loseTargetMs: 2000, accuracy: 0.72 },
  hard: { reaction: 0.2, aimError: 1.05, aimSpeed: 8.5, burstMs: [160, 420], loseTargetMs: 2800, accuracy: 0.86 },
};

let nextAiSeq = 1;

export function aiName(index) {
  const base = NAMES[index % NAMES.length];
  return index < NAMES.length ? base : `${base}${Math.floor(index / NAMES.length) + 1}`;
}

/**
 * Build an AI player. Shaped exactly like a human player so every existing code
 * path — damage, scoring, snapshots, spawns — works on it untouched.
 */
export function createAiPlayer({ name, primaryId, team, skill = 'normal' }) {
  return {
    id: `ai${nextAiSeq++}`,
    name,
    ws: null,
    isBot: true,
    team,
    ready: true,
    primaryId,
    pos: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    flags: 0,
    crouching: false,
    health: MAX_HEALTH,
    alive: false,
    inventory: [],
    weapon: null,
    ladderIndex: 0,
    score: 0,
    kills: 0,
    deaths: 0,
    lastShotAt: 0,
    lastStateAt: Date.now(),
    lastDamageAt: 0,
    spawnProtectedUntil: 0,
    respawnAt: 0,
    lastKilledBy: null,
    joinedAt: Date.now(),
    rejectedMoves: 0,
    chatTimes: [],
    vehicleId: null,

    ai: {
      skill,
      vel: [0, 0, 0],
      onGround: false,
      waypoint: null,
      stuckFor: 0,
      // Combat
      targetId: null,
      sawTargetAt: 0,
      lostSightAt: 0,
      aimYaw: 0,
      aimPitch: 0,
      nextShotAt: 0,
      burstUntil: 0,
      // Wander cadence
      repathAt: 0,
      strafeDir: Math.random() < 0.5 ? -1 : 1,
      strafeUntil: 0,
      landingTarget: null,
      lastGoodPos: [0, 0, 0],
    },
  };
}

/** Where an AI should head next. Overridable per mode (BR pulls toward the zone). */
function pickWaypoint(room, bot) {
  const map = room.map;
  const hint = room.aiWaypointHint?.(bot);
  if (hint) return hint;

  const points = map.spawns.ffa ?? map.spawns.A;
  // Authored spawn points are guaranteed walkable. On a lethal map, keep the
  // waypoint close to one instead of adding a blind ten-metre offset that can
  // place the goal in open air between rooftops.
  for (let tries = 0; tries < 8; tries++) {
    const p = points[Math.floor(Math.random() * points.length)];
    const spread = map.lethalFallY === undefined ? 10 : 3;
    const candidate = [
      p[0] + (Math.random() - 0.5) * spread,
      p[1],
      p[2] + (Math.random() - 0.5) * spread,
    ];
    if (safeFooting(room, candidate, p[1] + 1.4)) return candidate;
  }
  return [...points[Math.floor(Math.random() * points.length)]];
}

/** Best enemy this AI can actually see, with enough stickiness to avoid twitching. */
function acquireTarget(room, bot) {
  const eye = eyeOf(bot);
  let best = null;
  const weapon = getWeapon(bot.weapon);

  for (const other of room.players.values()) {
    if (other === bot || !other.alive) continue;
    if (!room.aiCanTarget(bot, other)) continue;
    if (other.spawnProtectedUntil > Date.now()) continue;

    // Test torso and head separately. A player peeking over a low wall should
    // still be noticed even when the centre of their body is hidden.
    const samples = [
      [other.pos[0], other.pos[1] + PLAYER_HEIGHT * 0.58, other.pos[2]],
      [other.pos[0], other.pos[1] + PLAYER_HEIGHT * 0.9, other.pos[2]],
    ];
    const centre = samples.find((point) => hasLineOfSight(eye, point, room.map.solids));
    if (!centre) continue;
    const d = dist3(eye, centre);
    if (d > weapon.range * 0.85) continue;

    // Prefer close, hurt opponents, while retaining an existing target until
    // somebody else is materially better. This reads as focus, not indecision.
    let score = d - (MAX_HEALTH - other.health) * 0.06;
    if (bot.ai.targetId === other.id) score *= 0.72;
    if (!best || score < best.score) best = { other, d, centre, score };
  }
  return best;
}

function eyeOf(p) {
  return [p.pos[0], p.pos[1] + PLAYER_HEIGHT - 0.15, p.pos[2]];
}

function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function safeFooting(room, pos, fromY = pos[1] + 1.2) {
  if (room.map.lethalFallY === undefined) return true;
  const origin = [pos[0], Math.max(fromY, pos[1] + 0.4), pos[2]];
  const hit = raycastBoxes(origin, [0, -1, 0], room.map.solids, 3.2);
  if (!hit) return false;
  const top = origin[1] - hit.t;
  return top > room.map.lethalFallY + 3 && Math.abs(top - pos[1]) <= 1.5;
}

function pathClear(room, bot, dirX, dirZ, distance = 1.5) {
  const d = Math.hypot(dirX, dirZ);
  if (d < 1e-4) return true;
  const nx = dirX / d;
  const nz = dirZ / d;
  const target = [
    bot.pos[0] + nx * distance,
    bot.pos[1],
    bot.pos[2] + nz * distance,
  ];
  if (!safeFooting(room, target, bot.pos[1] + 1.2)) return false;
  if (playerOverlapsAny(target, PLAYER_HEIGHT, PLAYER_RADIUS, room.map.solids)) return false;
  const chest = [bot.pos[0], bot.pos[1] + PLAYER_HEIGHT * 0.55, bot.pos[2]];
  return !raycastBoxes(chest, [nx, 0, nz], room.map.solids, distance + PLAYER_RADIUS);
}

/**
 * Select a nearby safe steering direction rather than discovering walls and
 * ledges by walking into them. Candidate order preserves the desired course,
 * then bends around either side, then tries a hard sidestep.
 */
function steer(room, bot, wantX, wantZ) {
  const length = Math.hypot(wantX, wantZ);
  if (length < 1e-4) return [0, 0];
  const x = wantX / length;
  const z = wantZ / length;
  const side = bot.ai.strafeDir || 1;
  for (const angle of [0, side * Math.PI / 6, -side * Math.PI / 6, side * Math.PI / 3, -side * Math.PI / 3, Math.PI]) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const dx = x * c - z * s;
    const dz = x * s + z * c;
    if (pathClear(room, bot, dx, dz)) return [dx, dz];
  }
  return [0, 0];
}

function stepParachute(room, bot, dt, now) {
  const ai = bot.ai;
  if (!ai.landingTarget) {
    // Each bot already started over a different shoreline point. Land near that
    // individual drop instead of the whole lobby evaluating the same epic loot and
    // converging into one mid-air swarm.
    const b = room.map.bounds;
    ai.landingTarget = [
      Math.max(b.min[0] + 4, Math.min(b.max[0] - 4, bot.pos[0] + (Math.random() - 0.5) * 28)),
      0,
      Math.max(b.min[2] + 4, Math.min(b.max[2] - 4, bot.pos[2] + (Math.random() - 0.5) * 28)),
    ];
  }

  const dx = ai.landingTarget[0] - bot.pos[0];
  const dz = ai.landingTarget[2] - bot.pos[2];
  const d = Math.hypot(dx, dz);
  ai.vel[0] = d > 1 ? (dx / d) * PARACHUTE_GLIDE_SPEED : 0;
  ai.vel[2] = d > 1 ? (dz / d) * PARACHUTE_GLIDE_SPEED : 0;
  ai.vel[1] = Math.max(-PARACHUTE_FALL_SPEED, ai.vel[1] + GRAVITY * dt);

  if (d > 0.1) {
    ai.aimYaw = Math.atan2(-dx, -dz);
    bot.yaw = ai.aimYaw;
  }

  const state = { pos: bot.pos, vel: ai.vel, onGround: ai.onGround };
  const result = moveAndCollide(state, dt, room.map.solids, PLAYER_HEIGHT, PLAYER_RADIUS);
  ai.onGround = state.onGround;
  if (result.landed && state.onGround) {
    bot.parachuting = false;
    bot.spawnProtectedUntil = now + 2000;
    ai.combatReadyAt = now + 5000 + Math.random() * 4000;
    ai.landingTarget = null;
    ai.vel[0] = 0;
    ai.vel[2] = 0;
  }
  bot.flags = (bot.parachuting ? FLAG.PARACHUTE : 0) | (ai.onGround ? 0 : FLAG.AIRBORNE);
  bot.lastStateAt = now;
}

/**
 * One tick of AI. Movement uses the same shared collision code as a real client,
 * so bots can't walk through walls or float — and if the collision code has a bug,
 * the bots hit it too, which is useful.
 */
export function stepAi(room, bot, dt, now) {
  if (!bot.alive) return;
  const skill = AI_SKILL[bot.ai.skill] ?? AI_SKILL.normal;
  const ai = bot.ai;

  if (bot.parachuting) {
    stepParachute(room, bot, dt, now);
    return;
  }

  const zoneUrgent = !!room.aiZoneUrgent?.(bot);

  // ---- target acquisition ----
  const found = !zoneUrgent && now >= (ai.combatReadyAt ?? 0) ? acquireTarget(room, bot) : null;
  if (zoneUrgent) ai.targetId = null;
  if (found) {
    if (ai.targetId !== found.other.id) {
      ai.targetId = found.other.id;
      // Reaction time: they don't start shooting the instant you're visible.
      ai.nextShotAt = now + skill.reaction * 1000;
    }
    ai.sawTargetAt = now;
    ai.lastSeen = found.centre;
  } else if (ai.targetId && now - ai.sawTargetAt > skill.loseTargetMs) {
    ai.targetId = null;
  }

  const target = ai.targetId ? room.players.get(ai.targetId) : null;
  const engaging = !!target && target.alive && now - ai.sawTargetAt < skill.loseTargetMs;

  // ---- aim ----
  if (engaging && ai.lastSeen) {
    const eye = eyeOf(bot);
    const dx = ai.lastSeen[0] - eye[0];
    const dy = ai.lastSeen[1] - eye[1];
    const dz = ai.lastSeen[2] - eye[2];
    const flat = Math.hypot(dx, dz);
    const wantYaw = Math.atan2(-dx, -dz);
    const wantPitch = Math.atan2(dy, flat);

    // Turn toward the target at a finite rate. Snapping is the single biggest
    // tell that you're fighting a machine.
    ai.aimYaw = turnToward(ai.aimYaw, wantYaw, skill.aimSpeed * dt);
    ai.aimPitch += (wantPitch - ai.aimPitch) * Math.min(1, skill.aimSpeed * dt);
    bot.yaw = ai.aimYaw;
    bot.pitch = ai.aimPitch;
  }

  // ---- movement ----
  if (!ai.waypoint || now > ai.repathAt || zoneUrgent) {
    ai.waypoint = pickWaypoint(room, bot);
    ai.repathAt = now + (zoneUrgent ? 1200 : 6000 + Math.random() * 6000);
  }

  // Close, retreat or orbit according to the equipped gun. Standing still at one
  // preferred distance made old bots trivial targets; this keeps pressure up
  // while still giving shotguns and snipers distinct behaviour.
  let wantX = 0;
  let wantZ = 0;
  if (engaging && ai.lastSeen) {
    const preferred = preferredRange(bot);
    const toX = ai.lastSeen[0] - bot.pos[0];
    const toZ = ai.lastSeen[2] - bot.pos[2];
    const d = Math.max(0.01, Math.hypot(toX, toZ));
    const nx = toX / d;
    const nz = toZ / d;

    if (now >= ai.strafeUntil) {
      ai.strafeDir = Math.random() < 0.5 ? -1 : 1;
      ai.strafeUntil = now + 900 + Math.random() * 1700;
    }
    const rangeBias = d > preferred * 1.18 ? 1 : d < preferred * 0.68 ? -0.9 : 0.12;
    const weaponType = getWeapon(bot.weapon).type;
    const strafeBias = weaponType === 'shotgun' || weaponType === 'melee' ? 0.32 : 0.78;
    wantX = nx * rangeBias + -nz * ai.strafeDir * strafeBias;
    wantZ = nz * rangeBias + nx * ai.strafeDir * strafeBias;
  } else if (ai.waypoint) {
    wantX = ai.waypoint[0] - bot.pos[0];
    wantZ = ai.waypoint[2] - bot.pos[2];
    if (Math.hypot(wantX, wantZ) < 1.5) ai.waypoint = null;
  }

  const speed = zoneUrgent ? SPRINT_SPEED : engaging ? WALK_SPEED * 0.85 : WALK_SPEED;
  const [moveX, moveZ] = steer(room, bot, wantX, wantZ);
  ai.vel[0] = moveX * speed;
  ai.vel[2] = moveZ * speed;
  if (!engaging && (moveX || moveZ)) {
    // Face the way you're walking when you've nothing to shoot at.
    ai.aimYaw = turnToward(ai.aimYaw, Math.atan2(-moveX, -moveZ), skill.aimSpeed * dt);
    bot.yaw = ai.aimYaw;
    bot.pitch = 0;
  }

  ai.vel[1] = Math.max(-MAX_FALL_SPEED, ai.vel[1] + GRAVITY * dt);

  const before = [...bot.pos];
  const state = { pos: bot.pos, vel: ai.vel, onGround: ai.onGround };
  moveAndCollide(state, dt, room.map.solids, PLAYER_HEIGHT, PLAYER_RADIUS);
  ai.onGround = state.onGround;

  // If an authored seam or a collision shove got past the probe, restore the
  // last supported position before the bot turns a small mistake into a death.
  if (safeFooting(room, bot.pos, bot.pos[1] + 1.2)) {
    ai.lastGoodPos = [...bot.pos];
  } else if (room.map.lethalFallY !== undefined && ai.lastGoodPos) {
    bot.pos = [...ai.lastGoodPos];
    ai.vel = [0, 0, 0];
    ai.waypoint = null;
    ai.strafeDir *= -1;
  }

  // Wedged: jump, then pick somewhere else.
  const moved = Math.hypot(bot.pos[0] - before[0], bot.pos[2] - before[2]);
  const wantedMove = Math.hypot(wantX, wantZ) > 0.2;
  if (wantedMove && moved < 0.008) {
    ai.stuckFor += dt;
    // Jump over cover on enclosed maps. On lethal maps a blind jump is exactly
    // how bots used to throw survival waves away, so they turn and repath.
    if (ai.stuckFor > 0.3 && ai.onGround && room.map.lethalFallY === undefined) {
      ai.vel[1] = JUMP_VELOCITY;
    }
    if (ai.stuckFor > 1.1) {
      ai.waypoint = null;
      ai.strafeDir *= -1;
      ai.stuckFor = 0;
    }
  } else {
    ai.stuckFor = 0;
  }

  bot.flags = (ai.onGround ? 0 : FLAG.AIRBORNE)
    | (engaging ? FLAG.FIRING : 0)
    | (zoneUrgent ? FLAG.SPRINT : 0);
  bot.lastStateAt = now;

  // ---- shooting ----
  if (engaging && now >= ai.nextShotAt) shoot(room, bot, target, skill, now);
}

/** How close this weapon wants to be. */
function preferredRange(bot) {
  if (bot.weapon === 'dmr') return 30;
  switch (getWeapon(bot.weapon).type) {
    case 'shotgun': return 6;
    case 'smg': return 11;
    case 'sniper': return 40;
    case 'lmg': return 20;
    case 'melee': return 1.6;
    default: return 16;
  }
}

function turnToward(current, want, maxStep) {
  let diff = want - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const step = Math.max(-maxStep, Math.min(maxStep, diff));
  return current + step;
}

/**
 * Take a shot. Damage is applied directly rather than round-tripped through the
 * client-reported hit path, because there's no client — but it goes through the
 * same applyDamage() so scoring, kill credit, gun game promotion and the killfeed
 * all behave identically to a human's shot.
 */
function shoot(room, bot, target, skill, now) {
  const weapon = getWeapon(bot.weapon);
  const ai = bot.ai;

  const interval = Math.max(fireIntervalMs(weapon), weapon.auto ? 90 : 240);
  const [minGap, maxGap] = skill.burstMs;
  ai.nextShotAt = now + interval + minGap + Math.random() * (maxGap - minGap);

  const eye = eyeOf(bot);
  // Keep shooting the visible body sample acquisition found. Reverting to the
  // torso here made bots notice a head above a parapet and then fire every round
  // into the wall covering that torso.
  const torso = [target.pos[0], target.pos[1] + PLAYER_HEIGHT * 0.58, target.pos[2]];
  const head = [target.pos[0], target.pos[1] + PLAYER_HEIGHT * 0.9, target.pos[2]];
  const centre = [ai.lastSeen, torso, head].find(
    (point) => point && hasLineOfSight(eye, point, room.map.solids),
  );
  if (!centre) return;
  const distance = dist3(eye, centre);
  if (distance > weapon.range) return;

  room.broadcastAiShot(bot, eye, centre);

  // Hit or miss is rolled rather than raycast against a spread cone: the cone
  // would need the aim error modelled twice over, and a single roll biased by
  // distance and skill is both cheaper and easier to tune.
  const rangeFactor = Math.max(0.35, 1 - distance / (weapon.range * 1.1));
  const chance = skill.accuracy * rangeFactor * (target.crouching ? 0.85 : 1);
  if (Math.random() > chance) return;

  const headshot = Math.random() < 0.1;
  let damage = damageAtDistance(weapon, distance);
  if (headshot) damage *= 2;
  // Pellet weapons land a fraction of the full pattern rather than all or
  // nothing. The old code applied the fraction to one pellet, making a bot's
  // shotgun deal about five damage while the same human weapon dealt 120.
  if (weapon.pellets > 1) damage *= weapon.pellets * (0.35 + Math.random() * 0.4);

  const occupiedVehicle = target.vehicleId != null
    ? room.vehicles?.find(
      (vehicle) => vehicle.index === target.vehicleId
        && vehicle.driverId === target.id && !vehicle.destroyed,
    )
    : null;
  if (occupiedVehicle) {
    // The rover body is in front of its occupant. Bots use the same durability
    // path as humans instead of magically shooting through the chassis.
    room.damageVehicle(occupiedVehicle, bot, Math.round(damage));
  } else {
    room.applyDamage(target, bot, Math.round(damage), bot.weapon, headshot);
  }
}
