// ISLAND — the battle royale map.
//
// 260m square, which is roughly twenty times the area of Warehouse. Hand-placing
// that much cover would be days of work and would read as a corridor shooter
// stretched out, so it's generated from a deterministic grid of districts: each
// cell picks a layout from a small set and fills itself, seeded off its own
// coordinates. Same map every time, no data file, and adding a district type adds
// variety everywhere at once.
//
// The design constraints that matter for battle royale specifically:
//   - No enclosing roof. The zone shrinks toward the middle and you need to be
//     able to see it closing from anywhere.
//   - Buildings are walk-in, not solid blocks: loot goes inside them, so there
//     has to be an inside.
//   - Sightlines break every ~30m. A 260m map with clear lines is a sniper's
//     shooting gallery and nobody else's game.

import { box, crateStack, prop, barrel, stairs } from './helpers.js';
import { compileBoxes, playerOverlapsAny } from '../collision.js';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../constants.js';

const C = {
  ground: 0x6f7a5c,
  road: 0x585b56,
  wall: 0xa89a80,
  wallAlt: 0x92876f,
  roof: 0x7a6a55,
  concrete: 0x8e8e88,
  metal: 0x5b6068,
  wood: 0x6d5237,
  crate: 0xb28c54,
  fence: 0x6b6252,
  water: 0x3f5f6b,
};

const HALF = 130; // 260m across
const CELL = 52; // district size; 5x5 grid
const GRID = 5;

/**
 * Deterministic pseudo-random from integer coordinates. Same island every match,
 * which matters more than variety here: players learn where the loot is, and a map
 * that reshuffles every round can't be learned.
 */
function rand(ix, iz, salt = 0) {
  let h = (ix * 374761393 + iz * 668265263 + salt * 1442695040888963407) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * A walk-in building: four walls with a doorway, and a roof you can stand on.
 *
 * `doorSide` is one of 'n' | 's' | 'e' | 'w'. It used to accept 'z-'/'x+' style
 * names while the wall builder compared against 'n'/'s'/'e'/'w', so the doorway
 * condition never once matched and every building on the island was sealed shut —
 * with loot inside. The map reachability test is what caught it.
 */
const SIDES = ['n', 's', 'e', 'w'];

function building({ x, z, w, d, h, color, doorSide = 's', roofColor }) {
  const out = [];
  const t = 0.6;
  const doorW = 3.2;

  // Walls, each split around a doorway on the chosen side.
  const wall = (side) => {
    const along = side === 'n' || side === 's' ? w : d;
    const hasDoor = doorSide === side;
    const segs = hasDoor
      ? [[-along / 2, -doorW / 2], [doorW / 2, along / 2]]
      : [[-along / 2, along / 2]];

    for (const [a, b] of segs) {
      const len = b - a;
      if (len <= 0.05) continue;
      const mid = (a + b) / 2;
      if (side === 'n') out.push(box(x + mid, 0, z + d / 2 - t / 2, len, h, t, color));
      if (side === 's') out.push(box(x + mid, 0, z - d / 2 + t / 2, len, h, t, color));
      if (side === 'e') out.push(box(x + w / 2 - t / 2, 0, z + mid, t, h, len, color));
      if (side === 'w') out.push(box(x - w / 2 + t / 2, 0, z + mid, t, h, len, color));
    }
  };
  for (const side of ['n', 's', 'e', 'w']) wall(side);

  // Roof. Standable, and reachable from an outside staircase.
  out.push(box(x, h, z, w, 0.5, d, roofColor ?? C.roof));
  return out;
}

/** Outside stairs onto a building's roof, so height is earned rather than given. */
function roofStairs({ x, z, h, side = 'e', color = C.concrete }) {
  const run = Math.max(3, h * 2.4);
  if (side === 'e') {
    return stairs({ x: x + run, y: 0, z, width: 3, rise: h + 0.5, run, axis: 'x', dir: -1, color });
  }
  return stairs({ x: x - run, y: 0, z, width: 3, rise: h + 0.5, run, axis: 'x', dir: 1, color });
}

// ---------------------------------------------------------------- districts

function districtTown(cx, cz, r) {
  const out = [];
  const layout = [
    [-14, -13, 15, 12, 5.5],
    [13, -12, 14, 11, 4.5],
    [-12, 14, 13, 12, 7.0],
    [15, 15, 12, 12, 4.0],
  ];
  for (const [dx, dz, w, d, h] of layout) {
    out.push(...building({
      x: cx + dx,
      z: cz + dz,
      w,
      d,
      h,
      color: r(1) > 0.5 ? C.wall : C.wallAlt,
      doorSide: SIDES[Math.floor(r(2) * SIDES.length)],
    }));
    if (r(3) > 0.45) out.push(...roofStairs({ x: cx + dx, z: cz + dz, h, side: r(4) > 0.5 ? 'e' : 'w' }));
  }
  // A crossroads through the middle of the block.
  out.push(box(cx, -0.9, cz, CELL, 0.2, 7, C.road));
  out.push(box(cx, -0.9, cz, 7, 0.2, CELL, C.road));
  return out;
}

function districtWarehouses(cx, cz, r) {
  const out = [];
  out.push(...building({ x: cx, z: cz, w: 30, d: 22, h: 8, color: C.concrete, doorSide: 's' }));
  out.push(...roofStairs({ x: cx, z: cz, h: 8, side: 'e' }));
  // Loading yard: crates and containers outside the big shed.
  for (let i = 0; i < 5; i++) {
    const ang = r(10 + i) * Math.PI * 2;
    const rad = 15 + r(20 + i) * 8;
    out.push(...crateStack({
      x: cx + Math.cos(ang) * rad,
      z: cz + Math.sin(ang) * rad,
      size: 1.8,
      height: 1 + Math.floor(r(30 + i) * 2),
      color: C.crate,
      seed: i + 1,
    }));
  }
  out.push(prop(cx - 18, 0, cz + 12, 2.44, 2.0, 1.3, C.metal, 'TrashContainer'));
  out.push(barrel(cx + 16, 0, cz - 14));
  out.push(barrel(cx + 17.2, 0, cz - 14.8));
  return out;
}

function districtFields(cx, cz, r) {
  const out = [];
  // Mostly open, broken by hedgerows and a barn. Somebody has to cross this.
  for (let i = 0; i < 4; i++) {
    const alongX = r(40 + i) > 0.5;
    const px = cx + (r(50 + i) - 0.5) * (CELL - 12);
    const pz = cz + (r(60 + i) - 0.5) * (CELL - 12);
    const len = 10 + r(70 + i) * 14;
    out.push(alongX
      ? box(px, 0, pz, len, 1.6, 0.8, C.fence)
      : box(px, 0, pz, 0.8, 1.6, len, C.fence));
  }
  out.push(...building({ x: cx + 8, z: cz - 8, w: 14, d: 10, h: 6, color: C.wood, doorSide: 'w' }));
  out.push(...crateStack({ x: cx - 12, z: cz + 10, size: 1.6, height: 2, color: C.crate, seed: 7 }));
  return out;
}

function districtIndustrial(cx, cz, r) {
  const out = [];
  out.push(...building({ x: cx - 10, z: cz, w: 18, d: 16, h: 9, color: C.metal, doorSide: 'e' }));
  out.push(...roofStairs({ x: cx - 10, z: cz, h: 9, side: 'w' }));
  // Silos: tall, solid, and good cover you cannot shoot through.
  for (let i = 0; i < 3; i++) {
    out.push(box(cx + 12, 0, cz - 12 + i * 11, 5, 11 + r(80 + i) * 4, 5, C.concrete));
  }
  out.push(prop(cx + 2, 0, cz + 16, 0.96, 4.2, 1.0, C.metal, 'Pipes'));
  out.push(barrel(cx - 2, 0, cz - 16));
  return out;
}

function districtRuins(cx, cz, r) {
  const out = [];
  // Broken walls: cover everywhere, roofs nowhere.
  for (let i = 0; i < 9; i++) {
    const px = cx + (r(90 + i) - 0.5) * (CELL - 10);
    const pz = cz + (r(100 + i) - 0.5) * (CELL - 10);
    const len = 5 + r(110 + i) * 10;
    const h = 1.6 + r(120 + i) * 2.6;
    out.push(r(130 + i) > 0.5
      ? box(px, 0, pz, len, h, 0.7, C.wallAlt)
      : box(px, 0, pz, 0.7, h, len, C.wallAlt));
  }
  out.push(...crateStack({ x: cx, z: cz, size: 1.7, height: 2, color: C.crate, seed: 11 }));
  return out;
}

const DISTRICTS = [districtTown, districtWarehouses, districtFields, districtIndustrial, districtRuins];

function build() {
  const b = [];

  // Ground and a sea wall — the island edge. No roof anywhere: the zone comes
  // from above and you need to be able to see it.
  b.push(box(0, -1, 0, HALF * 2 + 20, 1, HALF * 2 + 20, C.ground));
  const t = 4;
  for (const [dx, dz, w, d] of [
    [0, -HALF - t / 2, HALF * 2 + t * 2, t],
    [0, HALF + t / 2, HALF * 2 + t * 2, t],
    [-HALF - t / 2, 0, t, HALF * 2 + t * 2],
    [HALF + t / 2, 0, t, HALF * 2 + t * 2],
  ]) b.push(box(dx, -1, dz, w, 9, d, C.concrete));

  // Districts.
  const half = (GRID - 1) / 2;
  for (let gx = 0; gx < GRID; gx++) {
    for (let gz = 0; gz < GRID; gz++) {
      const cx = (gx - half) * CELL;
      const cz = (gz - half) * CELL;
      const r = (salt) => rand(gx + 1, gz + 1, salt);
      // The centre cell is always a town: the zone ends there, so the last fight
      // should happen somewhere with cover and rooftops rather than in a field.
      const pick = gx === half && gz === half
        ? districtTown
        : DISTRICTS[Math.floor(r(0) * DISTRICTS.length)];
      b.push(...pick(cx, cz, r));
    }
  }

  return b;
}

/**
 * Thirty spawns around the shoreline, each walked inward until it's clear of
 * geometry.
 *
 * Computed rather than hand-placed because the districts are generated: a fixed
 * ring drops people inside buildings and silos, and the map tests correctly
 * refused it. Searching outward-in keeps everyone near the coast while
 * guaranteeing they can actually stand where they land.
 */
function ringSpawns(boxes, count, startRadius, fromAngle = 0, toAngle = Math.PI * 2) {
  const solids = compileBoxes(boxes);
  const out = [];

  for (let i = 0; i < count; i++) {
    // Spread across the arc. A full ring closes the loop, so the last point sits
    // one step short of the first rather than on top of it.
    const span = toAngle - fromAngle;
    const full = Math.abs(span - Math.PI * 2) < 1e-6;
    const t = full ? i / count : (count === 1 ? 0.5 : i / (count - 1));
    const a = fromAngle + span * t;
    let placed = null;
    for (let r = startRadius; r >= 45; r -= 2) {
      const p = [Math.cos(a) * r, 0, Math.sin(a) * r];
      if (!playerOverlapsAny(p, PLAYER_HEIGHT, PLAYER_RADIUS, solids)) {
        placed = p;
        break;
      }
    }
    // Every angle finds something well before 45m on a map this open, but fall
    // back to the centre rather than emitting a spawn inside a wall.
    out.push(placed ?? [0, 0, 0]);
  }
  return out;
}

/**
 * Loot spawn points. Ground loot is placed by the server from these; each one
 * gets a random gun of a random tier, so the same island plays differently.
 */
function lootPoints() {
  const out = [];
  const half = (GRID - 1) / 2;
  for (let gx = 0; gx < GRID; gx++) {
    for (let gz = 0; gz < GRID; gz++) {
      const cx = (gx - half) * CELL;
      const cz = (gz - half) * CELL;
      const r = (salt) => rand(gx + 1, gz + 1, 500 + salt);
      // Six per district, scattered but never right on the edge where they'd end
      // up inside a sea wall.
      for (let i = 0; i < 6; i++) {
        out.push([
          cx + (r(i * 3) - 0.5) * (CELL - 14),
          0,
          cz + (r(i * 3 + 1) - 0.5) * (CELL - 14),
        ]);
      }
    }
  }
  return out;
}

const BOXES = build();

export default {
  id: 'island',
  name: 'The Island',
  blurb: '260m across. Land with a pistol, find something better.',
  battleRoyale: true,
  skyColor: 0x9fc0d8,
  fogColor: 0xb5cadb,
  fogDensity: 0.0035,
  ambientLight: 0.85,
  sunDirection: [0.4, 0.85, 0.35],
  sunIntensity: 1.1,
  groundTexture: 'concrete',
  wallTexture: 'blockwork',
  bounds: { min: [-HALF - 12, -12, -HALF - 12], max: [HALF + 12, 40, HALF + 12] },
  boxes: BOXES,
  // No health packs: in battle royale you heal by looting, not by standing on a
  // cross that respawns every twenty seconds.
  healthPacks: [],
  lootPoints: lootPoints(),
  spawns: {
    // Everyone starts on the shoreline and walks in.
    ffa: ringSpawns(BOXES, 30, HALF - 14),
    // Battle royale has no teams, but the map tests check that A and B are far
    // apart, and they're right to: if anyone ever plays TDM here the two sides
    // should start on opposite shores, not four metres apart.
    // Opposite shores, with a gap either side of the seam so the nearest pair
    // from opposing teams is most of the island apart. Rotating a full ring by
    // half a turn does NOT work: ten evenly spaced points map onto themselves,
    // which put every A spawn exactly on a B spawn.
    A: ringSpawns(BOXES, 10, HALF - 14, Math.PI * 0.12, Math.PI * 0.88),
    B: ringSpawns(BOXES, 10, HALF - 14, Math.PI * 1.12, Math.PI * 1.88),
  },
};
