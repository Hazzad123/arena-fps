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
  PLAYER_HEIGHT,
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

/**
 * Fresh battle-royale state. The zone starts centred on the map and only begins
 * closing after the drop grace, so nobody is taking damage while they're still
 * running inland.
 */
export function createBrState(map) {
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
    loot,
    zone: {
      centre: [0, 0],
      radius: BR_START_RADIUS,
      // Where it's heading, and when it gets there.
      targetCentre: [0, 0],
      targetRadius: BR_START_RADIUS,
      phase: -1, // -1 is the drop grace
      state: 'hold',
      nextAt: Date.now() + BR_DROP_MS,
      dps: 0,
    },
    winnerId: null,
  };
}

export function lootList(br) {
  const out = [];
  for (const item of br.loot.values()) {
    if (item.taken) continue;
    out.push({ i: item.index, p: item.pos, w: item.weaponId, t: item.tier });
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
    dps: z.dps,
  };
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

  if (z.state === 'hold' && now >= z.nextAt) {
    const next = BR_ZONE_PHASES[z.phase + 1];
    if (next) {
      z.phase += 1;
      z.state = 'shrink';
      z.shrinkFrom = { centre: [...z.centre], radius: z.radius };
      z.targetRadius = next.radius;
      // Pull the new centre somewhere inside the current circle, so the safe area
      // drifts rather than always closing on the middle. Kept well inside so the
      // next circle is always fully contained by this one.
      const drift = Math.max(0, z.radius - next.radius) * 0.45;
      const a = Math.random() * Math.PI * 2;
      z.targetCentre = [
        z.centre[0] + Math.cos(a) * drift * Math.random(),
        z.centre[1] + Math.sin(a) * drift * Math.random(),
      ];
      z.shrinkStart = now;
      z.nextAt = now + next.shrinkMs;
      z.dps = next.dps;
      changed = true;
    } else {
      z.nextAt = now + 5000; // final circle: stays put
    }
  } else if (z.state === 'shrink') {
    const phase = BR_ZONE_PHASES[z.phase];
    const span = Math.max(1, phase.shrinkMs);
    const t = Math.min(1, (now - z.shrinkStart) / span);
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
      z.nextAt = now + phase.holdMs;
      changed = true;
    }
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
 * humans find rifles — twenty-nine opponents who cannot meaningfully shoot back,
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

    item.taken = true;
    bot.primaryId = item.weaponId;
    bot.inventory = [item.weaponId, 'pistol', 'knife'];
    bot.weapon = item.weaponId;
    room.broadcast(S2C.LOOT, { taken: [item.index] });
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

  // Still holding the starting pistol: go and find something, as long as it's
  // inside the circle.
  if (bot.inventory?.[0] === 'pistol') {
    let best = null;
    for (const item of br.loot.values()) {
      if (item.taken) continue;
      const ix = item.pos[0] - z.centre[0];
      const iz = item.pos[2] - z.centre[1];
      if (Math.hypot(ix, iz) > z.radius * 0.9) continue; // don't run into the wall
      const d = Math.hypot(item.pos[0] - bot.pos[0], item.pos[2] - bot.pos[2]);
      if (d > 70) continue;
      if (!best || d < best.d) best = { d, pos: item.pos };
    }
    if (best) return [best.pos[0], bot.pos[1], best.pos[2]];
  }

  // Comfortably inside: wander freely.
  if (dist < z.radius * 0.62) return null;

  // Otherwise head for a random point well within the safe circle.
  const a = Math.random() * Math.PI * 2;
  const r = z.radius * 0.45 * Math.random();
  return [z.centre[0] + Math.cos(a) * r, bot.pos[1], z.centre[1] + Math.sin(a) * r];
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
  item.taken = true;

  // The gun on the ground becomes your primary; the old one is gone.
  player.primaryId = item.weaponId;
  player.inventory = [item.weaponId, 'pistol', 'knife'];
  player.weapon = item.weaponId;

  room.broadcast(S2C.LOOT, { taken: [item.index] });
  room.sendTo(player, S2C.LOADOUT, {
    inventory: player.inventory,
    weapon: player.weapon,
    picked: getWeapon(item.weaponId).name,
    tier: item.tier,
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
