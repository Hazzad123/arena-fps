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
export const MAX_HEALTH = 100;

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
export const COUNTDOWN_MS = 5_000;
export const SCOREBOARD_MS = 15_000;
export const MIN_PLAYERS_TO_START = 2;
export const MAX_PLAYERS = 8;
export const EMPTY_ROOM_TTL_MS = 60_000;

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
export const VIEW_DISTANCE = 220;

export const TEAMS = { A: 'A', B: 'B' };
export const TEAM_COLORS = { A: 0x4a90d9, B: 0xd95a4a };
export const FFA_COLOR = 0xc8a44a;
