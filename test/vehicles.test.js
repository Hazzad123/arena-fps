import test from 'node:test';
import assert from 'node:assert/strict';

import { raycastVehicle, VEHICLE_HITBOX } from '../shared/vehicles.js';

test('vehicle raycast hits a rover from the front at the correct distance', () => {
  const t = raycastVehicle(
    [0, 0.75, 8],
    [0, 0, -1],
    [0, 0, 0],
    0,
    20,
  );
  assert.ok(t !== null);
  assert.ok(Math.abs(t - (8 - VEHICLE_HITBOX.max[2])) < 1e-6);
});

test('vehicle raycast follows the rover rotation', () => {
  // Rotated 90 degrees, the long axis lies along world X.
  const t = raycastVehicle(
    [8, 0.75, 0],
    [-1, 0, 0],
    [0, 0, 0],
    Math.PI / 2,
    20,
  );
  assert.ok(t !== null);
  assert.ok(Math.abs(t - (8 - VEHICLE_HITBOX.max[2])) < 1e-6);
});

test('vehicle raycast misses above the roof and beyond its range', () => {
  assert.equal(raycastVehicle([0, 3, 8], [0, 0, -1], [0, 0, 0], 0, 20), null);
  assert.equal(raycastVehicle([0, 0.75, 8], [0, 0, -1], [0, 0, 0], 0, 4), null);
});
