// WebSocket client, snapshot buffering and clock sync.
//
// Remote players are rendered ~100ms in the past. That sounds bad and is
// actually the whole trick: it means we always have a snapshot on both sides of
// the time we're drawing, so movement can be interpolated smoothly instead of
// snapping 20 times a second. The cost is that everyone else is a tenth of a
// second stale, which nobody notices; the alternative is visible stutter, which
// everybody notices.

import { CLIENT_SEND_HZ, INTERP_DELAY_MS } from '@shared/constants.js';
import { C2S, S2C, decode, decodeSnapshot, encode } from '@shared/protocol.js';

const SEND_INTERVAL = 1000 / CLIENT_SEND_HZ;
const BUFFER_LIMIT = 24;

function socketUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export function createNet() {
  return {
    ws: null,
    connected: false,
    myId: null,
    handlers: new Map(),

    // Snapshot buffer, oldest first.
    buffer: [],
    // Estimated offset between the server's clock and performance.now().
    clockOffset: null,
    latency: 0,

    lastSendAt: 0,
    // Set when the client itself closed the socket, so an expected close doesn't
    // raise the 'connection lost' notice. There is deliberately no auto-reconnect:
    // the server holds rooms in memory and a dropped player is removed from theirs,
    // so silently reattaching would land you in a match you are no longer part of.
    intentionalClose: false,
  };
}

export function on(net, type, fn) {
  net.handlers.set(type, fn);
}

function emit(net, type, payload) {
  const fn = net.handlers.get(type);
  if (fn) fn(payload);
}

export function connect(net, { name } = {}) {
  return new Promise((resolve, reject) => {
    if (net.ws && net.connected) return resolve();

    net.intentionalClose = false;
    const ws = new WebSocket(socketUrl());
    net.ws = ws;

    const openTimeout = setTimeout(() => {
      ws.close();
      reject(new Error('Connection timed out.'));
    }, 8000);

    ws.addEventListener('open', () => {
      clearTimeout(openTimeout);
      net.connected = true;
      send(net, C2S.HELLO, { name });
      resolve();
    });

    ws.addEventListener('message', (ev) => {
      const msg = decode(ev.data);
      if (!msg) return;

      if (msg.m === S2C.WELCOME) {
        net.myId = msg.id;
        emit(net, S2C.WELCOME, msg);
        return;
      }

      if (msg.m === S2C.SNAPSHOT) {
        ingestSnapshot(net, msg);
        return;
      }

      emit(net, msg.m, msg);
    });

    ws.addEventListener('close', () => {
      clearTimeout(openTimeout);
      net.connected = false;
      net.buffer.length = 0;
      net.clockOffset = null;
      if (!net.intentionalClose) emit(net, 'disconnected', {});
      reject(new Error('Connection closed.'));
    });

    ws.addEventListener('error', () => {
      clearTimeout(openTimeout);
      // 'close' fires straight after and does the real handling.
    });
  });
}

export function disconnect(net) {
  net.intentionalClose = true;
  if (net.ws && net.connected) {
    send(net, C2S.LEAVE, {});
    net.ws.close();
  }
  net.connected = false;
  net.buffer.length = 0;
  net.clockOffset = null;
}

export function send(net, type, payload) {
  if (!net.ws || net.ws.readyState !== WebSocket.OPEN) return false;
  net.ws.send(encode(type, payload));
  return true;
}

// --------------------------------------------------------------- snapshots

function ingestSnapshot(net, msg) {
  const snap = decodeSnapshot(msg);
  const localNow = performance.now();

  // First snapshot seeds the clock. Later ones nudge it with a slow EMA so we
  // track drift without jittering the render time.
  const observed = snap.time - localNow;
  if (net.clockOffset === null) {
    net.clockOffset = observed;
  } else {
    net.clockOffset += (observed - net.clockOffset) * 0.02;
    // A big jump means the connection hiccuped or the server restarted; resync
    // rather than crawling there over several seconds.
    if (Math.abs(observed - net.clockOffset) > 1000) net.clockOffset = observed;
  }

  net.buffer.push(snap);
  if (net.buffer.length > BUFFER_LIMIT) net.buffer.shift();

  // Interpolation intentionally renders everyone 100ms in the past, but our own
  // health is UI state and should use the newest authoritative value. Without
  // this, server-side regeneration never reached the local health bar.
  const self = snap.players.find((player) => player.id === net.myId);
  if (self) emit(net, 'selfstate', self);
}

/** Server time we should be rendering right now. */
export function renderTime(net) {
  if (net.clockOffset === null) return 0;
  return performance.now() + net.clockOffset - INTERP_DELAY_MS;
}

/**
 * Interpolated states for every player at the current render time.
 * Returns a Map of id -> { pos, yaw, pitch, flags, health, weapon }.
 */
export function sampleWorld(net) {
  const out = new Map();
  if (net.buffer.length === 0) return out;

  const t = renderTime(net);

  // Find the pair of snapshots straddling t.
  let older = null;
  let newer = null;
  for (let i = net.buffer.length - 1; i >= 0; i--) {
    if (net.buffer[i].time <= t) {
      older = net.buffer[i];
      newer = net.buffer[i + 1] ?? null;
      break;
    }
  }

  // Running behind the buffer (just connected, or a stall): show the oldest we
  // have rather than nothing.
  if (!older) {
    for (const p of net.buffer[0].players) out.set(p.id, { ...p, extrapolated: false });
    return out;
  }

  // Ahead of the newest snapshot — hold the last known pose. Deliberately not
  // extrapolated: guessing forward makes players skate through walls and then
  // snap back, which looks far worse than a brief pause.
  if (!newer) {
    for (const p of older.players) out.set(p.id, { ...p, extrapolated: true });
    return out;
  }

  const span = newer.time - older.time;
  const alpha = span > 0 ? Math.min(1, Math.max(0, (t - older.time) / span)) : 0;

  const newerById = new Map(newer.players.map((p) => [p.id, p]));

  for (const a of older.players) {
    const b = newerById.get(a.id);
    if (!b) {
      out.set(a.id, { ...a, extrapolated: true });
      continue;
    }
    out.set(a.id, {
      id: a.id,
      pos: [
        a.pos[0] + (b.pos[0] - a.pos[0]) * alpha,
        a.pos[1] + (b.pos[1] - a.pos[1]) * alpha,
        a.pos[2] + (b.pos[2] - a.pos[2]) * alpha,
      ],
      yaw: lerpAngle(a.yaw, b.yaw, alpha),
      pitch: a.pitch + (b.pitch - a.pitch) * alpha,
      // Flags and health are discrete — take the newer value rather than
      // blending, or a dying player flickers.
      flags: b.flags,
      health: b.health,
      weapon: b.weapon,
      extrapolated: false,
    });
  }

  // Someone who joined between the two snapshots.
  for (const b of newer.players) {
    if (!out.has(b.id)) out.set(b.id, { ...b, extrapolated: false });
  }

  return out;
}

/** Shortest-path angle interpolation, so spinning past π doesn't whip around. */
function lerpAngle(a, b, t) {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

// ------------------------------------------------------------- outbound state

/**
 * Push our own state up, rate-limited to CLIENT_SEND_HZ.
 * `extra` carries one-shot reports like fall damage.
 */
export function sendState(net, player, flags, now, extra = null) {
  if (!net.connected) return;
  if (now - net.lastSendAt < SEND_INTERVAL) return;
  net.lastSendAt = now;

  const msg = {
    p: [round2(player.pos[0]), round2(player.pos[1]), round2(player.pos[2])],
    y: round3(player.yaw),
    t: round3(player.pitch),
    f: flags,
  };
  if (extra?.fallDamage) msg.fd = extra.fallDamage;
  if (extra?.void) msg.void = 1;

  send(net, C2S.STATE, msg);
}

export function sendShot(net, { weaponId, origin, dir, hits, barrels }) {
  const msg = {
    w: weaponId,
    o: [round2(origin[0]), round2(origin[1]), round2(origin[2])],
    d: [round3(dir[0]), round3(dir[1]), round3(dir[2])],
    h: hits,
  };
  // Only sent when a barrel was actually struck, which is rare.
  if (barrels?.length) msg.b = barrels;
  send(net, C2S.SHOOT, msg);
}

export function sendSwitch(net, weaponId) {
  send(net, C2S.SWITCH, { w: weaponId });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
function round3(n) {
  return Math.round(n * 1000) / 1000;
}
