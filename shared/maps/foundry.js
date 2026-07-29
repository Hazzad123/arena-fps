// FOUNDRY — long industrial lanes crossed by a central furnace deck.

import { barrel, box, crateStack, enclose, platform, prop, stairs } from './helpers.js';

const C = {
  floor: 0x55585b,
  wall: 0x727579,
  steel: 0x44494e,
  rust: 0x94552f,
  hot: 0xb66b31,
  crate: 0xb58446,
};

function build() {
  const b = [
    box(0, -1, 0, 74, 1, 60, C.floor),
    ...enclose({ w: 70, d: 56, h: 7, thickness: 1.4, color: C.wall }),
    ...platform({ x: 0, y: 2.2, z: 0, w: 16, d: 12, color: C.steel, stairSide: 'x-', stairWidth: 4 }),
    ...stairs({ x: 13.72, y: 0, z: 0, width: 4, rise: 2.2, run: 5.72, axis: 'x', dir: -1, color: C.steel }),
  ];

  // Furnace body with gaps at either end of the deck; the orange bands make the
  // centre legible at a glance without introducing damaging floor hazards.
  b.push(
    box(0, 0, 0, 5.5, 2.2, 7, C.rust),
    box(0, 2.2, 0, 5.7, 0.25, 7.2, C.hot),
    box(-18, 0, -8, 12, 3, 1.2, C.steel),
    box(-18, 0, 9, 12, 3, 1.2, C.steel),
    box(18, 0, -9, 12, 3, 1.2, C.steel),
    box(18, 0, 8, 12, 3, 1.2, C.steel),
  );

  // Short side catwalks add vertical options without splitting navigation.
  for (const side of [-1, 1]) {
    b.push(
      box(side * 29, 2.4, 0, 7, 0.35, 22, C.steel),
      ...stairs({ x: side * 29, y: 0, z: -17, width: 5, rise: 2.75, run: 7, axis: 'z', dir: 1, color: C.steel }),
      ...stairs({ x: side * 29, y: 0, z: 17, width: 5, rise: 2.75, run: 7, axis: 'z', dir: -1, color: C.steel }),
    );
  }

  b.push(
    ...crateStack({ x: -24, z: -17, size: 1.7, height: 2, color: C.crate, seed: 51 }),
    ...crateStack({ x: 24, z: 17, size: 1.7, height: 2, color: C.crate, seed: 53 }),
    prop(-8, 0, 18, 2.44, 2, 1.3, C.steel, 'TrashContainer'),
    prop(8, 0, -18, 2.44, 2, 1.3, C.steel, 'TrashContainer'),
    barrel(-11, 0, -13),
    barrel(11, 0, 13),
    barrel(27, 2.75, 0),
  );
  return b;
}

export default {
  id: 'foundry',
  name: 'Foundry',
  blurb: 'Industrial lanes, furnace cover and two compact side catwalks.',
  skyColor: 0x697079,
  fogColor: 0x5f6267,
  fogDensity: 0.008,
  ambientLight: 0.95,
  sunDirection: [0.35, 0.8, -0.3],
  sunIntensity: 0.9,
  wallTexture: 'brick',
  bounds: { min: [-39, -12, -32], max: [39, 18, 32] },
  boxes: build(),
  healthPacks: [
    [-7, 2.2, 0],
    [7, 2.2, 0],
    [-29, 2.75, 0],
    [29, 2.75, 0],
    [0, 0, -22],
    [0, 0, 22],
  ],
  spawns: {
    A: [[-29, 0, -23], [-15, 0, -24], [0, 0, -24], [15, 0, -24], [29, 0, -23]],
    B: [[29, 0, 23], [15, 0, 24], [0, 0, 24], [-15, 0, 24], [-29, 0, 23]],
    ffa: [
      [-30, 0, -23], [30, 0, 23], [-30, 0, 23], [30, 0, -23],
      [0, 0, -24], [0, 0, 24], [-20, 0, 0], [20, 0, 0],
      [-29, 2.75, 7], [29, 2.75, -7], [-7, 2.2, 0], [7, 2.2, 0],
    ],
  },
};
