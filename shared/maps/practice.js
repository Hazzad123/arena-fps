// PRACTICE RANGE — single player, no server, no timer.
//
// A place to learn the guns and the movement. Runs entirely client-side, so it
// works before you've got anyone to play against (and it's how the movement and
// gunplay get verified during development).
//
// Unlike the multiplayer maps this one carries a `targets` array. Targets are
// simulated by the client — see client/src/practice.js.

import { box, stairs, crateStack } from './helpers.js';

const C = {
  ground: 0x7f8574,
  wall: 0x9ba18d,
  line: 0xd8c264,
  bench: 0x8b806e,
  berm: 0x8a7c62,
  frame: 0x5c6252,
  crate: 0xb28c54,
  sign: 0x4c5242,
};

const X_HALF = 26;
const Z_MIN = -16;
const Z_MAX = 122;

function build() {
  const b = [];
  const depth = Z_MAX - Z_MIN;
  const midZ = (Z_MAX + Z_MIN) / 2;

  // ---- shell ----
  b.push(box(0, -1, midZ, X_HALF * 2 + 4, 1, depth + 4, C.ground));
  b.push(box(-X_HALF - 1, 0, midZ, 2, 9, depth + 4, C.wall));
  b.push(box(X_HALF + 1, 0, midZ, 2, 9, depth + 4, C.wall));
  b.push(box(0, 0, Z_MIN - 1, X_HALF * 2 + 4, 9, 2, C.wall));
  b.push(box(0, 0, Z_MAX + 1, X_HALF * 2 + 4, 12, 2, C.berm)); // backstop

  // ---- firing line ----
  b.push(box(0, 0, -0.6, X_HALF * 2, 0.12, 0.5, C.line));
  // Benches flank the centre lane rather than blocking it — you want to be able
  // to walk straight down range to look at where your shots landed.
  b.push(box(-7, 0, -2.2, 5, 1.05, 1.2, C.bench));
  b.push(box(7, 0, -2.2, 5, 1.05, 1.2, C.bench));
  b.push(box(-15, 0, -2.2, 5, 1.05, 1.2, C.bench));
  b.push(box(15, 0, -2.2, 5, 1.05, 1.2, C.bench));

  // ---- distance markers, so you learn what falloff feels like ----
  for (const z of [10, 25, 50, 75, 100]) {
    b.push(box(-X_HALF + 1.5, 0, z, 1, 0.3, 0.6, C.line));
    b.push(box(X_HALF - 1.5, 0, z, 1, 0.3, 0.6, C.line));
    b.push(box(-X_HALF + 2.4, 0.3, z, 0.25, 2.2, 0.25, C.sign));
  }

  // ---- target frames (scenery; the targets themselves are dynamic) ----
  for (const z of [10, 25, 50, 100]) {
    for (const x of [-6, 0, 6]) {
      b.push(box(x - 1.2, 0, z + 0.5, 0.2, 2.6, 0.2, C.frame));
      b.push(box(x + 1.2, 0, z + 0.5, 0.2, 2.6, 0.2, C.frame));
      b.push(box(x, 2.6, z + 0.5, 2.6, 0.2, 0.2, C.frame));
    }
  }

  // ---- movement course, left side ----
  // Somewhere to feel out jump distance, step-up and the crouch height.
  b.push(...stairs({ x: -18, y: 0, z: 6, width: 5, rise: 2.4, run: 6, axis: 'z', dir: 1, color: C.crate }));
  b.push(box(-18, 2.4, 16, 5, 0.4, 8, C.bench));
  b.push(box(-18, 0, 26, 4, 2.8, 4, C.crate)); // 3m gap: a running jump
  b.push(box(-18, 0, 34, 4, 2.8, 4, C.crate)); // 4m gap
  b.push(box(-18, 0, 43.5, 4, 2.8, 4, C.crate)); // 5.5m gap — the tricky one
  b.push(...crateStack({ x: -22, z: 20, size: 1.5, height: 2, color: C.crate, seed: 3 }));
  // A low tunnel that only fits a crouching player.
  b.push(box(-18, 1.3, 52, 5, 2, 4, C.bench));
  b.push(box(-20.4, 0, 52, 0.4, 1.3, 4, C.frame));
  b.push(box(-15.6, 0, 52, 0.4, 1.3, 4, C.frame));

  // ---- cover to practise peeking, right side ----
  for (let i = 0; i < 4; i++) {
    b.push(box(17 + (i % 2) * 3, 0, 12 + i * 9, 3.5, 1.5, 0.6, C.bench));
  }

  return b;
}

// Target kinds are simulated client-side:
//   static — stands still
//   slide  — travels between two points and back
//   bob    — rises and falls on the spot
//   popup  — appears and hides on a cycle
export const TARGET_KINDS = ['static', 'slide', 'bob', 'popup'];

function staticRow(z, xs, size = 0.55) {
  return xs.map((x) => ({ kind: 'static', pos: [x, 1.25, z], size }));
}

export default {
  id: 'practice',
  name: 'Practice Range',
  blurb: 'Single player. Learn the guns, no one shooting back.',
  singlePlayer: true,
  skyColor: 0x8fa7b8,
  fogColor: 0xa8bac6,
  fogDensity: 0.004,
  ambientLight: 0.85,
  // Kept deliberately low in the sky so walls and crate faces catch light —
  // an overhead sun leaves every vertical surface flat and murky.
  sunDirection: [0.5, 0.72, -0.5],
  sunIntensity: 1.15,
  bounds: { min: [-X_HALF - 4, -12, Z_MIN - 4], max: [X_HALF + 4, 30, Z_MAX + 4] },
  boxes: build(),
  spawns: { ffa: [[0, 0, -8]], A: [[0, 0, -8]], B: [[0, 0, -8]] },
  // Face down-range (+Z). Forward at yaw 0 is -Z, so this is a half turn.
  spawnYaw: Math.PI,

  targets: [
    // Static rows at known distances — good for learning damage falloff.
    ...staticRow(10, [-6, 0, 6], 0.6),
    ...staticRow(25, [-6, 0, 6], 0.55),
    ...staticRow(50, [-6, 0, 6], 0.5),
    ...staticRow(100, [-6, 0, 6], 0.5),

    // Sliding targets — tracking practice. Faster the further out they are.
    { kind: 'slide', from: [-10, 1.3, 18], to: [10, 1.3, 18], period: 5.0, size: 0.55 },
    { kind: 'slide', from: [12, 1.3, 35], to: [-12, 1.3, 35], period: 4.0, size: 0.55 },
    { kind: 'slide', from: [-14, 1.3, 68], to: [14, 1.3, 68], period: 6.5, size: 0.6 },

    // Bobbing targets — vertical tracking.
    { kind: 'bob', pos: [-4, 1.6, 60], amplitude: 1.1, period: 2.6, size: 0.5 },
    { kind: 'bob', pos: [4, 1.6, 60], amplitude: 1.1, period: 3.4, size: 0.5 },

    // Pop-ups — reaction and target acquisition.
    { kind: 'popup', pos: [-13, 1.3, 14], upTime: 1.5, downTime: 2.2, size: 0.6 },
    { kind: 'popup', pos: [13, 1.3, 14], upTime: 1.5, downTime: 3.0, size: 0.6 },
    { kind: 'popup', pos: [-9, 1.3, 31], upTime: 1.1, downTime: 2.6, size: 0.55 },
    { kind: 'popup', pos: [9, 1.3, 31], upTime: 1.1, downTime: 1.9, size: 0.55 },
    { kind: 'popup', pos: [0, 1.3, 44], upTime: 0.9, downTime: 2.4, size: 0.55 },
  ],
};
