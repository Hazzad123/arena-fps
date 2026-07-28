// A room is one match: a fixed set of players, a map, a mode and a clock.
//
// The server owns everything consequential — health, deaths, score, spawns, the
// round timer, gun-game progression. It does NOT own movement; clients simulate
// their own position and this just sanity-checks it (see validate.js).

import {
  SERVER_TICK_HZ, ROUND_MS, COUNTDOWN_MS, SCOREBOARD_MS, MIN_PLAYERS_TO_START,
  MAX_HEALTH, RESPAWN_DELAY_MS, SPAWN_PROTECTION_MS, REGEN_DELAY_MS,
  REGEN_PER_SECOND, FALL_DAMAGE_MIN_SPEED, FALL_DAMAGE_PER_SPEED,
  PLAYER_HEIGHT, PLAYER_RADIUS, EMPTY_ROOM_TTL_MS,
} from '../shared/constants.js';
import { S2C, PHASE, FLAG, encode, encodeSnapshot } from '../shared/protocol.js';
import { getMap, nextMap, ROTATION } from '../shared/maps/index.js';
import { getWeapon } from '../shared/weapons.js';
import { pushOutOfSolids, playerOverlapsAny } from '../shared/collision.js';
import * as modes from './modes.js';
import { validateMove, validateHit, validateFireRate, capPelletCount, heightOf } from './validate.js';

const TICK_MS = 1000 / SERVER_TICK_HZ;

// Phase durations, overridable by env so a test run can cycle whole rounds in
// seconds instead of three minutes. Server-only file, so process.env is safe
// here — never do this in shared/, which the browser also imports.
const DURATION = {
  round: Number(process.env.ARENA_ROUND_MS) || ROUND_MS,
  countdown: Number(process.env.ARENA_COUNTDOWN_MS) || COUNTDOWN_MS,
  scoreboard: Number(process.env.ARENA_SCOREBOARD_MS) || SCOREBOARD_MS,
};

export class Room {
  constructor(code, mode = 'tdm') {
    this.code = code;
    this.mode = mode;
    this.players = new Map();
    this.teamScores = { A: 0, B: 0 };

    this.mapId = ROTATION[Math.floor(Math.random() * ROTATION.length)];
    this.map = getMap(this.mapId);

    this.phase = PHASE.LOBBY;
    this.phaseEndsAt = 0;
    this.tickCount = 0;
    this.emptySince = Date.now();
    this.lastResult = null;

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

  addPlayer({ id, name, ws }) {
    const player = {
      id,
      name,
      ws,
      team: null,
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

    player.inventory = modes.loadoutFor(this, player);
    player.weapon = player.inventory[0];

    this.sendTo(player, S2C.JOINED, {
      code: this.code,
      mode: this.mode,
      mapId: this.mapId,
      you: { id, team: player.team },
      phase: this.phase,
      phaseMsLeft: Math.max(0, this.phaseEndsAt - Date.now()),
      roster: this.roster(),
      teamScores: this.teamScores,
      inventory: player.inventory,
    });

    this.broadcastRoster();

    // A match already in progress: drop them straight in.
    if (this.phase === PHASE.LIVE) this.spawn(player);
    else this.maybeStart();

    return player;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;
    this.players.delete(id);

    if (this.players.size === 0) {
      this.emptySince = Date.now();
      this.phase = PHASE.LOBBY;
    } else {
      modes.rebalance(this);
      this.broadcastRoster();
      // Everyone else left mid-match — back to the lobby rather than a 1-player
      // "match" running its clock down.
      if (this.phase !== PHASE.LOBBY && this.players.size < MIN_PLAYERS_TO_START) {
        this.setPhase(PHASE.LOBBY, 0);
      }
    }
  }

  isExpired(now = Date.now()) {
    return this.players.size === 0 && this.emptySince > 0 && now - this.emptySince > EMPTY_ROOM_TTL_MS;
  }

  dispose() {
    clearInterval(this.timer);
  }

  roster() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      score: p.score,
      kills: p.kills,
      deaths: p.deaths,
      ladderIndex: p.ladderIndex,
    }));
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

  // -------------------------------------------------------------------- phases

  setPhase(phase, durationMs) {
    this.phase = phase;
    this.phaseEndsAt = durationMs > 0 ? Date.now() + durationMs : 0;

    this.broadcast(S2C.PHASE, {
      phase,
      msLeft: durationMs,
      mapId: this.mapId,
      teamScores: this.teamScores,
      roster: this.roster(),
      result: this.lastResult,
      resultText: this.lastResult ? modes.describeResult(this, this.lastResult) : null,
    });
  }

  maybeStart() {
    if (this.phase !== PHASE.LOBBY) return;
    if (this.players.size < MIN_PLAYERS_TO_START) return;
    this.lastResult = null;
    this.setPhase(PHASE.COUNTDOWN, DURATION.countdown);
  }

  beginRound() {
    modes.resetScores(this);
    for (const p of this.players.values()) {
      p.inventory = modes.loadoutFor(this, p);
      p.weapon = p.inventory[0];
      this.spawn(p);
    }
    this.broadcastRoster();
    this.setPhase(PHASE.LIVE, DURATION.round);
  }

  endRound(result) {
    this.lastResult = result;
    for (const p of this.players.values()) p.alive = false;
    this.setPhase(PHASE.SCOREBOARD, DURATION.scoreboard);
  }

  rotateMap() {
    this.mapId = nextMap(this.mapId);
    this.map = getMap(this.mapId);
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

      damageByVictim.set(victim, (damageByVictim.get(victim) ?? 0) + check.damage);
    }

    for (const [victim, amount] of damageByVictim) {
      this.applyDamage(victim, player, amount, weaponId);
    }
  }

  // ---------------------------------------------------------------- damage

  applyDamage(victim, attacker, amount, weaponId) {
    if (!victim.alive) return;

    victim.health -= amount;
    victim.lastDamageAt = Date.now();

    if (attacker) {
      this.sendTo(attacker, S2C.DAMAGE, {
        target: victim.id,
        amount,
        lethal: victim.health <= 0,
      });
    }

    this.sendTo(victim, S2C.DAMAGE, {
      self: true,
      amount,
      health: Math.max(0, victim.health),
      from: attacker ? attacker.pos : null,
      by: attacker ? attacker.name : weaponId,
    });

    if (victim.health <= 0) this.killPlayer(victim, attacker, weaponId);
  }

  killPlayer(victim, attacker, weaponId) {
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
      headshot: false,
    });

    this.broadcastRoster();

    const win = modes.checkWin(this);
    if (win) this.endRound(win);
  }

  // ------------------------------------------------------------------- tick

  tick() {
    const now = Date.now();
    this.tickCount++;

    switch (this.phase) {
      case PHASE.COUNTDOWN:
        if (now >= this.phaseEndsAt) this.beginRound();
        break;

      case PHASE.LIVE:
        this.tickLive(now);
        if (now >= this.phaseEndsAt) this.endRound(modes.resultAtTimeUp(this));
        break;

      case PHASE.SCOREBOARD:
        if (now >= this.phaseEndsAt) {
          this.rotateMap();
          if (this.players.size >= MIN_PLAYERS_TO_START) {
            this.lastResult = null;
            this.setPhase(PHASE.COUNTDOWN, DURATION.countdown);
          } else {
            this.setPhase(PHASE.LOBBY, 0);
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
