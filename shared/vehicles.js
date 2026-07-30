// Shared rover hit geometry. Vehicles rotate, while map collision is axis-aligned,
// so shots are transformed into rover-local space and tested against one compact
// box. Keeping this shared means the client prediction and server authority agree.

export const VEHICLE_HITBOX = Object.freeze({
  min: [-1.15, 0.04, -1.7],
  max: [1.15, 1.42, 1.7],
});

/**
 * Raycast one rover's oriented hitbox.
 *
 * `pos` is the bottom-centre transform used by the rendered rover. Returns the
 * distance along a normalised ray, or null when it misses.
 */
export function raycastVehicle(origin, direction, pos, yaw, maxDistance = Infinity) {
  if (!Array.isArray(origin) || !Array.isArray(direction) || !Array.isArray(pos)) return null;
  if (![...origin, ...direction, ...pos, yaw].every(Number.isFinite)) return null;
  if (!Number.isFinite(maxDistance) && maxDistance !== Infinity) return null;

  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const dx = origin[0] - pos[0];
  const dz = origin[2] - pos[2];

  // Inverse of a Y rotation: world-space ray -> rover-local ray.
  const localOrigin = [
    dx * c - dz * s,
    origin[1] - pos[1],
    dx * s + dz * c,
  ];
  const localDirection = [
    direction[0] * c - direction[2] * s,
    direction[1],
    direction[0] * s + direction[2] * c,
  ];

  let near = 0;
  let far = maxDistance;
  for (let axis = 0; axis < 3; axis++) {
    const component = localDirection[axis];
    if (Math.abs(component) < 1e-9) {
      if (localOrigin[axis] < VEHICLE_HITBOX.min[axis]
          || localOrigin[axis] > VEHICLE_HITBOX.max[axis]) return null;
      continue;
    }

    let a = (VEHICLE_HITBOX.min[axis] - localOrigin[axis]) / component;
    let b = (VEHICLE_HITBOX.max[axis] - localOrigin[axis]) / component;
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a);
    far = Math.min(far, b);
    if (near > far) return null;
  }
  return near <= maxDistance && far >= 0 ? Math.max(0, near) : null;
}
