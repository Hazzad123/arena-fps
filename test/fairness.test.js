// The server-side checks that keep play honest, and the room list that describes
// it.
//
// Movement is client-authoritative by design — that trade is documented and
// deliberate — but the sanity checks that bound it had no coverage at all. Neither
// did the fire-rate limit or the pellet cap, which are the two places where a
// client could otherwise multiply its own damage.

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateMove, validateFireRate, capPelletCount } from '../server/validate.js';
import { getMap } from '../shared/maps/index.js';
import { getWeapon } from '../shared/weapons.js';
import { Room } from '../server/room.js';
import { MAX_VALIDATED_SPEED, PITCH_LIMIT } from '../shared/constants.js';

const map = getMap('warehouse');

function playerAt(pos) {
  return { pos: [...pos], yaw: 0, pitch: 0, lastShotAt: 0, rejectedMoves: 0 };
}

// ------------------------------------------------------------------- movement

test('a plausible step is accepted', () => {
  const p = playerAt([0, 0, 0]);
  const out = validateMove(p, { pos: [1, 0, 0], yaw: 0.5, pitch: 0.1 }, map, 0.2);
  assert.ok(out.ok, `should accept a 1m step: ${out.reason}`);
});

test('a teleport across the map is rejected as too fast', () => {
  // Kept inside the map bounds on purpose. Somewhere outside them is refused too,
  // but by the bounds check — this is specifically pinning the speed check, which
  // is the one that has to catch a teleport between two legal positions.
  const p = playerAt([-30, 0, -30]);
  const out = validateMove(p, { pos: [30, 0, 30], yaw: 0, pitch: 0 }, map, 0.05);
  assert.ok(!out.ok);
  assert.equal(out.reason, 'too-fast');
});

test('a position beyond the map is refused by the bounds check', () => {
  const p = playerAt([0, 0, 0]);
  const out = validateMove(p, { pos: [500, 0, 500], yaw: 0, pitch: 0 }, map, 60);
  assert.ok(!out.ok);
  assert.equal(out.reason, 'out-of-bounds',
    'a generous dt must not let someone walk out of the level');
});

test('the speed allowance scales with the reported frame time', () => {
  // A client on a bad connection legitimately batches movement, so a longer gap
  // has to permit a longer step — otherwise hotel wifi looks like cheating.
  const near = validateMove(playerAt([0, 0, 0]), { pos: [8, 0, 0], yaw: 0, pitch: 0 }, map, 0.05);
  const far = validateMove(playerAt([0, 0, 0]), { pos: [8, 0, 0], yaw: 0, pitch: 0 }, map, 1.2);
  assert.ok(!near.ok, '8m in 50ms is not walking');
  assert.ok(far.ok, 'but 8m across 1.2s is');
});

test('a sustained speed hack is still rejected however it is paced', () => {
  // The generous per-update slack (MAX_TELEPORT) must not compound into free
  // speed when a client sends many small over-range steps.
  let p = playerAt([0, 0, 0]);
  const dt = 0.05;
  let rejected = 0;
  for (let i = 0; i < 40; i++) {
    // Ask for four times the legitimate speed, every update.
    const step = MAX_VALIDATED_SPEED * dt * 4;
    const out = validateMove(p, { pos: [p.pos[0] + step, 0, 0], yaw: 0, pitch: 0 }, map, dt);
    if (out.ok) p = playerAt(out.pos);
    else rejected += 1;
  }
  assert.ok(rejected > 0, 'a persistent overspeed should be caught');
  // And they should not have got far: honest travel over 2s is ~MAX_SPEED*2.
  assert.ok(
    p.pos[0] < MAX_VALIDATED_SPEED * 2 + 10,
    `overspeed travelled ${p.pos[0].toFixed(1)}m in 2s of updates`,
  );
});

test('non-finite and out-of-bounds positions are refused', () => {
  const p = playerAt([0, 0, 0]);
  for (const pos of [[NaN, 0, 0], [0, Infinity, 0], ['x', 0, 0]]) {
    assert.equal(validateMove(p, { pos, yaw: 0, pitch: 0 }, map, 0.1).reason, 'malformed');
  }
  const far = validateMove(p, { pos: [99999, 0, 0], yaw: 0, pitch: 0 }, map, 0.1);
  assert.ok(!far.ok, 'a position outside the map must be refused');
});

test('pitch is clamped and yaw is wrapped', () => {
  const p = playerAt([0, 0, 0]);
  const out = validateMove(p, { pos: [0, 0, 0], yaw: 900, pitch: 99 }, map, 0.1);
  assert.ok(out.ok);
  assert.ok(Math.abs(out.yaw) <= Math.PI + 1e-9, `yaw should wrap, got ${out.yaw}`);
  assert.ok(Math.abs(out.pitch) <= PITCH_LIMIT + 1e-9, `pitch should clamp, got ${out.pitch}`);
});

// ------------------------------------------------------------------ fire rate

test('a weapon cannot be fired faster than its cadence', () => {
  const rifle = getWeapon('rifle');
  const interval = 60_000 / rifle.rpm;
  const p = playerAt([0, 0, 0]);

  assert.ok(validateFireRate(p, 'rifle', 1000), 'the first shot is always allowed');
  assert.ok(!validateFireRate(p, 'rifle', 1000 + interval * 0.2), 'five times too fast is refused');
  assert.ok(validateFireRate(p, 'rifle', 1000 + interval * 1.1), 'a legitimate follow-up is allowed');
});

test('a refused shot does not reset the cadence clock', () => {
  // If it did, spamming would push the next legal shot ever further out — or, worse
  // depending on the sign, let a client walk the clock backwards.
  const p = playerAt([0, 0, 0]);
  validateFireRate(p, 'rifle', 1000);
  const after = p.lastShotAt;
  validateFireRate(p, 'rifle', 1001);
  assert.equal(p.lastShotAt, after, 'a rejected shot must leave lastShotAt alone');
});

test('an unknown weapon can never fire', () => {
  assert.equal(validateFireRate(playerAt([0, 0, 0]), 'not-a-gun', 1000), false);
});

// ----------------------------------------------------------------- pellet cap

test('a client cannot claim more pellets than the weapon has', () => {
  const shotgun = getWeapon('shotgun');
  assert.equal(capPelletCount('shotgun', 999), shotgun.pellets);
  assert.equal(capPelletCount('shotgun', 1), 1, 'honest counts pass through');
  assert.equal(capPelletCount('rifle', 50), getWeapon('rifle').pellets);
  assert.equal(capPelletCount('not-a-gun', 8), 0, 'an unknown weapon lands nothing');
});

// ---------------------------------------------------------------- room summary

test('the room list reports the real capacity for the mode', () => {
  // ROOM_CAPACITY is MAX_PLAYERS, so this used to advertise a thirty-slot battle
  // royale as holding eight.
  const br = new Room('CAP1', 'br');
  const tdm = new Room('CAP2', 'tdm');
  try {
    assert.equal(br.summary().capacity, br.capacity());
    assert.ok(br.summary().capacity > tdm.summary().capacity,
      'battle royale should advertise more slots than team deathmatch');
  } finally {
    br.dispose();
    tdm.dispose();
  }
});

test('the room list distinguishes people from bots', () => {
  // players.size counts AI, so a battle royale with one person in it reported
  // "30 players" and read as full to anybody browsing the list.
  const room = new Room('CAP3', 'ffa');
  try {
    room.addPlayer({ id: 'h1', name: 'Human', ws: null, primaryId: 'rifle' });
    for (let i = 0; i < 5; i++) room.addAiPlayer();

    const s = room.summary();
    assert.equal(s.humans, 1, 'one actual person');
    assert.equal(s.players, 6, 'six bodies');
    assert.ok(s.humans < s.players, 'the two must not be the same number');
  } finally {
    room.dispose();
  }
});

test('rejected movement is counted where someone can see it', () => {
  // The old counter was incremented and never read by anything, which made a
  // stalling player impossible to diagnose after the fact.
  const room = new Room('CAP4', 'ffa');
  try {
    const p = room.addPlayer({ id: 'h1', name: 'Human', ws: null, primaryId: 'rifle' });
    assert.equal(room.summary().rejectedMoves, 0);

    const now = Date.now();
    room.noteRejectedMove(p, 'too-fast', now);
    room.noteRejectedMove(p, 'too-fast', now + 10);

    assert.equal(room.summary().rejectedMoves, 2);
    assert.equal(p.rejectedMoves, 2);
  } finally {
    room.dispose();
  }
});

test('a sustained rejection streak is reported once, not every time', () => {
  const room = new Room('CAP5', 'ffa');
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const p = room.addPlayer({ id: 'h1', name: 'Noisy', ws: null, primaryId: 'rifle' });
    const now = Date.now();
    // Well past the threshold, all inside the window.
    for (let i = 0; i < 60; i++) room.noteRejectedMove(p, 'too-fast', now + i);
    assert.equal(warnings.length, 1, 'one warning, however long the streak runs');
    assert.ok(warnings[0].includes('Noisy'));
  } finally {
    console.warn = realWarn;
    room.dispose();
  }
});

test('rejections outside the window do not accumulate into a false alarm', () => {
  // Twenty-five rejections spread over an hour is a flaky connection having a bad
  // day, not something to shout about.
  const room = new Room('CAP6', 'ffa');
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const p = room.addPlayer({ id: 'h1', name: 'Flaky', ws: null, primaryId: 'rifle' });
    let t = Date.now();
    for (let i = 0; i < 40; i++) {
      room.noteRejectedMove(p, 'too-fast', t);
      t += 6000; // each one past the 5s window
    }
    assert.equal(warnings.length, 0, 'spaced-out rejections should stay quiet');
    assert.equal(room.summary().rejectedMoves, 40, 'but still be counted');
  } finally {
    console.warn = realWarn;
    room.dispose();
  }
});
