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
  PLAYER_HEIGHT, PLAYER_RADIUS, WALK_SPEED, GRAVITY, MAX_FALL_SPEED,
  JUMP_VELOCITY, MAX_HEALTH,
} from '../shared/constants.js';
import { FLAG } from '../shared/protocol.js';
import { moveAndCollide, hasLineOfSight } from '../shared/collision.js';
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
    },
  };
}

/** Where an AI should head next. Overridable per mode (BR pulls toward the zone). */
function pickWaypoint(room, bot) {
  const map = room.map;
  const hint = room.aiWaypointHint?.(bot);
  if (hint) return hint;

  const points = map.spawns.ffa ?? map.spawns.A;
  const p = points[Math.floor(Math.random() * points.length)];
  return [p[0] + (Math.random() - 0.5) * 10, p[1], p[2] + (Math.random() - 0.5) * 10];
}

/** Nearest enemy this AI can actually see. */
function acquireTarget(room, bot) {
  const eye = eyeOf(bot);
  let best = null;

  for (const other of room.players.values()) {
    if (other === bot || !other.alive) continue;
    if (!room.aiCanTarget(bot, other)) continue;
    if (other.spawnProtectedUntil > Date.now()) continue;

    const centre = [other.pos[0], other.pos[1] + PLAYER_HEIGHT * 0.58, other.pos[2]];
    const d = dist3(eye, centre);
    const weapon = getWeapon(bot.weapon);
    if (d > weapon.range * 0.85) continue;
    if (!hasLineOfSight(eye, centre, room.map.solids)) continue;
    if (!best || d < best.d) best = { other, d, centre };
  }
  return best;
}

function eyeOf(p) {
  return [p.pos[0], p.pos[1] + PLAYER_HEIGHT - 0.15, p.pos[2]];
}

function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
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

  // ---- target acquisition ----
  const found = acquireTarget(room, bot);
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
  if (!ai.waypoint || now > ai.repathAt) {
    ai.waypoint = pickWaypoint(room, bot);
    ai.repathAt = now + 6000 + Math.random() * 6000;
  }

  // Close in on a target, but stop at a sensible fighting distance rather than
  // walking into their face.
  let goal = ai.waypoint;
  if (engaging && ai.lastSeen) {
    const preferred = preferredRange(bot);
    const d = Math.hypot(ai.lastSeen[0] - bot.pos[0], ai.lastSeen[2] - bot.pos[2]);
    if (d > preferred) goal = [ai.lastSeen[0], bot.pos[1], ai.lastSeen[2]];
    else goal = null; // hold position and shoot
  }

  const speed = engaging ? WALK_SPEED * 0.85 : WALK_SPEED;
  if (goal) {
    const dx = goal[0] - bot.pos[0];
    const dz = goal[2] - bot.pos[2];
    const d = Math.hypot(dx, dz);
    if (d < 1.5) {
      ai.waypoint = null;
      ai.vel[0] = 0;
      ai.vel[2] = 0;
    } else {
      ai.vel[0] = (dx / d) * speed;
      ai.vel[2] = (dz / d) * speed;
      if (!engaging) {
        // Face the way you're walking when you've nothing to shoot at.
        ai.aimYaw = turnToward(ai.aimYaw, Math.atan2(-dx / d, -dz / d), skill.aimSpeed * dt);
        bot.yaw = ai.aimYaw;
        bot.pitch = 0;
      }
    }
  } else {
    ai.vel[0] = 0;
    ai.vel[2] = 0;
  }

  ai.vel[1] = Math.max(-MAX_FALL_SPEED, ai.vel[1] + GRAVITY * dt);

  const before = [...bot.pos];
  const state = { pos: bot.pos, vel: ai.vel, onGround: ai.onGround };
  moveAndCollide(state, dt, room.map.solids, PLAYER_HEIGHT, PLAYER_RADIUS);
  ai.onGround = state.onGround;

  // Wedged: jump, then pick somewhere else.
  const moved = Math.hypot(bot.pos[0] - before[0], bot.pos[2] - before[2]);
  if (goal && moved < 0.008) {
    ai.stuckFor += dt;
    if (ai.stuckFor > 0.3 && ai.onGround) ai.vel[1] = JUMP_VELOCITY;
    if (ai.stuckFor > 1.1) {
      ai.waypoint = null;
      ai.stuckFor = 0;
    }
  } else {
    ai.stuckFor = 0;
  }

  bot.flags = (ai.onGround ? 0 : FLAG.AIRBORNE) | (engaging ? FLAG.FIRING : 0);
  bot.lastStateAt = now;

  // ---- shooting ----
  if (engaging && now >= ai.nextShotAt) shoot(room, bot, target, skill, now);
}

/** How close this weapon wants to be. */
function preferredRange(bot) {
  switch (bot.weapon) {
    case 'shotgun': return 6;
    case 'smg': return 11;
    case 'sniper': return 40;
    case 'dmr': return 30;
    case 'lmg': return 20;
    case 'knife': return 1.6;
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
  const centre = [target.pos[0], target.pos[1] + PLAYER_HEIGHT * 0.58, target.pos[2]];
  const distance = dist3(eye, centre);
  if (distance > weapon.range) return;
  if (!hasLineOfSight(eye, centre, room.map.solids)) return;

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
  // Pellet weapons land a fraction of their pellets rather than all or nothing.
  if (weapon.pellets > 1) damage *= 0.35 + Math.random() * 0.4;

  room.applyDamage(target, bot, Math.round(damage), bot.weapon, headshot);
}
