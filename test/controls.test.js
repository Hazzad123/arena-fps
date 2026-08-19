// Control schemes and analogue-stick maths.
//
// The stick functions are the interesting half. They're the kind of code that
// "works" while being subtly wrong — a squared deadzone, a diagonal that snaps to
// 45°, a stick that can never quite reach full speed — and none of that shows up
// as an error, only as aim that feels bad. So they get asserted on properly.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_KEY_MAP, SCHEME_KEYS, SCHEMES, keyMapFor, ALL_ACTIONS,
  DEADZONE, stickVector, lookCurve,
} from '../shared/controls.js';

// ------------------------------------------------------------------- schemes

test('every scheme can move, jump, fire and aim', () => {
  // The point of the whole abstraction: a scheme that can't shoot is not a
  // scheme, it's a bug. Firing and aiming are reachable per-scheme in different
  // ways, so this checks the capability rather than a specific key.
  for (const scheme of SCHEMES) {
    const map = keyMapFor(scheme);
    const actions = new Set(Object.values(map));

    for (const needed of ['forward', 'back', 'left', 'right', 'jump', 'reload', 'use']) {
      assert.ok(actions.has(needed), `${scheme} has no binding for ${needed}`);
    }

    // Mouse and pad schemes fire from the device itself; trackpad needs a key.
    if (scheme === 'trackpad') {
      assert.ok(actions.has('firing'), 'trackpad must be able to fire from the keyboard');
      assert.ok(actions.has('adsKey'), 'trackpad must be able to aim without right-click');
    }
  }
});

test('the trackpad scheme never needs Space for jumping', () => {
  // Space is the trigger there, so binding it to jump too would fire every time
  // you hopped a crate.
  const map = keyMapFor('trackpad');
  assert.equal(map.Space, 'firing');
  assert.equal(map.KeyF, 'jump');
  assert.notEqual(map.Space, 'jump');
});

test('mouse and pad schemes keep Space on jump', () => {
  assert.equal(keyMapFor('mouse').Space, 'jump');
  assert.equal(keyMapFor('pad').Space, 'jump');
});

test('an unknown scheme falls back to mouse rather than losing bindings', () => {
  // settings.scheme is null until the chooser is answered, and the game has to
  // stay playable in the meantime.
  assert.deepEqual(keyMapFor(undefined), keyMapFor('mouse'));
  assert.deepEqual(keyMapFor('nonsense'), keyMapFor('mouse'));
});

test('no scheme rebinds a key the base map already uses for something else', () => {
  // A silent collision here would mean pressing one key did two things, or the
  // wrong thing, depending on object key order.
  for (const [scheme, overrides] of Object.entries(SCHEME_KEYS)) {
    for (const [code, action] of Object.entries(overrides)) {
      const base = BASE_KEY_MAP[code];
      assert.ok(
        base === undefined || base === action,
        `${scheme} rebinds ${code} from '${base}' to '${action}'`,
      );
    }
  }
});

test('ALL_ACTIONS covers every action any scheme can bind', () => {
  // releaseAllKeys() iterates this to clear held state. Anything missing stays
  // stuck down after alt-tabbing.
  const every = new Set([
    ...Object.values(BASE_KEY_MAP),
    ...Object.values(SCHEME_KEYS).flatMap((m) => Object.values(m)),
  ]);
  assert.deepEqual([...every].sort(), [...ALL_ACTIONS].sort());
});

// -------------------------------------------------------------- stick vector

test('a resting stick reads exactly zero', () => {
  // Real pads rest off-centre. Anything that leaks through here is a view that
  // drifts on its own for the whole match.
  for (const [x, y] of [[0, 0], [0.05, 0], [0, -0.09], [0.1, 0.1], [-0.12, 0.08]]) {
    const v = stickVector(x, y);
    assert.equal(v.magnitude, 0, `${x},${y} should be inside the deadzone`);
    assert.equal(v.x, 0);
    assert.equal(v.y, 0);
  }
});

test('full deflection reaches full magnitude', () => {
  // Rescaling past the deadzone is what makes this true. Without it the stick
  // tops out around 0.82 and you can never sprint or turn at full speed.
  assert.equal(stickVector(1, 0).magnitude, 1);
  assert.equal(stickVector(-1, 0).magnitude, 1);
  assert.ok(Math.abs(stickVector(1, 0).x - 1) < 1e-9);
});

test('the deadzone is radial, not per-axis', () => {
  // The discriminating case: both components sit below the deadzone while the
  // vector as a whole is comfortably outside it. A per-axis deadzone rejects each
  // component independently and returns dead zero here — a real diagonal push the
  // player can feel, that the game ignores. Radially it registers.
  const c = DEADZONE - 0.03; // 0.15 each
  assert.ok(c < DEADZONE, 'each component is inside the per-axis threshold');
  assert.ok(Math.hypot(c, c) > DEADZONE, 'yet the vector is outside the circle');
  assert.ok(stickVector(c, c).magnitude > 0, 'a radial deadzone must let this through');
});

test('the deadzone boundary is a circle, so it is direction-independent', () => {
  // Same length, every direction, all rejected. A square deadzone would pass some
  // of these and not others, which feels like the stick having flat spots.
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
    const r = DEADZONE - 0.01;
    const v = stickVector(Math.cos(a) * r, Math.sin(a) * r);
    assert.equal(v.magnitude, 0, `direction ${a.toFixed(2)} leaked through`);
  }
});

test('a 45 degree push stays at 45 degrees', () => {
  const full = stickVector(0.8, 0.8);
  assert.ok(full.magnitude > 0);
  assert.ok(Math.abs(full.x - full.y) < 1e-9, 'a 45° push must stay at 45°');
});

test('magnitude never exceeds 1, even past the corners of the stick box', () => {
  // Some pads report slightly over 1.0 on a hard diagonal. Unclamped that means
  // moving faster than the movement code believes is possible.
  for (const [x, y] of [[1, 1], [-1, 1], [1.1, 0], [0.99, 0.99]]) {
    assert.ok(stickVector(x, y).magnitude <= 1 + 1e-12, `${x},${y} exceeded 1`);
  }
});

test('stick magnitude rises monotonically with deflection', () => {
  let previous = -1;
  for (let d = 0; d <= 1.0001; d += 0.05) {
    const m = stickVector(d, 0).magnitude;
    assert.ok(m >= previous - 1e-12, `magnitude dipped at ${d.toFixed(2)}`);
    previous = m;
  }
});

test('direction survives the deadzone rescale', () => {
  // The rescale must change length only. If it touched the components
  // independently the stick would pull toward the axes.
  const v = stickVector(0.6, -0.3);
  const inputAngle = Math.atan2(-0.3, 0.6);
  const outputAngle = Math.atan2(v.y, v.x);
  assert.ok(Math.abs(inputAngle - outputAngle) < 1e-9);
});

// ---------------------------------------------------------------- look curve

test('the look curve preserves sign and endpoints', () => {
  assert.equal(lookCurve(0), 0);
  assert.equal(lookCurve(1), 1);
  assert.equal(lookCurve(-1), -1);
  assert.ok(lookCurve(-0.5) < 0, 'pushing left must still look left');
});

test('the look curve compresses small inputs and keeps large ones', () => {
  // This is the entire point: fine control near the centre, full rate at the edge.
  assert.ok(lookCurve(0.2) < 0.2, 'small deflections should be gentler');
  assert.ok(lookCurve(0.9) > 0.5, 'large deflections should stay fast');
  assert.ok(lookCurve(0.5) < 0.5);
});

test('the look curve is monotonic', () => {
  // A dip anywhere here would feel like the stick sticking mid-turn.
  let previous = -Infinity;
  for (let d = -1; d <= 1.0001; d += 0.05) {
    const v = lookCurve(d);
    assert.ok(v >= previous - 1e-12, `curve dipped at ${d.toFixed(2)}`);
    previous = v;
  }
});
