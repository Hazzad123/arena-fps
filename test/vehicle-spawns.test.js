// Where rovers are placed.
//
// Player spawns have had reachability coverage since the sealed-buildings bug, but
// rover spawns arrived later and inherited none of it. They're validated in
// island.js with playerOverlapsAny using PLAYER_RADIUS — and a rover is nothing
// like a player. It is 2.3m across and 3.4m long against a player's 0.8m diameter,
// so a point that is comfortably clear for a person on foot can still leave a
// rover with its nose in a wall.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getMap, MAP_IDS } from '../shared/maps/index.js';
import { playerOverlapsAny } from '../shared/collision.js';
import { VEHICLE_HITBOX } from '../shared/vehicles.js';

// Rovers spawn at yaw 0 (see resetVehicles in room.js), so the footprint is
// axis-aligned. playerOverlapsAny tests a cylinder, so the long axis is the
// meaningful radius — a circle that spans the length of the chassis.
const VEHICLE_RADIUS = Math.max(
  Math.abs(VEHICLE_HITBOX.min[0]), VEHICLE_HITBOX.max[0],
  Math.abs(VEHICLE_HITBOX.min[2]), VEHICLE_HITBOX.max[2],
);
const VEHICLE_HEIGHT = VEHICLE_HITBOX.max[1] - VEHICLE_HITBOX.min[1];

const mapsWithVehicles = MAP_IDS.filter((id) => (getMap(id).vehicleSpawns ?? []).length > 0);

test('at least one map actually fields rovers', () => {
  // If this ever fails the rest of the file is silently vacuous.
  assert.ok(mapsWithVehicles.length > 0, 'no map declares vehicleSpawns');
});

for (const id of mapsWithVehicles) {
  test(`${id}: every rover spawns clear of the level`, () => {
    const map = getMap(id);
    const stuck = [];

    for (const spawn of map.vehicleSpawns) {
      if (playerOverlapsAny(spawn.pos, VEHICLE_HEIGHT, VEHICLE_RADIUS, map.solids)) {
        stuck.push(`#${spawn.index} at ${JSON.stringify(spawn.pos.map((n) => Math.round(n)))}`);
      }
    }

    assert.deepEqual(
      stuck, [],
      `${stuck.length}/${map.vehicleSpawns.length} rovers spawn intersecting geometry: ${stuck.join(', ')}`,
    );
  });

  test(`${id}: rover spawns are distinct and well separated`, () => {
    // Two rovers on the same point would render as one and fight over collision.
    const map = getMap(id);
    const tooClose = [];
    for (let i = 0; i < map.vehicleSpawns.length; i++) {
      for (let j = i + 1; j < map.vehicleSpawns.length; j++) {
        const a = map.vehicleSpawns[i].pos;
        const b = map.vehicleSpawns[j].pos;
        const d = Math.hypot(a[0] - b[0], a[2] - b[2]);
        if (d < VEHICLE_RADIUS * 2) tooClose.push(`#${i}/#${j} ${d.toFixed(1)}m apart`);
      }
    }
    assert.deepEqual(tooClose, [], `overlapping rover spawns: ${tooClose.join(', ')}`);
  });

  test(`${id}: rover spawns sit inside the map bounds`, () => {
    const map = getMap(id);
    // bounds is {min:[x,y,z], max:[x,y,z]} — not a half-extent triple.
    const { min, max } = map.bounds ?? {};
    if (!min || !max) return;
    for (const spawn of map.vehicleSpawns) {
      const [x, , z] = spawn.pos;
      assert.ok(
        x >= min[0] && x <= max[0] && z >= min[2] && z <= max[2],
        `rover #${spawn.index} at ${x},${z} is outside bounds ${JSON.stringify(map.bounds)}`,
      );
    }
  });
}
