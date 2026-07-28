// Weapon stats. All hitscan — no projectile simulation, which keeps the netcode
// simple and makes shooting feel direct.
//
// Time-to-kill is the number that matters most; against 100 HP the intent is:
//   rifle   4 shots @ 600rpm  ≈ 300ms   the all-rounder
//   smg     6 shots @ 900rpm  ≈ 333ms   faster, but punishes poor aim
//   pistol  4 shots @ 400rpm  ≈ 450ms   the gun-game starter
//   shotgun 1 shot up close, useless past ~12m
//   sniper  1 shot to the body anywhere
//   knife   always lethal, if you can reach
//
// Damage falls off linearly between falloffStart and falloffEnd, down to
// damage * falloffFloor. Past `range` a shot does nothing at all.

export const WEAPONS = {
  pistol: {
    id: 'pistol',
    name: 'Sidearm',
    slot: 2,
    auto: false,
    damage: 30,
    rpm: 400,
    pellets: 1,
    spread: 0.5, // degrees of cone, hip-fired
    adsSpread: 0.1,
    mag: 12,
    reloadMs: 1200,
    range: 60,
    falloffStart: 20,
    falloffEnd: 45,
    falloffFloor: 0.6,
    recoil: { up: 1.5, side: 0.5, recoverPerSec: 9 },
    adsZoom: 1.15,
    adsSensitivity: 0.93,
    moveMult: 1.0,
    viewColor: 0x3a3a42,
    tracerColor: 0xffe08a,
    audio: { kind: 'crack', freq: 340, decay: 0.11, gain: 0.35 },
  },

  smg: {
    id: 'smg',
    name: 'SMG',
    slot: 3,
    auto: true,
    damage: 18,
    rpm: 900,
    pellets: 1,
    spread: 2.2,
    adsSpread: 0.9,
    mag: 32,
    reloadMs: 1600,
    range: 70,
    falloffStart: 14,
    falloffEnd: 34,
    falloffFloor: 0.5,
    recoil: { up: 0.9, side: 0.55, recoverPerSec: 11 },
    adsZoom: 1.2,
    adsSensitivity: 0.91,
    moveMult: 1.0,
    viewColor: 0x4a4a52,
    tracerColor: 0xfff0b0,
    audio: { kind: 'crack', freq: 300, decay: 0.08, gain: 0.3 },
  },

  shotgun: {
    id: 'shotgun',
    name: 'Shotgun',
    slot: 4,
    auto: false,
    damage: 15,
    rpm: 75,
    pellets: 8, // 120 damage inside falloffStart — a clean one-shot
    spread: 4.5,
    adsSpread: 3.2,
    mag: 6,
    reloadMs: 2400,
    range: 26,
    falloffStart: 7,
    falloffEnd: 20,
    falloffFloor: 0.18,
    recoil: { up: 4.2, side: 1.1, recoverPerSec: 7 },
    adsZoom: 1.05,
    adsSensitivity: 0.97,
    moveMult: 0.96,
    viewColor: 0x5a3e2a,
    tracerColor: 0xffd48a,
    audio: { kind: 'boom', freq: 150, decay: 0.22, gain: 0.5 },
  },

  rifle: {
    id: 'rifle',
    name: 'Assault Rifle',
    slot: 5,
    auto: true,
    damage: 25,
    rpm: 600,
    pellets: 1,
    spread: 1.5,
    adsSpread: 0.35,
    mag: 30,
    reloadMs: 1900,
    range: 110,
    falloffStart: 30,
    falloffEnd: 70,
    falloffFloor: 0.6,
    recoil: { up: 1.35, side: 0.42, recoverPerSec: 10 },
    adsZoom: 1.35,
    adsSensitivity: 0.81,
    moveMult: 0.97,
    viewColor: 0x38403a,
    tracerColor: 0xfff2c0,
    audio: { kind: 'crack', freq: 260, decay: 0.1, gain: 0.4 },
  },

  sniper: {
    id: 'sniper',
    name: 'Sniper',
    slot: 6,
    auto: false,
    damage: 100,
    rpm: 45,
    pellets: 1,
    spread: 3.0, // hip-firing a sniper should not work
    adsSpread: 0.0,
    mag: 5,
    reloadMs: 2800,
    range: 220,
    falloffStart: 220,
    falloffEnd: 220,
    falloffFloor: 1.0,
    recoil: { up: 6.0, side: 0.8, recoverPerSec: 5 },
    adsZoom: 4.0,
    adsSensitivity: 0.34, // 4x optic: without this the scope is unusable
    moveMult: 0.9,
    viewColor: 0x2e3540,
    tracerColor: 0xbfe4ff,
    audio: { kind: 'boom', freq: 190, decay: 0.3, gain: 0.55 },
  },

  lmg: {
    id: 'lmg',
    name: 'Support LMG',
    slot: 7,
    auto: true,
    damage: 22,
    rpm: 700,
    pellets: 1,
    spread: 3.4, // punishing from the hip; it wants to be aimed or braced
    adsSpread: 0.7,
    mag: 75,
    reloadMs: 3600, // the trade for the belt: you do not want to run dry
    range: 120,
    falloffStart: 34,
    falloffEnd: 80,
    falloffFloor: 0.65,
    recoil: { up: 1.1, side: 0.7, recoverPerSec: 7 },
    adsZoom: 1.25,
    adsSensitivity: 0.88,
    moveMult: 0.88, // heavy
    viewColor: 0x3d4238,
    tracerColor: 0xffe49a,
    audio: { kind: 'boom', freq: 210, decay: 0.13, gain: 0.45 },
  },

  dmr: {
    id: 'dmr',
    name: 'Marksman',
    slot: 8,
    auto: false,
    damage: 55, // two taps to the body, one to the head
    rpm: 260,
    pellets: 1,
    spread: 1.9,
    adsSpread: 0.05,
    mag: 10,
    reloadMs: 2100,
    range: 170,
    falloffStart: 70,
    falloffEnd: 140,
    falloffFloor: 0.72,
    recoil: { up: 3.1, side: 0.5, recoverPerSec: 6.5 },
    adsZoom: 2.2,
    adsSensitivity: 0.58,
    moveMult: 0.94,
    viewColor: 0x4a4034,
    tracerColor: 0xcfe8ff,
    audio: { kind: 'crack', freq: 230, decay: 0.16, gain: 0.48 },
  },

  knife: {
    id: 'knife',
    name: 'Knife',
    slot: 1,
    auto: false,
    damage: 150,
    rpm: 130,
    pellets: 1,
    spread: 0,
    adsSpread: 0,
    mag: Infinity,
    reloadMs: 0,
    range: 2.4,
    falloffStart: 2.4,
    falloffEnd: 2.4,
    falloffFloor: 1.0,
    recoil: { up: 0.4, side: 0.3, recoverPerSec: 14 },
    adsZoom: 1.0,
    adsSensitivity: 1.0, // no optic, no change
    moveMult: 1.06, // knife out, run faster
    viewColor: 0x9aa0a8,
    tracerColor: 0x000000,
    audio: { kind: 'swipe', freq: 700, decay: 0.09, gain: 0.25 },
  },
};

/**
 * Gun Game progression. First player to get a kill with the knife wins.
 *
 * Deliberately does NOT include the LMG or Marksman: eight rungs makes the mode
 * drag past a three-minute round. They're available in the practice range and
 * anywhere loadouts are chosen.
 */
export const GUNGAME_LADDER = ['pistol', 'smg', 'shotgun', 'rifle', 'sniper', 'knife'];

/**
 * Classes: a primary, and the sidearm and knife everyone gets.
 *
 * The primary is the whole decision. Giving each class a different pistol or a
 * different knife would be six more numbers to tune and nobody would feel any of
 * them, whereas the primary changes the range you want to fight at, which is the
 * only thing a class in an arena shooter needs to do.
 *
 * Ordered by the number key that selects them.
 */
export const CLASSES = {
  assault: {
    id: 'assault',
    name: 'Assault',
    blurb: 'The all-rounder. Good everywhere, best nowhere.',
    primary: 'rifle',
  },
  scout: {
    id: 'scout',
    name: 'Scout',
    blurb: 'Fastest gun in the game. Punishes loose aim.',
    primary: 'smg',
  },
  breacher: {
    id: 'breacher',
    name: 'Breacher',
    blurb: 'One shot inside 7m. Nothing at all past 20m.',
    primary: 'shotgun',
  },
  marksman: {
    id: 'marksman',
    name: 'Marksman',
    blurb: 'Two body shots, or one to the head.',
    primary: 'dmr',
  },
  recon: {
    id: 'recon',
    name: 'Recon',
    blurb: 'One shot anywhere, if you can hold an angle.',
    primary: 'sniper',
  },
  support: {
    id: 'support',
    name: 'Support',
    blurb: '75 rounds without reloading. Slow to carry.',
    primary: 'lmg',
  },
};

export const CLASS_IDS = Object.keys(CLASSES);
export const DEFAULT_CLASS = 'assault';

/** Unknown ids fall back rather than throwing — this arrives over the wire. */
export function getClass(id) {
  return CLASSES[id] ?? CLASSES[DEFAULT_CLASS];
}

/** The three weapons a class spawns holding, primary first. */
export function loadoutForClass(id) {
  return [getClass(id).primary, 'pistol', 'knife'];
}

/** Everything the practice range unlocks, in number-key order. */
export const ALL_WEAPON_IDS = Object.keys(WEAPONS).sort((a, b) => WEAPONS[a].slot - WEAPONS[b].slot);

export function getWeapon(id) {
  const w = WEAPONS[id];
  if (!w) throw new Error(`unknown weapon: ${id}`);
  return w;
}

/** Milliseconds between shots. */
export function fireIntervalMs(weapon) {
  return 60_000 / weapon.rpm;
}

/**
 * Damage a single pellet does at a given distance, before hit-zone multipliers.
 * Shared so the client can predict the hitmarker and the server can agree.
 */
export function damageAtDistance(weapon, distance) {
  if (distance > weapon.range) return 0;
  if (distance <= weapon.falloffStart) return weapon.damage;

  const span = weapon.falloffEnd - weapon.falloffStart;
  if (span <= 0) return weapon.damage * weapon.falloffFloor;

  const t = Math.min(1, (distance - weapon.falloffStart) / span);
  const mult = 1 + (weapon.falloffFloor - 1) * t;
  return weapon.damage * mult;
}
