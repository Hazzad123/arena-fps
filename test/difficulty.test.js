// Does bot difficulty actually change anything?
//
// The existing tests check the setting propagates — that a host can pick "hard"
// and the bots receive it. None check that it *matters*. That's the property a
// player experiences, and it's exactly what silently breaks when the AI_SKILL
// numbers get tweaked: three difficulties that all play identically look fine in
// every propagation test ever written.
//
// So this runs whole matches at easy and hard and compares the outcomes.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Room } from '../server/room.js';
import { AI_SKILL } from '../server/ai.js';

// The room is time-driven, so the clock is faked and advanced a tick at a time —
// ticking in a tight loop leaves spawn protection permanently active.
const realNow = Date.now;
let fakeClock = realNow();

function installClock() {
  fakeClock = realNow();
  Date.now = () => fakeClock;
}

const TICK_MS = 50;

function ticks(room, n) {
  for (let i = 0; i < n; i++) {
    fakeClock += TICK_MS;
    room.tick();
  }
}

/** A free-for-all of `count` bots at a given difficulty, mid-round. */
function botMatch(count, difficulty) {
  installClock();
  const room = new Room('DIFF', 'ffa');
  clearInterval(room.timer);
  room.timer = null;
  room.botDifficulty = difficulty;
  room.aiSkill = difficulty;
  for (let i = 0; i < count; i++) room.addAiPlayer();
  room.beginRound();
  return room;
}

function totalKills(room) {
  let n = 0;
  for (const p of room.players.values()) n += p.kills;
  return n;
}

test('the difficulty table is ordered — harder means faster and more accurate', () => {
  // The knobs are all human failings, so "harder" is lower reaction, lower aim
  // error and higher accuracy. A table that got edited out of order would make
  // "hard" the easiest setting, which no propagation test would catch.
  const { easy, normal, hard } = AI_SKILL;

  assert.ok(easy.reaction > normal.reaction, 'easy should be slower to react than normal');
  assert.ok(normal.reaction > hard.reaction, 'normal should be slower to react than hard');

  assert.ok(easy.aimError > normal.aimError, 'easy should aim less precisely than normal');
  assert.ok(normal.aimError > hard.aimError, 'normal should aim less precisely than hard');

  assert.ok(easy.accuracy < normal.accuracy, 'easy should hit less often than normal');
  assert.ok(normal.accuracy < hard.accuracy, 'normal should hit less often than hard');

  assert.ok(easy.aimSpeed < normal.aimSpeed, 'easy should track more slowly than normal');
  assert.ok(normal.aimSpeed < hard.aimSpeed, 'normal should track more slowly than hard');

  assert.ok(easy.loseTargetMs < hard.loseTargetMs, 'easy should give up on a target sooner');
});

test('hard bots kill considerably more than easy bots over the same match', () => {
  // Averaged over several matches: one match of eight bots shooting at each other
  // is noisy enough that a single sample could invert by luck.
  const MATCHES = 5;
  const SECONDS = 40;
  let easyTotal = 0;
  let hardTotal = 0;

  for (let i = 0; i < MATCHES; i++) {
    const easy = botMatch(8, 'easy');
    ticks(easy, (SECONDS * 1000) / TICK_MS);
    easyTotal += totalKills(easy);
    easy.dispose();

    const hard = botMatch(8, 'hard');
    ticks(hard, (SECONDS * 1000) / TICK_MS);
    hardTotal += totalKills(hard);
    hard.dispose();
  }

  Date.now = realNow;

  assert.ok(easyTotal > 0, 'even easy bots should manage some kills');
  assert.ok(
    hardTotal > easyTotal,
    `hard bots should out-kill easy ones: hard ${hardTotal} vs easy ${easyTotal} over ${MATCHES} matches`,
  );
});

test('easy bots are not simply harmless', () => {
  // The other failure mode: making "easy" so gentle that it stops being a game.
  const room = botMatch(8, 'easy');
  ticks(room, (60 * 1000) / TICK_MS);
  const kills = totalKills(room);
  Date.now = realNow;
  room.dispose();
  assert.ok(kills >= 3, `eight easy bots in a minute should still fight, got ${kills} kills`);
});
