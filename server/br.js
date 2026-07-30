// Battle royale: the closing zone and the ground loot.
//
// Both are server-authoritative for the same reason everything else is — the zone
// deals damage and the loot changes what you're holding. The client draws the
// circle it's told about and asks to pick up the loot it's standing on; it decides
// neither.
//
// Kept out of room.js because it's a self-contained subsystem with its own state
// machine, and room.js is already the longest file in the project.

import {
  BR_ZONE_PHASES, BR_START_RADIUS, BR_DROP_MS, BR_LOOT_COUNT, BR_LOOT_RADIUS,
  BR_COMBAT_GRACE_MS, PLAYER_HEIGHT,
} from '../shared/constants.js';
import { S2C } from '../shared/protocol.js';
import { PRIMARY_IDS, WEAPONS, getWeapon } from '../shared/weapons.js';

/**
 * Loot tiers. Everyone lands with a pistol, so the ladder upward has to be worth
 * climbing: commons are a sidestep, rares are a real upgrade, and there is exactly
 * one thing on the island that one-shots.
 */
const LOOT_TIERS = [
  {
    name: 'common',
    weight: 0.5,
    guns: ['machinepistol', 'revolver', 'smg_compact', 'sawnoff', 'carbine'],
  },
  {
    name: 'rare',
    weight: 0.35,
    guns: ['smg', 'smg_heavy', 'shotgun', 'autoshotgun', 'rifle', 'dmr'],
  },
  {
    name: 'epic',
    weight: 0.15,
    guns: ['bullpup', 'lmg', 'sniper', 'antimateriel'],
  },
];

function rollTier() {
  let r = Math.random();
  for (const tier of LOOT_TIERS) {
    if (r < tier.weight) return tier;
    r -= tier.weight;
  }
  return LOOT_TIERS[LOOT_TIERS.length - 1];
}

function rollGun() {
  const tier = rollTier();
  const pool = tier.guns.filter((id) => PRIMARY_IDS.includes(id) && WEAPONS[id]);
  const id = pool[Math.floor(Math.random() * pool.length)];
  return { id, tier: tier.name };
}

function tierForGun(weaponId) {
  return LOOT_TIERS.find((tier) => tier.guns.includes(weaponId))?.name ?? 'common';
}

function lootPayload(item) {
  return { i: item.index, p: item.pos, w: item.weaponId, t: item.tier };
}

/**
 * Fresh battle-royale state. The zone starts centred on the map and only begins
 * closing after the drop grace, so nobody is taking damage while they're still
 * running inland.
 */
export function createBrState(map) {
  const now = Date.now();
  const points = [...map.lootPoints];
  // Shuffle and take a subset, so the same island has different loot each match
  // even though the *positions* are fixed and learnable.
  for (let i = points.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [points[i], points[j]] = [points[j], points[i]];
  }

  const loot = new Map();
  for (const point of points.slice(0, Math.min(BR_LOOT_COUNT, points.length))) {
    const { id, tier } = rollGun();
    loot.set(point.index, { index: point.index, pos: point.pos, weaponId: id, tier, taken: false });
  }

  return {
    startedAt: now,
    combatStartsAt: now + BR_COMBAT_GRACE_MS,
    loot,
    zone: {
      centre: [0, 0],
      radius: BR_START_RADIUS,
      // Where it's heading, and when it gets there.
      targetCentre: [0, 0],
      targetRadius: BR_START_RADIUS,
      phase: -1, // -1 is the drop grace
      state: 'hold',
      elapsedMs: 0,
      durationMs: BR_DROP_MS,
      lastTickAt: now,
      nextAt: now + BR_DROP_MS,
      pace: 1,
      dps: 0,
    },
    winnerId: null,
  };
}

export function lootList(br) {
  const out = [];
  for (const item of br.loot.values()) {
    if (item.taken) continue;
    out.push(lootPayload(item));
  }
  return out;
}

export function zonePayload(br, now = Date.now()) {
  const z = br.zone;
  return {
    centre: z.centre,
    radius: Math.round(z.radius * 10) / 10,
    targetCentre: z.targetCentre,
    targetRadius: Math.round(z.targetRadius * 10) / 10,
    state: z.state,
    phase: z.phase,
    msToNext: Math.max(0, z.nextAt - now),
    combatMs: Math.max(0, br.combatStartsAt - now),
    pace: z.pace,
    dps: z.dps,
  };
}

/** The final squads should be forced together instead of searching a huge island. */
export function zonePaceForAlive(alive) {
  if (alive <= 6) return 3.1;
  if (alive <= 12) return 2.35;
  if (alive <= 18) return 1.7;
  if (alive <= 24) return 1.3;
  return 1;
}

function targetPhaseForAlive(alive) {
  if (alive <= 6) return 4;
  if (alive <= 12) return 3;
  if (alive <= 18) return 2;
  if (alive <= 24) return 1;
  return 0;
}

function beginShrink(z, phase, now) {
  const next = BR_ZONE_PHASES[phase];
  z.phase = phase;
  z.state = 'shrink';
  z.elapsedMs = 0;
  z.durationMs = Math.max(1, next.shrinkMs);
  z.shrinkFrom = { centre: [...z.centre], radius: z.radius };
  z.targetRadius = next.radius;
  const drift = Math.max(0, z.radius - next.radius) * 0.45;
  const a = Math.random() * Math.PI * 2;
  z.targetCentre = [
    z.centre[0] + Math.cos(a) * drift * Math.random(),
    z.centre[1] + Math.sin(a) * drift * Math.random(),
  ];
  z.dps = next.dps;
  z.nextAt = now + z.durationMs / z.pace;
}

/**
 * Advance the zone and apply damage to anyone outside it.
 *
 * `room` is passed in rather than this living on Room because everything it needs
 * is public: players, applyDamage and broadcast.
 */
export function tickZone(room, br, now) {
  const z = br.zone;
  let changed = false;
  const alive = aliveCount(room);
  z.pace = zonePaceForAlive(alive);
  const realElapsed = Math.max(0, Math.min(1000, now - (z.lastTickAt ?? now)));
  z.lastTickAt = now;
  z.elapsedMs = (z.elapsedMs ?? 0) + realElapsed * z.pace;

  if (z.state === 'hold' && z.elapsedMs >= z.durationMs) {
    const desired = Math.max(z.phase + 1, targetPhaseForAlive(alive));
    if (BR_ZONE_PHASES[desired]) {
      beginShrink(z, desired, now);
      changed = true;
    } else {
      z.elapsedMs = 0;
      z.durationMs = 5000;
      z.nextAt = now + 5000 / z.pace;
    }
  } else if (z.state === 'shrink') {
    const phase = BR_ZONE_PHASES[z.phase];
    const t = Math.min(1, z.elapsedMs / Math.max(1, z.durationMs));
    // Smoothstep, so the wall eases in and out rather than lurching.
    const e = t * t * (3 - 2 * t);
    z.radius = z.shrinkFrom.radius + (z.targetRadius - z.shrinkFrom.radius) * e;
    z.centre = [
      z.shrinkFrom.centre[0] + (z.targetCentre[0] - z.shrinkFrom.centre[0]) * e,
      z.shrinkFrom.centre[1] + (z.targetCentre[1] - z.shrinkFrom.centre[1]) * e,
    ];
    changed = true;

    if (t >= 1) {
      z.state = 'hold';
      z.elapsedMs = 0;
      z.durationMs = Math.max(1, phase.holdMs);
      z.nextAt = now + z.durationMs / z.pace;
      changed = true;
    }
  }

  if (z.state === 'hold' || z.state === 'shrink') {
    z.nextAt = now + Math.max(0, z.durationMs - z.elapsedMs) / z.pace;
  }

  // Damage outside. Applied per tick so it's a steady drain rather than a spike.
  if (z.dps > 0) {
    const perTick = (z.dps * room.tickMs) / 1000;
    for (const player of room.players.values()) {
      if (!player.alive) continue;
      const dx = player.pos[0] - z.centre[0];
      const dz = player.pos[2] - z.centre[1];
      if (Math.hypot(dx, dz) <= z.radius) continue;
      room.applyDamage(player, null, perTick, 'zone');
    }
  }

  return changed;
}

/**
 * Rank a gun for an AI deciding whether to swap. Crude on purpose — a bot doesn't
 * need to understand range bands, it needs to prefer a rifle to a pistol.
 */
function gunScore(weaponId) {
  const w = getWeapon(weaponId);
  const perShot = w.damage * w.pellets;
  // Sustained damage, discounted for anything with almost no reach.
  const dps = perShot * (w.rpm / 60);
  const reachFactor = Math.min(1, w.falloffEnd / 60);
  return dps * (0.45 + reachFactor * 0.55);
}

/**
 * Let AI pick up loot they happen to be standing near, if it beats what they hold.
 *
 * Without this, every bot spends the whole match on the starting pistol while the
 * humans find rifles — dozens of opponents who cannot meaningfully shoot back,
 * which makes the mode trivial rather than tense.
 */
export function aiConsiderLoot(room, br, bot) {
  const holding = bot.inventory?.[0];
  const holdingScore = holding ? gunScore(holding) : 0;

  for (const item of br.loot.values()) {
    if (item.taken) continue;
    const d = Math.hypot(
      bot.pos[0] - item.pos[0],
      bot.pos[2] - item.pos[2],
    );
    // Slightly more generous than a human's reach: bots don't aim at the ground,
    // they just walk over things.
    if (d > BR_LOOT_RADIUS + 1.4) continue;
    if (gunScore(item.weaponId) <= holdingScore) continue;

    const dropped = holding;
    bot.primaryId = item.weaponId;
    bot.inventory = [item.weaponId, 'pistol', 'knife'];
    bot.weapon = item.weaponId;
    // Swap, don't delete: whatever the bot was carrying remains available to
    // the rest of the match at the exact place the exchange happened.
    item.weaponId = dropped;
    item.tier = tierForGun(dropped);
    item.pos = [bot.pos[0], bot.pos[1], bot.pos[2]];
    item.taken = false;
    room.broadcast(S2C.LOOT, { upsert: [lootPayload(item)] });
    return item;
  }
  return null;
}

/**
 * Where an AI should head. Bots must respect the zone or they'd all die in it and
 * the match would end with a human standing in a field.
 *
 * Early on they detour toward loot, because a bot that beelines for the centre with
 * a pistol is not an opponent.
 */
export function aiZoneWaypoint(br, bot) {
  const z = br.zone;
  const dx = bot.pos[0] - z.centre[0];
  const dz = bot.pos[2] - z.centre[1];
  const dist = Math.hypot(dx, dz);

  // Seek a meaningful upgrade, not merely the nearest object. This lets bots
  // replace a weak common later and stops them walking past an epic rifle just
  // because they already found an SMG.
  const holdingScore = gunScore(bot.inventory?.[0] ?? 'pistol');
  const urgent = aiNeedsZone(br, bot);
  if (!urgent && z.phase < 3) {
    let best = null;
    for (const item of br.loot.values()) {
      if (item.taken) continue;
      const improvement = gunScore(item.weaponId) - holdingScore;
      if (improvement <= holdingScore * 0.08) continue;
      const ix = item.pos[0] - z.centre[0];
      const iz = item.pos[2] - z.centre[1];
      if (Math.hypot(ix, iz) > z.radius * 0.9) continue; // don't run into the wall
      const d = Math.hypot(item.pos[0] - bot.pos[0], item.pos[2] - bot.pos[2]);
      if (d > 130) continue;
      const utility = improvement / Math.max(8, d);
      if (!best || utility > best.utility) best = { utility, pos: item.pos };
    }
    if (best) return [best.pos[0], bot.pos[1], best.pos[2]];
  }

  // Never hand control back to the generic shoreline wanderer. Even while safe,
  // a BR bot chooses another point in the playable circle so it cannot casually
  // march back into the storm.
  const safeRadius = Math.max(4, Math.min(z.radius, z.targetRadius ?? z.radius) * (urgent ? 0.38 : 0.66));
  const a = Math.random() * Math.PI * 2;
  const r = safeRadius * (urgent ? 0.35 : Math.sqrt(Math.random()));
  const centre = z.state === 'shrink' ? z.targetCentre : z.centre;
  return [centre[0] + Math.cos(a) * r, bot.pos[1], centre[1] + Math.sin(a) * r];
}

/** Outside, near the edge, or unable to reach the next circle at walking pace. */
export function aiNeedsZone(br, bot) {
  const z = br.zone;
  const centre = z.state === 'shrink' ? z.targetCentre : z.centre;
  const safeRadius = Math.min(z.radius, z.targetRadius ?? z.radius);
  const distance = Math.hypot(bot.pos[0] - centre[0], bot.pos[2] - centre[1]);
  const seconds = Math.max(0, z.nextAt - Date.now()) / 1000;
  return distance > safeRadius * 0.72 || distance - safeRadius * 0.55 > seconds * 5.4;
}

/**
 * Try to pick up loot near a player. Returns the item taken, or null.
 *
 * Swaps the primary slot only — your sidearm and knife are never lost, so a bad
 * pickup can't disarm you.
 */
export function takeLoot(room, br, player) {
  if (!player.alive) return null;

  let best = null;
  for (const item of br.loot.values()) {
    if (item.taken) continue;
    const d = Math.hypot(
      player.pos[0] - item.pos[0],
      (player.pos[1] + PLAYER_HEIGHT * 0.3) - item.pos[1],
      player.pos[2] - item.pos[2],
    );
    if (d > BR_LOOT_RADIUS + 0.6) continue;
    if (!best || d < best.d) best = { item, d };
  }
  if (!best) return null;

  const item = best.item;
  const dropped = player.inventory?.[0] ?? 'pistol';
  const pickedId = item.weaponId;
  const pickedTier = item.tier;

  // The gun on the ground becomes your primary, and the old primary takes its
  // place in the world. A loot route therefore evolves instead of being erased.
  player.primaryId = item.weaponId;
  player.inventory = [item.weaponId, 'pistol', 'knife'];
  player.weapon = item.weaponId;

  item.weaponId = dropped;
  item.tier = tierForGun(dropped);
  item.pos = [player.pos[0], player.pos[1], player.pos[2]];
  item.taken = false;
  room.broadcast(S2C.LOOT, { upsert: [lootPayload(item)] });
  room.sendTo(player, S2C.LOADOUT, {
    inventory: player.inventory,
    weapon: player.weapon,
    picked: getWeapon(pickedId).name,
    tier: pickedTier,
  });
  return item;
}

/** Everyone still standing. Battle royale has no respawns, so this is the score. */
export function aliveCount(room) {
  let n = 0;
  for (const p of room.players.values()) if (p.alive) n++;
  return n;
}

/** The last player standing, or null while more than one remains. */
export function soleSurvivor(room) {
  let found = null;
  for (const p of room.players.values()) {
    if (!p.alive) continue;
    if (found) return null;
    found = p;
  }
  return found;
}

export { LOOT_TIERS };
