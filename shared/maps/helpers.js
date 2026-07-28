// Level-authoring helpers.
//
// Every map is just an array of axis-aligned boxes. These helpers exist so the
// map files read like a description of a place rather than a wall of numbers.
//
// Convention throughout: `y` is the BOTTOM of the box, because that's how you
// actually think about level geometry ("a 2m crate on the floor", not "a crate
// centred at y=1"). compileBox in collision.js expects centres, so we convert.

import { STEP_HEIGHT } from '../constants.js';

/** A box resting with its underside at `y`, centred on `x`/`z`. */
export function box(x, y, z, w, h, d, color, tag) {
  return { pos: [x, y + h / 2, z], size: [w, h, d], color, tag };
}

/**
 * Solid cover that the client draws as a model.
 *
 * It's an ordinary box in every way that matters: the server collides with it,
 * the navigation tests route around it, and if the model never downloads you get
 * a plainly-coloured box of exactly the same size. `file` names a glTF in
 * client/public/models/props.
 */
export function prop(x, y, z, w, h, d, color, file) {
  return box(x, y, z, w, h, d, color, `prop:${file}`);
}

/**
 * An explosive barrel: cover that stops being cover.
 *
 * Tagged separately from an ordinary prop so the server can give it hit points
 * and the client knows to report shots against it. Place these deliberately and
 * sparingly — a barrel is a decision the room has to play around, and a map
 * littered with them is just a map where everything explodes.
 */
export function barrel(x, y, z, color = 0xb4472e) {
  return box(x, y, z, 0.78, 1.02, 0.78, color, 'barrel:ExplodingBarrel');
}

/**
 * A staircase built from solid blocks.
 *
 * We have no sloped surfaces — the world is axis-aligned boxes only — so ramps
 * are stairs. Step height is kept under STEP_HEIGHT so the movement code's
 * auto-step carries you up smoothly and it *feels* like a ramp.
 *
 * axis: 'x' | 'z' — which way the staircase climbs
 * dir:  +1 | -1   — direction along that axis
 */
export function stairs({ x, y, z, width, rise, run, axis = 'z', dir = 1, color }) {
  const stepCount = Math.max(1, Math.ceil(rise / (STEP_HEIGHT * 0.85)));
  const stepRise = rise / stepCount;
  const stepRun = run / stepCount;
  const out = [];

  for (let i = 0; i < stepCount; i++) {
    const offset = dir * (i * stepRun + stepRun / 2);
    const h = (i + 1) * stepRise;
    if (axis === 'z') {
      out.push(box(x, y, z + offset, width, h, stepRun, color));
    } else {
      out.push(box(x + offset, y, z, stepRun, h, width, color));
    }
  }
  return out;
}

/**
 * Four perimeter walls around a rectangle, built inward from the given extent
 * so the playable area is exactly w x d.
 */
export function enclose({ x = 0, z = 0, w, d, h, y = 0, thickness = 1, color }) {
  const t = thickness;
  return [
    box(x, y, z - d / 2 - t / 2, w + t * 2, h, t, color),
    box(x, y, z + d / 2 + t / 2, w + t * 2, h, t, color),
    box(x - w / 2 - t / 2, y, z, t, h, d, color),
    box(x + w / 2 + t / 2, y, z, t, h, d, color),
  ];
}

/** A stack of crates, slightly jittered so it doesn't look machine-made. */
export function crateStack({ x, y = 0, z, size = 1.6, height = 2, color, seed = 1 }) {
  const out = [];
  let rnd = seed * 9301;
  const next = () => {
    rnd = (rnd * 9301 + 49297) % 233280;
    return rnd / 233280;
  };
  for (let i = 0; i < height; i++) {
    const s = size * (1 - i * 0.08);
    const jx = (next() - 0.5) * size * 0.25;
    const jz = (next() - 0.5) * size * 0.25;
    // Tagged so the renderer can draw a crate model in this box's place. The box
    // is still the box — collision, the server's copy of it and the navigation
    // tests all see exactly what they saw before, only the picture changes.
    out.push(box(x + jx, y + i * size, z + jz, s, size, s, color, 'crate'));
  }
  return out;
}

/** A shelving rack: two solid uprights with a shootable gap between them. */
export function rack({ x, z, length, axis = 'z', height = 3.2, color }) {
  const legW = 0.5;
  const shelfH = 0.25;
  const out = [];
  const along = axis === 'z' ? 'z' : 'x';

  const mk = (cx, cz, w, h, d) => box(cx, 0, cz, w, h, d, color);

  if (along === 'z') {
    out.push(mk(x - 0.9, z, legW, height, length));
    out.push(mk(x + 0.9, z, legW, height, length));
    // Shelf decks — you can shoot under and over them.
    out.push(box(x, 1.4, z, 2.3, shelfH, length, color));
    out.push(box(x, height - shelfH, z, 2.3, shelfH, length, color));
  } else {
    out.push(mk(x, z - 0.9, length, height, legW));
    out.push(mk(x, z + 0.9, length, height, legW));
    out.push(box(x, 1.4, z, length, shelfH, 2.3, color));
    out.push(box(x, height - shelfH, z, length, shelfH, 2.3, color));
  }
  return out;
}

/** A raised platform with a lip, plus stairs up to it. */
export function platform({ x, y, z, w, d, color, stairSide = 'z-', stairWidth = 3 }) {
  const out = [box(x, y - 0.4, z, w, 0.4, d, color)];
  const rise = y;
  const run = Math.max(2, rise * 2.6);

  if (stairSide === 'z-') {
    out.push(...stairs({ x, y: 0, z: z - d / 2 - run, width: stairWidth, rise, run, axis: 'z', dir: 1, color }));
  } else if (stairSide === 'z+') {
    out.push(...stairs({ x, y: 0, z: z + d / 2 + run, width: stairWidth, rise, run, axis: 'z', dir: -1, color }));
  } else if (stairSide === 'x-') {
    out.push(...stairs({ x: x - w / 2 - run, y: 0, z, width: stairWidth, rise, run, axis: 'x', dir: 1, color }));
  } else {
    out.push(...stairs({ x: x + w / 2 + run, y: 0, z, width: stairWidth, rise, run, axis: 'x', dir: -1, color }));
  }
  return out;
}

/** Mirror boxes across an axis — the cheap way to keep a map symmetric. */
export function mirror(boxes, axis = 'z') {
  const i = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  return boxes.map((b) => ({
    ...b,
    pos: b.pos.map((v, k) => (k === i ? -v : v)),
    size: [...b.size],
  }));
}
