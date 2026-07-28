// Tests for shared/collision.js.
//
// These matter more than they look. A bug in here doesn't throw — it just makes
// the game feel bad in ways that are miserable to debug live (catching on
// corners, sinking through floors, shots that visibly connect but don't
// register). So the awkward cases get explicit coverage.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compileBoxes,
  slab,
  moveAndCollide,
  playerOverlapsAny,
  pushOutOfSolids,
  raycastBoxes,
  raycastPlayers,
  hasLineOfSight,
} from '../shared/collision.js';
import {
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  GRAVITY,
  STEP_HEIGHT,
  JUMP_VELOCITY,
} from '../shared/constants.js';

const H = PLAYER_HEIGHT;
const R = PLAYER_RADIUS;

/** A 40x40 floor with its top surface at y=0. */
const FLOOR = () => compileBoxes([slab(0, -1, 0, 40, 1, 40)]);

function player(pos, vel = [0, 0, 0]) {
  return { pos: [...pos], vel: [...vel], onGround: false };
}

/** Run n fixed steps, as the real game loop does. */
function simulate(state, boxes, steps, dt = 1 / 60, perStep) {
  for (let i = 0; i < steps; i++) {
    if (perStep) perStep(state, i);
    moveAndCollide(state, dt, boxes, H, R);
  }
  return state;
}

// ---------------------------------------------------------------- box compile

test('compileBox converts centre+size to min/max', () => {
  const [b] = compileBoxes([{ pos: [10, 5, -2], size: [2, 4, 6] }]);
  assert.deepEqual(b.min, [9, 3, -5]);
  assert.deepEqual(b.max, [11, 7, 1]);
});

test('slab() places a box resting on the given y rather than centred on it', () => {
  const [b] = compileBoxes([slab(0, 10, 0, 4, 2, 4)]);
  assert.equal(b.min[1], 10);
  assert.equal(b.max[1], 12);
});

// ------------------------------------------------------------------- gravity

test('a player falls and lands exactly on the floor surface', () => {
  const boxes = FLOOR();
  const s = player([0, 5, 0]);
  simulate(s, boxes, 180, 1 / 60, (st) => {
    st.vel[1] += GRAVITY * (1 / 60);
  });

  assert.ok(Math.abs(s.pos[1]) < 1e-3, `expected to rest at y=0, got ${s.pos[1]}`);
  assert.equal(s.onGround, true);
  assert.equal(s.vel[1], 0);
});

test('a resting player does not sink over time', () => {
  const boxes = FLOOR();
  const s = player([0, 0, 0]);
  simulate(s, boxes, 600, 1 / 60, (st) => {
    st.vel[1] += GRAVITY * (1 / 60);
  });
  assert.ok(Math.abs(s.pos[1]) < 1e-3, `drifted to y=${s.pos[1]}`);
});

test('a fast fall does not tunnel through a thin floor', () => {
  // 10cm thick floor, and a fall fast enough to cross it in one 60Hz step
  // if substepping were broken.
  const boxes = compileBoxes([slab(0, -0.1, 0, 40, 0.1, 40)]);
  const s = player([0, 3, 0], [0, -90, 0]);
  simulate(s, boxes, 30);
  assert.ok(s.pos[1] >= -0.01, `tunnelled to y=${s.pos[1]}`);
});

// -------------------------------------------------------------------- walls

test('walking into a wall stops horizontal movement without stopping the slide', () => {
  const boxes = compileBoxes([
    slab(0, -1, 0, 40, 1, 40),
    slab(4, 0, 0, 1, 3, 20), // wall at x≈4, running along z
  ]);
  const s = player([0, 0, 0], [10, 0, 6]);
  simulate(s, boxes, 60);

  // Stopped by the wall in x...
  assert.ok(s.pos[0] < 4, `passed through wall, x=${s.pos[0]}`);
  assert.ok(s.pos[0] > 3.0, `stopped too early, x=${s.pos[0]}`);
  // ...but still sliding along it in z.
  assert.ok(s.pos[2] > 1, `lost the slide along the wall, z=${s.pos[2]}`);
});

test('a corner between two walls does not trap or eject the player', () => {
  const boxes = compileBoxes([
    slab(0, -1, 0, 40, 1, 40),
    slab(4, 0, 0, 1, 3, 20),
    slab(0, 0, 4, 20, 3, 1),
  ]);
  const s = player([0, 0, 0], [10, 0, 10]);
  simulate(s, boxes, 60);

  assert.ok(s.pos[0] < 4 && s.pos[2] < 4, 'escaped through the corner');
  assert.ok(s.pos[0] > 0 && s.pos[2] > 0, 'was ejected backwards out of the corner');
  assert.equal(playerOverlapsAny(s.pos, H, R, boxes), false, 'ended up inside geometry');
});

test('jumping into a low ceiling stops the player without clipping through', () => {
  // Underside at 2.4, so a full jump (apex ≈ 1.28 + 1.8 head = 3.08) must hit it.
  const CEILING = 2.4;
  const boxes = compileBoxes([slab(0, -1, 0, 40, 1, 40), slab(0, CEILING, 0, 40, 1, 40)]);
  const s = player([0, 0, 0], [0, JUMP_VELOCITY, 0]);

  let bumped = false;
  let highestHead = 0;
  for (let i = 0; i < 60; i++) {
    s.vel[1] += GRAVITY * (1 / 60);
    const info = moveAndCollide(s, 1 / 60, boxes, H, R);
    if (info.hitCeiling) bumped = true;
    highestHead = Math.max(highestHead, s.pos[1] + H);
  }

  assert.equal(bumped, true, 'never registered a ceiling impact');
  assert.ok(highestHead <= CEILING + 1e-3, `head reached ${highestHead}, ceiling at ${CEILING}`);
  assert.ok(Math.abs(s.pos[1]) < 1e-3, `should have fallen back to the floor, y=${s.pos[1]}`);
});

// ------------------------------------------------------------------- step up

test('walks up a ledge within STEP_HEIGHT without jumping', () => {
  const step = STEP_HEIGHT - 0.05;
  const boxes = compileBoxes([slab(0, -1, 0, 40, 1, 40), slab(4, 0, 0, 4, step, 20)]);
  const s = player([0, 0, 0], [6, 0, 0]);
  simulate(s, boxes, 60, 1 / 60, (st) => {
    st.vel[1] += GRAVITY * (1 / 60);
    st.vel[0] = 6;
  });

  assert.ok(s.pos[1] >= step - 1e-2, `failed to step up, y=${s.pos[1]}`);
  assert.ok(s.pos[0] > 4, `did not get onto the ledge, x=${s.pos[0]}`);
});

test('is blocked by a ledge taller than STEP_HEIGHT', () => {
  const tall = STEP_HEIGHT + 0.35;
  const boxes = compileBoxes([slab(0, -1, 0, 40, 1, 40), slab(4, 0, 0, 4, tall, 20)]);
  const s = player([0, 0, 0], [6, 0, 0]);
  simulate(s, boxes, 60, 1 / 60, (st) => {
    st.vel[1] += GRAVITY * (1 / 60);
    st.vel[0] = 6;
  });

  assert.ok(s.pos[1] < 0.05, `climbed something it should not, y=${s.pos[1]}`);
  assert.ok(s.pos[0] < 4, `walked through the ledge, x=${s.pos[0]}`);
});

test('does not step up when there is no headroom above the ledge', () => {
  // Low ledge, but a ceiling right above it — stepping up would clip the head.
  const boxes = compileBoxes([
    slab(0, -1, 0, 40, 1, 40),
    slab(4, 0, 0, 4, 0.3, 20),
    slab(4, 0.6, 0, 4, 1, 20), // only 0.3m of gap
  ]);
  const s = player([0, 0, 0], [6, 0, 0]);
  simulate(s, boxes, 60, 1 / 60, (st) => {
    st.vel[1] += GRAVITY * (1 / 60);
    st.vel[0] = 6;
  });

  assert.equal(playerOverlapsAny(s.pos, H, R, boxes), false, 'clipped into the ceiling');
  assert.ok(s.pos[0] < 4, `squeezed through, x=${s.pos[0]}`);
});

// ------------------------------------------------------------ stuck recovery

test('pushOutOfSolids frees a player spawned inside a box', () => {
  const boxes = compileBoxes([{ pos: [0, 1, 0], size: [4, 2, 4] }]);
  const pos = [0, 0.5, 0];
  assert.equal(playerOverlapsAny(pos, H, R, boxes), true, 'test setup should start stuck');

  const freed = pushOutOfSolids(pos, H, R, boxes);
  assert.equal(freed, true);
  assert.equal(playerOverlapsAny(pos, H, R, boxes), false);
});

// ------------------------------------------------------------ raycast: boxes

test('raycastBoxes hits a wall dead ahead at the right distance', () => {
  const boxes = compileBoxes([{ pos: [10, 1, 0], size: [1, 4, 10] }]);
  const hit = raycastBoxes([0, 1, 0], [1, 0, 0], boxes, 100);

  assert.ok(hit, 'expected a hit');
  assert.ok(Math.abs(hit.t - 9.5) < 1e-6, `t=${hit.t}, expected 9.5`);
  assert.deepEqual(hit.normal, [-1, 0, 0]);
});

test('raycastBoxes misses when the ray points away', () => {
  const boxes = compileBoxes([{ pos: [10, 1, 0], size: [1, 4, 10] }]);
  assert.equal(raycastBoxes([0, 1, 0], [-1, 0, 0], boxes, 100), null);
});

test('raycastBoxes respects maxDist', () => {
  const boxes = compileBoxes([{ pos: [10, 1, 0], size: [1, 4, 10] }]);
  assert.equal(raycastBoxes([0, 1, 0], [1, 0, 0], boxes, 5), null);
});

test('raycastBoxes returns the nearest of several boxes', () => {
  const boxes = compileBoxes([
    { pos: [20, 1, 0], size: [1, 4, 10] },
    { pos: [6, 1, 0], size: [1, 4, 10] },
    { pos: [30, 1, 0], size: [1, 4, 10] },
  ]);
  const hit = raycastBoxes([0, 1, 0], [1, 0, 0], boxes, 100);
  assert.ok(Math.abs(hit.t - 5.5) < 1e-6, `t=${hit.t}, expected nearest at 5.5`);
});

test('raycastBoxes handles a ray parallel to a slab it is outside of', () => {
  // Aimed along x, but well above the box: must not register a hit.
  const boxes = compileBoxes([{ pos: [10, 1, 0], size: [1, 2, 10] }]);
  assert.equal(raycastBoxes([0, 20, 0], [1, 0, 0], boxes, 100), null);
});

test('raycastBoxes finds a downward hit on a floor', () => {
  const hit = raycastBoxes([0, 5, 0], [0, -1, 0], FLOOR(), 100);
  assert.ok(hit);
  assert.ok(Math.abs(hit.t - 5) < 1e-6);
  assert.deepEqual(hit.normal, [0, 1, 0]);
});

// ---------------------------------------------------------- raycast: players

const target = (id, pos) => ({ id, pos, height: H, radius: R });

test('raycastPlayers hits a target centre mass', () => {
  const hit = raycastPlayers([0, 1, 0], [1, 0, 0], [target('a', [10, 0, 0])], 100);
  assert.ok(hit, 'expected a hit');
  assert.equal(hit.player.id, 'a');
  assert.ok(Math.abs(hit.t - (10 - R)) < 1e-6, `t=${hit.t}`);
  assert.equal(hit.zone, 'body');
});

test('raycastPlayers misses a target just outside the cylinder radius', () => {
  // Offset in z by slightly more than the radius: a near miss.
  const hit = raycastPlayers([0, 1, 0], [1, 0, 0], [target('a', [10, 0, R + 0.02])], 100);
  assert.equal(hit, null);
});

test('raycastPlayers reports head, body and leg zones by height', () => {
  const t = [target('a', [10, 0, 0])];
  const zoneAt = (y) => raycastPlayers([0, y, 0], [1, 0, 0], t, 100)?.zone;

  assert.equal(zoneAt(H - 0.1), 'head');
  assert.equal(zoneAt(1.0), 'body');
  assert.equal(zoneAt(0.3), 'legs');
});

test('raycastPlayers misses over the head and under the feet', () => {
  const t = [target('a', [10, 0, 0])];
  assert.equal(raycastPlayers([0, H + 0.5, 0], [1, 0, 0], t, 100), null);
  assert.equal(raycastPlayers([0, -0.5, 0], [1, 0, 0], t, 100), null);
});

test('raycastPlayers ignores the shooter', () => {
  const players = [target('me', [0, 0, 0]), target('them', [10, 0, 0])];
  const hit = raycastPlayers([0, 1, 0], [1, 0, 0], players, 100, 'me');
  assert.equal(hit.player.id, 'them');
});

test('raycastPlayers returns the nearest target when two line up', () => {
  const players = [target('far', [20, 0, 0]), target('near', [8, 0, 0])];
  const hit = raycastPlayers([0, 1, 0], [1, 0, 0], players, 100);
  assert.equal(hit.player.id, 'near');
});

test('raycastPlayers hits the head cap on a steep shot from above', () => {
  // Straight down onto someone standing below a catwalk.
  const hit = raycastPlayers([0, 6, 0], [0, -1, 0], [target('a', [0, 0, 0])], 100);
  assert.ok(hit, 'expected a hit on the top cap');
  assert.equal(hit.zone, 'head');
});

// ------------------------------------------------------------ line of sight

test('hasLineOfSight is true across open ground', () => {
  assert.equal(hasLineOfSight([0, 1, 0], [20, 1, 0], FLOOR()), true);
});

test('hasLineOfSight is false through a wall', () => {
  const boxes = compileBoxes([slab(0, -1, 0, 40, 1, 40), { pos: [10, 2, 0], size: [1, 4, 20] }]);
  assert.equal(hasLineOfSight([0, 1, 0], [20, 1, 0], boxes), false);
});

test('hasLineOfSight tolerance forgives a corner peek', () => {
  // Wall ends just short of the target; without tolerance this reads as blocked.
  const boxes = compileBoxes([{ pos: [19.7, 2, 0], size: [0.4, 4, 20] }]);
  assert.equal(hasLineOfSight([0, 1, 0], [20, 1, 0], boxes, 0), false);
  assert.equal(hasLineOfSight([0, 1, 0], [20, 1, 0], boxes, 0.75), true);
});
