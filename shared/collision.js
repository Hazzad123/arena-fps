// Collision and raycasting. Imported by BOTH the client (movement prediction,
// shooting) and the server (movement validation, line-of-sight checks) so the
// two can never disagree about the shape of the world.
//
// Everything here is plain arrays ([x, y, z]) and plain objects on purpose:
// this module must not import three.js, because the server runs it too.
//
// World representation: axis-aligned boxes only. That's what lets us skip a
// physics engine entirely — see the plan for the reasoning.

import { HEAD_ZONE_FROM_TOP, LEG_ZONE_FROM_BOTTOM, STEP_HEIGHT } from './constants.js';

const EPS = 1e-4;

// ---------------------------------------------------------------------------
// Box representation
//
// Maps are *authored* as { pos: centre, size: [w, h, d] } because that reads
// naturally ("a 2m crate at eye height over there"). Collision wants min/max,
// so we compile once at load and never convert again in the hot path.
// ---------------------------------------------------------------------------

export function compileBox(box) {
  const [cx, cy, cz] = box.pos;
  const [w, h, d] = box.size;
  return {
    min: [cx - w / 2, cy - h / 2, cz - d / 2],
    max: [cx + w / 2, cy + h / 2, cz + d / 2],
    color: box.color ?? 0x808080,
    tag: box.tag ?? null,
  };
}

export function compileBoxes(boxes) {
  return boxes.map(compileBox);
}

/** Convenience for authoring: a box resting ON a given y, not centred at it. */
export function slab(x, y, z, w, h, d, color, tag) {
  return { pos: [x, y + h / 2, z], size: [w, h, d], color, tag };
}

// ---------------------------------------------------------------------------
// Player volume
//
// `pos` is at the player's FEET (centre of the base), which makes spawn points
// and ground snapping read naturally. The movement volume is an AABB; hitboxes
// for shooting use a cylinder (see raycastPlayers) because an AABB hitbox makes
// players feel wider than they look when strafing.
// ---------------------------------------------------------------------------

function playerBounds(pos, height, radius) {
  return {
    min: [pos[0] - radius, pos[1], pos[2] - radius],
    max: [pos[0] + radius, pos[1] + height, pos[2] + radius],
  };
}

function overlaps(a, b) {
  return (
    a.min[0] < b.max[0] - EPS &&
    a.max[0] > b.min[0] + EPS &&
    a.min[1] < b.max[1] - EPS &&
    a.max[1] > b.min[1] + EPS &&
    a.min[2] < b.max[2] - EPS &&
    a.max[2] > b.min[2] + EPS
  );
}

export function playerOverlapsAny(pos, height, radius, boxes) {
  const b = playerBounds(pos, height, radius);
  for (const box of boxes) if (overlaps(b, box)) return true;
  return false;
}

/**
 * Cap horizontal velocity without touching jumps or falls.
 *
 * Projection-based air acceleration is intentionally responsive, but without a
 * final magnitude cap it can add speed sideways while a wall removes the inward
 * component. Repeating a sprint-jump into angled cover then ratchets the player
 * above the sprint limit.
 */
export function clampHorizontalSpeed(state, maxSpeed) {
  const speed = Math.hypot(state.vel[0], state.vel[2]);
  if (!Number.isFinite(maxSpeed) || maxSpeed < 0 || speed <= maxSpeed || speed < EPS) return;
  const scale = maxSpeed / speed;
  state.vel[0] *= scale;
  state.vel[2] *= scale;
}

// ---------------------------------------------------------------------------
// Movement
//
// Move-and-slide, one axis at a time, with substepping to prevent tunnelling.
// Axis order is Y, X, Z: resolving Y first establishes ground contact, which is
// what makes step-up work on the horizontal passes.
// ---------------------------------------------------------------------------

/**
 * Integrate a player's position against the world.
 *
 * Mutates and returns `state`:
 *   { pos: [x,y,z] feet, vel: [x,y,z], onGround: bool }
 *
 * Returns extra info about the move for callers that care (fall damage).
 */
export function moveAndCollide(state, dt, boxes, height, radius) {
  const dx = state.vel[0] * dt;
  const dy = state.vel[1] * dt;
  const dz = state.vel[2] * dt;

  // Never travel more than half a radius per substep or we can pass through
  // thin geometry entirely.
  const dist = Math.hypot(dx, dy, dz);
  const maxStep = Math.max(0.05, radius * 0.5);
  const steps = Math.min(16, Math.max(1, Math.ceil(dist / maxStep)));

  const sx = dx / steps;
  const sy = dy / steps;
  const sz = dz / steps;

  const wasFalling = state.vel[1];
  let landed = false;
  let hitCeiling = false;

  state.onGround = false;

  for (let i = 0; i < steps; i++) {
    // ---- vertical ----
    if (sy !== 0) {
      state.pos[1] += sy;
      const b = playerBounds(state.pos, height, radius);
      let snap = null;
      for (const box of boxes) {
        if (!overlaps(b, box)) continue;
        if (sy > 0) {
          const y = box.min[1] - height;
          if (snap === null || y < snap) snap = y;
        } else {
          const y = box.max[1];
          if (snap === null || y > snap) snap = y;
        }
      }
      if (snap !== null) {
        state.pos[1] = snap;
        state.vel[1] = 0;
        if (sy < 0) landed = true;
        else hitCeiling = true;
      }
    }

    // Ground test: probe a hair below the feet. Done every substep so that
    // step-up on the horizontal passes knows whether we're grounded.
    state.onGround = isGrounded(state.pos, height, radius, boxes);

    // ---- horizontal ----
    if (sx !== 0) moveHorizontal(state, 0, sx, boxes, height, radius);
    if (sz !== 0) moveHorizontal(state, 2, sz, boxes, height, radius);
  }

  state.onGround = isGrounded(state.pos, height, radius, boxes);
  if (state.onGround && state.vel[1] < 0) state.vel[1] = 0;

  return {
    landed: landed || state.onGround,
    hitCeiling,
    impactSpeed: landed ? Math.abs(wasFalling) : 0,
  };
}

function moveHorizontal(state, axis, amount, boxes, height, radius) {
  const before = state.pos[axis];
  state.pos[axis] += amount;

  const b = playerBounds(state.pos, height, radius);
  let snap = null;
  let highestTop = -Infinity;

  for (const box of boxes) {
    if (!overlaps(b, box)) continue;
    if (box.max[1] > highestTop) highestTop = box.max[1];
    if (amount > 0) {
      const v = box.min[axis] - radius;
      if (snap === null || v < snap) snap = v;
    } else {
      const v = box.max[axis] + radius;
      if (snap === null || v > snap) snap = v;
    }
  }

  if (snap === null) return; // clear path

  // Blocked. Try to step up onto it before giving up — this is what lets you
  // walk over kerbs and low crates without jumping.
  const rise = highestTop - state.pos[1];
  if (state.onGround && rise > EPS && rise <= STEP_HEIGHT) {
    const savedY = state.pos[1];
    state.pos[1] = highestTop + EPS;
    if (!playerOverlapsAny(state.pos, height, radius, boxes)) return; // stepped up
    state.pos[1] = savedY; // no headroom, fall through to the wall slide
  }

  state.pos[axis] = snap;
  state.vel[axis] = 0;

  // Guard against the snap shoving us backwards past where we started, which
  // can happen when two boxes disagree.
  if (amount > 0 && state.pos[axis] < before) state.pos[axis] = before;
  if (amount < 0 && state.pos[axis] > before) state.pos[axis] = before;
}

function isGrounded(pos, height, radius, boxes) {
  const probe = [pos[0], pos[1] - 0.06, pos[2]];
  const b = playerBounds(probe, height, radius);
  // Only count boxes whose top is at or just below our feet — otherwise a wall
  // we're brushing against would register as ground.
  for (const box of boxes) {
    if (!overlaps(b, box)) continue;
    if (box.max[1] <= pos[1] + STEP_HEIGHT) return true;
  }
  return false;
}

/**
 * Shove a player out of any geometry they're stuck inside, along the axis that
 * needs the least movement. Used after teleports and spawns.
 */
export function pushOutOfSolids(pos, height, radius, boxes, maxIterations = 8) {
  for (let iter = 0; iter < maxIterations; iter++) {
    const b = playerBounds(pos, height, radius);
    let worst = null;

    for (const box of boxes) {
      if (!overlaps(b, box)) continue;
      // Smallest translation that separates us on each axis.
      const candidates = [
        [0, box.min[0] - radius - pos[0]],
        [0, box.max[0] + radius - pos[0]],
        [1, box.min[1] - height - pos[1]],
        [1, box.max[1] - pos[1]],
        [2, box.min[2] - radius - pos[2]],
        [2, box.max[2] + radius - pos[2]],
      ];
      let best = candidates[0];
      for (const c of candidates) if (Math.abs(c[1]) < Math.abs(best[1])) best = c;
      if (worst === null || Math.abs(best[1]) > Math.abs(worst[1])) worst = best;
    }

    if (worst === null) return true; // free
    pos[worst[0]] += worst[1] + Math.sign(worst[1]) * EPS;
  }
  return !playerOverlapsAny(pos, height, radius, boxes);
}

// ---------------------------------------------------------------------------
// Raycasting
// ---------------------------------------------------------------------------

/**
 * Ray vs axis-aligned boxes, slab method. Returns the NEAREST hit:
 *   { t, box, normal: [x,y,z] }  or  null
 * `dir` must be normalised, so `t` is a distance in metres.
 */
export function raycastBoxes(origin, dir, boxes, maxDist = Infinity) {
  let bestT = maxDist;
  let bestBox = null;
  let bestAxis = -1;
  let bestSign = 0;

  for (const box of boxes) {
    let tmin = 0;
    let tmax = bestT;
    let axis = -1;
    let sign = 0;
    let miss = false;

    for (let a = 0; a < 3; a++) {
      if (Math.abs(dir[a]) < EPS) {
        // Parallel to this slab: either always inside it or never.
        if (origin[a] < box.min[a] || origin[a] > box.max[a]) {
          miss = true;
          break;
        }
        continue;
      }
      const inv = 1 / dir[a];
      let t1 = (box.min[a] - origin[a]) * inv;
      let t2 = (box.max[a] - origin[a]) * inv;
      let s = -1;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
        s = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        axis = a;
        sign = s;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) {
        miss = true;
        break;
      }
    }

    if (miss || tmin >= bestT || tmin < 0) continue;
    bestT = tmin;
    bestBox = box;
    bestAxis = axis;
    bestSign = sign;
  }

  if (!bestBox) return null;

  const normal = [0, 0, 0];
  // axis === -1 means the origin was already inside the box.
  if (bestAxis >= 0) normal[bestAxis] = bestSign;
  return { t: bestT, box: bestBox, normal };
}

/**
 * Ray vs player capsules, treated as vertical cylinders with flat caps.
 * A cylinder is used rather than an AABB so that hitboxes don't feel wider
 * than the model when a target is strafing.
 *
 * players: [{ id, pos: [x,y,z] feet, height, radius }]
 * Returns nearest: { t, player, point: [x,y,z], zone: 'head'|'body'|'legs' }
 */
export function raycastPlayers(origin, dir, players, maxDist = Infinity, ignoreId = null) {
  let best = null;

  for (const p of players) {
    if (p.id === ignoreId) continue;
    const t = intersectCylinder(origin, dir, p.pos, p.radius, p.height, maxDist);
    if (t === null) continue;
    if (best && t >= best.t) continue;

    const point = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
    best = { t, player: p, point, zone: hitZone(point[1] - p.pos[1], p.height) };
  }

  return best;
}

function intersectCylinder(origin, dir, base, radius, height, maxDist) {
  const yLo = base[1];
  const yHi = base[1] + height;

  const ox = origin[0] - base[0];
  const oz = origin[2] - base[2];

  const a = dir[0] * dir[0] + dir[2] * dir[2];
  let nearest = null;

  const consider = (t) => {
    if (t === null || t < 0 || t > maxDist) return;
    if (nearest === null || t < nearest) nearest = t;
  };

  if (a < EPS) {
    // Ray is (near enough) vertical: only the caps can be hit.
    if (ox * ox + oz * oz <= radius * radius && Math.abs(dir[1]) > EPS) {
      consider((yLo - origin[1]) / dir[1]);
      consider((yHi - origin[1]) / dir[1]);
    }
    return nearest;
  }

  const b = 2 * (ox * dir[0] + oz * dir[2]);
  const c = ox * ox + oz * oz - radius * radius;
  const disc = b * b - 4 * a * c;

  if (disc >= 0) {
    const root = Math.sqrt(disc);
    for (const t of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
      if (t < 0 || t > maxDist) continue;
      const y = origin[1] + dir[1] * t;
      if (y >= yLo && y <= yHi) consider(t);
    }
  }

  // Caps, for shots that come in steeply from above or below.
  if (Math.abs(dir[1]) > EPS) {
    for (const capY of [yLo, yHi]) {
      const t = (capY - origin[1]) / dir[1];
      if (t < 0 || t > maxDist) continue;
      const hx = ox + dir[0] * t;
      const hz = oz + dir[2] * t;
      if (hx * hx + hz * hz <= radius * radius) consider(t);
    }
  }

  return nearest;
}

function hitZone(yFromFeet, height) {
  if (yFromFeet >= height - HEAD_ZONE_FROM_TOP) return 'head';
  if (yFromFeet <= LEG_ZONE_FROM_BOTTOM) return 'legs';
  return 'body';
}

/**
 * Is there a clear line between two points? Used server-side to sanity-check
 * client-reported hits — the shooter says they hit someone, and this confirms
 * a wall wasn't in the way.
 */
export function hasLineOfSight(from, to, boxes, tolerance = 0) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const dist = Math.hypot(dx, dy, dz);
  if (dist < EPS) return true;

  const dir = [dx / dist, dy / dist, dz / dist];
  const hit = raycastBoxes(from, dir, boxes, dist);
  if (!hit) return true;
  // `tolerance` forgives shots taken while peeking a corner, where the client's
  // camera has clearance the server's sample point doesn't.
  return hit.t >= dist - tolerance;
}
