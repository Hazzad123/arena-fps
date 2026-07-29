// Headless bots. A development tool, not part of the game.
//
// Filling a lobby with real people to test round transitions, scoring, map
// rotation and bandwidth is impractical, so these do it instead. They connect
// over the same WebSocket protocol as a browser and drive themselves using the
// same shared movement code, which means they exercise the real validation path
// rather than a convenient fiction.
//
//   node server/bot.js --count 7
//   node server/bot.js --count 3 --code ABCD --mode gungame --duration 60
//
// Run with one real browser client alongside to play against them.

import WebSocket from 'ws';

import {
  PHYSICS_DT, CLIENT_SEND_HZ, WALK_SPEED, GRAVITY, MAX_FALL_SPEED,
  PLAYER_HEIGHT, PLAYER_RADIUS, JUMP_VELOCITY,
} from '../shared/constants.js';
import { C2S, S2C, PHASE, FLAG, encode, decode, decodeSnapshot } from '../shared/protocol.js';
import { getMap } from '../shared/maps/index.js';
import { moveAndCollide, hasLineOfSight } from '../shared/collision.js';
import { getWeapon, fireIntervalMs, PRIMARY_IDS } from '../shared/weapons.js';

// ------------------------------------------------------------------------ args

function parseArgs(argv) {
  const out = { count: 7, url: 'ws://localhost:3000/ws', code: null, mode: 'tdm', duration: 0, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const [key, inline] = argv[i].split('=');
    const value = inline ?? argv[i + 1];
    const advance = () => { if (inline === undefined) i++; };
    switch (key) {
      case '--count': out.count = Number(value); advance(); break;
      case '--url': out.url = value; advance(); break;
      case '--code': out.code = String(value).toUpperCase(); advance(); break;
      case '--mode': out.mode = value; advance(); break;
      case '--duration': out.duration = Number(value); advance(); break;
      case '--quiet': out.quiet = true; break;
      default: break;
    }
  }
  return out;
}

const args = parseArgs(process.argv);

const NAMES = [
  'Bishop', 'Cobbler', 'Dredge', 'Ember', 'Fathom', 'Girder', 'Harrow', 'Ingot',
  'Jetty', 'Kestrel', 'Lintel', 'Mortar', 'Nimbus', 'Oxbow', 'Plinth',
];

// --------------------------------------------------------------------- stats

const stats = {
  connected: 0,
  snapshots: 0,
  snapshotBytes: 0,
  kills: 0,
  phases: [],
  maps: new Set(),
  errors: [],
  rejected: 0,
  started: Date.now(),
};

function log(...parts) {
  if (!args.quiet) console.log(...parts);
}

// ----------------------------------------------------------------------- bot

class Bot {
  constructor(index) {
    this.index = index;
    this.name = `${NAMES[index % NAMES.length]}${index >= NAMES.length ? index : ''}`;
    this.ws = null;
    this.id = null;

    this.map = null;
    this.phase = PHASE.LOBBY;
    this.mode = 'tdm';
    this.team = null;

    this.pos = [0, 0, 0];
    this.vel = [0, 0, 0];
    this.yaw = Math.random() * Math.PI * 2;
    this.pitch = 0;
    this.onGround = false;
    this.alive = false;
    this.inventory = ['rifle'];
    this.weapon = 'rifle';

    this.waypoint = null;
    this.stuckFor = 0;
    this.lastShotAt = 0;
    this.others = new Map();

    this.physicsTimer = null;
    this.sendTimer = null;
  }

  connect(url) {
    return new Promise((resolve) => {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        stats.connected++;
        this.send(C2S.HELLO, { name: this.name });
        // Spread the bots across the classes so a bot match exercises every
        // weapon rather than eight assault rifles.
        const primaryId = PRIMARY_IDS[this.index % PRIMARY_IDS.length];
        if (args.code) this.send(C2S.JOIN, { code: args.code, primaryId });
        else this.send(C2S.QUICKPLAY, { mode: args.mode, primaryId });
        resolve();
      });

      this.ws.on('message', (raw) => this.onMessage(raw));

      this.ws.on('error', (err) => {
        stats.errors.push(`${this.name}: ${err.message}`);
        resolve();
      });

      this.ws.on('close', () => {
        this.stop();
      });
    });
  }

  send(type, payload) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode(type, payload));
  }

  onMessage(raw) {
    const text = raw.toString();
    const msg = decode(text);
    if (!msg) return;

    switch (msg.m) {
      case S2C.WELCOME:
        this.id ??= msg.id;
        break;

      case S2C.JOINED:
        this.id = msg.you.id;
        this.team = msg.you.team;
        this.mode = msg.mode;
        this.phase = msg.phase;
        this.inventory = msg.inventory ?? this.inventory;
        this.weapon = this.inventory[0];
        this.setMap(msg.mapId);
        log(`  ${this.name} joined ${msg.code} (${msg.mode}) on ${msg.mapId}, team ${msg.you.team ?? '-'}`);
        // A lobby waits for people to ready up, so a room of bots would sit
        // there until the grace clock expired. Bots are always keen.
        this.send(C2S.READY, { ready: true });
        this.startLoops();
        break;

      case S2C.PHASE:
        // Only bot 0 records, or every transition appears once per bot.
        if (this.phase !== msg.phase && this.index === 0) {
          stats.phases.push({ at: Date.now() - stats.started, phase: msg.phase, map: msg.mapId });
          log(`  [phase] ${msg.phase}${msg.mapId ? ` on ${msg.mapId}` : ''}${msg.resultText ? ` — ${msg.resultText}` : ''}`);
        }
        this.phase = msg.phase;
        if (msg.mapId) this.setMap(msg.mapId);
        // Readiness is cleared when a round begins, so re-opt-in every time the
        // room falls back to the lobby.
        if (msg.phase === PHASE.LOBBY) this.send(C2S.READY, { ready: true });
        break;

      case S2C.RESPAWN:
        this.pos = [...msg.pos];
        this.vel = [0, 0, 0];
        this.yaw = msg.yaw ?? this.yaw;
        this.alive = true;
        this.inventory = msg.inventory ?? this.inventory;
        this.weapon = msg.weapon ?? this.inventory[0];
        this.waypoint = null;
        break;

      case S2C.LOADOUT:
        this.inventory = msg.inventory;
        this.weapon = this.inventory[0];
        break;

      case S2C.SNAPSHOT: {
        stats.snapshots++;
        stats.snapshotBytes += text.length;
        const snap = decodeSnapshot(msg);
        this.others.clear();
        for (const p of snap.players) {
          if (p.id === this.id) {
            // Trust the server on liveness; it owns that.
            this.alive = (p.flags & FLAG.DEAD) === 0;
            continue;
          }
          this.others.set(p.id, p);
        }
        break;
      }

      case S2C.KILL:
        if (this.index === 0) stats.kills++;
        break;

      case S2C.ERROR:
        stats.errors.push(`${this.name}: ${msg.code} ${msg.message}`);
        break;

      default:
        break;
    }
  }

  setMap(mapId) {
    if (this.map?.id === mapId) return;
    this.map = getMap(mapId);
    stats.maps.add(mapId);
    this.waypoint = null;
  }

  startLoops() {
    if (this.physicsTimer) return;
    this.physicsTimer = setInterval(() => this.stepPhysics(), PHYSICS_DT * 1000);
    this.sendTimer = setInterval(() => this.pushState(), 1000 / CLIENT_SEND_HZ);
  }

  stop() {
    clearInterval(this.physicsTimer);
    clearInterval(this.sendTimer);
    this.physicsTimer = null;
    this.sendTimer = null;
  }

  // ------------------------------------------------------------------ movement

  pickWaypoint() {
    if (!this.map) return;
    const points = this.map.spawns.ffa;
    const target = points[Math.floor(Math.random() * points.length)];
    // Aim near a spawn point rather than exactly at it, so bots spread out.
    this.waypoint = [
      target[0] + (Math.random() - 0.5) * 8,
      target[1],
      target[2] + (Math.random() - 0.5) * 8,
    ];
  }

  stepPhysics() {
    if (!this.map || !this.alive || this.phase !== PHASE.LIVE) return;

    if (!this.waypoint) this.pickWaypoint();

    const dx = this.waypoint[0] - this.pos[0];
    const dz = this.waypoint[2] - this.pos[2];
    const distance = Math.hypot(dx, dz);

    if (distance < 2) {
      this.pickWaypoint();
      return;
    }

    // Walk, don't sprint: keeps every bot comfortably inside the server's
    // speed validation even with timer jitter.
    const dirX = dx / distance;
    const dirZ = dz / distance;
    const speed = WALK_SPEED * 0.85;
    this.vel[0] = dirX * speed;
    this.vel[2] = dirZ * speed;

    // Face where we're going, with a slow scan so aim isn't perfectly rigid.
    this.yaw = Math.atan2(-dirX, -dirZ);
    this.pitch = Math.sin(Date.now() / 1400 + this.index) * 0.12;

    this.vel[1] = Math.max(-MAX_FALL_SPEED, this.vel[1] + GRAVITY * PHYSICS_DT);

    const before = [...this.pos];
    const state = { pos: this.pos, vel: this.vel, onGround: this.onGround };
    moveAndCollide(state, PHYSICS_DT, this.map.solids, PLAYER_HEIGHT, PLAYER_RADIUS);
    this.onGround = state.onGround;

    // Wedged against geometry: jump, then give up and go elsewhere.
    const progress = Math.hypot(this.pos[0] - before[0], this.pos[2] - before[2]);
    if (progress < 0.01) {
      this.stuckFor += PHYSICS_DT;
      if (this.stuckFor > 0.25 && this.onGround) this.vel[1] = JUMP_VELOCITY;
      if (this.stuckFor > 1.2) {
        this.pickWaypoint();
        this.stuckFor = 0;
      }
    } else {
      this.stuckFor = 0;
    }

    this.maybeShoot();
  }

  pushState() {
    if (!this.map) return;
    let flags = 0;
    if (!this.onGround) flags |= FLAG.AIRBORNE;
    if (!this.alive) flags |= FLAG.DEAD;

    this.send(C2S.STATE, {
      p: this.pos.map((v) => Math.round(v * 100) / 100),
      y: Math.round(this.yaw * 1000) / 1000,
      t: Math.round(this.pitch * 1000) / 1000,
      f: flags,
    });
  }

  // ------------------------------------------------------------------ shooting

  maybeShoot() {
    const now = Date.now();
    const weapon = getWeapon(this.weapon);
    // Deliberately slower than the weapon allows — we're testing the damage
    // path, not trying to win, and a fully automatic bot is miserable to play
    // against while checking things by hand.
    const interval = Math.max(fireIntervalMs(weapon), 420);
    if (now - this.lastShotAt < interval) return;

    const eye = [this.pos[0], this.pos[1] + PLAYER_HEIGHT - 0.15, this.pos[2]];

    for (const other of this.others.values()) {
      if ((other.flags & FLAG.DEAD) !== 0) continue;

      const centre = [other.pos[0], other.pos[1] + PLAYER_HEIGHT * 0.55, other.pos[2]];
      const dx = centre[0] - eye[0];
      const dy = centre[1] - eye[1];
      const dz = centre[2] - eye[2];
      const distance = Math.hypot(dx, dy, dz);
      if (distance > weapon.range * 0.8) continue;
      if (!hasLineOfSight(eye, centre, this.map.solids)) continue;

      this.lastShotAt = now;
      const dir = [dx / distance, dy / distance, dz / distance];
      // Look at the target so the server's own view of our aim is consistent.
      this.yaw = Math.atan2(-dir[0], -dir[2]);
      this.pitch = Math.asin(Math.max(-1, Math.min(1, dir[1])));

      // Miss sometimes, or a full lobby of bots is lethally accurate.
      const hits = Math.random() < 0.55 ? [{ id: other.id, z: Math.random() < 0.12 ? 'head' : 'body' }] : [];

      this.send(C2S.SHOOT, { w: this.weapon, o: eye, d: dir, h: hits });
      return;
    }
  }

  disconnect() {
    this.stop();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send(C2S.LEAVE, {});
      this.ws.close();
    }
  }
}

// ----------------------------------------------------------------------- main

const bots = [];

async function main() {
  log(`spawning ${args.count} bots -> ${args.url}${args.code ? ` (room ${args.code})` : ` (quickplay, ${args.mode})`}`);

  for (let i = 0; i < args.count; i++) {
    const bot = new Bot(i);
    bots.push(bot);
    await bot.connect(args.url);
    // Stagger joins so team assignment and rebalancing get exercised properly.
    await new Promise((r) => setTimeout(r, 140));
  }

  log(`${stats.connected}/${args.count} connected`);

  if (args.duration > 0) {
    setTimeout(() => {
      report();
      shutdown();
    }, args.duration * 1000);
  } else {
    log('running until interrupted (ctrl-c). Open http://localhost:5173 and join them.');
  }
}

function report() {
  const seconds = (Date.now() - stats.started) / 1000;
  const perClient = stats.snapshots / Math.max(1, stats.connected);

  console.log('\n──── bot run summary ────');
  console.log(`duration           ${seconds.toFixed(1)}s`);
  console.log(`bots connected     ${stats.connected}/${args.count}`);
  console.log(`snapshots          ${stats.snapshots} (${(perClient / seconds).toFixed(1)}/s per client)`);
  console.log(`snapshot bandwidth ${(stats.snapshotBytes / stats.connected / seconds / 1024).toFixed(1)} KB/s per client`);
  console.log(`kills observed     ${stats.kills}`);
  console.log(`maps played        ${[...stats.maps].join(', ') || 'none'}`);
  console.log(`phase transitions  ${stats.phases.map((p) => p.phase).join(' -> ') || 'none'}`);
  if (stats.errors.length) {
    console.log(`errors             ${stats.errors.length}`);
    for (const e of stats.errors.slice(0, 10)) console.log(`  - ${e}`);
  } else {
    console.log('errors             none');
  }
  console.log('─────────────────────────\n');
}

function shutdown() {
  for (const bot of bots) bot.disconnect();
  setTimeout(() => process.exit(stats.errors.length ? 1 : 0), 300);
}

process.on('SIGINT', () => {
  report();
  shutdown();
});

main();
