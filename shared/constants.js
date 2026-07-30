// Every number that affects how the game *feels* lives here or in weapons.js.
// Expect to tune these after the first real playtest.

// ---------------------------------------------------------------- simulation
export const PHYSICS_HZ = 60; // fixed step for movement integration
export const PHYSICS_DT = 1 / PHYSICS_HZ;
export const SERVER_TICK_HZ = 20; // snapshots server -> client
export const CLIENT_SEND_HZ = 30; // state client -> server
export const INTERP_DELAY_MS = 100; // how far in the past remotes are rendered

// ------------------------------------------------------------------- player
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_CROUCH_HEIGHT = 1.15;
// Metres per second that the player's height changes when crouching. 0.65m of
// travel at 4.2 m/s is about 155ms — quick enough to dodge with, slow enough to
// read as a movement rather than a teleport.
export const CROUCH_TRANSITION_SPEED = 4.2;
export const PLAYER_RADIUS = 0.4;
export const EYE_OFFSET = 0.15; // below the top of the head
export const PITCH_LIMIT = Math.PI / 2 - 0.02;
export const MAX_HEALTH = 100;

// Hitboxes are deliberately wider than the collision radius. Two different jobs:
// PLAYER_RADIUS decides where you can walk, these decide whether a shot connects.
// Being a little generous matters because you are shooting at a remote player
// rendered ~100ms in the past (see net.js) — the shooter shouldn't be punished for
// latency they can't see or correct for. Widening the hitbox is the cheap version
// of lag compensation.
export const HITBOX_RADIUS = 0.54; // vs PLAYER_RADIUS 0.4
export const HITBOX_HEAD_PAD = 0.12; // a little air above the crown still counts
export const EMOTE_COOLDOWN_MS = 1_200;

// ------------------------------------------------------------ explosive barrels
// Counted in *shots*, not damage, so a barrel takes the same two hits whether
// you're holding a pistol or an LMG — and so one shotgun blast isn't eight hits.
export const BARREL_HITS = 2;
export const BARREL_DAMAGE = 95; // at the centre; falls off linearly to 0
export const BARREL_RADIUS = 5.5;
export const BARREL_CHAIN_RADIUS = 6.5; // a blast sets off its neighbours
export const BARREL_CHAIN_LIMIT = 5; // guards against a pathological chain

// Movement. Faster than real life on purpose — this is an arena shooter.
export const WALK_SPEED = 6.2;
export const SPRINT_SPEED = 9.0;
export const CROUCH_SPEED = 3.0;
export const AIR_CONTROL = 0.35; // fraction of ground accel available mid-air
export const GROUND_ACCEL = 60;
export const GROUND_FRICTION = 10;
export const AIR_FRICTION = 0.2;
export const GRAVITY = -22.0; // snappier than 9.81
export const JUMP_VELOCITY = 7.5; // ~1.28m apex
export const STEP_HEIGHT = 0.45; // auto-step up small ledges
export const MAX_FALL_SPEED = 60;

// Fall damage: nothing below the threshold, then ramps up.
export const FALL_DAMAGE_MIN_SPEED = 18;
export const FALL_DAMAGE_PER_SPEED = 6;

// -------------------------------------------------------------------- combat
export const RESPAWN_DELAY_MS = 2500;
export const SPAWN_PROTECTION_MS = 1200;
export const HEADSHOT_MULTIPLIER = 2.0;
export const LEG_MULTIPLIER = 0.85;
export const HEAD_ZONE_FROM_TOP = 0.3; // top 30cm of the capsule counts as head
export const LEG_ZONE_FROM_BOTTOM = 0.6;

// Health regen, CoD-style: pause after damage, then fill fast.
export const REGEN_DELAY_MS = 5000;
export const REGEN_PER_SECOND = 35;

// ---------------------------------------------------------------- match flow
export const ROUND_MS = 180_000; // 3 minutes, as requested

// Gun Game needs longer: eight rungs at a couple of kills each is more than three
// minutes of work, and a round that ends on the clock with nobody past the rifle
// doesn't feel like the mode was played at all.
export const MODE_ROUND_MS = {
  tdm: ROUND_MS,
  ffa: ROUND_MS,
  gungame: 330_000, // 5m30
  // The island is deliberately huge and the circle closes in several readable
  // stages. A three-minute arena clock used to cut Battle Royale off mid-game.
  br: 720_000, // 12 minutes; the last-player check normally ends it sooner
  // Survival has no clock — the run ends when everyone is down. A nominal value
  // keeps the phase machine happy without ever being reached in practice.
  waves: 3_600_000,
};

// ------------------------------------------------------------- battle royale
//
// The zone closes in phases: hold at the current radius, then shrink to the next
// over `shrinkMs`, then hold again. Damage outside ramps up so a late-game player
// caught out cannot simply walk it off, but the first phase is survivable — being
// slightly late shouldn't be an execution.
export const BR_ZONE_PHASES = [
  { holdMs: 70_000, shrinkMs: 55_000, radius: 270, dps: 2 },
  { holdMs: 55_000, shrinkMs: 50_000, radius: 190, dps: 4 },
  { holdMs: 45_000, shrinkMs: 45_000, radius: 125, dps: 7 },
  { holdMs: 35_000, shrinkMs: 40_000, radius: 72, dps: 11 },
  { holdMs: 25_000, shrinkMs: 30_000, radius: 35, dps: 16 },
  { holdMs: 20_000, shrinkMs: 25_000, radius: 12, dps: 24 },
  { holdMs: 0, shrinkMs: 0, radius: 12, dps: 30 },
];
export const BR_START_RADIUS = 365;
export const BR_DROP_MS = 35_000; // parachute + looting grace before the first close
export const BR_COMBAT_GRACE_MS = 28_000; // land and find a gun before anybody can deal damage
export const BR_LOOT_COUNT = 180; // a large island needs multiple choices per district
export const BR_LOOT_RADIUS = 1.6; // how close you must be to pick one up
export const BR_DROP_HEIGHT = 92;
export const PARACHUTE_FALL_SPEED = 7;
export const PARACHUTE_GLIDE_SPEED = 11;
export const BR_VICTORY_MS = 8_000;
export const BR_SCOREBOARD_MS = 25_000;
export const VEHICLE_MAX_SPEED = 18;
export const VEHICLE_REVERSE_SPEED = 8;
export const VEHICLE_ACCEL = 14;
export const VEHICLE_TURN_SPEED = 1.8;
export const VEHICLE_USE_RADIUS = 4;
export const VEHICLE_HEALTH = 400;
export const VEHICLE_DESTRUCTION_DAMAGE = 55;

// ---------------------------------------------------------------- health packs
// Pickups are NOT part of map.solids — you walk over them, you don't bump into
// them — so they live in their own list on the map and are collected by proximity
// on the server tick.
export const HEALTH_PACK_HEAL = 45;
export const HEALTH_PACK_RADIUS = 1.2; // how close you have to be
export const HEALTH_PACK_RESPAWN_MS = 20_000;

// ------------------------------------------------------------------- survival
export const WAVE_BREAK_MS = 6_000; // breathing room between waves
export const WAVE_FIRST_DELAY_MS = 4_000;
export const WAVE_MAX_CONCURRENT = 12; // how many enemies can be alive at once
export const WAVE_BASE_ENEMIES = 4; // wave 1
export const WAVE_ENEMIES_PER_WAVE = 2;
export const COUNTDOWN_MS = 5_000;
export const SCOREBOARD_MS = 15_000;
export const MIN_PLAYERS_TO_START = 2;
export const MAX_PLAYERS = 8;
// Battle royale runs a much bigger lobby on a much bigger map. Any unfilled slot
// becomes an AI, so a room of two still plays a thirty-player match.
export const BR_MAX_PLAYERS = 30;
export const EMPTY_ROOM_TTL_MS = 60_000;

// How long a lobby that already has enough players waits for the stragglers to
// ready up before starting without them. A lobby that can only start on a
// unanimous vote deadlocks the moment one person wanders off to get a coffee,
// and the host — the one person who could force it — is as likely as anyone to
// be that person.
export const LOBBY_GRACE_MS = 45_000;

export const SCORE_LIMIT = { tdm: 75, ffa: 30, gungame: null }; // null = no cap

// ------------------------------------------------------------------- rooms
// No 0/O/1/I/L — these get misread when someone reads a code out loud.
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;

// ------------------------------------------------------- server validation
// Loose bounds only. Movement is client-authoritative (see the plan) so these
// exist to catch nonsense and accidents, not determined cheaters.
export const MAX_VALIDATED_SPEED = SPRINT_SPEED * 1.6;
export const MAX_HIT_DISTANCE_SLACK = 1.35; // multiplier on weapon range
export const LOS_ORIGIN_TOLERANCE = 0.75; // metres of wall-peek forgiveness

// ---------------------------------------------------------------- rendering
export const DEFAULT_FOV = 80;
export const MIN_FOV = 60;
export const MAX_FOV = 110;
export const DEFAULT_SENSITIVITY = 1.0;
export const VIEW_DISTANCE = 480;

export const TEAMS = { A: 'A', B: 'B' };
export const TEAM_COLORS = { A: 0x4a90d9, B: 0xd95a4a };
export const FFA_COLOR = 0xc8a44a;
