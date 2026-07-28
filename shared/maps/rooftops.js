// ROOFTOPS — outdoor, and the only map where the floor can kill you.
//
// A ring of eight rooftops all at the same height, separated by 3m lethal gaps.
// A running jump clears one comfortably; walking off the edge does not. In the
// middle, a tower 4m up, reached only by two long exposed ramps from the west
// and east roofs — so the best position on the map is also the most committed.
//
// Design constraint worth stating, because getting it wrong makes platforms
// silently unreachable: a player's jump apex is 1.28m (JUMP_VELOCITY 7.5,
// GRAVITY -22) and auto-step handles 0.45m. So *nothing* may sit more than
// ~1.2m above its neighbour unless there are stairs to it. Everything here is
// either level with its neighbours or connected by an explicit ramp, and
// test/navigation.test.js proves every spawn can reach every other.

import { box, stairs, crateStack, mirror } from './helpers.js';

const C = {
  roof: 0x5f5c56,
  roofAlt: 0x6d6255,
  parapet: 0x827668,
  brick: 0x8c6250,
  tower: 0x706d66,
  ramp: 0x5a5f66,
  metal: 0x55585e,
  tank: 0x7d7e70,
  vent: 0x8d8f88,
};

const FALL_Y = -30;
const TOWER_TOP = 4.0;
const SLAB = 2.5; // how thick a rooftop looks from below

/** A rooftop whose walkable surface is at `topY`, with parapets on chosen edges. */
function roof({ x, z, w, d, topY = 0, parapets = '', color = C.roof }) {
  const out = [box(x, topY - SLAB, z, w, SLAB, d, color)];
  const t = 0.4;
  const h = 1.0; // cover you can jump over, not a fence
  if (parapets.includes('n')) out.push(box(x, topY, z + d / 2 - t / 2, w, h, t, C.parapet));
  if (parapets.includes('s')) out.push(box(x, topY, z - d / 2 + t / 2, w, h, t, C.parapet));
  if (parapets.includes('e')) out.push(box(x + w / 2 - t / 2, topY, z, t, h, d, C.parapet));
  if (parapets.includes('w')) out.push(box(x - w / 2 + t / 2, topY, z, t, h, d, C.parapet));
  return out;
}

/** Rooftop furniture: cover, and something to make the place look inhabited. */
function clutter({ x, y = 0, z, seed = 1 }) {
  return [
    box(x, y, z, 2.4, 1.2, 1.8, C.vent),
    box(x + 3.2, y, z - 1.4, 1.6, 1.9, 1.6, C.tank),
    ...crateStack({ x: x - 2.8, y, z: z + 1.6, size: 1.2, height: 1, color: C.metal, seed }),
  ];
}

function build() {
  const b = [];

  // ---- team roofs, south and north ----
  // 30 wide, so the 3m gaps to the corner roofs sit at x = ±15..±18.
  b.push(...roof({ x: 0, z: -24, w: 30, d: 12, parapets: 's', color: C.roof }));
  b.push(...roof({ x: 0, z: 24, w: 30, d: 12, parapets: 'n', color: C.roof }));
  b.push(...clutter({ x: -9, z: -25, seed: 2 }));
  b.push(...clutter({ x: 9, z: 25, seed: 3 }));
  // A stair block by each spawn: cover on an otherwise bare roof.
  b.push(box(6, 0, -22, 6, 2.2, 2, C.brick));
  b.push(box(-6, 0, 22, 6, 2.2, 2, C.brick));

  // ---- side roofs, west and east ----
  b.push(...roof({ x: -24, z: 0, w: 12, d: 30, parapets: 'w', color: C.roofAlt }));
  b.push(...roof({ x: 24, z: 0, w: 12, d: 30, parapets: 'e', color: C.roofAlt }));
  b.push(...clutter({ x: -25, z: -9, seed: 5 }));
  b.push(...clutter({ x: 25, z: 9, seed: 6 }));

  // ---- corner roofs ----
  // 7x7 at (±21.5, ±21.5): a 3m gap to both the team roof and the side roof, so
  // the ring is continuous but every link costs you a jump.
  const corner = [...roof({ x: 21.5, z: -21.5, w: 7, d: 7, color: C.roofAlt })];
  b.push(...corner);
  b.push(...mirror(corner, 'x'));
  b.push(...mirror(corner, 'z'));
  b.push(...mirror(mirror(corner, 'x'), 'z'));

  // ---- central tower ----
  // Best sightlines on the map. Parapets all round with doorways where the two
  // ramps arrive.
  b.push(...roof({ x: 0, z: 0, w: 14, d: 14, topY: TOWER_TOP, parapets: 'nsew', color: C.tower }));
  b.push(...clutter({ x: 3, y: TOWER_TOP, z: 3, seed: 9 }));

  // ---- the two ramps up ----
  // From the inner edge of each side roof (x = ±18, y = 0) up to the tower
  // (x = ±7, y = 4). Long, straight and completely exposed — taking the tower
  // is a decision, not a default.
  for (const side of [-1, 1]) {
    b.push(
      ...stairs({
        x: side * 18,
        y: 0,
        z: 0,
        width: 4,
        rise: TOWER_TOP,
        run: 11,
        axis: 'x',
        dir: -side,
        color: C.ramp,
      }),
    );
    // Doorway: cut the parapet by flanking it, leaving a 4m gap for the ramp.
    b.push(box(side * 6.8, TOWER_TOP, side * 5.25, 0.4, 1.0, 3.5, C.parapet));
    b.push(box(side * 6.8, TOWER_TOP, side * -5.25, 0.4, 1.0, 3.5, C.parapet));
  }

  return b;
}

export default {
  id: 'rooftops',
  name: 'Rooftops',
  blurb: 'Eight roofs, lethal gaps, one tower. Mind the drop.',
  skyColor: 0x8fb4cc,
  fogColor: 0xa8c4d6,
  fogDensity: 0.005,
  ambientLight: 0.8,
  sunDirection: [-0.45, 0.8, 0.4],
  sunIntensity: 1.1,
  lethalFallY: FALL_Y,
  bounds: { min: [-40, FALL_Y - 5, -40], max: [40, 30, 40] },
  boxes: build(),
  spawns: {
    A: [
      [-12, 0, -26],
      [-4, 0, -27],
      [3, 0, -27],
      [11, 0, -26],
      [-13, 0, -21],
      [13, 0, -21],
      [0, 0, -20],
    ],
    B: [
      [12, 0, 26],
      [4, 0, 27],
      [-3, 0, 27],
      [-11, 0, 26],
      [13, 0, 21],
      [-13, 0, 21],
      [0, 0, 20],
    ],
    ffa: [
      [-12, 0, -26],
      [12, 0, 26],
      [-25, 0, -5],
      [25, 0, 5],
      [-25, 0, 8],
      [25, 0, -8],
      [0, TOWER_TOP, 0],
      [-21.5, 0, -21.5],
      [21.5, 0, 21.5],
      [21.5, 0, -21.5],
      [-21.5, 0, 21.5],
      [0, 0, 26],
    ],
  },
};
