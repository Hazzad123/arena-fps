// Lobby rules.
//
// The lobby is where a match either starts on time or deadlocks, and every way
// it can deadlock is invisible until eight people are stood around waiting. So
// the start rule gets tested directly against a real Room rather than through a
// socket: who's host, who can start it, and what happens when someone never
// readies up.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Room } from '../server/room.js';
import { PHASE, S2C, decode } from '../shared/protocol.js';
import { MAX_PLAYERS, MIN_PLAYERS_TO_START, LOBBY_GRACE_MS } from '../shared/constants.js';
import { ROOM_CAPACITY } from '../server/modes.js';
import { CLASSES, CLASS_IDS, DEFAULT_CLASS, WEAPONS, loadoutForClass, GUNGAME_LADDER } from '../shared/weapons.js';

/** A socket that just records what the server sent it. */
function fakeSocket() {
  return {
    readyState: 1,
    sent: [],
    send(raw) {
      this.sent.push(decode(raw));
    },
    received(type) {
      return this.sent.filter((m) => m?.m === type);
    },
    last(type) {
      const all = this.received(type);
      return all[all.length - 1] ?? null;
    },
  };
}

let roomCount = 0;

/** A room plus `n` joined players, torn down after the test. */
function makeRoom(t, n, mode = 'tdm') {
  const room = new Room(`T${String(roomCount++).padStart(3, '0')}`, mode);
  t.after(() => room.dispose());

  const players = [];
  for (let i = 0; i < n; i++) {
    const ws = fakeSocket();
    // Distinct join times: host promotion is defined by who arrived first, and
    // a whole room joining inside one millisecond would make it a coin toss.
    const player = room.addPlayer({ id: `p${i}`, name: `Player${i}`, ws });
    player.joinedAt = 1000 + i;
    players.push(player);
  }
  return { room, players };
}

function readyAll(room, players) {
  for (const p of players) room.handleReady(p, { ready: true });
}

// --------------------------------------------------------------------- capacity

test('a room holds exactly eight players and then reports itself full', () => {
  assert.equal(MAX_PLAYERS, 8);
  assert.equal(ROOM_CAPACITY, 8);

  const room = new Room('CAP1', 'tdm');
  try {
    for (let i = 0; i < MAX_PLAYERS; i++) {
      assert.equal(room.isFull(), false, `should have room for player ${i + 1}`);
      room.addPlayer({ id: `p${i}`, name: `Player${i}`, ws: fakeSocket() });
    }
    assert.equal(room.size, 8);
    assert.equal(room.isFull(), true, 'the ninth player must be turned away');
    assert.equal(room.lobbyState().capacity, 8);
  } finally {
    room.dispose();
  }
});

test('eight players in a team lobby split four and four', (t) => {
  const { room, players } = makeRoom(t, 8);
  const teams = { A: 0, B: 0 };
  for (const p of players) teams[p.team]++;
  assert.deepEqual(teams, { A: 4, B: 4 });
});

// ------------------------------------------------------------------------- host

test('the first player is host, and the longest-standing player inherits it', (t) => {
  const { room, players } = makeRoom(t, 3);
  assert.equal(room.hostId, players[0].id);
  assert.equal(room.isHost(players[0]), true);
  assert.equal(room.isHost(players[1]), false);

  room.removePlayer(players[0].id);
  assert.equal(room.hostId, players[1].id, 'host should pass to the next-longest-standing player');

  // A player leaving who isn't the host changes nothing.
  room.removePlayer(players[2].id);
  assert.equal(room.hostId, players[1].id);
});

test('an emptied room forgets its host', (t) => {
  const { room, players } = makeRoom(t, 2);
  for (const p of players) room.removePlayer(p.id);
  assert.equal(room.hostId, null);
  assert.equal(room.phase, PHASE.LOBBY);
});

// ------------------------------------------------------------------ start rules

test('a lobby does not start just because a second player walked in', (t) => {
  const { room } = makeRoom(t, 2);
  assert.equal(room.phase, PHASE.LOBBY, 'joining is not consent to start');
  assert.equal(room.graceEndsAt, 0, 'and nothing is counting down yet');
});

test('a single player cannot start a match alone', (t) => {
  const { room, players } = makeRoom(t, 1);
  room.handleReady(players[0], { ready: true });
  assert.equal(room.phase, PHASE.LOBBY);

  room.handleStart(players[0]); // host, but on their own
  assert.equal(room.phase, PHASE.LOBBY);
});

test('everybody ready starts the countdown immediately', (t) => {
  const { room, players } = makeRoom(t, 4);
  readyAll(room, players);
  assert.equal(room.phase, PHASE.COUNTDOWN);
  assert.equal(room.graceEndsAt, 0, 'the grace clock is irrelevant once everyone agrees');
});

test('one unready player starts a grace clock instead of blocking forever', (t) => {
  const { room, players } = makeRoom(t, 3);
  room.handleReady(players[0], { ready: true });
  assert.equal(room.graceEndsAt, 0, 'one ready player is not a quorum');

  room.handleReady(players[1], { ready: true });
  assert.equal(room.phase, PHASE.LOBBY, 'still waiting on the third');
  assert.ok(room.graceEndsAt > 0, 'but a clock is now running');

  const left = room.graceEndsAt - Date.now();
  assert.ok(left > LOBBY_GRACE_MS - 2000 && left <= LOBBY_GRACE_MS, `unexpected grace of ${left}ms`);

  // Time's up: start without them.
  room.graceEndsAt = Date.now() - 1;
  room.tick();
  assert.equal(room.phase, PHASE.COUNTDOWN);
  assert.equal(room.players.get(players[2].id).ready, false, 'the straggler is dragged in unready');
});

test('un-readying below quorum stops the clock', (t) => {
  const { room, players } = makeRoom(t, 3);
  room.handleReady(players[0], { ready: true });
  room.handleReady(players[1], { ready: true });
  assert.ok(room.graceEndsAt > 0);

  room.handleReady(players[1], { ready: false });
  assert.equal(room.graceEndsAt, 0, 'back below quorum, so nothing should be counting down');
  assert.equal(room.phase, PHASE.LOBBY);
});

test('the clock keeps its original deadline while people ready up around it', (t) => {
  const { room, players } = makeRoom(t, 4);
  room.handleReady(players[0], { ready: true });
  room.handleReady(players[1], { ready: true });
  const deadline = room.graceEndsAt;
  assert.ok(deadline > 0);

  room.handleReady(players[2], { ready: true });
  assert.equal(room.graceEndsAt, deadline, 'a third yes must not restart the wait');
  assert.equal(room.phase, PHASE.LOBBY);

  room.handleReady(players[3], { ready: true });
  assert.equal(room.phase, PHASE.COUNTDOWN, 'the last yes starts it outright');
});

test('a player leaving can complete the quorum and start the match', (t) => {
  const { room, players } = makeRoom(t, 3);
  room.handleReady(players[0], { ready: true });
  room.handleReady(players[1], { ready: true });
  assert.equal(room.phase, PHASE.LOBBY);

  // The one holdout leaves — everyone remaining is ready.
  room.removePlayer(players[2].id);
  assert.equal(room.phase, PHASE.COUNTDOWN);
});

test('the host can force the start; nobody else can', (t) => {
  const { room, players } = makeRoom(t, 4);

  room.handleStart(players[2]);
  assert.equal(room.phase, PHASE.LOBBY, 'a non-host start must be ignored');

  room.handleStart(players[0]);
  assert.equal(room.phase, PHASE.COUNTDOWN, 'the host can start with nobody ready');
});

test('readiness is cleared when the round begins, so the next lobby asks again', (t) => {
  const { room, players } = makeRoom(t, 2);
  readyAll(room, players);
  assert.equal(room.phase, PHASE.COUNTDOWN);

  room.beginRound();
  assert.equal(room.phase, PHASE.LIVE);
  for (const p of room.players.values()) {
    assert.equal(p.ready, false, 'a yes from the last match should not carry over');
  }

  // Drop below the minimum: back to the lobby, and it needs fresh consent.
  room.removePlayer(players[1].id);
  assert.equal(room.phase, PHASE.LOBBY);
  room.handleReady(players[0], { ready: true });
  assert.equal(room.phase, PHASE.LOBBY, 'one ready player is still not enough');
});

test('joining a live match skips the lobby entirely', (t) => {
  const { room, players } = makeRoom(t, 2);
  readyAll(room, players);
  room.beginRound();
  assert.equal(room.phase, PHASE.LIVE);

  const ws = fakeSocket();
  const latecomer = room.addPlayer({ id: 'late', name: 'Late', ws });
  assert.equal(room.phase, PHASE.LIVE);
  assert.equal(latecomer.alive, true, 'a latecomer spawns in rather than waiting');
  assert.ok(ws.last(S2C.RESPAWN), 'and is told where');
});

test('a class given at join time is used for the very first spawn', (t) => {
  const { room, players } = makeRoom(t, 2, 'ffa');
  readyAll(room, players);
  room.beginRound();

  // Joining a live match spawns you immediately, so the class has to arrive with
  // the join rather than in a message after it.
  const ws = fakeSocket();
  const latecomer = room.addPlayer({ id: 'late', name: 'Late', ws, classId: 'support' });
  assert.equal(latecomer.classId, 'support');
  assert.deepEqual(latecomer.inventory, loadoutForClass('support'));
  assert.deepEqual(ws.last(S2C.RESPAWN).inventory, loadoutForClass('support'));
});

test('a junk class at join time falls back instead of breaking the join', (t) => {
  const { room } = makeRoom(t, 1, 'ffa');
  const player = room.addPlayer({ id: 'x', name: 'X', ws: fakeSocket(), classId: 'wizard' });
  assert.equal(player.classId, DEFAULT_CLASS);
});

test('ready toggles are ignored outside the lobby', (t) => {
  const { room, players } = makeRoom(t, 2);
  readyAll(room, players);
  room.beginRound();

  room.handleReady(players[0], { ready: true });
  assert.equal(players[0].ready, false, 'mid-match readiness is meaningless');
  assert.equal(room.phase, PHASE.LIVE);
});

// -------------------------------------------------------------- host controls

test('the host can change mode from the lobby and teams are rebuilt', (t) => {
  const { room, players } = makeRoom(t, 4, 'tdm');
  for (const p of players) assert.ok(p.team, 'team mode should assign teams');

  room.handleLobbySet(players[0], { mode: 'ffa' });
  assert.equal(room.mode, 'ffa');
  for (const p of room.players.values()) {
    assert.equal(p.team, null, 'free-for-all has no teams');
  }

  room.handleLobbySet(players[0], { mode: 'tdm' });
  const teams = { A: 0, B: 0 };
  for (const p of room.players.values()) teams[p.team]++;
  assert.deepEqual(teams, { A: 2, B: 2 }, 'switching back must not pile everyone onto one team');
});

test('changing to gun game hands out the ladder loadout', (t) => {
  const { room, players } = makeRoom(t, 2, 'tdm');
  const ws = players[1].ws;

  room.handleLobbySet(players[0], { mode: 'gungame' });
  assert.equal(room.mode, 'gungame');
  assert.equal(players[1].inventory.length, 1, 'gun game starts you with one weapon');
  const load = ws.last(S2C.LOADOUT);
  assert.ok(load, 'players must be told their loadout changed');
  assert.deepEqual(load.inventory, players[1].inventory);
});

test('the host can pick the map, but only one in rotation', (t) => {
  const { room, players } = makeRoom(t, 2);

  room.handleLobbySet(players[0], { mapId: 'alley' });
  assert.equal(room.mapId, 'alley');
  assert.equal(room.map.id, 'alley');

  room.handleLobbySet(players[0], { mapId: 'practice' });
  assert.equal(room.mapId, 'alley', 'the single-player range is not a match map');

  room.handleLobbySet(players[0], { mapId: 'nonsense' });
  assert.equal(room.mapId, 'alley');
});

test('a non-host cannot change the mode or the map', (t) => {
  const { room, players } = makeRoom(t, 3);
  const mode = room.mode;
  // Rooms open on a randomly chosen map, so compare against what it actually was
  // rather than assuming it wasn't the one we try to set.
  room.handleLobbySet(players[0], { mapId: 'warehouse' });
  const mapId = room.mapId;

  room.handleLobbySet(players[1], { mode: 'gungame', mapId: 'alley' });
  assert.equal(room.mode, mode);
  assert.equal(room.mapId, mapId);
});

test('host controls are ignored once the match is live', (t) => {
  const { room, players } = makeRoom(t, 2);
  readyAll(room, players);
  room.beginRound();

  room.handleLobbySet(players[0], { mode: 'ffa' });
  assert.notEqual(room.mode, 'ffa', 'changing mode mid-match would reassign teams under people');
});

// -------------------------------------------------------------- what clients see

test('the lobby payload tells a client everything it needs to draw the panel', (t) => {
  const { room, players } = makeRoom(t, 3);
  room.handleReady(players[1], { ready: true });

  const state = room.lobbyState();
  assert.equal(state.code, room.code);
  assert.equal(state.hostId, players[0].id);
  assert.equal(state.capacity, MAX_PLAYERS);
  assert.equal(state.minPlayers, MIN_PLAYERS_TO_START);
  assert.equal(state.mapId, room.mapId);
  assert.equal(state.roster.length, 3);

  const entry = state.roster.find((p) => p.id === players[1].id);
  assert.equal(entry.ready, true, 'ready state has to reach the other clients');
  assert.equal(state.roster.find((p) => p.id === players[0].id).ready, false);
});

test('joining sends the newcomer the lobby state, and tells everyone else', (t) => {
  const { room, players } = makeRoom(t, 2);
  const existing = players[0].ws;
  const before = existing.received(S2C.LOBBY).length;

  const ws = fakeSocket();
  room.addPlayer({ id: 'p9', name: 'Ninth', ws });

  const joined = ws.last(S2C.JOINED);
  assert.ok(joined?.lobby, 'the JOINED message carries the lobby so the panel draws at once');
  assert.equal(joined.lobby.roster.length, 3);
  assert.ok(
    existing.received(S2C.LOBBY).length > before,
    'the players already waiting must see the new arrival',
  );
});

test('the start clock is reported as a remaining duration, not an absolute time', (t) => {
  const { room, players } = makeRoom(t, 3);
  room.handleReady(players[0], { ready: true });
  assert.equal(room.lobbyState().startsInMs, 0, 'no clock, no countdown');

  room.handleReady(players[1], { ready: true });
  const { startsInMs } = room.lobbyState();
  assert.ok(startsInMs > 0 && startsInMs <= LOBBY_GRACE_MS, `unexpected ${startsInMs}ms`);
});

// ------------------------------------------------------------------- classes

test('every class names a real weapon and a distinct primary', () => {
  assert.ok(CLASS_IDS.length >= 4, 'a class picker needs enough choices to be a choice');
  assert.ok(CLASSES[DEFAULT_CLASS], 'the default class has to exist');

  const primaries = new Set();
  for (const id of CLASS_IDS) {
    const cls = CLASSES[id];
    assert.equal(cls.id, id, `${id}: id must match its key`);
    assert.ok(cls.name && cls.blurb, `${id}: needs a name and a blurb for the picker`);
    assert.ok(WEAPONS[cls.primary], `${id}: primary ${cls.primary} is not a real weapon`);
    assert.ok(!primaries.has(cls.primary), `${cls.primary} is the primary of two classes`);
    primaries.add(cls.primary);
  }
});

test('every class fits on the number keys', () => {
  assert.ok(CLASS_IDS.length <= 9, 'classes are chosen with digits 1-9 on the death screen');
});

test('a loadout is the class primary plus the shared sidearm and knife', () => {
  for (const id of CLASS_IDS) {
    assert.deepEqual(loadoutForClass(id), [CLASSES[id].primary, 'pistol', 'knife']);
  }
  // Junk from the wire falls back rather than throwing.
  assert.deepEqual(loadoutForClass('nope'), loadoutForClass(DEFAULT_CLASS));
});

test('players start on the default class and spawn with its loadout', (t) => {
  const { room, players } = makeRoom(t, 2, 'ffa');
  assert.equal(players[0].classId, DEFAULT_CLASS);

  readyAll(room, players);
  room.beginRound();
  assert.deepEqual(players[0].inventory, loadoutForClass(DEFAULT_CLASS));
});

test('choosing a class in the lobby re-arms you immediately', (t) => {
  const { room, players } = makeRoom(t, 2, 'ffa');
  const ws = players[0].ws;

  room.handleSetClass(players[0], { classId: 'recon' });
  assert.equal(players[0].classId, 'recon');
  assert.deepEqual(players[0].inventory, loadoutForClass('recon'));
  assert.equal(players[0].weapon, 'sniper');

  const load = ws.last(S2C.LOADOUT);
  assert.equal(load.classId, 'recon', 'the client needs the change confirmed');
  assert.deepEqual(load.inventory, loadoutForClass('recon'));

  // And it survives into the match.
  readyAll(room, players);
  room.beginRound();
  assert.deepEqual(players[0].inventory, loadoutForClass('recon'));
});

test('a live player cannot re-arm mid-fight; the choice waits for their respawn', (t) => {
  const { room, players } = makeRoom(t, 2, 'ffa');
  readyAll(room, players);
  room.beginRound();

  const victim = players[0];
  assert.equal(victim.alive, true);
  const held = [...victim.inventory];

  room.handleSetClass(victim, { classId: 'breacher' });
  assert.equal(victim.classId, 'breacher', 'the choice is remembered');
  assert.deepEqual(victim.inventory, held, 'but the gun in their hands does not change');

  // Die, and the new class arrives with the respawn.
  room.killPlayer(victim, players[1], 'rifle');
  assert.equal(victim.alive, false);
  victim.respawnAt = Date.now() - 1;
  room.tickLive(Date.now());
  assert.equal(victim.alive, true);
  assert.deepEqual(victim.inventory, loadoutForClass('breacher'));
});

test('a dead player changing class re-arms at once, before respawning', (t) => {
  const { room, players } = makeRoom(t, 2, 'ffa');
  readyAll(room, players);
  room.beginRound();

  const victim = players[0];
  room.killPlayer(victim, players[1], 'rifle');
  room.handleSetClass(victim, { classId: 'support' });
  assert.deepEqual(victim.inventory, loadoutForClass('support'), 'the death screen choice is instant');

  const respawn = (() => {
    victim.respawnAt = Date.now() - 1;
    room.tickLive(Date.now());
    return victim.ws.last(S2C.RESPAWN);
  })();
  assert.deepEqual(respawn.inventory, loadoutForClass('support'));
});

test('an unknown class is ignored rather than trusted', (t) => {
  const { room, players } = makeRoom(t, 2, 'ffa');

  room.handleSetClass(players[0], { classId: 'lolnope' });
  assert.equal(players[0].classId, DEFAULT_CLASS);

  room.handleSetClass(players[0], { classId: null });
  assert.equal(players[0].classId, DEFAULT_CLASS);

  room.handleSetClass(players[0], {});
  assert.equal(players[0].classId, DEFAULT_CLASS);
});

test('gun game ignores your class and hands out the ladder', (t) => {
  const { room, players } = makeRoom(t, 2, 'gungame');

  room.handleSetClass(players[0], { classId: 'recon' });
  assert.equal(players[0].classId, 'recon', 'the pick is still remembered for other modes');

  readyAll(room, players);
  room.beginRound();
  assert.deepEqual(players[0].inventory, [GUNGAME_LADDER[0]], 'gun game starts everyone on rung one');
});

test('a gun game promotion survives the promoted player dying', (t) => {
  const { room, players } = makeRoom(t, 2, 'gungame');
  readyAll(room, players);
  room.beginRound();

  const [killer, victim] = players;
  room.killPlayer(victim, killer, GUNGAME_LADDER[0]);
  assert.equal(killer.ladderIndex, 1);
  assert.deepEqual(killer.inventory, [GUNGAME_LADDER[1]], 'promoted to rung two');

  // Now the killer dies. Spawning resolves the loadout, so it must resolve to the
  // rung they climbed to and not back to the bottom.
  room.killPlayer(killer, victim, GUNGAME_LADDER[0]);
  killer.respawnAt = Date.now() - 1;
  room.tickLive(Date.now());
  assert.deepEqual(killer.inventory, [GUNGAME_LADDER[1]], 'a death must not demote you');
});

test('the roster carries classes so the lobby can show them', (t) => {
  const { room, players } = makeRoom(t, 2, 'ffa');
  room.handleSetClass(players[1], { classId: 'marksman' });

  const entry = room.lobbyState().roster.find((p) => p.id === players[1].id);
  assert.equal(entry.classId, 'marksman');
});
