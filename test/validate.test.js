import test from 'node:test';
import assert from 'node:assert/strict';

import { compileBoxes, hasLineOfSight } from '../shared/collision.js';
import { EYE_OFFSET, LOS_ORIGIN_TOLERANCE, PITCH_LIMIT } from '../shared/constants.js';
import { getMap } from '../shared/maps/index.js';
import {
  eyeOf, heightOf, sanitiseShotTrace, validateHit, validateMove,
} from '../server/validate.js';

function combatant(pos) {
  return {
    pos: [...pos],
    inventory: ['rifle'],
    alive: true,
    crouching: false,
    spawnProtectedUntil: 0,
  };
}

test('a head exposed above a Rooftops wall can be hit', () => {
  const map = getMap('rooftops');
  const shooter = combatant([-12, 0, -26]);
  const victim = combatant([-5, 4, -5]);
  const shooterEye = eyeOf(shooter);
  const victimCentre = [
    victim.pos[0],
    victim.pos[1] + heightOf(victim) * 0.55,
    victim.pos[2],
  ];
  const victimHead = [
    victim.pos[0],
    victim.pos[1] + heightOf(victim) - EYE_OFFSET,
    victim.pos[2],
  ];

  assert.equal(
    hasLineOfSight(shooterEye, victimCentre, map.solids, LOS_ORIGIN_TOLERANCE),
    false,
    'test setup must keep the victim centre behind cover',
  );
  assert.equal(
    hasLineOfSight(shooterEye, victimHead, map.solids, LOS_ORIGIN_TOLERANCE),
    true,
    'test setup must leave the victim head exposed',
  );

  const result = validateHit({
    shooter,
    victim,
    weaponId: 'rifle',
    zone: 'head',
    map,
  });

  assert.equal(result.ok, true);
  assert.ok(result.damage > 0);
});

test('zone-aware validation still rejects a player fully behind a wall', () => {
  const map = {
    solids: compileBoxes([
      { pos: [5, 2, 0], size: [1, 8, 8] },
    ]),
  };
  const shooter = combatant([0, 0, 0]);
  const victim = combatant([10, 0, 0]);

  for (const zone of ['head', 'body', 'legs']) {
    const result = validateHit({
      shooter,
      victim,
      weaponId: 'rifle',
      zone,
      map,
    });
    assert.deepEqual(
      { ok: result.ok, reason: result.reason },
      { ok: false, reason: 'no-line-of-sight' },
      `${zone} should not pass through full-height cover`,
    );
  }
});

test('a claimed headshot cannot fall back to a visible torso', () => {
  const map = {
    solids: compileBoxes([
      // At x=5 this blocks both head probes, while the ray to centre mass
      // passes just underneath it.
      { pos: [5, 1.8, 0], size: [1, 0.8, 4] },
    ]),
  };
  const shooter = combatant([0, 0, 0]);
  const victim = combatant([10, 0, 0]);
  const victimCentre = [
    victim.pos[0],
    victim.pos[1] + heightOf(victim) * 0.55,
    victim.pos[2],
  ];

  assert.equal(
    hasLineOfSight(eyeOf(shooter), victimCentre, map.solids, LOS_ORIGIN_TOLERANCE),
    true,
    'test setup must leave centre mass visible',
  );

  const result = validateHit({
    shooter,
    victim,
    weaponId: 'rifle',
    zone: 'head',
    map,
  });
  assert.deepEqual(
    { ok: result.ok, reason: result.reason },
    { ok: false, reason: 'no-line-of-sight' },
  );
});

test('movement snapshots bound huge finite look angles', () => {
  const map = getMap('warehouse');
  const player = combatant([0, 0, 0]);

  const result = validateMove(player, {
    pos: [0, 0, 0],
    yaw: 1e300,
    pitch: 99,
  }, map, 1 / 30);

  assert.equal(result.ok, true);
  assert.ok(result.yaw >= -Math.PI && result.yaw <= Math.PI);
  assert.equal(result.pitch, PITCH_LIMIT);
});

test('cosmetic shot traces cannot carry invalid or remote vectors to peers', () => {
  const player = combatant([0, 0, 0]);
  player.yaw = 0;
  player.pitch = 0;

  const fallback = sanitiseShotTrace(player, [1e99, 0, 0], [0, 0, 0]);
  assert.deepEqual(fallback.origin, eyeOf(player));
  assert.ok(Math.abs(fallback.direction[0]) < 1e-12);
  assert.equal(fallback.direction[1], 0);
  assert.equal(fallback.direction[2], -1);

  const valid = sanitiseShotTrace(player, eyeOf(player), [10, 0, 0]);
  assert.deepEqual(valid.direction, [1, 0, 0]);
});

test('unknown hit zones are rejected before damage is calculated', () => {
  const result = validateHit({
    shooter: combatant([0, 0, 0]),
    victim: combatant([1, 0, 0]),
    weaponId: 'rifle',
    zone: 'everything',
    map: { solids: [] },
  });

  assert.deepEqual(
    { ok: result.ok, reason: result.reason },
    { ok: false, reason: 'unknown-zone' },
  );
});
