// A room is one match: a fixed set of players, a map, a mode and a clock.
//
// The server owns everything consequential — health, deaths, score, spawns, the
// round timer, gun-game progression. It does NOT own movement; clients simulate
// their own position and this just sanity-checks it (see validate.js).

import {
  SERVER_TICK_HZ, ROUND_MS, COUNTDOWN_MS, SCOREBOARD_MS, MIN_PLAYERS_TO_START,
  MAX_HEALTH, RESPAWN_DELAY_MS, SPAWN_PROTECTION_MS, REGEN_DELAY_MS,
  REGEN_PER_SECOND, FALL_DAMAGE_MIN_SPEED, FALL_DAMAGE_PER_SPEED,
  PLAYER_HEIGHT, PLAYER_RADIUS, EMPTY_ROOM_TTL_MS, LOBBY_GRACE_MS,
  BARREL_HITS, BARREL_DAMAGE, BARREL_RADIUS, BARREL_CHAIN_RADIUS, BARREL_CHAIN_LIMIT,
} from '../shared/constants.js';
import { S2C, PHASE, FLAG, MODES, encode, encodeSnapshot } from '../shared/protocol.js';
import { getMap, nextMap, ROTATION } from '../shared/maps/index.js';
import { getWeapon, CLASSES, DEFAULT_CLASS } from '../shared/weapons.js';
import { pushOutOfSolids, playerOverlapsAny, hasLineOfSight } from '../shared/collision.js';
import * as modes from './modes.js';
import { validateMove, validateHit, validateFireRate, capPelletCount, heightOf, eyeOf } from './validate.js';

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

    this.mapId = ROTATION[Math.floor(Math.random() * ROTATION.length)];
    this.map = getMap(this.mapId);
    this.resetBarrels();

    this.phase = PHASE.LOBBY;
    this.phaseEndsAt = 0;
    this.tickCount = 0;
    this.emptySince = Date.now();
    this.empty = false;
    this.closed = false;
    this.lastResult = null;

    // Lobby: whoever got here first picks the mode and the map and can force the
    // start; everyone readies up individually.
    this.hostId = null;
    this.graceEndsAt = 0;

    // Players who asked, from the results screen, to regroup in the lobby rather
    // than roll straight into the next round.
    this.regroupRequests = new Set();

    this.timer = setInterval(() => this.tick(), TICK_MS);
    // Don't hold the process open on an idle room.
    this.timer.unref?.();
  }

  // ------------------------------------------------------------------ players

  get size() {
    return this.players.size;
  }

  isFull() {
    return this.players.size >= modes.ROOM_CAPACITY;
  }

  addPlayer({ id, name, ws, classId }) {
    const player = {
      id,
      name,
      ws,
      team: null,
      ready: false,
      classId: CLASSES[classId] ? classId : DEFAULT_CLASS,
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
      you: { id, team: player.team, classId: player.classId },
      phase: this.phase,
      phaseMsLeft: Math.max(0, this.phaseEndsAt - Date.now()),
      roster: this.roster(),
      teamScores: this.teamScores,
      inventory: player.inventory,
      lobby: this.lobbyState(),
      // Barrels already destroyed, so a latecomer doesn't see ones that are gone.
      barrelsGone: this.destroyedBarrels(),
    });

    this.broadcastRoster();

    // A match already in progress: drop them straight in.
    if (this.phase === PHASE.LIVE) this.spawn(player);
    else this.evaluateLobby();

    return player;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;
    this.players.delete(id);
    // Someone who has left shouldn't still be holding the room in the lobby.
    this.regroupRequests.delete(id);

    if (this.players.size === 0) {
      // Last one out: end the match and mark the room for immediate closure.
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
    if (this.players.size > 0) return false;
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
      team: p.team,
      ready: p.ready,
      classId: p.classId,
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
      capacity: modes.ROOM_CAPACITY,
      minPlayers: MIN_PLAYERS_TO_START,
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
      nextMapId: this.phase === PHASE.SCOREBOARD ? nextMap(this.mapId) : null,
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

    const players = [...this.players.values()];
    const readyCount = players.filter((p) => p.ready).length;

    if (players.length < MIN_PLAYERS_TO_START) {
      this.graceEndsAt = 0;
      this.broadcastLobby();
      return;
    }

    if (readyCount === players.length) {
      this.startCountdown();
      return;
    }

    if (readyCount >= MIN_PLAYERS_TO_START) {
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
    if (this.players.size < MIN_PLAYERS_TO_START) return;
    this.startCountdown();
  }

  /** Host picks the mode and the map from the lobby. */
  handleLobbySet(player, msg) {
    if (this.phase !== PHASE.LOBBY) return;
    if (!this.isHost(player)) return;

    let changed = false;

    if (typeof msg?.mode === 'string' && msg.mode !== this.mode && MODES.includes(msg.mode)) {
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
      for (const p of this.players.values()) {
        p.ladderIndex = 0;
        p.inventory = modes.loadoutFor(this, p);
        p.weapon = p.inventory[0];
        this.sendTo(p, S2C.LOADOUT, { inventory: p.inventory, weapon: p.weapon });
      }
      changed = true;
    }

    if (typeof msg?.mapId === 'string' && msg.mapId !== this.mapId && ROTATION.includes(msg.mapId)) {
      this.mapId = msg.mapId;
      this.map = getMap(this.mapId);
      changed = true;
    }

    if (changed) this.broadcastLobby();
  }

  beginRound() {
    modes.resetScores(this);
    this.resetBarrels();
    this.broadcast(S2C.BARRELS, { gone: [] });
    this.graceEndsAt = 0;
    this.regroupRequests.clear();
    for (const p of this.players.values()) {
      // Readiness is per-match. If the room drops back to the lobby later,
      // everyone opts in again rather than inheriting a yes from an hour ago.
      p.ready = false;
      this.spawn(p); // resolves the loadout from their class

    }
    this.broadcastRoster();
    this.setPhase(PHASE.LIVE, DURATION.round);
  }

  endRound(result) {
    this.lastResult = result;
    this.regroupRequests.clear();
    for (const p of this.players.values()) p.alive = false;
    this.setPhase(PHASE.SCOREBOARD, DURATION.scoreboard);
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

  rotateMap() {
    this.mapId = nextMap(this.mapId);
    this.map = getMap(this.mapId);
    this.resetBarrels();
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
    // spawn" true. A class chosen while alive only changes classId; this is the
    // single place that turns a class into weapons, for the lobby, a respawn and
    // a gun-game promotion alike.
    player.inventory = modes.loadoutFor(this, player);
    player.weapon = player.inventory[0];

    const point = this.chooseSpawn(player);
    player.pos = [point[0], point[1], point[2]];
    player.health = MAX_HEALTH;
    player.alive = true;
    player.crouching = false;
    player.flags = 0;
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
    player.yaw = Math.atan2(-(cx - player.pos[0]), -(cz - player.pos[2]));
    player.pitch = 0;

    this.sendTo(player, S2C.RESPAWN, {
      pos: player.pos,
      yaw: player.yaw,
      health: player.health,
      inventory: player.inventory,
      weapon: player.weapon,
      protectedMs: SPAWN_PROTECTION_MS,
    });
  }

  // -------------------------------------------------------------- client input

  handleState(player, msg) {
    const now = Date.now();
    const dt = (now - player.lastStateAt) / 1000;
    player.lastStateAt = now;

    const result = validateMove(player, { pos: msg.p, yaw: msg.y, pitch: msg.t }, this.map, dt);
    if (!result.ok) {
      player.rejectedMoves++;
      // Leave the last known good position in place; a brief stall reads far
      // better than yanking someone across the map.
      return;
    }

    player.pos = result.pos;
    player.yaw = msg.y;
    player.pitch = msg.t;
    player.flags = msg.f | 0;
    player.crouching = (player.flags & FLAG.CROUCH) !== 0;

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
  handleSetClass(player, msg) {
    const id = String(msg?.classId ?? '');
    if (!CLASSES[id] || player.classId === id) return;
    player.classId = id;

    if (modes.usesClasses(this.mode) && !player.alive) {
      player.inventory = modes.loadoutFor(this, player);
      player.weapon = player.inventory[0];
      this.sendTo(player, S2C.LOADOUT, {
        inventory: player.inventory,
        weapon: player.weapon,
        classId: player.classId,
      });
    }

    if (this.phase === PHASE.LOBBY) this.broadcastLobby();
    else this.broadcastRoster();
  }

  handleShoot(player, msg) {
    if (this.phase !== PHASE.LIVE || !player.alive) return;

    const weaponId = msg.w;
    if (!player.inventory.includes(weaponId)) return;
    if (!validateFireRate(player, weaponId, Date.now())) return;

    // Firing gives away spawn protection — otherwise you could shoot from
    // behind it with impunity.
    player.spawnProtectedUntil = 0;

    const hits = Array.isArray(msg.h) ? msg.h : [];
    const maxPellets = capPelletCount(weaponId, hits.length);

    // Tell everyone else a shot was fired so they get a tracer and a bang, even
    // if it hit nothing.
    this.broadcast(S2C.SHOTS, {
      id: player.id,
      w: weaponId,
      o: msg.o,
      d: msg.d,
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

    // Barrels. Deduplicated so one shotgun blast counts as one hit, not eight.
    if (Array.isArray(msg.b)) {
      for (const index of new Set(msg.b)) this.hitBarrel(index | 0, player);
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
    victim.alive = false;
    victim.health = 0;
    victim.respawnAt = Date.now() + RESPAWN_DELAY_MS;
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
    });

    this.broadcastRoster();

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

          if (!regroup && this.players.size >= MIN_PLAYERS_TO_START) {
            this.lastResult = null;
            this.setPhase(PHASE.COUNTDOWN, DURATION.countdown);
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
