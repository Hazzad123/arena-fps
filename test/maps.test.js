// Map sanity checks.
//
// Hand-authored geometry gets things wrong in predictable ways: a spawn point
// buried in a wall, a spawn floating over a gap, a box with a negative
// dimension. These are tedious to find by walking around and trivial to catch
// here, so every map gets checked on every test run.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getMap, MAP_IDS, ROTATION, nextMap, mapList } from '../shared/maps/index.js';
import { playerOverlapsAny, raycastBoxes, pushOutOfSolids } from '../shared/collision.js';
import { PLAYER_HEIGHT as H, PLAYER_RADIUS as R, MAX_PLAYERS } from '../shared/constants.js';

test('rotation contains all six competitive maps and cycles', () => {
  assert.deepEqual(ROTATION, ['warehouse', 'rooftops', 'alley', 'courtyard', 'foundry', 'switchyard']);
  assert.equal(nextMap('warehouse'), 'rooftops');
  assert.equal(nextMap('switchyard'), 'warehouse', 'rotation should wrap');
  assert.equal(mapList().length, 6);
});

test('the practice range is marked single player and is not in rotation', () => {
  const m = getMap('practice');
  assert.equal(m.singlePlayer, true);
  assert.ok(!ROTATION.includes('practice'));
  assert.ok(m.targets.length >= 10, 'practice range should have a decent number of targets');
});

test('battle royale has distinct named areas with useful loot', () => {
  const map = getMap('island');
  assert.ok(map.areas.length >= 10, 'the island should have enough landmarks to avoid repeated districts');
  assert.equal(new Set(map.areas.map((area) => area.id)).size, map.areas.length, 'area ids must be unique');
  assert.equal(new Set(map.areas.map((area) => area.name)).size, map.areas.length, 'area names must be unique');

  for (const area of map.areas) {
    assert.ok(area.name.length > 3, `${area.id} needs a readable name`);
    assert.ok(area.radius >= 35, `${area.name} is too small to function as a drop zone`);
    assert.ok(
      area.pos[0] - area.radius >= map.bounds.min[0] &&
      area.pos[0] + area.radius <= map.bounds.max[0] &&
      area.pos[1] - area.radius >= map.bounds.min[2] &&
      area.pos[1] + area.radius <= map.bounds.max[2],
      `${area.name} escapes the island bounds`,
    );

    const nearbyLoot = map.lootPoints.filter(
      (point) => Math.hypot(point.pos[0] - area.pos[0], point.pos[2] - area.pos[1]) <= area.radius,
    );
    assert.ok(nearbyLoot.length >= 8, `${area.name} has only ${nearbyLoot.length} reachable loot points`);
  }
});

for (const id of MAP_IDS) {
  test(`${id}: geometry is well formed`, () => {
    const map = getMap(id);
    assert.ok(map.solids.length > 0, 'map has no geometry');

    for (const [i, s] of map.solids.entries()) {
      for (let a = 0; a < 3; a++) {
        assert.ok(
          s.max[a] > s.min[a],
          `box ${i} has non-positive extent on axis ${a} (${s.min[a]}..${s.max[a]})`,
        );
        assert.ok(Number.isFinite(s.min[a]) && Number.isFinite(s.max[a]), `box ${i} has NaN bounds`);
      }
    }
  });

  test(`${id}: geometry stays inside the declared bounds`, () => {
    const map = getMap(id);
    for (const [i, s] of map.solids.entries()) {
      for (let a = 0; a < 3; a++) {
        assert.ok(
          s.min[a] >= map.bounds.min[a] - 0.01 && s.max[a] <= map.bounds.max[a] + 0.01,
          `box ${i} escapes bounds on axis ${a}`,
        );
      }
    }
  });

  test(`${id}: every spawn point is clear of geometry`, () => {
    const map = getMap(id);
    for (const [team, points] of Object.entries(map.spawns)) {
      for (const [i, p] of points.entries()) {
        assert.equal(
          playerOverlapsAny(p, H, R, map.solids),
          false,
          `spawn ${team}[${i}] at ${JSON.stringify(p)} is inside geometry`,
        );
      }
    }
  });

  test(`${id}: every spawn point has ground close beneath it`, () => {
    const map = getMap(id);
    for (const [team, points] of Object.entries(map.spawns)) {
      for (const [i, p] of points.entries()) {
        // Probe from just above the feet so we don't start inside the floor.
        const hit = raycastBoxes([p[0], p[1] + 0.2, p[2]], [0, -1, 0], map.solids, 6);
        assert.ok(
          hit,
          `spawn ${team}[${i}] at ${JSON.stringify(p)} has no ground within 6m — players will fall`,
        );
        assert.ok(
          hit.t < 1.0,
          `spawn ${team}[${i}] floats ${hit.t.toFixed(2)}m above the ground`,
        );
      }
    }
  });

  test(`${id}: has enough spawn points for a full game`, () => {
    const map = getMap(id);
    if (map.singlePlayer) {
      assert.ok(map.spawns.ffa.length >= 1);
      return;
    }
    // Team modes split the room, so each side needs half a lobby's worth.
    assert.ok(
      map.spawns.A.length >= MAX_PLAYERS / 2,
      `team A has ${map.spawns.A.length} spawns, needs ${MAX_PLAYERS / 2}`,
    );
    assert.ok(map.spawns.B.length >= MAX_PLAYERS / 2, `team B has too few spawns`);
    assert.ok(
      map.spawns.ffa.length >= MAX_PLAYERS,
      `FFA has ${map.spawns.ffa.length} spawns, needs ${MAX_PLAYERS}`,
    );
  });

  test(`${id}: team spawns are far apart`, () => {
    const map = getMap(id);
    if (map.singlePlayer) return;

    let closest = Infinity;
    for (const a of map.spawns.A) {
      for (const b of map.spawns.B) {
        closest = Math.min(closest, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
      }
    }
    // Spawning within a few seconds' sprint of the enemy makes for miserable
    // spawn-trading, which is the main way a small arena map goes wrong.
    assert.ok(closest > 25, `closest opposing spawns are only ${closest.toFixed(1)}m apart`);
  });

  test(`${id}: is caches compiled geometry rather than recompiling`, () => {
    assert.equal(getMap(id), getMap(id), 'getMap should return the cached instance');
  });
}

test('pushOutOfSolids recovers from shallow overlaps near every spawn', () => {
  // Scoped deliberately to *shallow* penetration, which is the only case that
  // actually happens: two players telefragging on the same spawn, or a spawn
  // point authored a few centimetres inside a crate. Being buried at the dead
  // centre of a 3m-thick wall has no sensible resolution and never occurs, so
  // it isn't tested.
  const nudges = [
    [0.35, 0, 0],
    [-0.35, 0, 0],
    [0, 0, 0.35],
    [0, 0, -0.35],
    [0, 0.3, 0],
  ];

  for (const id of MAP_IDS) {
    const map = getMap(id);
    for (const points of Object.values(map.spawns)) {
      for (const p of points) {
        for (const n of nudges) {
          const pos = [p[0] + n[0], p[1] + n[1], p[2] + n[2]];
          if (!playerOverlapsAny(pos, H, R, map.solids)) continue;

          pushOutOfSolids(pos, H, R, map.solids, 16);
          assert.equal(
            playerOverlapsAny(pos, H, R, map.solids),
            false,
            `${id}: could not recover from a shallow overlap near ${JSON.stringify(p)}`,
          );
        }
      }
    }
  }
});
