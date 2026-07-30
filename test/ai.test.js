// Server-side AI.
//
// The Room is exercised directly, with no sockets: AI players don't have a
// WebSocket, so nothing here needs one, and driving tick() by hand makes the
// simulation deterministic enough to assert on.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Room } from '../server/room.js';
import { stepAi } from '../server/ai.js';
import { aiNeedsZone, zonePaceForAlive } from '../server/br.js';
import { PHASE, S2C } from '../shared/protocol.js';
import {
  MAX_HEALTH, PLAYER_HEIGHT, PLAYER_RADIUS, HEALTH_PACK_RESPAWN_MS, BR_VICTORY_MS,
  VEHICLE_DESTRUCTION_DAMAGE,
} from '../shared/constants.js';
import { playerOverlapsAny, raycastBoxes } from '../shared/collision.js';
import { getMap, MAP_IDS } from '../shared/maps/index.js';

// The room reads Date.now() for everything time-based: spawn protection, respawn
// timers, weapon cadence, AI reaction. Ticking in a tight loop leaves the wall
// clock almost stationary, so spawn protection never lapses and the bots are
// permanently invulnerable — the first version of this file concluded the AI
// couldn't shoot when in fact the test had frozen time.
//
// So the clock is faked and advanced one tick at a time.
const realNow = Date.now;
let fakeClock = realNow();

function installClock() {
  fakeClock = realNow();
  Date.now = () => fakeClock;
}
function restoreClock() {
  Date.now = realNow;
}

/** A room with `count` AI and no humans, mid-round, with its own timer stopped. */
function aiRoom(count, mode = 'ffa', skill = 'hard') {
  installClock();
  const room = new Room('TEST', mode);
  clearInterval(room.timer); // drive it by hand
  room.timer = null;
  room.aiSkill = skill;
  for (let i = 0; i < count; i++) room.addAiPlayer();
  room.beginRound();
  return room;
}

const TICK_MS = 50; // SERVER_TICK_HZ 20

function ticks(room, n) {
  for (let i = 0; i < n; i++) {
    fakeClock += TICK_MS;
    room.tick();
  }
}

/** Simulate a human joining and then leaving, which is what marks a room empty. */
function humanJoinsAndLeaves(room) {
  const human = room.addPlayer({ id: 'h1', name: 'Human', ws: null, classId: 'assault' });
  room.removePlayer(human.id);
}

test('AI players are not counted as people', () => {
  const room = aiRoom(4);
  assert.equal(room.players.size, 4);
  assert.equal(room.humanCount(), 0, 'bots must not read as humans');
  room.dispose();
  restoreClock();
});

test('a room of bots closes once the last human leaves', () => {
  const room = aiRoom(6);
  // The close path lives in index.js but it asks isExpired(), so that's the
  // contract: bots must never be able to keep a room alive.
  humanJoinsAndLeaves(room);
  assert.equal(room.humanCount(), 0);
  assert.ok(room.players.size > 0, 'bots are still present');
  assert.ok(room.isExpired(), 'yet the room is expired, because nobody is here');
  room.dispose();
  restoreClock();
});

test('AI spawn alive and clear of geometry', () => {
  const room = aiRoom(6);
  assert.equal(room.phase, PHASE.LIVE);

  for (const bot of room.players.values()) {
    assert.ok(bot.alive, `${bot.name} should be alive after beginRound`);
    assert.equal(bot.health, MAX_HEALTH);
    assert.ok(
      !playerOverlapsAny(bot.pos, PLAYER_HEIGHT, PLAYER_RADIUS, room.map.solids),
      `${bot.name} spawned inside geometry at ${JSON.stringify(bot.pos)}`,
    );
    assert.ok(bot.weapon, 'should be holding something');
  }
  room.dispose();
  restoreClock();
});

test('AI move, and stay out of walls while doing it', () => {
  const room = aiRoom(5);
  const start = [...room.players.values()].map((b) => [...b.pos]);

  ticks(room, 120); // ~6 seconds

  const bots = [...room.players.values()];
  let moved = 0;
  for (const [i, bot] of bots.entries()) {
    const d = Math.hypot(bot.pos[0] - start[i][0], bot.pos[2] - start[i][2]);
    if (d > 1.5) moved++;
    // Alive bots must never end a tick embedded in the level.
    if (bot.alive) {
      assert.ok(
        !playerOverlapsAny(bot.pos, PLAYER_HEIGHT, PLAYER_RADIUS, room.map.solids),
        `${bot.name} ended up inside geometry at ${JSON.stringify(bot.pos)}`,
      );
    }
    assert.ok(Number.isFinite(bot.pos[0]) && Number.isFinite(bot.pos[1]) && Number.isFinite(bot.pos[2]),
      `${bot.name} position went non-finite`);
  }
  assert.ok(moved >= 3, `expected most bots to have walked somewhere, only ${moved}/${bots.length} did`);
  room.dispose();
  restoreClock();
});

test('AI probe lethal ledges instead of walking off Rooftops', () => {
  const room = aiRoom(1);
  room.mapId = 'rooftops';
  room.map = getMap('rooftops');
  const bot = [...room.players.values()][0];
  bot.pos = [0, 0, -19.2]; // inner edge of the south roof
  bot.ai.vel = [0, 0, 0];
  bot.ai.onGround = true;
  bot.ai.waypoint = null;
  room.aiWaypointHint = () => [0, 0, 0]; // deliberately points across the void

  for (let i = 0; i < 300; i++) {
    fakeClock += TICK_MS;
    stepAi(room, bot, TICK_MS / 1000, fakeClock);
  }

  assert.ok(bot.pos[1] > -1, `bot fell to y=${bot.pos[1]}`);
  assert.ok(bot.pos[2] <= -18, `bot crossed the unsupported roof edge at z=${bot.pos[2]}`);
  assert.ok(bot.alive);
  room.dispose();
  restoreClock();
});

test('AI find each other and fight', () => {
  const room = aiRoom(8, 'ffa', 'hard');
  ticks(room, 700); // ~35 seconds

  let kills = 0;
  let deaths = 0;
  for (const bot of room.players.values()) {
    kills += bot.kills;
    deaths += bot.deaths;
  }
  assert.ok(kills > 0, 'eight hard bots in 35s should manage at least one kill between them');
  assert.ok(deaths > 0, 'and therefore at least one death');
  room.dispose();
  restoreClock();
});

test('AI respect team damage rules', () => {
  const room = aiRoom(8, 'tdm', 'hard');
  const teams = new Set([...room.players.values()].map((b) => b.team));
  assert.deepEqual([...teams].sort(), ['A', 'B'], 'bots should be spread across both teams');

  ticks(room, 700);

  // Friendly fire is off, so nobody should have been credited a teammate kill.
  // Team scores only rise on a legitimate kill, so they're the check.
  const total = (room.teamScores.A ?? 0) + (room.teamScores.B ?? 0);
  let kills = 0;
  for (const bot of room.players.values()) kills += bot.kills;
  assert.equal(total, kills, 'every credited kill should have scored for a team');
  room.dispose();
  restoreClock();
});

test('AI are removable, and removing them leaves the humans alone', () => {
  const room = aiRoom(6);
  assert.equal(room.players.size, 6);

  const removed = room.removeAiPlayers(4);
  assert.equal(removed, 4);
  assert.equal(room.players.size, 2);

  room.removeAiPlayers();
  assert.equal(room.players.size, 0);
  room.dispose();
  restoreClock();
});

// ---------------------------------------------------------------- survival

/** A survival room with one human, mid-run. */
function survivalRoom() {
  installClock();
  const room = new Room('WAVE', 'waves');
  clearInterval(room.timer);
  room.timer = null;
  const human = room.addPlayer({ id: 'h1', name: 'Solo', ws: null, classId: 'assault' });
  room.beginRound();
  return { room, human };
}

test('survival is playable alone', () => {
  const { room } = survivalRoom();
  assert.equal(room.minPlayers(), 1, 'a solo mode cannot require two people');
  assert.equal(room.phase, PHASE.LIVE);
  assert.ok(room.wave, 'wave state should exist');
  room.dispose();
  restoreClock();
});

test('survival spawns escalating waves and clears them', () => {
  const { room, human } = survivalRoom();

  // Keep the human topped up so the run doesn't end while we watch the waves.
  const keepAlive = () => {
    human.health = MAX_HEALTH;
    if (!human.alive) room.spawn(human);
    // Several enemies can legitimately land shots in the same server tick.
    // Health alone therefore leaves a random chance that the test subject dies
    // before tickWaves observes them. Protection keeps this a wave-lifecycle
    // test rather than an AI accuracy lottery.
    human.spawnProtectedUntil = Infinity;
  };

  ticks(room, 100);
  keepAlive();
  ticks(room, 60);
  assert.equal(room.wave.number, 1, 'first wave should have started');
  assert.ok(room.wave.toSpawn >= 4, `wave 1 should bring several enemies, got ${room.wave.toSpawn}`);

  // Enemies are on the other side and are real players in the room.
  const enemies = [...room.players.values()].filter((p) => p.isBot);
  assert.ok(enemies.length > 0, 'enemies should have spawned');
  for (const e of enemies) assert.equal(e.team, 'B', 'enemies are team B');
  assert.equal(human.team, 'A', 'the human is team A');

  // Kill the wave off and confirm it advances.
  for (let i = 0; i < 400; i++) {
    keepAlive();
    for (const p of room.players.values()) {
      if (p.isBot && p.alive) room.applyDamage(p, human, 500, 'rifle');
    }
    fakeClock += TICK_MS;
    room.tick();
    if (room.wave.number >= 3) break;
  }
  assert.ok(room.wave.number >= 2, `waves should advance, reached ${room.wave.number}`);
  assert.ok(
    room.waveEnemyCount(3) > room.waveEnemyCount(1),
    'later waves must be bigger',
  );
  room.dispose();
  restoreClock();
});

test('survival ends the run when the last human goes down', () => {
  const { room, human } = survivalRoom();
  ticks(room, 160); // let wave 1 start

  room.applyDamage(human, null, 999, 'fall');
  assert.ok(!human.alive);
  assert.equal(human.respawnAt, 0, 'no auto-respawn in survival');

  ticks(room, 4);
  assert.equal(room.phase, PHASE.SCOREBOARD, 'the run should be over');
  room.dispose();
  restoreClock();
});

test('host can add and remove bots in a normal lobby', () => {
  installClock();
  const room = new Room('BOTS', 'tdm');
  clearInterval(room.timer);
  room.timer = null;
  const host = room.addPlayer({ id: 'h1', name: 'Host', ws: null, classId: 'assault' });

  room.handleSetBots(host, { n: 5 });
  assert.equal(room.players.size - room.humanCount(), 5, 'should have five bots');
  assert.equal(room.humanCount(), 1);

  room.handleSetBots(host, { n: 2 });
  assert.equal(room.players.size - room.humanCount(), 2, 'should have come back down to two');

  // Capacity is respected.
  room.handleSetBots(host, { n: 99 });
  assert.ok(room.players.size <= 8, `room capacity exceeded: ${room.players.size}`);

  // A non-host can't touch it.
  const other = room.addPlayer({ id: 'h2', name: 'Guest', ws: null, classId: 'scout' });
  const before = room.players.size;
  room.handleSetBots(other, { n: 0 });
  assert.equal(room.players.size, before, 'a guest should not be able to change the bot count');

  room.dispose();
  restoreClock();
});

// ------------------------------------------------------------- health packs

test('every map carries health packs, and none sits inside geometry', () => {
  for (const id of MAP_IDS) {
    const map = getMap(id);
    assert.ok(map.healthPacks.length > 0, `${id} has no health packs`);
    for (const pack of map.healthPacks) {
      // Packs are walked over, so they must not be part of the collision set.
      const inSolids = map.solids.some((s) => s.tag === 'pickup:health');
      assert.ok(!inSolids, `${id}: packs must not be solids`);
      assert.ok(
        pack.pos.every(Number.isFinite),
        `${id}: pack ${pack.index} has a bad position`,
      );
      const floor = raycastBoxes(
        [pack.pos[0], pack.pos[1] + 0.2, pack.pos[2]],
        [0, -1, 0],
        map.solids,
        1,
      );
      assert.ok(floor && floor.t < 0.35, `${id}: pack ${pack.index} is not grounded`);
    }
  }
});

test('a hurt player standing on a pack is healed, and the pack goes away', () => {
  installClock();
  const room = new Room('PICK', 'ffa');
  clearInterval(room.timer);
  room.timer = null;
  const p = room.addPlayer({ id: 'h1', name: 'Hurt', ws: null, primaryId: 'rifle' });
  room.addPlayer({ id: 'h2', name: 'Other', ws: null, primaryId: 'rifle' });
  room.beginRound();

  const pack = room.map.healthPacks[0];
  p.pos = [...pack.pos];
  p.health = 40;

  ticks(room, 3);
  assert.ok(p.health > 40, `should have healed, still on ${p.health}`);
  assert.ok(p.health <= MAX_HEALTH, 'must not overheal');
  assert.deepEqual(room.takenPickups(), [pack.index], 'the pack should be marked taken');

  room.dispose();
  restoreClock();
});

test('a pack is left alone by a player already at full health', () => {
  installClock();
  const room = new Room('PICK2', 'ffa');
  clearInterval(room.timer);
  room.timer = null;
  const p = room.addPlayer({ id: 'h1', name: 'Fine', ws: null, primaryId: 'rifle' });
  room.addPlayer({ id: 'h2', name: 'Other', ws: null, primaryId: 'rifle' });
  room.beginRound();

  const pack = room.map.healthPacks[0];
  p.pos = [...pack.pos];
  p.health = MAX_HEALTH;

  ticks(room, 5);
  assert.deepEqual(room.takenPickups(), [], 'a full-health player should not waste it');

  room.dispose();
  restoreClock();
});

test('a taken pack comes back after its timer', () => {
  installClock();
  const room = new Room('PICK3', 'ffa');
  clearInterval(room.timer);
  room.timer = null;
  const p = room.addPlayer({ id: 'h1', name: 'Hurt', ws: null, primaryId: 'rifle' });
  room.addPlayer({ id: 'h2', name: 'Other', ws: null, primaryId: 'rifle' });
  room.beginRound();

  const pack = room.map.healthPacks[0];
  p.pos = [...pack.pos];
  p.health = 30;
  ticks(room, 3);
  assert.deepEqual(room.takenPickups(), [pack.index]);

  // Move away so it isn't instantly re-collected, then wait it out.
  p.pos = [pack.pos[0] + 40, pack.pos[1], pack.pos[2]];
  ticks(room, Math.ceil(HEALTH_PACK_RESPAWN_MS / TICK_MS) + 4);
  assert.deepEqual(room.takenPickups(), [], 'the pack should have respawned');

  room.dispose();
  restoreClock();
});

// ------------------------------------------------------------- battle royale

function brRoom() {
  installClock();
  const room = new Room('BR', 'br');
  clearInterval(room.timer);
  room.timer = null;
  const human = room.addPlayer({ id: 'h1', name: 'Solo', ws: null, primaryId: 'sniper' });
  room.beginRound();
  return { room, human };
}

test('battle royale plays the island and fills the lobby to thirty', () => {
  const { room } = brRoom();
  assert.equal(room.mapId, 'island', 'battle royale has exactly one map');
  assert.equal(room.capacity(), 30);
  assert.equal(room.players.size, 30, 'every empty slot should be an AI');
  assert.equal(room.humanCount(), 1);
  assert.equal(room.minPlayers(), 1, 'bots fill the rest, so one person is a match');
  room.dispose();
  restoreClock();
});

test('everyone in battle royale starts alive, with only a pistol and a knife', () => {
  const { room, human } = brRoom();
  // The bots have to be spawned too, or the sole-survivor check ends the match
  // before it starts.
  for (const p of room.players.values()) {
    assert.ok(p.alive, `${p.name} should be alive at the start`);
  }
  assert.deepEqual(human.inventory, ['pistol', 'knife'],
    'the lobby gun choice is deliberately ignored — finding one is the mode');
  room.dispose();
  restoreClock();
});

test('battle royale has ground loot, and picking it up changes your gun', () => {
  const { room, human } = brRoom();
  assert.ok(room.br, 'br state should exist');
  const items = [...room.br.loot.values()];
  assert.ok(items.length > 20, `expected plenty of loot, got ${items.length}`);

  const item = items[0];
  const pickedId = item.weaponId;
  human.pos = [...item.pos];
  room.handleTakeLoot(human);

  assert.equal(human.inventory[0], pickedId, 'the ground weapon should be in your hands');
  assert.equal(item.taken, false, 'the dropped gun should remain available');
  assert.equal(item.weaponId, 'pistol', 'your old held gun should replace the pickup');
  assert.deepEqual(item.pos, human.pos, 'the dropped gun should land at the exchange');
  assert.equal(human.inventory[1], 'pistol', 'the sidearm survives a pickup');
  assert.equal(human.inventory[2], 'knife', 'and so does the knife');
  room.dispose();
  restoreClock();
});

test('nobody respawns in battle royale', () => {
  const { room, human } = brRoom();
  room.applyDamage(human, null, 999, 'test');
  assert.ok(!human.alive);
  assert.equal(human.respawnAt, 0, 'death is the end of your match');
  room.dispose();
  restoreClock();
});

test('the alive counter drops as people are eliminated', () => {
  // The alive count is the whole scoreboard in battle royale, and it is only ever
  // recomputed on a kill. The first version never broadcast it there, so the HUD
  // read the starting count for a full match while everyone died in front of you.
  const { room, human } = brRoom();
  const sent = [];
  human.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };

  const bots = [...room.players.values()].filter((p) => p !== human);
  assert.equal(bots.length, 29);

  room.applyDamage(bots[0], human, 999, 'sniper');
  const alive = sent.filter((m) => m.m === S2C.ALIVE);
  assert.equal(alive.length, 1, 'a kill has to refresh the counter');
  assert.equal(alive[0].alive, 29, 'one down, twenty-nine standing');
  assert.equal(alive[0].total, 30);

  room.applyDamage(bots[1], human, 999, 'sniper');
  assert.equal(sent.filter((m) => m.m === S2C.ALIVE).at(-1).alive, 28);

  room.dispose();
  restoreClock();
});

test('being killed in battle royale tells you where you finished', () => {
  const { room, human } = brRoom();
  const sent = [];
  human.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };

  // Two bots go first, so the human should come 28th of 30.
  const bots = [...room.players.values()].filter((p) => p !== human);
  room.applyDamage(bots[0], human, 999, 'sniper');
  room.applyDamage(bots[1], human, 999, 'sniper');
  room.applyDamage(human, bots[2], 999, 'rifle');

  const myDeath = sent.filter((m) => m.m === S2C.KILL).find((m) => m.victim === human.id);
  assert.ok(myDeath, 'the victim hears about their own death');
  assert.equal(myDeath.placed, 28, 'placement is the only score battle royale has');
  room.dispose();
  restoreClock();
});

test('modes that respawn you do not report a placement', () => {
  // placed is what makes the client say ELIMINATED instead of counting down, so a
  // stray non-zero here would break the Team Deathmatch death screen.
  const room = aiRoom(3, 'ffa');
  const victim = [...room.players.values()][0];
  const sent = [];
  victim.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };

  room.applyDamage(victim, null, 999, 'test');
  const kill = sent.filter((m) => m.m === S2C.KILL).at(-1);
  assert.equal(kill.placed, 0, 'you are coming straight back');
  room.dispose();
  restoreClock();
});

test('the zone closes and hurts whoever is outside it', () => {
  const { room, human } = brRoom();
  const first = room.br.zone.radius;

  // Park well outside any circle the zone will ever be.
  human.pos = [350, 0, 350];
  human.health = MAX_HEALTH;

  // Run past the drop grace and into the first shrink.
  ticks(room, 1400);

  assert.ok(room.br.zone.radius < first, `zone should have shrunk from ${first}`);
  assert.ok(room.br.zone.phase >= 0, 'it should have entered a phase');
  assert.ok(human.health < MAX_HEALTH || !human.alive,
    'standing outside the zone has to cost something');
  room.dispose();
  restoreClock();
});

test('late-game population accelerates the zone', () => {
  assert.equal(zonePaceForAlive(30), 1);
  assert.ok(zonePaceForAlive(20) > zonePaceForAlive(30));
  assert.ok(zonePaceForAlive(12) > 2);
  assert.ok(zonePaceForAlive(6) > zonePaceForAlive(12));
});

test('bots treat the storm edge as urgent instead of wandering back to the coast', () => {
  const { room } = brRoom();
  const bot = [...room.players.values()].find((p) => p.isBot);
  room.br.zone.centre = [0, 0];
  room.br.zone.targetCentre = [0, 0];
  room.br.zone.radius = 100;
  room.br.zone.targetRadius = 70;
  room.br.zone.state = 'shrink';
  bot.pos = [95, 0, 0];
  assert.equal(aiNeedsZone(room.br, bot), true);
  const waypoint = room.aiWaypointHint(bot);
  assert.ok(Math.hypot(waypoint[0], waypoint[2]) < 40, 'urgent waypoint must be deep in safety');
  room.dispose();
  restoreClock();
});

test('opening combat grace blocks shots until players have landed and looted', () => {
  const { room, human } = brRoom();
  human.parachuting = false;
  human.flags = 0;
  room.handleShoot(human, { w: 'pistol', h: [], o: human.pos, d: [0, 0, -1] });
  assert.equal(human.lastShotAt, 0, 'opening shot should be ignored');

  fakeClock = room.br.combatStartsAt + 1;
  room.handleShoot(human, { w: 'pistol', h: [], o: human.pos, d: [0, 0, -1] });
  assert.equal(human.lastShotAt, fakeClock, 'weapon should unlock after the grace period');
  room.dispose();
  restoreClock();
});

test('rovers have exclusive drivers and are released on death', () => {
  const { room, human } = brRoom();
  const rover = room.vehicles[0];
  assert.ok(rover, 'battle royale should spawn road vehicles');
  human.parachuting = false;
  human.pos = [...rover.pos];
  room.handleVehicle(human, { i: rover.index });
  assert.equal(human.vehicleId, rover.index);
  assert.equal(rover.driverId, human.id);

  const other = [...room.players.values()].find((p) => p !== human);
  other.parachuting = false;
  other.pos = [...rover.pos];
  room.handleVehicle(other, { i: rover.index });
  assert.equal(rover.driverId, human.id, 'an occupied rover cannot be stolen');

  room.applyDamage(human, other, 999, 'rifle');
  assert.equal(human.vehicleId, null);
  assert.equal(rover.driverId, null, 'death must leave the rover usable');
  room.dispose();
  restoreClock();
});

test('gunfire destroys a rover and ejects its driver', () => {
  const { room, human } = brRoom();
  const rover = room.vehicles[0];
  const driver = [...room.players.values()].find((p) => p !== human);

  human.parachuting = false;
  human.flags = 0;
  human.inventory = ['rifle', 'pistol', 'knife'];
  human.weapon = 'rifle';
  human.pos = [rover.pos[0], rover.pos[1], rover.pos[2] + 8];

  driver.parachuting = false;
  driver.pos = [...rover.pos];
  driver.vehicleId = rover.index;
  rover.driverId = driver.id;

  const origin = [human.pos[0], human.pos[1] + PLAYER_HEIGHT - 0.18, human.pos[2]];
  const target = [rover.pos[0], rover.pos[1] + 0.75, rover.pos[2]];
  const delta = target.map((value, i) => value - origin[i]);
  const length = Math.hypot(...delta);
  const direction = delta.map((value) => value / length);

  fakeClock = room.br.combatStartsAt + 1;
  for (let shot = 0; shot < 20 && !rover.destroyed; shot++) {
    fakeClock += 100;
    room.handleShoot(human, {
      w: 'rifle',
      h: [],
      o: origin,
      d: direction,
      v: [{ i: rover.index, d: direction }],
    });
  }

  assert.equal(rover.destroyed, true, 'sustained rifle fire should wreck the rover');
  assert.equal(rover.health, 0);
  assert.equal(rover.driverId, null);
  assert.equal(driver.vehicleId, null, 'the occupant must be ejected from a wreck');
  assert.equal(
    driver.health,
    MAX_HEALTH - VEHICLE_DESTRUCTION_DAMAGE,
    'destruction should hurt, not silently free, the driver',
  );
  room.dispose();
  restoreClock();
});

test('the last player standing wins', () => {
  const { room, human } = brRoom();
  // Kill everyone but the human.
  for (const p of room.players.values()) {
    if (p.id === human.id) continue;
    room.applyDamage(p, human, 999, 'rifle');
  }
  ticks(room, Math.ceil(BR_VICTORY_MS / TICK_MS) + 4);
  assert.equal(room.phase, PHASE.SCOREBOARD, 'the match should be over');
  assert.equal(room.br.winnerId, human.id, 'and the survivor should have won it');
  room.dispose();
  restoreClock();
});

// --------------------------------------------------- mode state must not leak

test('a new round does not inherit the previous mode\'s state', () => {
  // Regression. this.br and this.wave were never cleared, so switching out of
  // battle royale left the old zone closing — it drained a Team Deathmatch player
  // from 100 to 4 HP over a minute — and switching out of survival kept spawning
  // enemy bots into Free-for-all.
  installClock();
  const room = new Room('LEAK', 'br');
  clearInterval(room.timer);
  room.timer = null;

  const host = room.addPlayer({ id: 'h1', name: 'Host', ws: null, primaryId: 'rifle' });
  room.beginRound();
  assert.ok(room.br, 'battle royale state should exist during a battle royale');

  room.endRound({ reason: 'br', winnerId: host.id, winnerName: host.name });
  room.setPhase(PHASE.LOBBY, 0);
  room.handleLobbySet(host, { mode: 'tdm' });
  room.addPlayer({ id: 'h2', name: 'Other', ws: null, primaryId: 'smg' });
  room.beginRound();

  assert.equal(room.br, null, 'the zone must not survive into Team Deathmatch');
  assert.equal(room.wave, null, 'nor should wave state');

  // Park somewhere the old zone would have been lethal.
  host.pos = [200, 0, 200];
  host.health = MAX_HEALTH;
  ticks(room, 600);
  assert.equal(host.health, MAX_HEALTH, 'nothing should be damaging them out here');
  assert.equal(room.phase, PHASE.LIVE, 'and the round should still be running');

  room.dispose();
  restoreClock();
});

test('survival state does not survive into another mode', () => {
  installClock();
  const room = new Room('LEAK2', 'waves');
  clearInterval(room.timer);
  room.timer = null;

  const host = room.addPlayer({ id: 'h1', name: 'Host', ws: null, primaryId: 'rifle' });
  room.beginRound();
  assert.ok(room.wave, 'wave state should exist during survival');

  room.endRound({ reason: 'survival', wave: 1 });
  room.setPhase(PHASE.LOBBY, 0);
  room.handleLobbySet(host, { mode: 'ffa' });
  room.addPlayer({ id: 'h2', name: 'Other', ws: null, primaryId: 'smg' });
  room.beginRound();

  assert.equal(room.wave, null);
  ticks(room, 300);
  assert.equal(room.players.size - room.humanCount(), 0,
    'no enemy waves should be spawning in Free-for-all');

  room.dispose();
  restoreClock();
});
