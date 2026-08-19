// Weapon stats. All hitscan — no projectile simulation, which keeps the netcode
// simple and makes shooting feel direct.
//
// Damage falls off linearly between falloffStart and falloffEnd, down to
// damage * falloffFloor. Past `range` a shot does nothing at all.
//
// BALANCE
//
// Time-to-kill against 100HP is the number that matters, and within each type the
// rule is: faster kill, shorter reach. Nothing should be strictly better than
// anything else of its own type — test/balance.test.js fails if it is.
//
//   type      gun            TTK    effective to
//   shotgun   Sawn-off        1 shot   4m      then nothing
//   shotgun   Pump            1 shot   7m      then nothing
//   shotgun   Auto           250ms    ~15m
//   rifle     Carbine        282ms    ~40m
//   smg       Compact SMG    286ms    ~25m
//   rifle     Assault Rifle  300ms    ~70m     the all-rounder
//   smg       SMG            316ms    ~35m
//   sniper    Marksman       316ms    150m     two body shots, or one head
//   pistol    Machine Pistol 327ms    ~24m
//   smg       Heavy SMG      343ms    ~45m
//   lmg       Support LMG    343ms    ~80m     and 75 rounds to do it with
//   rifle     Bullpup        353ms    130m
//   pistol    Revolver       400ms    ~55m
//   pistol    Sidearm        450ms    ~45m     the secondary everyone carries
//   sniper    Bolt / Anti-M   1 shot   any     the whole point of them
//   knife     Knife           1 hit    2.4m
//
// Historical note worth keeping: before the recoil ordering bug was fixed (shots
// were deflected by their own kick) only the rifle and SMG were viable, because
// they were the only guns whose recoil was small enough not to throw the shot.
// Any balance conclusion drawn before that fix is worthless.

export const WEAPONS = {
  pistol: {
    id: 'pistol',
    name: 'Sidearm',
    type: 'pistol',
    model: 'gltf:Pistol',
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
    type: 'smg',
    model: 'gltf:SMG',
    slot: 3,
    auto: true,
    damage: 18,
    rpm: 950,
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
    name: 'Pump Shotgun',
    type: 'shotgun',
    model: 'gltf:Shotgun',
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
    type: 'rifle',
    model: 'gltf:AK',
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
    name: 'Bolt Sniper',
    type: 'sniper',
    model: 'gltf:Sniper',
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
    type: 'lmg',
    model: 'gltf:ShortCannon',
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
    type: 'sniper',
    model: 'gltf:Sniper_2',
    slot: 8,
    auto: false,
    damage: 55, // two taps to the body, one to the head
    // Buffed on handling, not damage: two body shots was always the design, but
    // 3.1 degrees of kick recovering at 6.5/s meant the second shot landed
    // somewhere else entirely, so the class could never actually deliver it.
    rpm: 190, // deliberately slower TTK than the rifle — see the table below
    pellets: 1,
    spread: 1.9, // still poor from the hip — it's a marksman rifle
    adsSpread: 0.02,
    mag: 12,
    reloadMs: 1900,
    range: 170,
    falloffStart: 80,
    falloffEnd: 150,
    falloffFloor: 0.68, // still two shots a long way out, but not for free
    recoil: { up: 2.1, side: 0.35, recoverPerSec: 10 },
    adsZoom: 2.2,
    adsSensitivity: 0.58,
    moveMult: 0.97,
    viewColor: 0x4a4034,
    tracerColor: 0xcfe8ff,
    audio: { kind: 'crack', freq: 230, decay: 0.16, gain: 0.48 },
  },


  // ------------------------------------------------------------------- pistols

  revolver: {
    id: 'revolver',
    name: 'Revolver',
    type: 'pistol',
    model: 'obj:Revolver_1',
    slot: 2,
    auto: false,
    damage: 52, // two shots, or one to the head
    rpm: 150,
    pellets: 1,
    spread: 0.9,
    adsSpread: 0.15,
    mag: 6,
    reloadMs: 2000,
    range: 75,
    falloffStart: 26,
    falloffEnd: 55,
    falloffFloor: 0.7,
    recoil: { up: 3.2, side: 0.7, recoverPerSec: 8 },
    adsZoom: 1.25,
    adsSensitivity: 0.88,
    moveMult: 1.0,
    viewColor: 0x53433a,
    tracerColor: 0xffd08a,
    audio: { kind: 'boom', freq: 260, decay: 0.16, gain: 0.44 },
  },

  machinepistol: {
    id: 'machinepistol',
    name: 'Machine Pistol',
    type: 'pistol',
    model: 'obj:Pistol_4',
    slot: 2,
    auto: true,
    damage: 16,
    rpm: 1100, // absurd rate, no range at all
    pellets: 1,
    spread: 3.2,
    adsSpread: 1.5,
    mag: 26,
    reloadMs: 1400,
    range: 40,
    falloffStart: 9,
    falloffEnd: 24,
    falloffFloor: 0.4,
    recoil: { up: 0.85, side: 0.75, recoverPerSec: 13 },
    adsZoom: 1.1,
    adsSensitivity: 0.95,
    moveMult: 1.04,
    viewColor: 0x40434a,
    tracerColor: 0xfff0b0,
    audio: { kind: 'crack', freq: 380, decay: 0.06, gain: 0.26 },
  },

  // ---------------------------------------------------------------------- smgs

  smg_compact: {
    id: 'smg_compact',
    name: 'Compact SMG',
    type: 'smg',
    model: 'obj:SubmachineGun_3',
    slot: 3,
    auto: true,
    damage: 17,
    rpm: 1050, // fastest kill in the game inside a room
    pellets: 1,
    spread: 2.6,
    adsSpread: 1.1,
    mag: 30,
    reloadMs: 1450,
    range: 55,
    falloffStart: 11,
    falloffEnd: 28,
    falloffFloor: 0.45,
    recoil: { up: 0.8, side: 0.6, recoverPerSec: 12 },
    adsZoom: 1.15,
    adsSensitivity: 0.93,
    moveMult: 1.03,
    viewColor: 0x45484f,
    tracerColor: 0xfff0b0,
    audio: { kind: 'crack', freq: 320, decay: 0.07, gain: 0.29 },
  },

  smg_heavy: {
    id: 'smg_heavy',
    name: 'Heavy SMG',
    type: 'smg',
    model: 'obj:SubmachineGun_5',
    slot: 3,
    auto: true,
    damage: 23,
    rpm: 700, // slower than an SMG has any right to be, and hits like it
    pellets: 1,
    spread: 1.9,
    adsSpread: 0.6,
    mag: 25,
    reloadMs: 1800,
    range: 85,
    falloffStart: 20,
    falloffEnd: 45,
    falloffFloor: 0.55,
    recoil: { up: 1.2, side: 0.5, recoverPerSec: 10 },
    adsZoom: 1.25,
    adsSensitivity: 0.9,
    moveMult: 0.98,
    viewColor: 0x3d4046,
    tracerColor: 0xffe8a0,
    audio: { kind: 'crack', freq: 250, decay: 0.1, gain: 0.36 },
  },

  // ------------------------------------------------------------------- rifles

  carbine: {
    id: 'carbine',
    name: 'Carbine',
    type: 'rifle',
    model: 'obj:AssaultRifle2_1',
    slot: 5,
    auto: true,
    damage: 22,
    rpm: 850, // the fastest rifle, and the shortest-legged
    pellets: 1,
    spread: 1.7,
    adsSpread: 0.45,
    mag: 30,
    reloadMs: 1700,
    range: 95,
    falloffStart: 25,
    falloffEnd: 60,
    falloffFloor: 0.55,
    recoil: { up: 1.15, side: 0.4, recoverPerSec: 11 },
    adsZoom: 1.3,
    adsSensitivity: 0.83,
    moveMult: 1.0,
    viewColor: 0x3a3f38,
    tracerColor: 0xfff2c0,
    audio: { kind: 'crack', freq: 280, decay: 0.09, gain: 0.37 },
  },

  bullpup: {
    id: 'bullpup',
    name: 'Bullpup',
    type: 'rifle',
    model: 'obj:Bullpup_1',
    slot: 5,
    auto: true,
    damage: 28,
    rpm: 510, // slowest rifle, but four shots at almost any range
    pellets: 1,
    spread: 1.3,
    adsSpread: 0.22,
    mag: 24,
    reloadMs: 2100,
    range: 130,
    falloffStart: 42,
    falloffEnd: 95,
    falloffFloor: 0.72,
    recoil: { up: 1.6, side: 0.4, recoverPerSec: 9.5 },
    adsZoom: 1.45,
    adsSensitivity: 0.78,
    moveMult: 0.95,
    viewColor: 0x363b3a,
    tracerColor: 0xfff2c0,
    audio: { kind: 'crack', freq: 240, decay: 0.11, gain: 0.42 },
  },

  // ----------------------------------------------------------------- shotguns

  sawnoff: {
    id: 'sawnoff',
    name: 'Sawn-off',
    type: 'shotgun',
    model: 'obj:Shotgun_SawedOff',
    slot: 4,
    auto: false,
    damage: 20,
    rpm: 140, // two fast barrels, then a long reload
    pellets: 7,
    spread: 7.5,
    adsSpread: 6.0,
    mag: 2,
    reloadMs: 1900,
    range: 18,
    falloffStart: 4,
    falloffEnd: 13,
    falloffFloor: 0.1,
    recoil: { up: 5.5, side: 1.6, recoverPerSec: 7 },
    adsZoom: 1.0,
    adsSensitivity: 1.0,
    moveMult: 1.05, // the fastest thing you can carry
    viewColor: 0x5a3a26,
    tracerColor: 0xffd48a,
    audio: { kind: 'boom', freq: 135, decay: 0.24, gain: 0.52 },
  },

  autoshotgun: {
    id: 'autoshotgun',
    name: 'Auto Shotgun',
    type: 'shotgun',
    model: 'obj:Shotgun_ShortStock',
    slot: 4,
    auto: true,
    damage: 9,
    rpm: 240,
    pellets: 6, // 54 a shot up close: needs two, but they come fast
    spread: 5.2,
    adsSpread: 3.8,
    mag: 8,
    reloadMs: 2700,
    range: 24,
    falloffStart: 6,
    falloffEnd: 18,
    falloffFloor: 0.15,
    recoil: { up: 2.4, side: 0.9, recoverPerSec: 9 },
    adsZoom: 1.05,
    adsSensitivity: 0.97,
    moveMult: 0.97,
    viewColor: 0x4e3a2c,
    tracerColor: 0xffd48a,
    audio: { kind: 'boom', freq: 160, decay: 0.16, gain: 0.44 },
  },

  // ------------------------------------------------------------------ snipers

  antimateriel: {
    id: 'antimateriel',
    name: 'Anti-Materiel',
    type: 'sniper',
    model: 'obj:SniperRifle_6',
    slot: 6,
    auto: false,
    damage: 130, // lethal anywhere, and it goes through nothing you'd hope
    rpm: 32,
    pellets: 1,
    spread: 4.0, // hip-firing this is a joke
    adsSpread: 0.0,
    mag: 4,
    reloadMs: 3400,
    range: 260,
    falloffStart: 260,
    falloffEnd: 260,
    falloffFloor: 1.0,
    recoil: { up: 8.5, side: 1.2, recoverPerSec: 4 },
    adsZoom: 5.0,
    adsSensitivity: 0.27,
    moveMult: 0.84, // very heavy
    viewColor: 0x2a3038,
    tracerColor: 0xbfe4ff,
    audio: { kind: 'boom', freq: 150, decay: 0.42, gain: 0.6 },
  },

  knife: {
    id: 'knife',
    name: 'Knife',
    type: 'melee',
    model: 'gltf:Knife_1',
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
 * All eight weapons, ordered so the ladder keeps changing the range you want to
 * fight at rather than simply getting better: shotgun then marksman then rifle
 * makes you cross the map twice. The mode gets a longer round to suit (see
 * MODE_ROUND_MS) — with six rungs and three minutes it was usually decided by the
 * clock rather than by anyone finishing.
 */
export const GUNGAME_LADDER = [
  'pistol', 'smg', 'shotgun', 'dmr', 'rifle', 'lmg', 'sniper', 'knife',
];

/**
 * Weapon types, in the order they're offered.
 *
 * Classes used to be the unit of choice — six fixed bundles, each with a primary
 * you couldn't change. That put a layer of naming between the player and the only
 * decision that mattered: which gun am I holding. So the guns are the choice now,
 * and the type is just how they're grouped in the picker.
 */
export const WEAPON_TYPES = [
  { id: 'rifle', name: 'Assault Rifles', blurb: 'Good at everything, best at nothing.' },
  { id: 'smg', name: 'SMGs', blurb: 'Fast and close. Punishes loose aim.' },
  { id: 'shotgun', name: 'Shotguns', blurb: 'Lethal inside a room, useless outside one.' },
  { id: 'sniper', name: 'Snipers & Marksman', blurb: 'One angle, held patiently.' },
  { id: 'lmg', name: 'Support', blurb: 'A belt of ammunition and nowhere to be quickly.' },
  { id: 'pistol', name: 'Sidearms', blurb: 'A primary only if you like a challenge.' },
];

/** Every weapon of a type, in table order. */
export function weaponsOfType(type) {
  return Object.values(WEAPONS).filter((w) => w.type === type);
}

/**
 * Guns you can pick as your primary. The knife isn't one — everybody carries it —
 * and neither is the plain Sidearm, since it's the secondary everyone gets. The
 * other pistols are fair game if you want to handicap yourself.
 */
export const PRIMARY_IDS = Object.keys(WEAPONS).filter(
  (id) => WEAPONS[id].type !== 'melee' && id !== 'pistol',
);

export const DEFAULT_PRIMARY = 'rifle';

/** Unknown ids fall back rather than throwing — this arrives over the wire. */
export function getPrimary(id) {
  return PRIMARY_IDS.includes(id) ? id : DEFAULT_PRIMARY;
}

/**
 * What you spawn holding: your chosen primary, the standard sidearm, and a knife.
 * Slot order is the order of the number keys, so 1 is always your primary.
 */
export function loadoutForPrimary(id) {
  return [getPrimary(id), 'pistol', 'knife'];
}

// Table order, grouped by type — used by the practice range, which offers
// everything. Sorting by slot stopped meaning anything once several guns shared
// one slot.
export const ALL_WEAPON_IDS = WEAPON_TYPES.flatMap((t) => weaponsOfType(t.id).map((w) => w.id))
  .concat(Object.keys(WEAPONS).filter((id) => WEAPONS[id].type === 'melee'));

/**
 * Look up a weapon, throwing if it doesn't exist.
 *
 * Throwing is the right contract for our own code — a typo'd id should be loud —
 * but it is the wrong one for anything a client sent us. Use maybeWeapon() there.
 */
export function getWeapon(id) {
  const w = WEAPONS[id];
  if (!w) throw new Error(`unknown weapon: ${id}`);
  return w;
}

/**
 * Look up a weapon that may not exist, for ids that arrived over the wire.
 *
 * validate.js used getWeapon() and then checked the result for falsiness, which
 * cannot happen — getWeapon throws first. So the guards were dead code, and a shot
 * message naming a nonexistent weapon threw instead of being refused. Nothing
 * crashed, because handleMessage catches, but every such message wrote a stack
 * trace: at the 140-messages-a-second rate limit that is a cheap way to fill a
 * log. An unknown weapon should be a quiet "no", not an exception.
 */
export function maybeWeapon(id) {
  return typeof id === 'string' ? WEAPONS[id] ?? null : null;
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
