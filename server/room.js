// A room is one match: a fixed set of players, a map, a mode and a clock.
//
// The server owns everything consequential — health, deaths, score, spawns, the
// round timer, gun-game progression. It does NOT own movement; clients simulate
// their own position and this just sanity-checks it (see validate.js).

import {
  SERVER_TICK_HZ, ROUND_MS, COUNTDOWN_MS, SCOREBOARD_MS, MIN_PLAYERS_TO_START,
  MAX_HEALTH, RESPAWN_DELAY_MS, SPAWN_PROTECTION_MS, REGEN_DELAY_MS,
  REGEN_PER_SECOND, FALL_DAMAGE_MIN_SPEED, FALL_DAMAGE_PER_SPEED,
  PLAYER_HEIGHT, PLAYER_RADIUS, EMPTY_ROOM_TTL_MS, LOBBY_GRACE_MS, MODE_ROUND_MS,
  BARREL_HITS, BARREL_DAMAGE, BARREL_RADIUS, BARREL_CHAIN_RADIUS, BARREL_CHAIN_LIMIT,
  TEAMS, HEALTH_PACK_HEAL, HEALTH_PACK_RADIUS, HEALTH_PACK_RESPAWN_MS,
  WAVE_BREAK_MS, WAVE_FIRST_DELAY_MS, WAVE_MAX_CONCURRENT,
  WAVE_BASE_ENEMIES, WAVE_ENEMIES_PER_WAVE,
  EMOTE_COOLDOWN_MS, BR_DROP_HEIGHT, BR_VICTORY_MS, BR_SCOREBOARD_MS,
  VEHICLE_MAX_SPEED, VEHICLE_USE_RADIUS, VEHICLE_HEALTH, VEHICLE_DESTRUCTION_DAMAGE,
} from '../shared/constants.js';
import {
  S2C, PHASE, FLAG, MODES, EMOTES, encode, encodeSnapshot, sanitiseChat,
} from '../shared/protocol.js';
import { getMap, nextMap, ROTATION } from '../shared/maps/index.js';
import {
  PRIMARY_IDS, getPrimary, getWeapon, damageAtDistance,
} from '../shared/weapons.js';
import {
  pushOutOfSolids, playerOverlapsAny, hasLineOfSight, raycastBoxes,
} from '../shared/collision.js';
import { raycastVehicle } from '../shared/vehicles.js';
import * as modes from './modes.js';
import { createAiPlayer, stepAi, aiName } from './ai.js';
import {
  createBrState, tickZone, zonePayload, lootList, takeLoot, aiZoneWaypoint, aiNeedsZone,
  aiConsiderLoot, aliveCount, soleSurvivor,
} from './br.js';
import {
  validateMove, validateHit, validateFireRate, capPelletCount, heightOf, eyeOf,
  sanitiseShotTrace,
} from './validate.js';

const TICK_MS = 1000 / SERVER_TICK_HZ;

// Phase durations, overridable by env so a test run can cycle whole rounds in
// seconds instead of three minutes. Server-only file, so process.env is safe
// here — never do this in shared/, which the browser also imports.
const DURATION = {
  round: Number(process.env.ARENA_ROUND_MS) || ROUND_MS,
  countdown: Number(process.env.ARENA_COUNTDOWN_MS) || COUNTDOWN_MS,
  scoreboard: Number(process.env.ARENA_SCOREBOARD_MS) || SCOREBOARD_MS,
  lobbyGrace: Number(process.env.ARENA_LOBBY_GRACE_MS) || LOBBY_GRACE_MS,
};

export class Room {
  constructor(code, mode = 'tdm') {
    this.code = code;
    this.mode = mode;
    this.players = new Map();
    this.teamScores = { A: 0, B: 0 };

    // Battle royale has exactly one map; the arena modes rotate.
    this.mapId = modes.isBattleRoyale(mode)
      ? 'island'
      : ROTATION[Math.floor(Math.random() * ROTATION.length)];
    this.map = getMap(this.mapId);
    this.resetBarrels();
    this.resetPickups();

    this.phase = PHASE.LOBBY;
    this.phaseEndsAt = 0;
    this.tickCount = 0;
    this.emptySince = Date.now();
    this.empty = false;
    this.closed = false;
    this.lastResult = null;
    this.roundPrepared = false;

    // Lobby: whoever got here first picks the mode and the map and can force the
    // start; everyone readies up individually.
    this.hostId = null;
    this.graceEndsAt = 0;

    // Players who asked, from the results screen, to regroup in the lobby rather
    // than roll straight into the next round.
    this.regroupRequests = new Set();

    // AI bookkeeping. aiSpawned only ever increases, so bot names don't repeat
    // within a room even as they're added and removed.
    this.aiSpawned = 0;
    this.aiSkill = 'normal';

    // Survival state. Null in every other mode.
    this.wave = null;
    this.br = null;
    this.vehicles = [];
    this.botTarget = 0;

    this.timer = setInterval(() => this.tick(), TICK_MS);
    // Don't hold the process open on an idle room.
    this.timer.unref?.();
  }

  // ------------------------------------------------------------------ players

  get size() {
    return this.players.size;
  }

  /**
   * People, as opposed to players. Once AI can occupy slots, players.size stops
   * meaning "is anyone here" — an all-bot room would never close and would never
   * stop ticking. Everything about presence uses this instead.
   */
  humanCount() {
    let n = 0;
    for (const p of this.players.values()) if (!p.isBot) n++;
    return n;
  }

  /**
   * Humans needed to start. Survival is solo by design, and battle royale fills
   * every empty slot with AI — so in both cases one person is a match.
   */
  minPlayers() {
    if (modes.isSurvival(this.mode) || modes.isBattleRoyale(this.mode)) return 1;
    return MIN_PLAYERS_TO_START;
  }

  humans() {
    return [...this.players.values()].filter((p) => !p.isBot);
  }

  /** Slots in this room. Battle royale runs a forty-five-player lobby. */
  capacity() {
    return modes.capacityFor(this.mode);
  }

  get tickMs() {
    return TICK_MS;
  }

  isFull() {
    return this.players.size >= this.capacity();
  }

  addPlayer({ id, name, ws, primaryId }) {
    const player = {
      id,
      name,
      ws,
      team: null,
      ready: false,
      primaryId: getPrimary(primaryId),
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
      lastEmoteAt: 0,
      vehicleId: null,
    };

    this.players.set(id, player);
    player.team = modes.assignTeam(this, player);
    modes.rebalance(this);
    this.emptySince = 0;
    this.ensureHost();

    player.inventory = modes.loadoutFor(this, player);
    player.weapon = player.inventory[0];

    this.sendTo(player, S2C.JOINED, {
      code: this.code,
      mode: this.mode,
      mapId: this.mapId,
      you: { id, team: player.team, primaryId: player.primaryId },
      phase: this.phase,
      phaseMsLeft: Math.max(0, this.phaseEndsAt - Date.now()),
      roster: this.roster(),
      teamScores: this.teamScores,
      inventory: player.inventory,
      lobby: this.lobbyState(),
      // Barrels already destroyed, so a latecomer doesn't see ones that are gone.
      barrelsGone: this.destroyedBarrels(),
      pickupsTaken: this.takenPickups(),
      loot: this.br ? lootList(this.br) : null,
      zone: this.br ? zonePayload(this.br) : null,
      vehicles: this.vehicles.length ? this.vehiclePayload() : null,
    });

    this.broadcastRoster();

    // A prepared countdown already has everybody at their start position. A
    // late joiner belongs there too, not at [0,0,0] falling under the map.
    if (this.phase === PHASE.LIVE || (this.phase === PHASE.COUNTDOWN && this.roundPrepared)) {
      this.spawn(player);
    }
    else this.evaluateLobby();

    return player;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;
    this.releaseVehicle(player);
    this.players.delete(id);
    // Someone who has left shouldn't still be holding the room in the lobby.
    this.regroupRequests.delete(id);

    if (this.humanCount() === 0) {
      // Last human out: end the match and mark the room for immediate closure.
      // Previously it sat in the lobby for a 60s TTL, still ticking 20 times a
      // second and still holding its code, which is a slow leak on a server
      // that's meant to be one small always-on instance.
      this.emptySince = Date.now();
      this.phase = PHASE.LOBBY;
      this.hostId = null;
      this.graceEndsAt = 0;
      this.lastResult = null;
      this.empty = true;
    } else {
      modes.rebalance(this);
      this.ensureHost();
      this.broadcastRoster();
      // Everyone else left mid-match — back to the lobby rather than a 1-player
      // "match" running its clock down.
      if (this.phase !== PHASE.LOBBY && this.players.size < MIN_PLAYERS_TO_START) {
        this.setPhase(PHASE.LOBBY, 0);
      }
      if (this.phase === PHASE.LOBBY) this.evaluateLobby();
    }
  }

  /**
   * Ready to be torn down. An empty room qualifies straight away — there's
   * nothing to come back to, since a rejoin would create a fresh room anyway.
   * The TTL is kept only as a backstop for a room that somehow emptied without
   * going through removePlayer.
   */
  isExpired(now = Date.now()) {
    // Bots don't keep a room alive.
    if (this.humanCount() > 0) return false;
    if (this.empty) return true;
    return this.emptySince > 0 && now - this.emptySince > EMPTY_ROOM_TTL_MS;
  }

  dispose() {
    clearInterval(this.timer);
    this.timer = null;
    this.closed = true;
  }

  roster() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      isBot: !!p.isBot,
      team: p.team,
      ready: p.ready,
      primaryId: p.primaryId,
      score: p.score,
      kills: p.kills,
      deaths: p.deaths,
      ladderIndex: p.ladderIndex,
    }));
  }

  /**
   * The host is whoever has been here longest. Nobody chose them and nobody can
   * take it from them — a vote or a transfer UI is more machinery than a room of
   * coworkers needs, and "longest-standing" is the same answer everyone in the
   * room would give anyway.
   */
  ensureHost() {
    if (this.hostId && this.players.has(this.hostId)) return;

    let next = null;
    for (const p of this.players.values()) {
      if (p.isBot) continue; // a bot can't pick the map
      if (!next || p.joinedAt < next.joinedAt) next = p;
    }
    this.hostId = next?.id ?? null;
  }

  isHost(player) {
    return !!player && player.id === this.hostId;
  }

  /** Everything the lobby screen renders. Includes the roster so a client only
   *  ever needs one message to redraw the whole panel. */
  lobbyState() {
    return {
      code: this.code,
      mode: this.mode,
      mapId: this.mapId,
      hostId: this.hostId,
      capacity: this.capacity(),
      minPlayers: this.minPlayers(),
      bots: this.players.size - this.humanCount(),
      maxBots: Math.max(0, this.capacity() - this.humanCount()),
      startsInMs: this.graceEndsAt > 0 ? Math.max(0, this.graceEndsAt - Date.now()) : 0,
      roster: this.roster(),
    };
  }

  // ------------------------------------------------------------------ messaging

  sendTo(player, type, payload) {
    if (player.ws?.readyState !== 1) return;
    player.ws.send(encode(type, payload));
  }

  broadcast(type, payload, except = null) {
    const msg = encode(type, payload);
    for (const p of this.players.values()) {
      if (p === except) continue;
      if (p.ws?.readyState === 1) p.ws.send(msg);
    }
  }

  broadcastRaw(msg) {
    for (const p of this.players.values()) {
      if (p.ws?.readyState === 1) p.ws.send(msg);
    }
  }

  broadcastRoster() {
    this.broadcast(S2C.ROSTER, { roster: this.roster(), teamScores: this.teamScores });
  }

  broadcastLobby() {
    this.broadcast(S2C.LOBBY, this.lobbyState());
  }

  // -------------------------------------------------------------------- phases

  /**
   * Everything a client needs to render the current phase.
   *
   * Built on demand rather than captured at transition time so it can be re-sent
   * mid-phase — a regroup request has to reach everyone without restarting the
   * countdown they're all watching, hence msLeft being derived from the deadline.
   */
  phasePayload() {
    return {
      phase: this.phase,
      msLeft: this.phaseEndsAt > 0 ? Math.max(0, this.phaseEndsAt - Date.now()) : 0,
      mapId: this.mapId,
      // The results screen names the map you're about to play.
      nextMapId: this.phase === PHASE.SCOREBOARD
        ? (modes.isBattleRoyale(this.mode) ? 'island' : nextMap(this.mapId))
        : null,
      teamScores: this.teamScores,
      roster: this.roster(),
      result: this.lastResult,
      resultText: this.lastResult ? modes.describeResult(this, this.lastResult) : null,
      regroup: [...this.regroupRequests],
      mode: this.mode,
    };
  }

  setPhase(phase, durationMs) {
    this.phase = phase;
    this.phaseEndsAt = durationMs > 0 ? Date.now() + durationMs : 0;
    this.broadcast(S2C.PHASE, this.phasePayload());
  }

  // ------------------------------------------------------------------- lobby
  //
  // Two rules decide when a lobby starts, and the second one exists only to stop
  // the first from deadlocking:
  //
  //   1. Everybody present has readied up — go immediately.
  //   2. At least MIN_PLAYERS have readied but somebody hasn't — run a grace
  //      clock, then start without them.
  //
  // The grace clock needs a quorum of *ready* players to run at all, so a match
  // can never start unless the minimum number of people actively asked for it.
  // The host can also force the start, which is what actually gets used when
  // eight people are stood around waiting for one straggler.

  evaluateLobby() {
    if (this.phase !== PHASE.LOBBY) return;

    // AI cannot click Ready and should never hold humans in the lobby. This
    // matters most after a Battle Royale, where the previous round can leave
    // fill bots in the roster while the human regroups.
    const players = this.humans();
    const readyCount = players.filter((p) => p.ready).length;

    // Counted in humans, and against this mode's minimum — survival is a solo
    // mode, so a global "needs two people" would make it unstartable.
    if (this.humanCount() < this.minPlayers()) {
      this.graceEndsAt = 0;
      this.broadcastLobby();
      return;
    }

    if (readyCount === players.length) {
      this.startCountdown();
      return;
    }

    if (readyCount >= this.minPlayers()) {
      if (this.graceEndsAt === 0) this.graceEndsAt = Date.now() + DURATION.lobbyGrace;
    } else {
      // Dropped back below quorum — somebody un-readied, or left.
      this.graceEndsAt = 0;
    }

    this.broadcastLobby();
  }

  startCountdown() {
    this.graceEndsAt = 0;
    this.lastResult = null;
    this.prepareRound();
    this.setPhase(PHASE.COUNTDOWN, DURATION.countdown);
  }

  handleReady(player, msg) {
    if (this.phase !== PHASE.LOBBY) return;
    const ready = msg?.ready !== false;
    if (player.ready === ready) return;
    player.ready = ready;
    this.evaluateLobby();
  }

  handleStart(player) {
    if (this.phase !== PHASE.LOBBY) return;
    if (!this.isHost(player)) return;
    if (this.humanCount() < this.minPlayers()) return;
    this.startCountdown();
  }

  /** Host picks the mode and the map from the lobby. */
  handleLobbySet(player, msg) {
    if (this.phase !== PHASE.LOBBY) return;
    if (!this.isHost(player)) return;

    let changed = false;

    const requestedModeFits =
      typeof msg?.mode === 'string' &&
      this.humanCount() <= modes.capacityFor(msg.mode);
    if (
      requestedModeFits &&
      msg.mode !== this.mode &&
      MODES.includes(msg.mode)
    ) {
      this.mode = msg.mode;
      this.teamScores = { A: 0, B: 0 };

      // Team assignment has to be redone from scratch. Reusing it would leave
      // everyone holding a team from a mode that no longer has any, and switching
      // *into* a team mode would pile the whole room onto A.
      for (const p of this.players.values()) p.team = null;
      for (const p of this.players.values()) p.team = modes.assignTeam(this, p);
      modes.rebalance(this);

      // Gun Game hands out one weapon and the others hand out three, so the
      // loadout everyone was told about at join time is now wrong.
      // The map has to follow the mode: battle royale plays the island and
      // nothing else, and the arena modes can't play the island at all.
      const wantedMap = modes.mapForMode(this.mode, this.mapId);
      if (wantedMap !== this.mapId) {
        this.mapId = wantedMap;
        this.map = getMap(this.mapId);
        this.resetBarrels();
        this.resetPickups();
      }
      // Switching out of battle royale leaves bots behind that a normal lobby
      // never asked for.
      if (!modes.isBattleRoyale(this.mode)) this.removeAiPlayers(Math.max(0, (this.players.size - this.humanCount()) - this.botTarget));

      for (const p of this.players.values()) {
        p.ladderIndex = 0;
        p.inventory = modes.loadoutFor(this, p);
        p.weapon = p.inventory[0];
        this.sendTo(p, S2C.LOADOUT, { inventory: p.inventory, weapon: p.weapon });
      }
      changed = true;
    }

    if (
      !modes.isBattleRoyale(this.mode) &&
      typeof msg?.mapId === 'string' &&
      msg.mapId !== this.mapId &&
      ROTATION.includes(msg.mapId)
    ) {
      this.mapId = msg.mapId;
      this.map = getMap(this.mapId);
      changed = true;
    }

    if (changed) this.broadcastLobby();
  }

  /**
   * Put the next round in a fully renderable state before the countdown appears.
   *
   * Previously players entered the match screen alive=false at [0,0,0], so the
   * client integrated a falling body for five seconds and could show stale kill
   * state from the previous round. Preparing first makes "Get ready" show the
   * actual map, actual spawn, actual loot and (in BR) the actual aircraft drop.
   */
  prepareRound() {
    if (this.roundPrepared) return;
    modes.resetScores(this);

    // Wipe the previous round's mode state before installing this round's.
    // Without this, switching out of battle royale left this.br set, so the old
    // zone kept closing and damaging people through an entire Team Deathmatch —
    // and switching out of survival left this.wave set, quietly spawning enemy
    // bots into a Free-for-all. Each mode's state is installed below; nothing
    // should survive a round it wasn't started for.
    this.wave = null;
    this.br = null;
    this.vehicles = [];

    this.resetBarrels();
    this.resetPickups();
    this.broadcast(S2C.BARRELS, { gone: [] });
    this.broadcast(S2C.PICKUPS, { taken: [] });
    this.graceEndsAt = 0;
    this.regroupRequests.clear();
    for (const p of this.players.values()) {
      // Readiness is per-match. If the room drops back to the lobby later,
      // everyone opts in again rather than inheriting a yes from an hour ago.
      p.ready = false;
      this.spawn(p); // resolves the loadout from their class

    }
    if (modes.isSurvival(this.mode)) this.startSurvival();
    if (modes.isBattleRoyale(this.mode)) this.startBattleRoyale();
    this.broadcastRoster();
    this.roundPrepared = true;
  }

  beginRound() {
    this.prepareRound();
    this.setPhase(PHASE.LIVE, this.roundMs());
  }

  endRound(result) {
    this.lastResult = result;
    this.roundPrepared = false;
    this.regroupRequests.clear();
    for (const p of this.players.values()) {
      p.alive = false;
      p.parachuting = false;
    }
    const duration = modes.isBattleRoyale(this.mode)
      ? Math.max(DURATION.scoreboard, BR_SCOREBOARD_MS)
      : DURATION.scoreboard;
    this.setPhase(PHASE.SCOREBOARD, duration);
  }

  /**
   * "Back to lobby" from the results screen.
   *
   * Any player can ask, and one asker is enough to hold the room — it isn't a
   * veto on playing, just a detour through the lobby, where the normal start
   * rules take over and the host can change the mode or map. Each player toggles
   * only their own request, so nobody can cancel somebody else's.
   */
  handleReturnToLobby(player, msg) {
    if (this.phase !== PHASE.SCOREBOARD) return;

    const want = msg?.on !== false;
    if (want === this.regroupRequests.has(player.id)) return;

    if (want) this.regroupRequests.add(player.id);
    else this.regroupRequests.delete(player.id);

    this.broadcast(S2C.PHASE, this.phasePayload());
  }

  // ------------------------------------------------------------ battle royale

  startBattleRoyale() {
    // Fill every empty slot with AI. A forty-five-player match with four people in
    // it is the whole point of having bots.
    const missing = this.capacity() - this.players.size;
    for (let i = 0; i < missing; i++) this.addAiPlayer({ team: null });

    // Spawn the ones just added. addAiPlayer only spawns when the room is already
    // LIVE, and during beginRound it isn't yet — so without this every bot stays
    // dead, the human is the only one standing, and the sole-survivor check ends
    // the match before it begins.
    for (const p of this.players.values()) {
      if (!p.alive) this.spawn(p);
    }

    this.br = createBrState(this.map);
    this.resetVehicles();
    this.broadcast(S2C.LOOT, { all: lootList(this.br) });
    this.broadcast(S2C.ZONE, zonePayload(this.br));
    this.broadcast(S2C.VEHICLES, { all: this.vehiclePayload() });
    this.broadcastAlive();
    this.systemChat(`${this.players.size} players. Last one standing.`);
  }

  broadcastAlive() {
    this.broadcast(S2C.ALIVE, { alive: aliveCount(this), total: this.players.size });
  }

  handleTakeLoot(player) {
    if (!this.br || this.phase !== PHASE.LIVE) return;
    takeLoot(this, this.br, player);
  }

  resetVehicles() {
    this.vehicles = (this.map.vehicleSpawns ?? []).map((spawn) => ({
      index: spawn.index,
      pos: [...spawn.pos],
      yaw: 0,
      driverId: null,
      health: VEHICLE_HEALTH,
      destroyed: false,
    }));
    for (const player of this.players.values()) player.vehicleId = null;
  }

  vehiclePayload(vehicle = null) {
    const encodeVehicle = (v) => ({
      i: v.index,
      p: v.pos.map((n) => Math.round(n * 100) / 100),
      y: Math.round(v.yaw * 1000) / 1000,
      d: v.driverId,
      h: Math.max(0, Math.round(v.health)),
      x: v.destroyed ? 1 : 0,
    });
    return vehicle ? [encodeVehicle(vehicle)] : this.vehicles.map(encodeVehicle);
  }

  releaseVehicle(player) {
    if (player?.vehicleId === null || player?.vehicleId === undefined) return;
    const vehicle = this.vehicles.find((v) => v.index === player.vehicleId);
    player.vehicleId = null;
    if (!vehicle || vehicle.driverId !== player.id) return;
    vehicle.driverId = null;
    this.broadcast(S2C.VEHICLES, { upsert: this.vehiclePayload(vehicle) });
  }

  handleVehicle(player, msg) {
    if (!this.br || this.phase !== PHASE.LIVE || !player.alive || player.parachuting) return;
    if (player.vehicleId !== null && player.vehicleId !== undefined) {
      this.releaseVehicle(player);
      return;
    }
    const index = Number(msg?.i);
    if (!Number.isInteger(index)) return;
    const vehicle = this.vehicles.find((v) => v.index === index);
    if (!vehicle || vehicle.driverId || vehicle.destroyed) return;
    const distance = Math.hypot(
      player.pos[0] - vehicle.pos[0],
      player.pos[1] - vehicle.pos[1],
      player.pos[2] - vehicle.pos[2],
    );
    if (distance > VEHICLE_USE_RADIUS) return;
    vehicle.driverId = player.id;
    player.vehicleId = vehicle.index;
    vehicle.pos = [...player.pos];
    vehicle.yaw = player.yaw;
    this.broadcast(S2C.VEHICLES, { upsert: this.vehiclePayload(vehicle) });
  }

  /** Nearest intact rover hit by a ray, using the same OBB as the client. */
  raycastVehicle(origin, direction, maxDistance) {
    let best = null;
    for (const vehicle of this.vehicles) {
      if (vehicle.destroyed) continue;
      const t = raycastVehicle(origin, direction, vehicle.pos, vehicle.yaw, maxDistance);
      if (t === null || (best && t >= best.t)) continue;
      best = { vehicle, t };
    }
    return best;
  }

  damageVehicle(vehicle, shooter, amount) {
    if (!vehicle || vehicle.destroyed || !Number.isFinite(amount) || amount <= 0) return;
    const dealt = Math.min(vehicle.health, Math.max(1, Math.round(amount)));
    vehicle.health -= dealt;
    const destroyed = vehicle.health <= 0;
    const at = [vehicle.pos[0], vehicle.pos[1] + 0.75, vehicle.pos[2]];

    if (destroyed) {
      vehicle.health = 0;
      vehicle.destroyed = true;
      const driver = vehicle.driverId ? this.players.get(vehicle.driverId) : null;
      vehicle.driverId = null;
      if (driver) {
        driver.vehicleId = null;
        driver.flags &= ~FLAG.VEHICLE;
        if (driver.alive) {
          this.applyDamage(driver, shooter, VEHICLE_DESTRUCTION_DAMAGE, 'vehicle');
        }
      }
    }

    this.broadcast(S2C.VEHICLES, {
      upsert: this.vehiclePayload(vehicle),
      hit: {
        i: vehicle.index,
        by: shooter?.id ?? null,
        amount: dealt,
        destroyed,
        at,
      },
    });
  }

  tickBattleRoyale(now) {
    if (!this.br) return;

    if (this.br.winnerId) {
      if (now >= this.br.endingAt) {
        const winner = this.players.get(this.br.winnerId);
        this.endRound({
          reason: 'br',
          winnerId: this.br.winnerId,
          winnerName: winner?.name ?? 'Survivor',
        });
      }
      return;
    }

    if (tickZone(this, this.br, now)) {
      // Only when it actually moved: the zone spends most of its time holding.
      this.broadcast(S2C.ZONE, zonePayload(this.br, now));
    }

    // One left: that's the match.
    const survivor = soleSurvivor(this);
    if (survivor && this.players.size > 1) {
      this.br.winnerId = survivor.id;
      this.br.endingAt = now + BR_VICTORY_MS;
      survivor.score += 10;
      this.broadcast(S2C.BR_WIN, {
        winnerId: survivor.id,
        winnerName: survivor.name,
        ms: BR_VICTORY_MS,
      });
    }
  }

  // ------------------------------------------------------------------ survival
  //
  // Escalating waves of AI. Enemies never respawn — clearing the wave is the goal
  // — and humans are revived only at the top of the next wave, so going down means
  // sitting out until your team clears it. If nobody is left standing, the run is
  // over and the score is how many waves you got through.

  startSurvival() {
    this.removeAiPlayers();
    this.wave = {
      number: 0,
      state: 'break',
      nextAt: Date.now() + WAVE_FIRST_DELAY_MS,
      toSpawn: 0,
      spawned: 0,
      nextSpawnAt: 0,
    };
    this.broadcastWave();
  }

  waveEnemyCount(n) {
    return WAVE_BASE_ENEMIES + (n - 1) * WAVE_ENEMIES_PER_WAVE;
  }

  waveSkill(n) {
    if (n < 3) return 'easy';
    if (n < 7) return 'normal';
    return 'hard';
  }

  aliveEnemies() {
    let n = 0;
    for (const p of this.players.values()) if (p.isBot && p.alive) n++;
    return n;
  }

  broadcastWave() {
    if (!this.wave) return;
    const w = this.wave;
    this.broadcast(S2C.WAVE, {
      number: w.number,
      state: w.state,
      enemiesLeft: this.aliveEnemies() + Math.max(0, w.toSpawn - w.spawned),
      msToNext: w.state === 'break' ? Math.max(0, w.nextAt - Date.now()) : 0,
    });
  }

  tickWaves(now) {
    const w = this.wave;
    if (!w) return;

    // Everyone down: the run ends here.
    if (!this.humans().some((p) => p.alive) && w.number > 0) {
      this.endRound(modes.resultAtTimeUp(this));
      return;
    }

    if (w.state === 'break') {
      if (now < w.nextAt) return;
      w.number += 1;
      w.toSpawn = this.waveEnemyCount(w.number);
      w.spawned = 0;
      w.nextSpawnAt = 0;
      w.state = 'active';
      this.aiSkill = this.waveSkill(w.number);
      // A new wave puts everyone back on their feet.
      for (const p of this.humans()) if (!p.alive) this.spawn(p);
      this.systemChat(`Wave ${w.number} — ${w.toSpawn} incoming`);
      this.broadcastWave();
      return;
    }

    // Trickle enemies in rather than dumping the whole wave at once: a wall of
    // twelve bots appearing together is a spike, not a fight.
    if (w.spawned < w.toSpawn && this.aliveEnemies() < WAVE_MAX_CONCURRENT && now >= w.nextSpawnAt) {
      this.addAiPlayer({ team: TEAMS.B, skill: this.aiSkill });
      w.spawned += 1;
      w.nextSpawnAt = now + 700;
      this.broadcastWave();
    }

    if (w.spawned >= w.toSpawn && this.aliveEnemies() === 0) {
      // Sweep the corpses so the roster doesn't grow without bound over a long run.
      this.removeAiPlayers();
      w.state = 'break';
      w.nextAt = now + WAVE_BREAK_MS;
      this.systemChat(`Wave ${w.number} cleared`);
      this.broadcastWave();
    }
  }

  // ----------------------------------------------------------------------- ai

  addAiPlayer({ primaryId, team, skill } = {}) {
    const bot = createAiPlayer({
      name: aiName(this.aiSpawned++),
      primaryId: primaryId ?? modes.randomPrimaryId(),
      team: team ?? null,
      skill: skill ?? this.aiSkill ?? 'normal',
    });
    this.players.set(bot.id, bot);
    if (team === undefined && modes.isTeamMode(this.mode)) bot.team = modes.assignTeam(this, bot);
    bot.inventory = modes.loadoutFor(this, bot);
    bot.weapon = bot.inventory[0];
    if (this.phase === PHASE.LIVE) this.spawn(bot);
    this.broadcastRoster();
    return bot;
  }

  removeAiPlayers(count = Infinity) {
    let removed = 0;
    for (const [id, p] of [...this.players]) {
      if (!p.isBot || removed >= count) continue;
      this.players.delete(id);
      removed++;
    }
    if (removed) this.broadcastRoster();
    return removed;
  }

  /**
   * Host sets how many AI opponents to play against. Applied immediately so the
   * lobby shows them in the slots before the round starts.
   */
  handleSetBots(player, msg) {
    if (!this.isHost(player)) return;
    if (modes.isSurvival(this.mode)) return; // survival manages its own enemies

    const capacity = this.capacity() - this.humanCount();
    const want = Math.max(0, Math.min(capacity, Math.floor(Number(msg.n) || 0)));
    this.botTarget = want;

    let current = this.players.size - this.humanCount();
    while (current > want) {
      this.removeAiPlayers(current - want);
      current = this.players.size - this.humanCount();
    }
    while (current < want) {
      this.addAiPlayer();
      current += 1;
    }
    this.broadcastLobby();
  }

  /** Where an AI should walk. Battle royale overrides it to respect the zone. */
  aiWaypointHint(bot) {
    if (this.br) return aiZoneWaypoint(this.br, bot);
    return null;
  }

  aiZoneUrgent(bot) {
    return this.br ? aiNeedsZone(this.br, bot) : false;
  }

  /** Whether an AI is allowed to shoot at someone. Modes override the details. */
  aiCanTarget(bot, other) {
    if (this.br && (Date.now() < this.br.combatStartsAt || aiNeedsZone(this.br, bot))) return false;
    return modes.canDamage(this, bot, other);
  }

  /** Tell clients an AI fired, so it gets a tracer, a bang and a radar blip. */
  broadcastAiShot(bot, from, to) {
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    this.broadcast(S2C.SHOTS, {
      id: bot.id,
      w: bot.weapon,
      o: from.map((v) => Math.round(v * 100) / 100),
      d: [dx / len, dy / len, dz / len].map((v) => Math.round(v * 1000) / 1000),
    });
  }

  stepAllAi(dt, now) {
    for (const p of this.players.values()) {
      if (!p.isBot || !p.alive) continue;
      stepAi(this, p, dt, now);
      // Battle royale: bots pick up guns they walk over, or they fight the whole
      // match with the pistol they landed with.
      if (this.br) aiConsiderLoot(this, this.br, p);
    }
  }

  // --------------------------------------------------------------------- chat

  /**
   * Relay a chat line.
   *
   * Rate-limited per player rather than per socket, because the point is to stop
   * one person flooding everyone else's screen — the socket-level flood guard in
   * index.js is about protecting the server, which is a different problem.
   */
  handleChat(player, msg) {
    const text = sanitiseChat(msg.t);
    if (!text) return;

    const now = Date.now();
    player.chatTimes = player.chatTimes.filter((t) => now - t < 6000);
    if (player.chatTimes.length >= 5) return;
    player.chatTimes.push(now);

    // Team chat only means anything when there are teams.
    const teamOnly = !!msg.team && modes.isTeamMode(this.mode) && !!player.team;
    const payload = {
      id: player.id,
      name: player.name,
      team: player.team,
      text,
      teamOnly,
    };

    if (!teamOnly) {
      this.broadcast(S2C.CHAT, payload);
      return;
    }
    for (const p of this.players.values()) {
      if (p.team === player.team) this.sendTo(p, S2C.CHAT, payload);
    }
  }

  /** A line from the server itself — joins, leaves, mode changes. */
  systemChat(text) {
    this.broadcast(S2C.CHAT, { system: true, text });
  }

  // ------------------------------------------------------------------- emotes

  /**
   * Relay one of the animation clips shipped with the shared character model.
   * Emotes are cosmetic, but the allow-list and cooldown keep a modified client
   * from turning them into arbitrary payload spam.
   */
  handleEmote(player, msg) {
    if (this.phase !== PHASE.LIVE || !player.alive) return;

    const emote = String(msg?.e ?? '');
    if (!Object.hasOwn(EMOTES, emote)) return;

    const now = Date.now();
    if (now - player.lastEmoteAt < EMOTE_COOLDOWN_MS) return;
    player.lastEmoteAt = now;

    this.broadcast(S2C.EMOTE, { id: player.id, e: emote });
  }

  // ------------------------------------------------------------- health packs
  //
  // Server-authoritative, because they change health. Collected by proximity on
  // the tick rather than by a client saying "I picked it up" — there's no aiming
  // involved, so there's nothing the client knows that the server doesn't.

  resetPickups() {
    this.pickups = new Map();
    for (const p of this.map.healthPacks) this.pickups.set(p.index, { takenUntil: 0 });
  }

  /** Indices currently collected, for syncing a joining client. */
  takenPickups(now = Date.now()) {
    const out = [];
    for (const [index, state] of this.pickups ?? []) {
      if (state.takenUntil > now) out.push(index);
    }
    return out;
  }

  tickPickups(now) {
    if (!this.pickups) return;

    for (const pack of this.map.healthPacks) {
      const state = this.pickups.get(pack.index);
      if (!state) continue;

      // Respawn.
      if (state.takenUntil > 0 && now >= state.takenUntil) {
        state.takenUntil = 0;
        this.broadcast(S2C.PICKUP, { index: pack.index, taken: false });
      }
      if (state.takenUntil > now) continue;

      for (const player of this.players.values()) {
        if (!player.alive || player.health >= MAX_HEALTH) continue;
        const d = Math.hypot(
          player.pos[0] - pack.pos[0],
          (player.pos[1] + PLAYER_HEIGHT * 0.4) - pack.pos[1],
          player.pos[2] - pack.pos[2],
        );
        if (d > HEALTH_PACK_RADIUS + PLAYER_RADIUS) continue;

        player.health = Math.min(MAX_HEALTH, player.health + HEALTH_PACK_HEAL);
        // Topping up shouldn't also restart the regen clock's grace period.
        state.takenUntil = now + HEALTH_PACK_RESPAWN_MS;
        this.broadcast(S2C.PICKUP, {
          index: pack.index,
          taken: true,
          by: player.id,
          at: pack.pos,
        });
        this.sendTo(player, S2C.DAMAGE, {
          self: true,
          amount: 0,
          heal: HEALTH_PACK_HEAL,
          health: Math.round(player.health),
        });
        break; // one pack, one player
      }
    }
  }

  // ------------------------------------------------------------------ barrels
  //
  // Server-authoritative, because they deal damage. The client reports "I shot
  // barrel 47" the same way it reports hitting a player, and everything that
  // matters — the hit count, whether it blows, who gets the kill — is decided
  // here.

  resetBarrels() {
    this.barrels = new Map();
    for (const b of this.map.barrels) this.barrels.set(b.index, { hits: 0, exploded: false });
  }

  /** Indices of barrels already destroyed, for syncing a joining client. */
  destroyedBarrels() {
    const out = [];
    for (const [index, state] of this.barrels ?? []) if (state.exploded) out.push(index);
    return out;
  }

  hitBarrel(index, shooter) {
    const state = this.barrels?.get(index);
    if (!state || state.exploded) return;

    const barrel = this.map.barrels.find((b) => b.index === index);
    if (!barrel) return;

    // Same loose validation as a player hit: it has to be in range and visible.
    const eye = eyeOf(shooter);
    const distance = Math.hypot(
      barrel.pos[0] - eye[0],
      barrel.pos[1] - eye[1],
      barrel.pos[2] - eye[2],
    );
    if (distance > 250) return;
    if (!hasLineOfSight(eye, barrel.pos, this.map.solids, 1.2)) return;

    state.hits += 1;
    if (state.hits >= BARREL_HITS) {
      this.explodeBarrel(barrel, shooter, 0);
    } else {
      this.broadcast(S2C.BARREL_HIT, { index, hits: state.hits, at: barrel.pos });
    }
  }

  explodeBarrel(barrel, shooter, depth) {
    const state = this.barrels.get(barrel.index);
    if (!state || state.exploded) return;
    state.exploded = true;

    this.broadcast(S2C.EXPLODE, { index: barrel.index, at: barrel.pos });

    for (const victim of this.players.values()) {
      if (!victim.alive) continue;

      const centre = [victim.pos[0], victim.pos[1] + heightOf(victim) * 0.55, victim.pos[2]];
      const distance = Math.hypot(
        centre[0] - barrel.pos[0],
        centre[1] - barrel.pos[1],
        centre[2] - barrel.pos[2],
      );
      if (distance > BARREL_RADIUS) continue;

      // A wall between you and the blast should protect you, which is what makes
      // barrels a positional threat rather than an area denial ability.
      if (!hasLineOfSight(barrel.pos, centre, this.map.blastSolids, 0.9)) continue;

      // You can absolutely blow yourself up. Teammates are still protected,
      // matching friendly fire being off everywhere else.
      const isSelf = shooter && victim.id === shooter.id;
      if (!isSelf && shooter && !modes.canDamage(this, shooter, victim)) continue;

      const damage = Math.round(BARREL_DAMAGE * (1 - distance / BARREL_RADIUS));
      if (damage <= 0) continue;
      this.applyDamage(victim, shooter, damage, 'barrel');
    }

    // Chain reaction. Bounded by depth so a tightly packed cluster can't recurse
    // without end.
    if (depth >= BARREL_CHAIN_LIMIT) return;
    for (const other of this.map.barrels) {
      if (other.index === barrel.index) continue;
      const st = this.barrels.get(other.index);
      if (!st || st.exploded) continue;
      const d = Math.hypot(
        other.pos[0] - barrel.pos[0],
        other.pos[1] - barrel.pos[1],
        other.pos[2] - barrel.pos[2],
      );
      if (d <= BARREL_CHAIN_RADIUS) this.explodeBarrel(other, shooter, depth + 1);
    }
  }

  /**
   * How long this mode's round runs. The env override still wins so a test can
   * cycle rounds in seconds.
   */
  roundMs() {
    if (process.env.ARENA_ROUND_MS) return Number(process.env.ARENA_ROUND_MS);
    return MODE_ROUND_MS[this.mode] ?? ROUND_MS;
  }

  rotateMap() {
    // Battle royale always plays the island; the rotation is for the arena modes.
    if (modes.isBattleRoyale(this.mode)) {
      this.mapId = 'island';
      this.map = getMap(this.mapId);
      this.resetBarrels();
      this.resetPickups();
      return;
    }
    this.mapId = nextMap(this.mapId);
    this.map = getMap(this.mapId);
    this.resetBarrels();
    this.resetPickups();
  }

  /**
   * Height below which a player is dead.
   *
   * Rooftops declares one because falling between buildings is a real way to
   * die there. The enclosed maps get a catch-all below their floor, so falling
   * through the world is recoverable rather than a stuck player.
   */
  voidY() {
    return this.map.lethalFallY ?? this.map.bounds.min[1] + 2;
  }

  // -------------------------------------------------------------------- spawning

  /**
   * Pick the spawn furthest from the nearest live enemy.
   *
   * This is what actually prevents spawn-trading on the small maps — static
   * spawn placement can only get you so far, especially on Alley where the
   * whole arena is 36m across.
   */
  chooseSpawn(player) {
    const points = modes.spawnPointsFor(this, this.map, player);
    const enemies = [...this.players.values()].filter(
      (p) => p !== player && p.alive && modes.canDamage(this, p, player),
    );

    let best = points[0];
    let bestScore = -Infinity;

    for (const point of points) {
      let nearest = Infinity;
      for (const e of enemies) {
        const d = Math.hypot(point[0] - e.pos[0], point[1] - e.pos[1], point[2] - e.pos[2]);
        nearest = Math.min(nearest, d);
      }
      // No enemies alive: spread out randomly instead of always picking [0].
      const score = enemies.length === 0 ? Math.random() : nearest;
      if (score > bestScore) {
        bestScore = score;
        best = point;
      }
    }
    return best;
  }

  spawn(player) {
    // The loadout is resolved here, which is what makes "applies on your next
    // spawn" true. A class chosen while alive only changes primaryId; this is the
    // single place that turns a class into weapons, for the lobby, a respawn and
    // a gun-game promotion alike.
    this.releaseVehicle(player);
    player.inventory = modes.loadoutFor(this, player);
    player.weapon = player.inventory[0];

    const point = this.chooseSpawn(player);
    const parachuting = modes.isBattleRoyale(this.mode);
    player.pos = [
      point[0],
      parachuting ? Math.max(point[1] + BR_DROP_HEIGHT, BR_DROP_HEIGHT) : point[1],
      point[2],
    ];
    player.health = MAX_HEALTH;
    player.alive = true;
    player.crouching = false;
    player.parachuting = parachuting;
    player.flags = parachuting ? FLAG.PARACHUTE | FLAG.AIRBORNE : 0;
    player.respawnAt = 0;
    player.lastDamageAt = 0;
    player.spawnProtectedUntil = Date.now() + SPAWN_PROTECTION_MS;

    if (playerOverlapsAny(player.pos, PLAYER_HEIGHT, PLAYER_RADIUS, this.map.solids)) {
      pushOutOfSolids(player.pos, PLAYER_HEIGHT, PLAYER_RADIUS, this.map.solids);
    }

    // Face roughly toward the middle of the map — nothing worse than spawning
    // looking at a wall.
    const b = this.map.bounds;
    const cx = (b.min[0] + b.max[0]) / 2;
    const cz = (b.min[2] + b.max[2]) / 2;
    const centreYaw = Math.atan2(-(cx - player.pos[0]), -(cz - player.pos[2]));
    // "Face the centre" is a useful default until a spawn sits behind deliberate
    // lane cover, at which point it means the first frame is a wall. Probe a few
    // nearby headings and retain the most open one, mildly preferring centre.
    let bestYaw = centreYaw;
    let bestView = -Infinity;
    const eye = [player.pos[0], player.pos[1] + PLAYER_HEIGHT - 0.15, player.pos[2]];
    for (const offset of [0, -Math.PI / 4, Math.PI / 4, -Math.PI / 2, Math.PI / 2, Math.PI]) {
      const yaw = centreYaw + offset;
      const dir = [-Math.sin(yaw), 0, -Math.cos(yaw)];
      const wall = raycastBoxes(eye, dir, this.map.solids, 14);
      const clearance = wall?.t ?? 14;
      const viewScore = clearance - Math.abs(offset) * 0.18;
      if (viewScore > bestView) {
        bestView = viewScore;
        bestYaw = yaw;
      }
    }
    player.yaw = bestYaw;
    player.pitch = 0;

    this.sendTo(player, S2C.RESPAWN, {
      pos: player.pos,
      yaw: player.yaw,
      health: player.health,
      inventory: player.inventory,
      weapon: player.weapon,
      protectedMs: SPAWN_PROTECTION_MS,
      parachuting,
    });
  }

  // -------------------------------------------------------------- client input

  handleState(player, msg) {
    const now = Date.now();
    const dt = (now - player.lastStateAt) / 1000;
    player.lastStateAt = now;

    const driving = player.vehicleId !== null && player.vehicleId !== undefined;
    const maxSpeed = driving ? VEHICLE_MAX_SPEED * 1.5 : undefined;
    const result = validateMove(
      player,
      { pos: msg.p, yaw: msg.y, pitch: msg.t },
      this.map,
      dt,
      maxSpeed,
    );
    if (!result.ok) {
      player.rejectedMoves++;
      // Leave the last known good position in place; a brief stall reads far
      // better than yanking someone across the map.
      return;
    }

    player.pos = result.pos;
    player.yaw = result.yaw;
    player.pitch = result.pitch;
    player.flags = msg.f | 0;
    const wasParachuting = !!player.parachuting;
    if (player.parachuting) {
      // The client lowers the canopy on first ground contact. Never allow a
      // packet to reopen it after landing.
      player.parachuting = (player.flags & FLAG.PARACHUTE) !== 0;
      if (!player.parachuting) player.flags &= ~FLAG.PARACHUTE;
    } else {
      player.flags &= ~FLAG.PARACHUTE;
    }
    if (wasParachuting && !player.parachuting) {
      player.spawnProtectedUntil = now + 2000;
    }
    player.crouching = (player.flags & FLAG.CROUCH) !== 0;
    if (driving) {
      const vehicle = this.vehicles.find(
        (candidate) => candidate.index === player.vehicleId
          && candidate.driverId === player.id && !candidate.destroyed,
      );
      if (vehicle) {
        vehicle.pos = [...player.pos];
        vehicle.yaw = player.yaw;
        player.flags |= FLAG.VEHICLE;
        // Normal player snapshots already carry the driver's position and yaw.
        // Broadcasting a second, rounded vehicle transform for every snapshot
        // made clients alternate between two timelines and visibly jitter.
      } else {
        player.vehicleId = null;
        player.flags &= ~FLAG.VEHICLE;
      }
    } else {
      player.flags &= ~FLAG.VEHICLE;
    }

    // Fall damage and the void are reported by the client but applied here.
    if (typeof msg.fd === 'number' && msg.fd > 0 && player.alive) {
      const capped = Math.min(msg.fd, (60 - FALL_DAMAGE_MIN_SPEED) * FALL_DAMAGE_PER_SPEED);
      this.applyDamage(player, null, capped, 'fall');
    }
    if (msg.void && player.alive) {
      this.applyDamage(player, null, MAX_HEALTH * 2, 'void');
    }
  }

  handleSwitch(player, msg) {
    if (!player.inventory.includes(msg.w)) return;
    player.weapon = msg.w;
  }

  /**
   * Pick a class. Takes effect at once if you aren't currently alive — in the
   * lobby, or on the death screen, which are the two moments anyone actually
   * chooses — and otherwise waits for your next spawn. Letting a live player
   * re-arm on demand would make every class the best class.
   */
  handleSetPrimary(player, msg) {
    const id = String(msg?.primaryId ?? '');
    if (!PRIMARY_IDS.includes(id) || player.primaryId === id) return;
    player.primaryId = id;

    if (modes.usesClasses(this.mode) && !player.alive) {
      player.inventory = modes.loadoutFor(this, player);
      player.weapon = player.inventory[0];
      this.sendTo(player, S2C.LOADOUT, {
        inventory: player.inventory,
        weapon: player.weapon,
        primaryId: player.primaryId,
      });
    }

    if (this.phase === PHASE.LOBBY) this.broadcastLobby();
    else this.broadcastRoster();
  }

  handleShoot(player, msg) {
    if (this.phase !== PHASE.LIVE || !player.alive || player.parachuting || player.vehicleId != null) return;
    if (this.br && Date.now() < this.br.combatStartsAt) return;

    const weaponId = msg.w;
    if (!player.inventory.includes(weaponId)) return;
    if (!validateFireRate(player, weaponId, Date.now())) return;

    // Firing gives away spawn protection — otherwise you could shoot from
    // behind it with impunity.
    player.spawnProtectedUntil = 0;

    const hits = Array.isArray(msg.h) ? msg.h : [];
    const maxPellets = capPelletCount(weaponId, hits.length);
    const trace = sanitiseShotTrace(player, msg.o, msg.d);

    // Tell everyone else a shot was fired so they get a tracer and a bang, even
    // if it hit nothing.
    this.broadcast(S2C.SHOTS, {
      id: player.id,
      w: weaponId,
      o: trace.origin,
      d: trace.direction,
    }, player);

    const damageByVictim = new Map();

    for (let i = 0; i < maxPellets; i++) {
      const hit = hits[i];
      const victim = this.players.get(hit?.id);
      if (!victim || !modes.canDamage(this, player, victim)) continue;

      const check = validateHit({
        room: this,
        shooter: player,
        victim,
        weaponId,
        zone: hit.z,
        map: this.map,
      });
      if (!check.ok) continue;

      const acc = damageByVictim.get(victim) ?? { amount: 0, head: false };
      acc.amount += check.damage;
      // A shotgun blast can land pellets in several zones at once. If any of them
      // hit the head, the shot reads as a headshot — that's the feedback the
      // shooter is owed, and it's the pellet that did the most damage.
      acc.head = acc.head || hit.z === 'head';
      damageByVictim.set(victim, acc);
    }

    for (const [victim, acc] of damageByVictim) {
      this.applyDamage(victim, player, acc.amount, weaponId, acc.head);
    }

    // Vehicles. Each pellet carries its own direction so a shotgun can clip the
    // edge honestly. The server raycasts every report again and only accepts the
    // nearest intact rover in front of all map geometry.
    const vehicleReports = Array.isArray(msg.v) ? msg.v : [];
    const remainingPellets = Math.max(0, getWeapon(weaponId).pellets - maxPellets);
    const maxVehiclePellets = Math.min(vehicleReports.length, remainingPellets);
    const vehicleDamage = new Map();
    const weapon = getWeapon(weaponId);
    for (let i = 0; i < maxVehiclePellets; i++) {
      const report = vehicleReports[i];
      if (!Number.isInteger(report?.i)) continue;
      const pelletTrace = sanitiseShotTrace(player, msg.o, report.d);
      const hit = this.raycastVehicle(pelletTrace.origin, pelletTrace.direction, weapon.range);
      if (!hit || hit.vehicle.index !== report.i) continue;
      const wall = raycastBoxes(
        pelletTrace.origin,
        pelletTrace.direction,
        this.map.solids,
        weapon.range,
      );
      if (wall && wall.t + 0.05 < hit.t) continue;
      const damage = damageAtDistance(weapon, hit.t);
      if (damage <= 0) continue;
      vehicleDamage.set(hit.vehicle, (vehicleDamage.get(hit.vehicle) ?? 0) + damage);
    }
    for (const [vehicle, damage] of vehicleDamage) {
      this.damageVehicle(vehicle, player, damage);
    }

    // Barrels. Deduplicated so one shotgun blast counts as one hit, not eight.
    if (Array.isArray(msg.b)) {
      for (const index of new Set(msg.b)) {
        if (Number.isInteger(index)) this.hitBarrel(index, player);
      }
    }
  }

  // ---------------------------------------------------------------- damage

  applyDamage(victim, attacker, amount, weaponId, headshot = false) {
    if (!victim.alive) return;

    victim.health -= amount;
    victim.lastDamageAt = Date.now();

    if (attacker) {
      this.sendTo(attacker, S2C.DAMAGE, {
        target: victim.id,
        amount,
        lethal: victim.health <= 0,
        head: headshot,
        // The victim's position, so the shooter's client can put a damage number
        // and a blood burst on them rather than in the middle of the screen.
        at: [victim.pos[0], victim.pos[1] + heightOf(victim) * 0.62, victim.pos[2]],
        name: victim.name,
      });
    }

    this.sendTo(victim, S2C.DAMAGE, {
      self: true,
      amount,
      health: Math.max(0, victim.health),
      from: attacker ? attacker.pos : null,
      by: attacker ? attacker.name : weaponId,
    });

    if (victim.health <= 0) this.killPlayer(victim, attacker, weaponId, headshot);
  }

  killPlayer(victim, attacker, weaponId, headshot = false) {
    this.releaseVehicle(victim);
    victim.alive = false;
    victim.health = 0;
    // No respawns in survival or battle royale: being killed is the end of your
    // match, which is what makes either mode tense.
    const noRespawn = modes.isSurvival(this.mode) || modes.isBattleRoyale(this.mode);
    victim.respawnAt = noRespawn ? 0 : Date.now() + RESPAWN_DELAY_MS;
    victim.lastKilledBy = attacker?.name ?? null;

    const outcome = modes.onKill(this, attacker, victim, weaponId);

    if (outcome.newWeapon && attacker) {
      attacker.inventory = modes.loadoutFor(this, attacker);
      attacker.weapon = attacker.inventory[0];
      this.sendTo(attacker, S2C.LOADOUT, {
        inventory: attacker.inventory,
        weapon: attacker.weapon,
        promoted: true,
        rung: attacker.ladderIndex,
      });
    }

    this.broadcast(S2C.KILL, {
      killer: attacker?.id ?? null,
      killerName: attacker?.name ?? null,
      victim: victim.id,
      victimName: victim.name,
      weapon: weaponId,
      headshot,
      // Where the victim finished. In a mode with no respawns that's the only
      // score there is, so it rides along with the kill rather than needing its
      // own message. aliveCount has already excluded the victim, hence the +1.
      placed: noRespawn ? aliveCount(this) + 1 : 0,
    });

    this.broadcastRoster();

    // The alive counter is the whole HUD in battle royale, and it only ever
    // changes here. Without this it can sit at the starting count for an entire
    // match while everyone dies in front of you.
    if (modes.isBattleRoyale(this.mode)) this.broadcastAlive();

    const win = modes.checkWin(this);
    if (win) this.endRound(win);
  }

  // ------------------------------------------------------------------- tick

  tick() {
    if (this.closed) return;
    const now = Date.now();
    this.tickCount++;

    switch (this.phase) {
      case PHASE.LOBBY:
        // The grace clock ran out with somebody still unready. Start anyway;
        // they get dropped in alive like anyone joining mid-match.
        if (this.graceEndsAt > 0 && now >= this.graceEndsAt) this.startCountdown();
        break;

      case PHASE.COUNTDOWN:
        if (now >= this.phaseEndsAt) this.beginRound();
        break;

      case PHASE.LIVE:
        this.tickLive(now);
        if (now >= this.phaseEndsAt) this.endRound(modes.resultAtTimeUp(this));
        break;

      case PHASE.SCOREBOARD:
        if (now >= this.phaseEndsAt) {
          const regroup = this.regroupRequests.size > 0;
          this.regroupRequests.clear();
          this.rotateMap();

          if (!regroup && this.humanCount() >= this.minPlayers()) {
            this.lastResult = null;
            this.startCountdown();
          } else {
            // Somebody asked to regroup, or there aren't enough people for
            // another round. Either way: back to the lobby to sort it out.
            this.setPhase(PHASE.LOBBY, 0);
            this.broadcastLobby();
          }
        }
        break;

      default:
        break;
    }

    this.sendSnapshot(now);
  }

  tickLive(now) {
    // AI move and fight on the server's clock; there's no client to wait for.
    this.stepAllAi(TICK_MS / 1000, now);
    this.tickPickups(now);
    if (this.wave) this.tickWaves(now);
    if (this.br) this.tickBattleRoyale(now);

    for (const player of this.players.values()) {
      // Respawns.
      if (!player.alive && player.respawnAt > 0 && now >= player.respawnAt) {
        this.spawn(player);
        continue;
      }
      if (!player.alive) continue;

      // The void is enforced here rather than trusted to the client's report.
      // A client that never sends it — a bot, a broken build, someone who
      // tampered with it — would otherwise fall for the rest of the round,
      // alive and unreachable. Death is the server's call, so it checks.
      if (player.pos[1] < this.voidY()) {
        this.applyDamage(player, null, MAX_HEALTH * 2, 'void');
        continue;
      }

      // Health regen, CoD-style: nothing for a few seconds, then fills fast.
      if (player.health < MAX_HEALTH && now - player.lastDamageAt > REGEN_DELAY_MS) {
        player.health = Math.min(MAX_HEALTH, player.health + (REGEN_PER_SECOND * TICK_MS) / 1000);
      }

      // A client that stops sending state has hung or dropped. Freeze them
      // rather than leaving a ghost sliding around.
      if (now - player.lastStateAt > 5000) {
        player.flags |= FLAG.DEAD;
      }
    }
  }

  sendSnapshot(now) {
    if (this.players.size === 0) return;

    const list = [...this.players.values()].map((p) => ({
      id: p.id,
      pos: p.pos,
      yaw: p.yaw,
      pitch: p.pitch,
      flags: p.alive ? p.flags & ~FLAG.DEAD : p.flags | FLAG.DEAD,
      health: Math.max(0, Math.round(p.health)),
      weapon: p.weapon,
    }));

    // One encode for the whole room rather than one per player.
    this.broadcastRaw(encodeSnapshot(this.tickCount, now, list));
  }

  /** Everything a spectating or joining client needs to render the match. */
  summary() {
    return {
      code: this.code,
      mode: this.mode,
      mapId: this.mapId,
      phase: this.phase,
      players: this.players.size,
      capacity: modes.ROOM_CAPACITY,
    };
  }
}
