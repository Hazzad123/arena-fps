// HTTP + WebSocket server.
//
// In development Vite serves the client and proxies /ws here. In production this
// process serves the built client itself, so the whole thing is one container
// and one port.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../shared/constants.js';
import { C2S, S2C, PHASE, encode, decode, isValidRoomCode, sanitiseName, MODES } from '../shared/protocol.js';
import { mapList } from '../shared/maps/index.js';
import { Room } from './room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// ---------------------------------------------------------------- room registry

/** @type {Map<string, Room>} */
const rooms = new Map();

function generateCode() {
  // 31^4 ≈ 920k combinations. Collisions are handled by retrying, and we give up
  // rather than loop forever in the absurd case that the server is full.
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return null;
}

function createRoom(mode) {
  const code = generateCode();
  if (!code) return null;
  const room = new Room(code, MODES.includes(mode) ? mode : 'tdm');
  rooms.set(code, room);
  return room;
}

/** A room with space, preferring one that's mid-match so you get straight in. */
function findJoinableRoom(mode = null) {
  const candidates = [...rooms.values()].filter(
    (r) => !r.isFull() && (!mode || r.mode === mode),
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const live = (r) => (r.phase === PHASE.LIVE || r.phase === PHASE.COUNTDOWN ? 1 : 0);
    // Prefer live rooms, then the fullest — keeps players together rather than
    // scattering them one per empty room.
    return live(b) - live(a) || b.size - a.size;
  });
  return candidates[0];
}

// Sweep out rooms that have been empty a while.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    // Backstop only: leaveRoom closes rooms the moment they empty. This catches
    // anything that emptied without going through it.
    if (room.isExpired(now)) closeRoom(room, 'swept');
  }
}, 15_000);
sweeper.unref?.();

// ------------------------------------------------------------------------- http

const app = express();
app.disable('x-powered-by');

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    players: [...rooms.values()].reduce((n, r) => n + r.size, 0),
  });
});

app.get('/api/rooms', (_req, res) => {
  res.json({
    maps: mapList(),
    rooms: [...rooms.values()].map((r) => r.summary()),
  });
});

if (IS_PROD) {
  const dist = path.join(__dirname, '..', 'dist');
  app.use(express.static(dist, { maxAge: '1h', index: false }));

  // Single page app: navigation routes serve the shell so /#CODE links work.
  //
  // The narrowing matters more than it looks. A bare catch-all answers *every*
  // unmatched GET with the 16KB HTML shell and a 200, including requests for
  // assets that aren't there. That hides missing files completely — the network
  // tab shows a row of cheerful 200s while textures silently fall back to flat
  // colours — and it bills a full page load for each one. Anything that looks
  // like a file, or that didn't ask for HTML, gets an honest 404.
  app.get(/.*/, (req, res, next) => {
    const looksLikeAFile = path.extname(req.path) !== '';
    if (looksLikeAFile || !req.accepts('html')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}

const server = http.createServer(app);

// -------------------------------------------------------------------- websocket

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

let nextId = 1;

wss.on('connection', (ws) => {
  const session = {
    id: `p${nextId++}`,
    name: null,
    room: null,
    player: null,
    alive: true,
    // Crude flood guard. A legitimate client sends ~35 messages/second
    // (30Hz state plus fire); this trips well above that.
    windowStart: Date.now(),
    windowCount: 0,
  };

  ws.send(encode(S2C.WELCOME, { id: session.id, maps: mapList() }));

  ws.on('message', (raw) => {
    const now = Date.now();
    if (now - session.windowStart > 1000) {
      session.windowStart = now;
      session.windowCount = 0;
    }
    if (++session.windowCount > 140) return; // silently drop the excess

    const msg = decode(raw.toString());
    if (!msg) return;

    try {
      handleMessage(session, ws, msg);
    } catch (err) {
      // One bad message shouldn't take down a room full of people.
      console.error(`[${session.id}] ${msg.m} failed:`, err.message);
    }
  });

  ws.on('close', () => {
    session.alive = false;
    leaveRoom(session);
  });

  ws.on('error', () => {
    session.alive = false;
    leaveRoom(session);
  });

  // Heartbeat: drop sockets that stop responding so rooms don't fill with ghosts.
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 20_000);
heartbeat.unref?.();

function handleMessage(session, ws, msg) {
  switch (msg.m) {
    case C2S.HELLO:
      session.name = sanitiseName(msg.name);
      ws.send(encode(S2C.WELCOME, { id: session.id, name: session.name }));
      return;

    case C2S.CREATE: {
      leaveRoom(session);
      const room = createRoom(msg.mode);
      if (!room) {
        ws.send(encode(S2C.ERROR, { code: 'no-capacity', message: 'Server is full — try again shortly.' }));
        return;
      }
      joinRoom(session, ws, room, msg.primaryId);
      return;
    }

    case C2S.JOIN: {
      const code = String(msg.code ?? '').toUpperCase();
      if (!isValidRoomCode(code)) {
        ws.send(encode(S2C.ERROR, { code: 'bad-code', message: 'That code doesn’t look right.' }));
        return;
      }
      const room = rooms.get(code);
      if (!room) {
        ws.send(encode(S2C.ERROR, { code: 'not-found', message: `No room called ${code}.` }));
        return;
      }
      if (room.isFull()) {
        ws.send(encode(S2C.ERROR, { code: 'full', message: `Room ${code} is full.` }));
        return;
      }
      leaveRoom(session);
      joinRoom(session, ws, room, msg.primaryId);
      return;
    }

    case C2S.QUICKPLAY: {
      leaveRoom(session);
      const wantedMode = MODES.includes(msg.mode) ? msg.mode : 'br';
      const room = findJoinableRoom(wantedMode) ?? createRoom(wantedMode);
      if (!room) {
        ws.send(encode(S2C.ERROR, { code: 'no-capacity', message: 'Server is full — try again shortly.' }));
        return;
      }
      joinRoom(session, ws, room, msg.primaryId);
      return;
    }

    case C2S.LEAVE:
      leaveRoom(session);
      return;

    case C2S.CHAT:
      if (session.room && session.player) session.room.handleChat(session.player, msg);
      return;

    case C2S.TAKE_LOOT:
      if (session.room && session.player) session.room.handleTakeLoot(session.player);
      return;

    case C2S.VEHICLE:
      if (session.room && session.player) session.room.handleVehicle(session.player, msg);
      return;

    case C2S.EMOTE:
      if (session.room && session.player) session.room.handleEmote(session.player, msg);
      return;

    case C2S.SET_BOTS:
      if (session.room && session.player) session.room.handleSetBots(session.player, msg);
      return;

    case C2S.STATE:
      if (session.room && session.player) session.room.handleState(session.player, msg);
      return;

    case C2S.SHOOT:
      if (session.room && session.player) session.room.handleShoot(session.player, msg);
      return;

    case C2S.SWITCH:
      if (session.room && session.player) session.room.handleSwitch(session.player, msg);
      return;

    case C2S.READY:
      if (session.room && session.player) session.room.handleReady(session.player, msg);
      return;

    case C2S.START:
      if (session.room && session.player) session.room.handleStart(session.player);
      return;

    case C2S.LOBBY_SET:
      if (session.room && session.player) session.room.handleLobbySet(session.player, msg);
      return;

    case C2S.SET_PRIMARY:
      if (session.room && session.player) session.room.handleSetPrimary(session.player, msg);
      return;

    case C2S.TO_LOBBY:
      if (session.room && session.player) session.room.handleReturnToLobby(session.player, msg);
      return;

    default:
      return;
  }
}

function joinRoom(session, ws, room, primaryId) {
  session.room = room;
  session.name ??= sanitiseName(null);
  // The class arrives with the join because joining a live match spawns you on
  // the spot — a separate message afterwards would always be one life too late.
  session.player = room.addPlayer({ id: session.id, name: session.name, ws, primaryId });
}

function leaveRoom(session) {
  if (!session.room) return;
  const room = session.room;
  room.removePlayer(session.id);
  session.room = null;
  session.player = null;

  // The room dies with its last player. Nothing is kept warm for a rejoin: the
  // code is gone, the 20Hz tick stops, and the memory is released. Quick Play
  // makes a fresh room in a millisecond, so there's nothing to preserve.
  if (room.size === 0) closeRoom(room, 'empty');
}

function closeRoom(room, reason) {
  if (!rooms.has(room.code)) return;
  room.dispose();
  rooms.delete(room.code);
  console.log(`room ${room.code} closed (${reason}); ${rooms.size} remaining`);
}

// ------------------------------------------------------------------- lifecycle

server.listen(PORT, () => {
  console.log(`arena server on :${PORT} (${IS_PROD ? 'production' : 'development'})`);
  if (!IS_PROD) console.log('client dev server: http://localhost:5173');
});

function shutdown() {
  console.log('shutting down…');
  clearInterval(heartbeat);
  clearInterval(sweeper);
  for (const room of rooms.values()) room.dispose();
  wss.close();
  server.close(() => process.exit(0));
  // Don't hang forever on a stuck socket.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { app, server, rooms };
