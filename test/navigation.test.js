// Map reachability.
//
// This exists because of a bug it would have caught immediately: Rooftops
// originally had platforms 1.5m above their neighbours, when a player's jump
// apex is 1.28m. Whole sections of the map were quietly unreachable, and the
// only symptom was players milling about at the bottom of the level.
//
// The model is a coarse walkable-surface graph:
//   - sample the map on a 1m grid, find every surface a player can stand on
//   - connect neighbours you can walk or step between
//   - connect neighbours you can jump up to, within the real jump apex
//   - connect across gaps, within the real horizontal jump distance
// then assert every spawn point lands in one connected component.
//
// It's an approximation — it doesn't know about crouching through gaps or
// jumping off a crate to reach a ledge — so it's deliberately *permissive*.
// A failure means something is genuinely stranded.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getMap, MAP_IDS } from '../shared/maps/index.js';
import {
  PLAYER_HEIGHT, STEP_HEIGHT, JUMP_VELOCITY, GRAVITY, SPRINT_SPEED,
} from '../shared/constants.js';

const CELL = 1.0;
// Real jump apex from the movement constants, with a little slack for the fact
// that auto-step gets you the last few centimetres.
const JUMP_APEX = (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * Math.abs(GRAVITY));
const MAX_STEP_UP = JUMP_APEX + STEP_HEIGHT * 0.5;
// Airtime from launch to landing at the same height.
const AIRTIME = (2 * JUMP_VELOCITY) / Math.abs(GRAVITY);
// Sprint is available, discounted to 70% so the test doesn't bless jumps that
// need a perfect run-up. The +1 is grid discretisation: a 3m gap costs 4 cells
// of travel, because you leave from the last solid cell and land on the first
// solid cell on the far side.
const MAX_JUMP_CELLS = Math.floor((SPRINT_SPEED * AIRTIME * 0.7) / CELL) + 1;
const EPS = 1e-3;

/**
 * Standable heights in a single vertical column.
 *
 * Deliberately a *column* test with no body radius. An earlier version probed
 * with a 0.28m radius and reported every middle step of every staircase as
 * blocked: standing on one step, your legs occupy the same space as the next
 * step's solid block. That's fine in the real game because auto-step lifts you
 * onto the higher surface — so modelling the body here produces false negatives
 * on exactly the geometry we most need to check.
 */
function standableHeights(boxes) {
  // Heights are kept EXACT and only deduplicated via a rounded key. Rounding
  // the height itself is subtly wrong: a stair step topping out at 0.7538 would
  // round to 0.75 and then register as blocking its own surface, which silently
  // deleted about one step in six from the graph.
  const seen = new Set();
  const tops = [];
  for (const b of boxes) {
    const key = Math.round(b.max[1] * 100);
    if (seen.has(key)) continue;
    seen.add(key);
    tops.push(b.max[1]);
  }
  tops.sort((a, b) => a - b);

  return tops.filter(
    (h) => !boxes.some((b) => b.max[1] > h + EPS && b.min[1] < h + PLAYER_HEIGHT - EPS),
  );
}

function buildNavGraph(map) {
  const { bounds, solids } = map;
  const minX = Math.floor(bounds.min[0]);
  const maxX = Math.ceil(bounds.max[0]);
  const minZ = Math.floor(bounds.min[2]);
  const maxZ = Math.ceil(bounds.max[2]);

  /** cellKey -> array of standable heights */
  const cells = new Map();

  for (let ix = minX; ix <= maxX; ix++) {
    for (let iz = minZ; iz <= maxZ; iz++) {
      const cx = ix + 0.5;
      const cz = iz + 0.5;

      const column = solids.filter(
        (s) => cx >= s.min[0] && cx <= s.max[0] && cz >= s.min[2] && cz <= s.max[2],
      );
      if (column.length === 0) continue;

      const heights = standableHeights(column);
      if (heights.length) cells.set(`${ix},${iz}`, heights);
    }
  }

  return { cells, minX, maxX, minZ, maxZ };
}

function neighbours(graph, ix, iz, h) {
  const out = [];
  const DIRS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  for (const [dx, dz] of DIRS) {
    // Walk or step to the adjacent cell, or jump up to it.
    let bridgedGap = false;

    for (let dist = 1; dist <= MAX_JUMP_CELLS; dist++) {
      const nx = ix + dx * dist;
      const nz = iz + dz * dist;
      const heights = graph.cells.get(`${nx},${nz}`);

      if (!heights) {
        // Empty column: a gap we might be able to clear. Keep looking further
        // out for a landing.
        bridgedGap = true;
        continue;
      }

      for (const nh of heights) {
        const rise = nh - h;
        if (dist === 1 && !bridgedGap) {
          // Adjacent: walk up a step, jump up a ledge, or drop down any amount.
          if (rise <= MAX_STEP_UP) out.push([nx, nz, nh]);
        } else {
          // Across a gap: you can't gain much height mid-flight, and landing
          // lower is always fine.
          if (rise <= JUMP_APEX * 0.75) out.push([nx, nz, nh]);
        }
      }

      // Stop at the first solid column in this direction — you can't jump
      // through a roof to land on something beyond it.
      break;
    }
  }

  return out;
}

function nodeKey(ix, iz, h) {
  return `${ix},${iz},${Math.round(h * 100)}`;
}

function nodeForPoint(graph, point) {
  const ix = Math.floor(point[0]);
  const iz = Math.floor(point[2]);

  // Check the spawn's own cell and its immediate ring, in case a spawn sits
  // just over a cell boundary from the surface it stands on.
  for (const [ox, oz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    const heights = graph.cells.get(`${ix + ox},${iz + oz}`);
    if (!heights) continue;
    for (const h of heights) {
      if (Math.abs(h - point[1]) < 0.8) return [ix + ox, iz + oz, h];
    }
  }
  return null;
}

function reachableFrom(graph, start) {
  const seen = new Set([nodeKey(...start)]);
  const queue = [start];

  while (queue.length) {
    const [ix, iz, h] = queue.shift();
    for (const n of neighbours(graph, ix, iz, h)) {
      const key = nodeKey(...n);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(n);
    }
  }
  return seen;
}

for (const id of MAP_IDS) {
  test(`${id}: every spawn sits on a standable surface`, () => {
    const map = getMap(id);
    const graph = buildNavGraph(map);

    for (const [team, points] of Object.entries(map.spawns)) {
      for (const [i, p] of points.entries()) {
        assert.ok(
          nodeForPoint(graph, p),
          `${id} spawn ${team}[${i}] at ${JSON.stringify(p)} isn't on any walkable surface`,
        );
      }
    }
  });

  test(`${id}: every spawn can reach every other spawn`, () => {
    const map = getMap(id);
    const graph = buildNavGraph(map);

    // Deduplicate — team and FFA spawn lists overlap.
    const points = [...new Set(Object.values(map.spawns).flat().map((p) => JSON.stringify(p)))].map(
      (s) => JSON.parse(s),
    );

    const origin = nodeForPoint(graph, points[0]);
    assert.ok(origin, 'first spawn is not on a walkable surface');

    const reachable = reachableFrom(graph, origin);

    const stranded = [];
    for (const p of points.slice(1)) {
      const node = nodeForPoint(graph, p);
      if (!node || !reachable.has(nodeKey(...node))) stranded.push(p);
    }

    assert.deepEqual(
      stranded,
      [],
      `${id}: these spawns can't be reached from ${JSON.stringify(points[0])} — ` +
        `something is stranded above a ${JUMP_APEX.toFixed(2)}m jump or across a gap wider than ` +
        `${(MAX_JUMP_CELLS * CELL).toFixed(0)}m: ${JSON.stringify(stranded)}`,
    );
  });
}

test('the jump numbers this test relies on match the movement constants', () => {
  // If someone retunes the jump, this test's assumptions have to move with it,
  // and the map geometry probably needs revisiting too.
  assert.ok(Math.abs(JUMP_APEX - 1.278) < 0.01, `jump apex is ${JUMP_APEX.toFixed(3)}m`);
  assert.ok(MAX_JUMP_CELLS >= 3, `horizontal jump reach is only ${MAX_JUMP_CELLS}m`);
});
