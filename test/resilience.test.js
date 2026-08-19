// Room resilience.
//
// The tick runs twenty times a second for every room and touches AI, the zone,
// vehicles, waves and spawning. An exception thrown from a setInterval callback is
// an uncaught exception, which ends the Node process — so one room hitting a bad
// state would drop every *other* match on the server too. These tests pin the
// guard that stops that.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Room } from '../server/room.js';

/** A room with its interval stopped, so tests drive it by hand. */
function quietRoom(mode = 'ffa') {
  const room = new Room('SAFE', mode);
  clearInterval(room.timer);
  room.timer = null;
  return room;
}

test('a throwing tick does not escape the interval callback', () => {
  const room = quietRoom();
  room.tick = () => { throw new Error('deliberate'); };

  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    // If this throws, the real setInterval would take the process with it.
    assert.doesNotThrow(() => room.safeTick());
  } finally {
    console.error = realError;
  }

  assert.equal(room.tickFailures, 1);
  assert.ok(errors.some((e) => e.includes('tick failed')), 'the failure should be logged');
  room.dispose();
});

test('a room that keeps failing is closed rather than left throwing forever', () => {
  const room = quietRoom();
  room.tick = () => { throw new Error('deliberate'); };

  const realError = console.error;
  console.error = () => {};
  try {
    for (let i = 0; i < 5; i++) room.safeTick();
  } finally {
    console.error = realError;
  }

  assert.equal(room.tickFailures, 5);
  assert.ok(room.closed, 'five consecutive failures should close the room');
  assert.equal(room.timer, null, 'and stop its interval');
});

test('one good tick clears the failure count', () => {
  // Otherwise a room that hiccups five times across a whole match — for five
  // unrelated reasons, minutes apart — would be closed under working players.
  const room = quietRoom();
  let explode = true;
  const realTick = Room.prototype.tick.bind(room);
  room.tick = () => {
    if (explode) throw new Error('deliberate');
    realTick();
  };

  const realError = console.error;
  console.error = () => {};
  try {
    room.safeTick();
    room.safeTick();
    assert.equal(room.tickFailures, 2);
    explode = false;
    room.safeTick();
  } finally {
    console.error = realError;
  }

  assert.equal(room.tickFailures, 0, 'a successful tick resets the counter');
  assert.ok(!room.closed, 'and the room stays open');
  room.dispose();
});

test('a healthy room ticks without incident', () => {
  // Guards against the guard itself being the thing that breaks.
  const room = quietRoom();
  for (let i = 0; i < 20; i++) room.safeTick();
  assert.equal(room.tickFailures, 0);
  assert.ok(!room.closed);
  room.dispose();
});

test('disposing a room stops it ticking', () => {
  const room = quietRoom();
  room.dispose();
  assert.ok(room.closed);
  // tick() returns early when closed, so this must stay harmless.
  assert.doesNotThrow(() => room.safeTick());
  assert.equal(room.tickFailures, 0);
});
