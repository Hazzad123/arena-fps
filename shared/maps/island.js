// ISLAND — the battle royale map.
//
// 540m square, roughly eighty times the area of Warehouse. The first version
// filled that space by stamping five district templates across a 9x9 grid. It was
// technically large but visually read like the same block copied eighty times.
//
// This version is a deliberately authored island: large, named landmarks occupy
// each part of the map, with roads, wilderness and smaller roadside locations
// connecting them. The geometry is still code-native and deterministic, but a
// player can now navigate by silhouette instead of by grid coordinate.
//
// The design constraints that matter for battle royale specifically:
//   - No enclosing roof. The zone shrinks toward the middle and you need to be
//     able to see it closing from anywhere.
//   - Buildings are walk-in, not solid blocks: loot goes inside them, so there
//     has to be an inside.
//   - Sightlines break every ~30m. A 540m map with clear lines is a sniper's
//     shooting gallery and nobody else's game.

import { box, crateStack, prop, barrel, stairs } from './helpers.js';
import { compileBoxes, playerOverlapsAny } from '../collision.js';
import { VEHICLE_HITBOX } from '../vehicles.js';
import { BR_MAX_PLAYERS, PLAYER_HEIGHT, PLAYER_RADIUS } from '../constants.js';

const C = {
  ground: 0x6f7a5c,
  grassDark: 0x465a3e,
  grassLight: 0x81905c,
  soil: 0x786044,
  road: 0x585b56,
  runway: 0x3f4448,
  wall: 0xa89a80,
  wallAlt: 0x92876f,
  brick: 0x8d5f4e,
  military: 0x69705c,
  roof: 0x7a6a55,
  concrete: 0x8e8e88,
  concreteDark: 0x6d716f,
  stone: 0x77766d,
  metal: 0x5b6068,
  rust: 0x875a3e,
  wood: 0x6d5237,
  crate: 0xb28c54,
  fence: 0x6b6252,
  water: 0x3f5f6b,
  tree: 0x344b2e,
  trunk: 0x59432c,
  stripe: 0xd7d2b8,
};

// Rendering-only material hints. Collision and gameplay still see ordinary
// boxes; the client uses this palette map to give large walls, roofs and floors
// the material they visually represent instead of painting every landmark with
// the same concrete tile.
const MATERIAL_TEXTURES = {
  [C.ground]: 'grass',
  [C.grassDark]: 'grass',
  [C.grassLight]: 'grass',
  [C.soil]: 'dirt',
  [C.road]: 'asphalt',
  [C.runway]: 'asphalt',
  [C.wall]: 'plaster',
  [C.wallAlt]: 'stone',
  [C.brick]: 'sbsbrick',
  [C.military]: 'metal',
  [C.roof]: 'roof',
  [C.concrete]: 'plaster',
  [C.concreteDark]: 'plaster',
  [C.stone]: 'stone',
  [C.metal]: 'metal',
  [C.rust]: 'metal',
  [C.wood]: 'wood',
  [C.crate]: 'wood',
  [C.fence]: 'wood',
  [C.water]: 'water',
  [C.tree]: 'grass',
  [C.trunk]: 'wood',
  [C.stripe]: 'plaster',
};

const HALF = 270; // 540m across
const CELL = 60;
const GRID = 9; // 81 districts: enough space for genuinely separate landings

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

function building({
  x, z, w, d, h, color, doorSide = 's', doorSides, doorW = 3.2,
  roofColor, roof = true, y = 0,
}) {
  const out = [];
  const t = 0.6;
  const entrances = doorSides ?? [doorSide];

  // Walls, each split around a doorway on the chosen side.
  const wall = (side) => {
    const along = side === 'n' || side === 's' ? w : d;
    const hasDoor = entrances.includes(side);
    const segs = hasDoor
      ? [[-along / 2, -doorW / 2], [doorW / 2, along / 2]]
      : [[-along / 2, along / 2]];

    for (const [a, b] of segs) {
      const len = b - a;
      if (len <= 0.05) continue;
      const mid = (a + b) / 2;
      if (side === 'n') out.push(box(x + mid, y, z + d / 2 - t / 2, len, h, t, color));
      if (side === 's') out.push(box(x + mid, y, z - d / 2 + t / 2, len, h, t, color));
      if (side === 'e') out.push(box(x + w / 2 - t / 2, y, z + mid, t, h, len, color));
      if (side === 'w') out.push(box(x - w / 2 + t / 2, y, z + mid, t, h, len, color));
    }
  };
  for (const side of ['n', 's', 'e', 'w']) wall(side);

  if (roof) out.push(box(x, y + h, z, w, 0.5, d, roofColor ?? C.roof));
  return out;
}

/** Outside stairs onto a building's roof, so height is earned rather than given. */
function roofStairs({ x, z, w, h, side = 'e', color = C.concrete, y = 0 }) {
  const run = Math.max(3, h * 2.4);
  if (side === 'e') {
    return stairs({
      x: x + w / 2 + run, y, z, width: 3, rise: h + 0.5, run, axis: 'x', dir: -1, color,
    });
  }
  return stairs({
    x: x - w / 2 - run, y, z, width: 3, rise: h + 0.5, run, axis: 'x', dir: 1, color,
  });
}

/** A collision-flush coloured patch; layer is used only to stack its rendered mesh. */
function surface(x, z, w, d, color, texture = null, layer = 1) {
  const material = texture ?? MATERIAL_TEXTURES[color] ?? 'plaster';
  return box(x, -0.08, z, w, 0.08, d, color, `surface:${material}:${layer}`);
}

/** Perimeter walls with real openings rather than a sealed decorative compound. */
function compound({ x, z, w, d, h = 3, color, gates = ['n', 's'], gateW = 8 }) {
  const out = [];
  const t = 0.8;
  const addLine = (side, length, fixed, horizontal) => {
    const hasGate = gates.includes(side);
    const pieces = hasGate
      ? [[-length / 2, -gateW / 2], [gateW / 2, length / 2]]
      : [[-length / 2, length / 2]];
    for (const [a, b] of pieces) {
      const mid = (a + b) / 2;
      const len = b - a;
      out.push(horizontal
        ? box(x + mid, 0, fixed, len, h, t, color)
        : box(fixed, 0, z + mid, t, h, len, color));
    }
  };
  addLine('n', w, z + d / 2, true);
  addLine('s', w, z - d / 2, true);
  addLine('e', d, x + w / 2, false);
  addLine('w', d, x - w / 2, false);
  return out;
}

function watchtower(x, z, facing = 's') {
  const out = [];
  const top = 5.5;
  const size = 6;
  for (const dx of [-2.2, 2.2]) {
    for (const dz of [-2.2, 2.2]) out.push(box(x + dx, 0, z + dz, 0.65, top, 0.65, C.metal));
  }
  out.push(box(x, top, z, size, 0.5, size, C.concreteDark));
  // Waist-high rails keep the top useful without becoming a perfect fortress.
  out.push(box(x, top + 0.5, z - size / 2, size, 1.1, 0.35, C.metal));
  out.push(box(x, top + 0.5, z + size / 2, size, 1.1, 0.35, C.metal));
  out.push(box(x - size / 2, top + 0.5, z, 0.35, 1.1, size, C.metal));
  out.push(box(x + size / 2, top + 0.5, z, 0.35, 1.1, size, C.metal));
  const run = 14;
  const north = facing === 'n';
  out.push(...stairs({
    x,
    y: 0,
    z: z + (north ? size / 2 + run : -size / 2 - run),
    width: 2.3,
    rise: top + 0.5,
    run,
    axis: 'z',
    dir: north ? -1 : 1,
    color: C.concrete,
  }));
  return out;
}

function tree(x, z, scale = 1) {
  return [
    box(x, 0, z, 0.8 * scale, 4.2 * scale, 0.8 * scale, C.trunk),
    box(x, 3.7 * scale, z, 4.8 * scale, 2.4 * scale, 4.8 * scale, C.tree),
    box(x - 0.7 * scale, 5.3 * scale, z + 0.5 * scale, 3.2 * scale, 1.8 * scale, 3.2 * scale, C.grassDark),
  ];
}

function rocks(x, z, seed, count = 5) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = rand(seed, i, 31) * Math.PI * 2;
    const r = 2 + rand(seed, i, 32) * 7;
    const w = 1.4 + rand(seed, i, 33) * 2.8;
    const d = 1.4 + rand(seed, i, 34) * 2.8;
    const h = 0.9 + rand(seed, i, 35) * 2.6;
    out.push(box(x + Math.cos(a) * r, 0, z + Math.sin(a) * r, w, h, d, C.stone));
  }
  return out;
}

function crane(x, z) {
  return [
    box(x - 5, 0, z, 1, 9, 1, C.rust),
    box(x + 5, 0, z, 1, 9, 1, C.rust),
    box(x, 8.5, z, 12, 0.8, 1, C.rust),
    box(x + 2, 8.5, z, 0.35, 4.5, 0.35, C.metal),
  ];
}

// ---------------------------------------------------------------- named areas

function crownCitadel() {
  const out = [surface(0, 0, 84, 84, C.stone, 'cobbles')];
  out.push(...compound({ x: 0, z: 0, w: 74, d: 74, h: 4.5, color: C.wallAlt, gates: SIDES, gateW: 10 }));

  const towers = [
    [-29, -29, 'e'],
    [29, -29, 'w'],
    [-29, 29, 'e'],
    [29, 29, 'w'],
  ];
  for (const [x, z, side] of towers) {
    out.push(...building({ x, z, w: 12, d: 12, h: 7, color: C.stone, doorSide: side }));
  }
  // Two reachable roofs create strong but contestable high ground.
  out.push(...roofStairs({ x: -29, z: 29, w: 12, h: 7, side: 'w' }));
  out.push(...roofStairs({ x: 29, z: -29, w: 12, h: 7, side: 'e' }));

  out.push(...building({
    x: 0, z: 0, w: 27, d: 22, h: 9, color: C.brick, doorSides: ['n', 's'], doorW: 5,
  }));
  out.push(...roofStairs({ x: 0, z: 0, w: 27, h: 9, side: 'e', color: C.stone }));
  out.push(...crateStack({ x: -16, z: 7, height: 2, color: C.crate, seed: 101 }));
  out.push(...crateStack({ x: 17, z: -8, height: 2, color: C.crate, seed: 102 }));
  return out;
}

function blackwaterDocks() {
  const out = [
    surface(-214, 0, 92, 126, C.concreteDark, 'pavers'),
    surface(-255, 0, 10, 126, C.water, 'water', 2),
  ];

  out.push(...building({
    x: -210, z: -34, w: 34, d: 24, h: 8, color: C.metal,
    doorSides: ['n', 's'], doorW: 8,
  }));
  out.push(...roofStairs({ x: -210, z: -34, w: 34, h: 8, side: 'e' }));
  out.push(...building({
    x: -218, z: 39, w: 27, d: 19, h: 6, color: C.rust, doorSide: 'e', doorW: 6,
  }));

  // Container lanes form short, readable fights rather than a maze.
  for (const [x, z, alongX, file] of [
    [-237, -7, false, 'Container_Long'],
    [-226, -7, false, 'Container_Long'],
    [-214, 4, true, 'Container_Long'],
    [-236, 21, true, 'Container_Long'],
    [-197, 17, false, 'Container_Long'],
    [-194, -3, false, 'Container_Small'],
  ]) {
    out.push(prop(x, 0, z, alongX ? 6.2 : 2.5, 2.5, alongX ? 2.5 : 6.2, C.metal, file));
  }
  out.push(...crane(-244, -41));
  out.push(...crane(-244, 38));
  out.push(prop(-191, 0, 51, 2.44, 2, 1.3, C.metal, 'TrashContainer'));
  out.push(barrel(-203, 0, 17), barrel(-205, 0, 18));
  return out;
}

function slateQuarry() {
  const out = [surface(-176, -176, 98, 98, C.stone, 'dirt')];
  // Terraced square cuts, each broken at a different side. They read as a pit
  // while keeping the whole quarry traversable with ordinary movement.
  out.push(...compound({
    x: -176, z: -176, w: 84, d: 84, h: 1.6, color: C.stone, gates: ['s', 'e'], gateW: 16,
  }));
  out.push(...compound({
    x: -176, z: -176, w: 57, d: 57, h: 2.7, color: C.concreteDark, gates: ['n', 'w'], gateW: 13,
  }));
  out.push(...compound({
    x: -176, z: -176, w: 31, d: 31, h: 3.8, color: C.wallAlt, gates: ['s'], gateW: 9,
  }));
  out.push(...rocks(-209, -149, 201, 7));
  out.push(...rocks(-144, -205, 202, 6));
  out.push(...rocks(-175, -176, 203, 4));

  // Crusher platform: the quarry's single piece of earned high ground.
  out.push(box(-142, 4.5, -151, 16, 0.6, 11, C.rust));
  out.push(box(-148, 0, -155, 0.8, 4.5, 0.8, C.metal));
  out.push(box(-136, 0, -155, 0.8, 4.5, 0.8, C.metal));
  out.push(...stairs({
    x: -142, y: 0, z: -164, width: 3, rise: 5.1, run: 13, axis: 'z', dir: 1, color: C.concrete,
  }));
  return out;
}

function northwatchBase() {
  const out = [surface(0, -194, 118, 74, C.military, 'pavers')];
  out.push(...compound({
    x: 0, z: -194, w: 110, d: 68, h: 3.2, color: C.military, gates: ['s', 'e'], gateW: 12,
  }));
  out.push(...building({
    x: -26, z: -198, w: 29, d: 18, h: 4, color: C.concreteDark,
    doorSides: ['s', 'e'], doorW: 6,
  }));
  out.push(...building({
    x: 20, z: -210, w: 24, d: 15, h: 5, color: C.military, doorSide: 's', doorW: 5,
  }));
  out.push(...watchtower(-45, -218, 's'));
  out.push(...watchtower(45, -170, 'n'));

  // Above-ground trench lines provide low cover and deliberately kink.
  for (const [x, z, w, d] of [
    [-9, -177, 28, 0.8],
    [5, -184, 0.8, 14],
    [25, -184, 26, 0.8],
    [34, -192, 0.8, 16],
    [-8, -218, 34, 0.8],
  ]) out.push(box(x, 0, z, w, 1.25, d, C.fence));
  out.push(prop(2, 0, -201, 3.35, 1.28, 0.92, C.military, 'SackTrench'));
  out.push(barrel(35, 0, -212), barrel(37, 0, -212));
  return out;
}

function meridianPower() {
  const out = [surface(176, -176, 102, 102, C.concreteDark, 'asphalt')];
  out.push(...compound({
    x: 176, z: -176, w: 96, d: 96, h: 2.4, color: C.metal, gates: ['w', 's'], gateW: 13,
  }));
  out.push(...building({
    x: 151, z: -187, w: 28, d: 20, h: 8, color: C.metal, doorSide: 'e', doorW: 6,
  }));
  out.push(...roofStairs({ x: 151, z: -187, w: 28, h: 8, side: 'w' }));

  // Stepped reactor stacks are unique silhouettes visible from across the island.
  for (const [x, z] of [[190, -199], [211, -180], [188, -158]]) {
    out.push(box(x, 0, z, 10, 3, 10, C.concrete));
    out.push(box(x, 3, z, 8, 4, 8, C.concreteDark));
    out.push(box(x, 7, z, 6, 8, 6, C.metal));
  }
  // Transformer banks: low parallel cover with shooting lanes between.
  for (let i = 0; i < 5; i++) {
    out.push(box(144 + i * 13, 0, -145, 8, 2.2, 3.5, i % 2 ? C.rust : C.metal));
  }
  out.push(prop(169, 0, -170, 0.96, 4.2, 1, C.metal, 'Pipes'));
  out.push(barrel(157, 0, -158));
  return out;
}

function pinewoodCamp() {
  const out = [surface(198, 16, 92, 112, C.grassDark, 'grass')];
  const trees = [
    [-34, -41, 1.1], [-18, -48, 0.9], [5, -44, 1.2], [28, -39, 1],
    [-38, -18, 0.85], [34, -14, 1.15], [-31, 10, 1.05], [38, 13, 0.9],
    [-37, 36, 1.2], [-13, 45, 0.9], [12, 43, 1.1], [35, 38, 1.05],
  ];
  for (const [dx, dz, scale] of trees) out.push(...tree(198 + dx, 16 + dz, scale));

  out.push(...building({
    x: 190, z: 10, w: 21, d: 16, h: 5.5, color: C.wood, doorSides: ['s', 'e'], doorW: 4.5,
  }));
  // Open sawmill canopy: roof and posts, no fake solid walls.
  out.push(box(220, 5.2, 23, 25, 0.5, 16, C.roof));
  for (const dx of [-11, 11]) {
    for (const dz of [-6.5, 6.5]) out.push(box(220 + dx, 0, 23 + dz, 0.6, 5.2, 0.6, C.wood));
  }
  for (let i = 0; i < 5; i++) {
    out.push(box(214 + i * 3, 0.45, 23, 2.1, 0.9, 11, i % 2 ? C.wood : C.trunk));
  }
  out.push(...crateStack({ x: 181, z: 30, height: 2, color: C.crate, seed: 301 }));
  return out;
}

function sunfieldFarms() {
  const out = [];
  // Alternating crop strips break up the giant green floor before any cover is added.
  for (let i = 0; i < 8; i++) {
    out.push(surface(-219 + i * 12, 177, 9, 102, i % 2 ? C.soil : C.grassLight));
  }
  out.push(...building({
    x: -176, z: 155, w: 29, d: 20, h: 7, color: C.brick, doorSides: ['n', 's'], doorW: 7,
  }));
  out.push(...roofStairs({ x: -176, z: 155, w: 29, h: 7, side: 'e' }));
  // Grain silos and a windbreak make a recognisable farm skyline.
  for (const [x, z, h] of [[-207, 135, 11], [-194, 135, 9], [-211, 204, 8]]) {
    out.push(box(x, 0, z, 6, h, 6, C.concrete));
  }
  for (let i = 0; i < 7; i++) out.push(...tree(-221 + i * 15, 222, 0.75 + (i % 2) * 0.15));

  for (const [x, z, w, d] of [
    [-211, 177, 0.8, 88],
    [-152, 184, 0.8, 74],
    [-188, 210, 48, 0.8],
    [-195, 122, 52, 0.8],
  ]) out.push(box(x, 0, z, w, 1.45, d, C.fence));
  out.push(...crateStack({ x: -157, z: 145, height: 2, color: C.crate, seed: 302 }));
  return out;
}

function switchbackYard() {
  const out = [surface(0, 190, 142, 76, C.soil, 'dirt')];
  // Three rail lines, with sleepers at intervals. They are flush decoration and
  // never snag movement.
  for (const z of [169, 187, 205]) {
    out.push(surface(0, z - 1.6, 132, 0.35, C.metal, 'metal', 3));
    out.push(surface(0, z + 1.6, 132, 0.35, C.metal, 'metal', 3));
    for (let x = -60; x <= 60; x += 8) {
      out.push(surface(x, z, 3.5, 5, C.wood, 'wood', 2));
    }
  }
  out.push(...building({
    x: -43, z: 219, w: 35, d: 13, h: 5, color: C.brick, doorSide: 'n', doorW: 6,
  }));
  out.push(...watchtower(50, 218, 'n'));
  for (const [x, z, long] of [
    [-32, 171, true], [-12, 171, true], [16, 187, true], [38, 205, true], [55, 171, false],
  ]) {
    out.push(prop(x, 0, z, long ? 8 : 2.5, 2.5, long ? 2.5 : 8, C.rust, 'Container_Long'));
  }
  out.push(...crane(5, 217));
  out.push(barrel(-2, 0, 199), barrel(0, 0, 199));
  return out;
}

function falconAirfield() {
  const out = [
    surface(174, 180, 112, 126, C.grassLight),
    surface(178, 181, 22, 118, C.runway, 'asphalt', 2),
    surface(216, 181, 28, 72, C.concreteDark, 'pavers', 2),
  ];
  // Runway threshold and centreline.
  for (let z = 131; z <= 231; z += 16) {
    out.push(surface(178, z, 2.2, 8, C.stripe, 'plaster', 3));
  }
  for (const x of [171, 178, 185]) {
    out.push(surface(x, 126, 3, 12, C.stripe, 'plaster', 4));
  }

  out.push(...building({
    x: 137, z: 154, w: 38, d: 24, h: 8, color: C.metal,
    doorSides: ['e', 's'], doorW: 10,
  }));
  out.push(...building({
    x: 137, z: 210, w: 31, d: 21, h: 7, color: C.concrete,
    doorSide: 'e', doorW: 9,
  }));
  // Control tower and its external access.
  out.push(...building({ x: 222, z: 137, w: 12, d: 12, h: 11, color: C.concreteDark, doorSide: 'w' }));
  out.push(...roofStairs({ x: 222, z: 137, w: 12, h: 11, side: 'e' }));
  for (const z of [159, 175, 191, 207]) {
    out.push(prop(215, 0, z, 3.35, 1.28, 0.92, C.military, 'SackTrench'));
  }
  out.push(barrel(149, 0, 180));
  return out;
}

function oldMillHamlet() {
  const out = [surface(-86, 76, 74, 72, C.wallAlt, 'cobbles')];
  const homes = [
    [-108, 57, 18, 13, 5, 'e'],
    [-78, 55, 16, 14, 6, 's'],
    [-105, 91, 14, 16, 4.5, 'n'],
    [-72, 94, 20, 13, 5.5, 'w'],
  ];
  for (const [x, z, w, d, h, doorSide] of homes) {
    out.push(...building({ x, z, w, d, h, color: h > 5 ? C.brick : C.wall, doorSide }));
  }
  out.push(...roofStairs({ x: -78, z: 55, w: 16, h: 6, side: 'e' }));
  out.push(...crateStack({ x: -88, z: 79, height: 2, color: C.crate, seed: 401 }));
  return out;
}

function ashChapelRuins() {
  const out = [surface(86, -77, 76, 74, C.stone, 'cobbles')];
  // A roofless chapel shell, grave rows and a collapsed bell tower.
  out.push(...building({
    x: 86, z: -81, w: 24, d: 39, h: 6.5, color: C.wallAlt,
    doorSides: ['n', 's'], doorW: 5, roof: false,
  }));
  out.push(box(86, 0, -62, 8, 9, 8, C.stone));
  out.push(...stairs({
    x: 86, y: 0, z: -76, width: 2.6, rise: 9, run: 14, axis: 'z', dir: 1, color: C.stone,
  }));
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      out.push(box(60 + col * 7, 0, -100 + row * 9, 1.4, 1.05, 3.2, C.stone));
    }
  }
  out.push(...rocks(111, -54, 402, 6));
  return out;
}

/** Arterial routes make rotations legible and connect every major POI. */
function roads() {
  return [
    // Roads occupy their own layer band above local area decoration. Previously
    // the main north/south road shared layer 2 with railyard sleepers, leaving
    // small but very visible patches of z-fighting at every crossing.
    surface(0, 0, 11, 500, C.road, 'asphalt', 8),
    surface(0, 0, 500, 11, C.road, 'asphalt', 9),
    surface(-174, 88, 9, 176, C.road, 'asphalt', 10),
    surface(174, 88, 9, 176, C.road, 'asphalt', 11),
    surface(-88, -176, 176, 9, C.road, 'asphalt', 12),
    surface(88, 176, 176, 9, C.road, 'asphalt', 13),
  ];
}

/** Sparse transition cover keeps travel risky without restoring the old grid. */
function transitionCover() {
  const out = [];
  const clusters = [
    [-92, -126, 501], [-104, -31, 502], [-44, -102, 503],
    [43, -129, 504], [128, -112, 505], [124, -30, 506],
    [-129, 28, 507], [-118, 128, 508], [-43, 128, 509],
    [48, 117, 510], [119, 82, 511], [122, 236, 512],
  ];
  for (const [x, z, seed] of clusters) out.push(...rocks(x, z, seed, 4 + (seed % 3)));

  // Roadside barricades alternate sides, preventing kilometre-long sightlines.
  for (let i = -3; i <= 3; i++) {
    if (i === 0) continue;
    out.push(box(i * 58, 0, i % 2 ? -7 : 7, 12, 1.2, 0.8, C.concreteDark));
    out.push(box(i % 2 ? -7 : 7, 0, i * 58, 0.8, 1.2, 12, C.concreteDark));
  }
  return out;
}

export const ISLAND_AREAS = [
  { id: 'citadel', name: 'Crown Citadel', pos: [0, 0], radius: 48 },
  { id: 'docks', name: 'Blackwater Docks', pos: [-214, 0], radius: 66 },
  { id: 'quarry', name: 'Slate Quarry', pos: [-176, -176], radius: 54 },
  { id: 'base', name: 'Northwatch Base', pos: [0, -194], radius: 62 },
  { id: 'power', name: 'Meridian Power', pos: [176, -176], radius: 58 },
  { id: 'logging', name: 'Pinewood Camp', pos: [198, 16], radius: 62 },
  { id: 'farms', name: 'Sunfield Farms', pos: [-176, 177], radius: 62 },
  { id: 'railyard', name: 'Switchback Yard', pos: [0, 190], radius: 70 },
  { id: 'airfield', name: 'Falcon Airfield', pos: [174, 180], radius: 70 },
  { id: 'hamlet', name: 'Old Mill Hamlet', pos: [-86, 76], radius: 42 },
  { id: 'chapel', name: 'Ash Chapel', pos: [86, -77], radius: 42 },
];

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

  b.push(...roads());
  b.push(...crownCitadel());
  b.push(...blackwaterDocks());
  b.push(...slateQuarry());
  b.push(...northwatchBase());
  b.push(...meridianPower());
  b.push(...pinewoodCamp());
  b.push(...sunfieldFarms());
  b.push(...switchbackYard());
  b.push(...falconAirfield());
  b.push(...oldMillHamlet());
  b.push(...ashChapelRuins());
  b.push(...transitionCover());

  return b;
}

/**
 * Battle-royale spawns around the shoreline, each walked inward until it's clear of
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
    for (let r = startRadius; r >= 80; r -= 2) {
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
function lootPoints(boxes) {
  const out = [];
  const solids = compileBoxes(boxes);
  const half = (GRID - 1) / 2;
  for (let gx = 0; gx < GRID; gx++) {
    for (let gz = 0; gz < GRID; gz++) {
      const cx = (gx - half) * CELL;
      const cz = (gz - half) * CELL;
      const r = (salt) => rand(gx + 1, gz + 1, 500 + salt);
      // Plenty of candidates per district. Reject anything inside authored
      // cover so every glowing pickup is genuinely reachable on the ground.
      for (let i = 0; i < 9; i++) {
        const point = [
          cx + (r(i * 3) - 0.5) * (CELL - 14),
          0,
          cz + (r(i * 3 + 1) - 0.5) * (CELL - 14),
        ];
        if (!playerOverlapsAny(point, PLAYER_HEIGHT, PLAYER_RADIUS, solids)) out.push(point);
      }
    }
  }
  return out;
}

/** A grounded medical cache in roughly half the districts. */
function healthPacks(boxes) {
  const solids = compileBoxes(boxes);
  const out = [];
  const half = (GRID - 1) / 2;
  const offsets = [[0, 0], [18, 0], [-18, 0], [0, 18], [0, -18], [18, 18], [-18, -18]];

  for (let gx = 0; gx < GRID; gx++) {
    for (let gz = 0; gz < GRID; gz++) {
      if ((gx + gz) % 2 !== 0) continue;
      const cx = (gx - half) * CELL;
      const cz = (gz - half) * CELL;
      const point = offsets
        .map(([dx, dz]) => [cx + dx, 0, cz + dz])
        .find((p) => !playerOverlapsAny(p, PLAYER_HEIGHT, PLAYER_RADIUS, solids));
      if (point) out.push(point);
    }
  }
  return out;
}

/** Road rovers are spread between districts, never inside authored cover. */
// A rover has to be placed against its own footprint, not a person's. It is 2.3m
// across and 3.4m long against a player's 0.8m diameter, so validating with
// PLAYER_RADIUS — as this did originally — cleared points that left four of the
// fourteen rovers with their chassis inside a building. Rovers spawn at yaw 0, so
// the long axis is what matters; the height comes from the hitbox too, since a
// rover is short enough to sit under overhangs a standing player could not.
const VEHICLE_PLACE_RADIUS = Math.max(
  Math.abs(VEHICLE_HITBOX.min[0]), VEHICLE_HITBOX.max[0],
  Math.abs(VEHICLE_HITBOX.min[2]), VEHICLE_HITBOX.max[2],
);
const VEHICLE_PLACE_HEIGHT = VEHICLE_HITBOX.max[1] - VEHICLE_HITBOX.min[1];

function vehicleSpawns(boxes) {
  const solids = compileBoxes(boxes);
  const out = [];
  const half = (GRID - 1) / 2;
  // More candidates than before: the rover needs a genuinely open patch, so a
  // district with one clear corner for a player may have none for a vehicle, and
  // the search has to be able to give up on a cell rather than force a bad spot.
  const offsets = [
    [24, 24], [-24, -24], [24, -24], [-24, 24], [0, 25], [25, 0], [-25, 0], [0, -25],
    [18, 18], [-18, -18], [18, -18], [-18, 18], [30, 12], [-30, -12], [12, 30], [-12, -30],
  ];
  for (let gx = 0; gx < GRID && out.length < 14; gx++) {
    for (let gz = 0; gz < GRID && out.length < 14; gz++) {
      if ((gx * 3 + gz * 5) % 6 !== 0) continue;
      const cx = (gx - half) * CELL;
      const cz = (gz - half) * CELL;
      const point = offsets
        .map(([dx, dz]) => [cx + dx, 0, cz + dz])
        .find((p) => !playerOverlapsAny(p, VEHICLE_PLACE_HEIGHT, VEHICLE_PLACE_RADIUS, solids)
          // Keep the approach clear too, or you spawn nose-to-wall and can't pull
          // away. A player-sized probe is right here: this is about the gap the
          // rover drives through, not the space it occupies.
          && !playerOverlapsAny([p[0], p[1], p[2] + 3], PLAYER_HEIGHT, PLAYER_RADIUS, solids));
      if (point) out.push(point);
    }
  }
  return out;
}

const BOXES = build();

export default {
  id: 'island',
  name: 'Crown Island',
  blurb: 'Eleven distinct drop zones across 540m of forts, docks, farms and wilderness.',
  battleRoyale: true,
  areas: ISLAND_AREAS,
  skyColor: 0x9fc0d8,
  fogColor: 0xb5cadb,
  fogDensity: 0.0022,
  ambientLight: 0.85,
  sunDirection: [0.4, 0.85, 0.35],
  sunIntensity: 1.1,
  detailTexture: 'plaster',
  materialTextures: MATERIAL_TEXTURES,
  groundTexture: 'grass',
  wallTexture: 'blockwork',
  bounds: { min: [-HALF - 12, -12, -HALF - 12], max: [HALF + 12, 130, HALF + 12] },
  boxes: BOXES,
  healthPacks: healthPacks(BOXES),
  lootPoints: lootPoints(BOXES),
  vehicleSpawns: vehicleSpawns(BOXES),
  spawns: {
    // Everyone starts on the shoreline and walks in.
    ffa: ringSpawns(BOXES, BR_MAX_PLAYERS, HALF - 14),
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
