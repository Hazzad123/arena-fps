// Control bindings and analogue-stick maths.
//
// This lives in shared/ rather than client/src/ for one practical reason: it has
// no imports and touches no DOM, so the test suite can load it directly. The
// client modules that use it (input.js, gamepad.js) both pull in settings.js,
// which reaches for the `@shared` bundler alias that plain Node can't resolve.
//
// Everything here is pure. The bindings are data and the stick functions are
// maths, which means the parts most likely to be quietly wrong are also the parts
// that are cheapest to assert on.

/** Bindings common to every control scheme. */
export const BASE_KEY_MAP = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  ControlLeft: 'crouch',
  KeyC: 'crouch',
  KeyR: 'reload',
  KeyE: 'use',
  KeyT: 'resetPractice',
  KeyL: 'lobby',
  KeyZ: 'emoteWave',
  KeyX: 'emoteYes',
  KeyV: 'emoteNo',
  Tab: 'scoreboard',
};

/**
 * Per-scheme additions.
 *
 * The trackpad row is the whole reason this abstraction exists. On a trackpad a
 * right-click is a two-finger tap or a corner press — not something you can do
 * while dragging to aim — and holding a click down while dragging is worse still.
 * So firing and aiming both move onto the keyboard, which leaves the trackpad
 * doing nothing but aiming. Jump moves to F because Space is now the trigger.
 */
export const SCHEME_KEYS = {
  mouse: { Space: 'jump' },
  pad: { Space: 'jump' },
  trackpad: {
    Space: 'firing',
    KeyF: 'jump',
    KeyQ: 'adsKey',
  },
};

export const SCHEMES = Object.keys(SCHEME_KEYS);

/** The complete binding table for a scheme. */
export function keyMapFor(scheme) {
  return { ...BASE_KEY_MAP, ...(SCHEME_KEYS[scheme] ?? SCHEME_KEYS.mouse) };
}

/** Every action any scheme can bind, so held state can be cleared exhaustively. */
export const ALL_ACTIONS = [
  ...new Set([
    ...Object.values(BASE_KEY_MAP),
    ...Object.values(SCHEME_KEYS).flatMap((m) => Object.values(m)),
  ]),
];

// ------------------------------------------------------------ analogue sticks

/** Anything inside this radius counts as centred. */
export const DEADZONE = 0.18;

/** Look response exponent. Squared: fine near the centre, full speed at the edge. */
export const LOOK_EXPO = 2.0;

/**
 * Radial deadzone.
 *
 * Applied to the stick as a pair, not per-axis. A per-axis deadzone makes a round
 * stick behave like a square one: push diagonally and both axes clear the zone at
 * the same moment, so the output snaps to exactly 45°. Taking the magnitude of the
 * pair keeps diagonals continuous.
 *
 * The magnitude is then rescaled so the edge of the deadzone reads as 0 and the
 * edge of the stick still reads as 1. Skip that and you lose a deadzone's worth of
 * travel off the top, and full sprint or full turn speed becomes unreachable.
 */
export function stickVector(x, y, deadzone = DEADZONE) {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= deadzone) return { x: 0, y: 0, magnitude: 0 };
  const scaled = Math.min(1, (magnitude - deadzone) / (1 - deadzone));
  // Unit direction, then reapply the rescaled magnitude.
  return { x: (x / magnitude) * scaled, y: (y / magnitude) * scaled, magnitude: scaled };
}

/** The look response curve. Preserves direction, compresses the centre. */
export function lookCurve(value, expo = LOOK_EXPO) {
  return Math.sign(value) * Math.abs(value) ** expo;
}
