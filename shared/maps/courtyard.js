// COURTYARD — a broad, readable arena built around a raised garden.
//
// The outer arcade supplies flanking cover while four open gates into the centre
// keep the map from becoming a collection of disconnected rooms.

import { barrel, box, crateStack, enclose, platform, prop, stairs } from './helpers.js';

const C = {
  floor: 0x817a6b,
  wall: 0xa79b84,
  stone: 0x77746b,
  hedge: 0x526447,
  wood: 0x9a6335,
};

function build() {
  const b = [
    box(0, -1, 0, 64, 1, 64, C.floor),
    ...enclose({ w: 60, d: 60, h: 5.5, thickness: 1.2, color: C.wall }),
    ...platform({ x: 0, y: 1.2, z: 0, w: 13, d: 13, color: C.stone, stairSide: 'z-', stairWidth: 4 }),
    ...stairs({ x: 0, y: 0, z: 8.5, width: 4, rise: 1.2, run: 2, axis: 'z', dir: -1, color: C.stone }),
  ];

  // Broken arcade walls: long enough to make cover, split widely enough that
  // every lane has more than one entrance.
  for (const side of [-1, 1]) {
    b.push(
      box(side * 17, 0, -19, 1.1, 3.4, 15, C.wall),
      box(side * 17, 0, 19, 1.1, 3.4, 15, C.wall),
      box(-19, 0, side * 17, 15, 3.4, 1.1, C.wall),
      box(19, 0, side * 17, 15, 3.4, 1.1, C.wall),
    );
  }

  // Four low planters make the central platform contestable without hiding it.
  for (const [x, z] of [[-10, -10], [10, -10], [-10, 10], [10, 10]]) {
    b.push(box(x, 0, z, 5, 0.85, 2.2, C.hedge));
  }

  b.push(
    ...crateStack({ x: -24, z: -6, size: 1.5, height: 2, color: C.wood, seed: 41 }),
    ...crateStack({ x: 24, z: 7, size: 1.5, height: 2, color: C.wood, seed: 43 }),
    prop(-8, 0, 23, 3.35, 1.28, 0.92, C.wood, 'SackTrench'),
    prop(8, 0, -23, 3.35, 1.28, 0.92, C.wood, 'SackTrench'),
    barrel(-24, 0, 19),
    barrel(24, 0, -19),
  );
  return b;
}

export default {
  id: 'courtyard',
  name: 'Courtyard',
  blurb: 'Open garden fights framed by broken arcades and fast flank routes.',
  skyColor: 0x91adc0,
  fogColor: 0xaebbc0,
  fogDensity: 0.006,
  ambientLight: 0.85,
  sunDirection: [-0.4, 0.9, 0.25],
  sunIntensity: 1.1,
  wallTexture: 'blockwork',
  bounds: { min: [-34, -12, -34], max: [34, 16, 34] },
  boxes: build(),
  healthPacks: [
    [0, 1.2, 0],
    [-25, 0, 0],
    [25, 0, 0],
    [0, 0, -25],
    [0, 0, 25],
  ],
  spawns: {
    A: [[-22, 0, -26], [-10, 0, -26], [4, 0, -27], [13, 0, -27], [27, 0, -10]],
    B: [[22, 0, 26], [10, 0, 26], [-4, 0, 27], [-13, 0, 27], [-27, 0, 10]],
    ffa: [
      [-24, 0, -25], [24, 0, 25], [-24, 0, 25], [24, 0, -25],
      [0, 0, -26], [0, 0, 26], [-26, 0, 0], [26, 0, 0],
      [-5, 1.2, 0], [5, 1.2, 0], [0, 0, -15], [0, 0, 15],
    ],
  },
};
