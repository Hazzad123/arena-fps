// WAREHOUSE — tight indoor CQB.
//
// Three lanes running north/south, separated by shelving racks you can shoot
// through at two heights. Catwalks up both side walls give a height advantage
// but no cover, so taking them is a real decision. Mid is a crate-strewn
// crossroads where most fights happen.
//
// Symmetric about z=0. Team A spawns south (-z), Team B north (+z).

import { barrel, box, crateStack, enclose, mirror, platform, prop, rack, stairs } from './helpers.js';

const C = {
  floor: 0x8b8b93,
  wall: 0x9d9da6,
  trim: 0x6a6a73,
  steel: 0x63656d,
  crateA: 0xc98432,
  crateB: 0xd0ad3f,
  catwalk: 0x767986,
  rail: 0x55575f,
  spawnA: 0x4d84b8,
  spawnB: 0xb85a4d,
};

const HALF = 30;
const CEILING = 11;

function build() {
  const b = [];

  // ---- shell ----
  b.push(box(0, -1, 0, HALF * 2 + 4, 1, HALF * 2 + 4, C.floor));
  b.push(...enclose({ w: HALF * 2, d: HALF * 2, h: CEILING, thickness: 1.5, color: C.wall }));

  // Roof in three panels, leaving two 4m skylight strips at x = ±14. Without
  // them the roof blocks the sun completely and the whole interior is lit only
  // by ambient, which looks like a rendering fault rather than a warehouse.
  // The gaps also give the lanes below some welcome shafts of light.
  b.push(box(-24, CEILING, 0, 16, 1, HALF * 2 + 4, C.trim));
  b.push(box(0, CEILING, 0, 24, 1, HALF * 2 + 4, C.trim));
  b.push(box(24, CEILING, 0, 16, 1, HALF * 2 + 4, C.trim));

  // ---- lane dividers ----
  // Racks at x=±10, split so there's a wide crossing at mid and smaller gaps
  // toward each spawn.
  for (const x of [-10, 10]) {
    b.push(...rack({ x, z: -13, length: 13, axis: 'z', height: 3.4, color: C.steel }));
    b.push(...rack({ x, z: 13, length: 13, axis: 'z', height: 3.4, color: C.steel }));
  }

  // ---- mid ----
  // Low central platform: worth holding, but exposed from the catwalks.
  b.push(...platform({ x: 0, y: 1.8, z: 0, w: 9, d: 9, color: C.trim, stairSide: 'z-', stairWidth: 4 }));
  b.push(...stairs({ x: 0, y: 0, z: 9, width: 4, rise: 1.8, run: 4.6, axis: 'z', dir: -1, color: C.trim }));

  // Crate cover flanking mid, on both sides of the lane dividers.
  const midCrates = [
    ...crateStack({ x: -17, z: -4, size: 1.7, height: 2, color: C.crateA, seed: 3 }),
    ...crateStack({ x: -20, z: 3, size: 1.5, height: 1, color: C.crateB, seed: 7 }),
    ...crateStack({ x: -6, z: -7, size: 1.6, height: 1, color: C.crateB, seed: 11 }),
    ...crateStack({ x: 6.5, z: -6, size: 1.7, height: 2, color: C.crateA, seed: 13 }),
    ...crateStack({ x: 17, z: 4, size: 1.7, height: 2, color: C.crateA, seed: 17 }),
    ...crateStack({ x: 20.5, z: -3, size: 1.5, height: 1, color: C.crateB, seed: 19 }),
  ];
  b.push(...midCrates);

  // ---- yard clutter ----
  // Real cover, not decoration: these are ordinary solid boxes that the client
  // happens to draw as models. Authored at each model's own proportions so
  // filling the box doesn't stretch it, placed on the south half and mirrored, so
  // both teams get exactly the same fight.
  const cover = [
    prop(-22, 0, -9, 2.2, 2.1, 2.1, C.steel, 'Container_Small'),
    prop(22, 0, -13, 2.44, 2.0, 1.3, C.steel, 'TrashContainer'),
    // Pipe runs against the side walls, under the catwalk decks.
    prop(-28.2, 0, -6, 0.96, 4.2, 1.0, C.steel, 'Pipes'),
    prop(28.2, 0, -18, 0.96, 4.2, 1.0, C.steel, 'Pipes'),
    // Low cover you can shoot over but not walk through. Clear of the rack legs
    // at x=-10 and of the free-for-all spawn at [-6, 0, 14], which its mirror
    // sat directly on top of until the map tests said so.
    prop(-14, 0, -12, 3.35, 1.28, 0.92, C.crateB, 'SackTrench'),
    prop(5.5, 0, -17, 1.0, 1.66, 1.0, C.steel, 'GasTank'),
    // Explosive. Two together so shooting one takes the other with it.
    barrel(-15.5, 0, -18.5),
    barrel(-16.7, 0, -19.3),
    barrel(15.5, 0, -8),
  ];
  b.push(...cover, ...mirror(cover, 'z'));

  // ---- catwalks up both side walls ----
  // The deck's underside is at 4.5 and its walkable surface at 4.9, so the
  // stairs have to climb to 4.9 — climbing to 4.5 puts you under the floor.
  const DECK_BOTTOM = 4.5;
  const DECK_TOP = 4.9;

  for (const side of [-1, 1]) {
    const x = side * 25.5;
    b.push(box(x, DECK_BOTTOM, 0, 7, 0.4, 32, C.catwalk)); // deck, z -16..16
    // Inner railing: 0.9m, too tall to step over but you can jump it to drop off.
    b.push(box(x - side * 3.3, DECK_TOP, 0, 0.3, 0.9, 32, C.rail));
    // Stairs at both ends.
    b.push(...stairs({ x, y: 0, z: -27, width: 5, rise: DECK_TOP, run: 11, axis: 'z', dir: 1, color: C.catwalk }));
    b.push(...stairs({ x, y: 0, z: 27, width: 5, rise: DECK_TOP, run: 11, axis: 'z', dir: -1, color: C.catwalk }));
    // A sightline breaker halfway along, so the catwalk isn't a free firing line.
    // Deliberately only half the deck width — a full-width block would wall the
    // catwalk off completely rather than breaking the angle.
    b.push(box(x + side * 1.75, DECK_TOP, 0, 3.5, 2.6, 1.2, C.steel));
  }

  // ---- spawn rooms ----
  // Partial walls so you aren't shot the instant you appear, with two exits each.
  //
  // The walls themselves are concrete and only carry a thin team-coloured band
  // along the top. Colouring the whole 12x3.6m slab reads as a wall of flat
  // red or blue filling half your screen the moment you spawn, which tells you
  // whose side you're on at the cost of being able to see anything.
  const spawnWalls = [];
  for (const [x, w] of [[-13, 12], [13, 12], [0, 6]]) {
    spawnWalls.push(box(x, 0, -22, w, 3.3, 1, C.wall));
    spawnWalls.push(box(x, 3.3, -22, w, 0.3, 1.05, C.spawnA));
  }
  b.push(...spawnWalls);
  b.push(
    ...mirror(spawnWalls, 'z').map((s) => (s.color === C.spawnA ? { ...s, color: C.spawnB } : s)),
  );

  return b;
}

export default {
  id: 'warehouse',
  name: 'Warehouse',
  blurb: 'Tight indoor lanes. Catwalks trade cover for height.',
  skyColor: 0x5c6470,
  fogColor: 0x51555e,
  fogDensity: 0.01,
  // Indoors: the roof stops the sun reaching most of the floor, so ambient is
  // doing nearly all the work and has to be much stronger than on an open map.
  ambientLight: 1.15,
  sunDirection: [0.25, 1, 0.15],
  sunIntensity: 0.9,
  // Grey brickwork walls over a concrete floor.
  wallTexture: 'brick',
  bounds: { min: [-HALF - 3, -12, -HALF - 3], max: [HALF + 3, CEILING + 3, HALF + 3] },
  boxes: build(),
  // Health pickups. Not solids — you walk over them.
  healthPacks: [
    // Health, out in the open on purpose: taking one means leaving cover.
    [0, 0, 0],            // on the mid platform, the most contested spot
    [-25.5, 4.9, 0],      // west catwalk
    [25.5, 4.9, 0],       // east catwalk
    [-20, 0, -14],
    [20, 0, 14],
  ],

  spawns: {
    A: [
      [-16, 0, -26],
      [-7, 0, -26],
      [0, 0, -27],
      [7, 0, -26],
      [16, 0, -26],
      [-20, 0, -24],
      [20, 0, -24],
    ],
    B: [
      [-16, 0, 26],
      [-7, 0, 26],
      [0, 0, 27],
      [7, 0, 26],
      [16, 0, 26],
      [-20, 0, 24],
      [20, 0, 24],
    ],
    ffa: [
      [-16, 0, -26],
      [16, 0, 26],
      [-20, 0, 10],
      [20, 0, -10],
      [0, 1.8, 0],
      [-25.5, 4.9, -8],
      [25.5, 4.9, 8],
      [-6, 0, 14],
      [6, 0, -14],
      [18, 0, 0],
      [-18, 0, 0],
      [0, 0, 20],
    ],
  },
};
