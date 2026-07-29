// SWITCHYARD — three rail lanes with containers, cargo and a central footbridge.

import { barrel, box, crateStack, enclose, prop, stairs } from './helpers.js';

const C = {
  ground: 0x68665f,
  wall: 0x7b7770,
  rail: 0x3f4348,
  blue: 0x496b83,
  red: 0x8b5146,
  cargo: 0xaa7b3e,
};

function build() {
  const b = [
    box(0, -1, 0, 84, 1, 64, C.ground),
    ...enclose({ w: 80, d: 60, h: 5, thickness: 1.3, color: C.wall }),
  ];

  // Broken train/container lines preserve cross-lane movement every 12–16m.
  for (const x of [-18, 0, 18]) {
    b.push(
      box(x, 0, -18, 5, 2.8, 13, x < 0 ? C.blue : C.red),
      box(x, 0, 5, 5, 2.8, 16, x < 0 ? C.red : C.blue),
      box(x, 0, 23, 5, 2.8, 7, C.blue),
    );
  }

  // Footbridge runs east-west over the middle lane, with a stair on both ends.
  b.push(
    box(0, 3.1, -7, 34, 0.4, 4, C.rail),
    ...stairs({ x: -22, y: 0, z: -7, width: 4, rise: 3.5, run: 8, axis: 'x', dir: 1, color: C.rail }),
    ...stairs({ x: 22, y: 0, z: -7, width: 4, rise: 3.5, run: 8, axis: 'x', dir: -1, color: C.rail }),
  );

  b.push(
    ...crateStack({ x: -30, z: 8, size: 1.6, height: 2, color: C.cargo, seed: 61 }),
    ...crateStack({ x: 30, z: -18, size: 1.6, height: 2, color: C.cargo, seed: 63 }),
    prop(-30, 0, -18, 3.35, 1.28, 0.92, C.cargo, 'SackTrench'),
    prop(30, 0, 17, 3.35, 1.28, 0.92, C.cargo, 'SackTrench'),
    barrel(-9, 0, 16),
    barrel(9, 0, -18),
    barrel(0, 0, 17),
  );
  return b;
}

export default {
  id: 'switchyard',
  name: 'Switchyard',
  blurb: 'Long rail lanes cut by container gaps and a risky central bridge.',
  skyColor: 0x8097a5,
  fogColor: 0x8e9ba0,
  fogDensity: 0.0065,
  ambientLight: 0.8,
  sunDirection: [-0.2, 0.9, 0.4],
  sunIntensity: 1.05,
  wallTexture: 'blockwork',
  bounds: { min: [-44, -12, -34], max: [44, 18, 34] },
  boxes: build(),
  healthPacks: [
    [0, 3.5, -7],
    [-31, 0, 0],
    [31, 0, 0],
    [0, 0, -26],
    [0, 0, 27],
  ],
  spawns: {
    A: [[-35, 0, -25], [-20, 0, -26], [-8, 0, -28], [20, 0, -26], [35, 0, -25]],
    B: [[35, 0, 25], [25, 0, 27], [8, 0, 28], [-25, 0, 27], [-35, 0, 25]],
    ffa: [
      [-35, 0, -25], [35, 0, 25], [-35, 0, 25], [35, 0, -25],
      [-27, 0, 0], [27, 0, 0], [-8, 0, -28], [8, 0, 28],
      [-10, 3.5, -7], [10, 3.5, -7], [-10, 0, 12], [9, 0, -12],
    ],
  },
};
