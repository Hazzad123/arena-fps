// ALLEY — small, loud, and close.
//
// A ring corridor around a central block, with a crossroads cut straight
// through the middle. Nothing is more than a few seconds from anything else,
// which is exactly what Gun Game wants: you're never hunting for a fight.
//
// Sightlines are deliberately short. Snipers are a liability here, shotguns are
// king, and every corner is a coin flip.

import { box, stairs, crateStack } from './helpers.js';

const C = {
  ground: 0x59544c,
  wall: 0xa8926f,
  wallAlt: 0x947f5f,
  wood: 0x674c33,
  awning: 0x9e3c37,
  awningAlt: 0x3f6b7a,
  metal: 0x4e5257,
  bin: 0x3f5a44,
  balcony: 0x7a6144,
};

const HALF = 18;
const WALL_H = 14; // a canyon — you are not getting out of here

function build() {
  const b = [];

  // ---- shell ----
  b.push(box(0, -1, 0, HALF * 2 + 6, 1, HALF * 2 + 6, C.ground));
  // Outer walls are the surrounding buildings, so they're thick and tall.
  b.push(box(0, 0, -HALF - 1.5, HALF * 2 + 6, WALL_H, 3, C.wall));
  b.push(box(0, 0, HALF + 1.5, HALF * 2 + 6, WALL_H, 3, C.wall));
  b.push(box(-HALF - 1.5, 0, 0, 3, WALL_H, HALF * 2 + 6, C.wallAlt));
  b.push(box(HALF + 1.5, 0, 0, 3, WALL_H, HALF * 2 + 6, C.wallAlt));

  // ---- central block, quartered by a 4m crossroads ----
  // Four 7x7 buildings leaving a plus-shaped passage through the middle.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.push(box(sx * 5.5, 0, sz * 5.5, 7, 10, 7, sx * sz > 0 ? C.wall : C.wallAlt));
    }
  }

  // ---- ring cover ----
  // The ring is 9m wide, which is too open for a map this size, so it gets
  // broken up with bins, stalls and low walls.
  const bins = [
    [-13.5, -12],
    [13.5, 12],
    [-13.5, 6],
    [13.5, -6],
    [-4, -13.5],
    [4, 13.5],
  ];
  for (const [x, z] of bins) b.push(box(x, 0, z, 2.2, 1.4, 1.3, C.bin));

  // Low walls that force you wide around the corners.
  b.push(box(-12.5, 0, -2, 0.6, 1.9, 7, C.wallAlt));
  b.push(box(12.5, 0, 2, 0.6, 1.9, 7, C.wallAlt));
  // No low walls on the north/south stretches — the balcony staircases run
  // through there and provide the cover instead.

  // ---- market stalls ----
  // Canopy tops sit at 2.6m: you can't reach them from the ground, but you can
  // from a bin. A small reward for knowing the map.
  const stalls = [
    { x: -13.5, z: -12, axis: 'z', color: C.awning },
    { x: 13.5, z: 12, axis: 'z', color: C.awningAlt },
    { x: -4, z: -13.5, axis: 'x', color: C.awningAlt },
    { x: 4, z: 13.5, axis: 'x', color: C.awning },
  ];
  for (const s of stalls) {
    const w = s.axis === 'z' ? 3.4 : 6;
    const d = s.axis === 'z' ? 6 : 3.4;
    b.push(box(s.x, 2.4, s.z, w, 0.2, d, s.color)); // canopy
    // Corner posts.
    for (const dx of [-1, 1]) {
      for (const dz of [-1, 1]) {
        b.push(box(s.x + dx * (w / 2 - 0.2), 0, s.z + dz * (d / 2 - 0.2), 0.22, 2.4, 0.22, C.wood));
      }
    }
  }

  // ---- two corner balconies ----
  // Modest height advantage over the ring, in opposite corners so neither team
  // owns both.
  for (const side of [-1, 1]) {
    const x = side * 13;
    const z = side * -13;
    b.push(box(x, 3.4, z, 8, 0.4, 8, C.balcony)); // walkable surface at 3.8
    b.push(box(x, 3.8, z + side * 3.8, 8, 0.9, 0.4, C.wood)); // railing
    // The staircase climbs from the middle of the map *outward* to the
    // balcony's inner edge at x = ±9, and rises to the deck's top surface.
    // Running it the other way puts the stairs underneath the balcony, where
    // the deck becomes a ceiling you can't get past.
    b.push(
      ...stairs({
        x: side * 1.5,
        y: 0,
        z,
        width: 3,
        rise: 3.8,
        run: 7.5,
        axis: 'x',
        dir: side,
        color: C.wood,
      }),
    );
    b.push(...crateStack({ x, z: z - side * 2.5, y: 3.8, size: 1.2, height: 1, color: C.wood, seed: 5 + side }));
  }

  return b;
}

export default {
  id: 'alley',
  name: 'Alley',
  blurb: 'Short sightlines, constant contact. Bring a shotgun.',
  skyColor: 0x4a4335,
  fogColor: 0x6d6350,
  fogDensity: 0.018,
  ambientLight: 0.6,
  sunDirection: [0.5, 0.85, -0.3],
  sunIntensity: 0.85,
  // Cobbled back-alley underfoot, old red brick either side.
  groundTexture: 'cobbles',
  wallTexture: 'redbrick',
  bounds: { min: [-HALF - 5, -12, -HALF - 5], max: [HALF + 5, WALL_H + 6, HALF + 5] },
  boxes: build(),
  spawns: {
    A: [
      [-14, 0, -15.5],
      [-10, 0, -15.5],
      [-15.5, 0, -10],
      [-15.5, 0, -5],
      [-6, 0, -15.5],
      [-15.5, 0, 0],
      [-15.5, 0, -13],
    ],
    B: [
      [14, 0, 15.5],
      [10, 0, 15.5],
      [15.5, 0, 10],
      [15.5, 0, 5],
      [6, 0, 15.5],
      [15.5, 0, 0],
      [15.5, 0, 13],
    ],
    ffa: [
      [-14, 0, -15.5],
      [14, 0, 15.5],
      [15.5, 0, -10],
      [-15.5, 0, 10],
      [0, 0, 0],
      [0, 0, -14],
      [0, 0, 14],
      [-13, 3.8, 13],
      [13, 3.8, -13],
      [11.5, 0, -2],
      [-11.5, 0, 2],
      [15.5, 0, 15.5],
    ],
  },
};
