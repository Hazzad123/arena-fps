// Keyboard, mouse and gamepad. Owns pointer lock, because that's what makes this
// feel like a shooter rather than a web page.
//
// Mouse deltas accumulate between frames and are drained once per frame, so look
// speed doesn't depend on how often mousemove fires.
//
// ---------------------------------------------------------------------------
// Control schemes
//
// Three input devices with genuinely different constraints, not three skins over
// the same bindings:
//
// - `mouse`    — the default. Hold to fire, right-click to aim.
// - `trackpad` — right-click is a two-finger tap or a corner press, which is not
//                something you can do mid-aim, and holding a click while dragging
//                is worse. So the trackpad scheme moves both onto the keyboard:
//                Space fires and Q aims, leaving the pad free to do nothing but
//                aim. Jump moves to F because Space is spoken for. Aim is a
//                toggle here, since holding a key while dragging is the exact
//                thing we're trying to avoid.
// - `pad`       — a controller. See gamepad.js; this file only merges its state.
//
// Every scheme keeps the mouse and keyboard live. The scheme decides the *extra*
// bindings and the defaults, it never takes anything away, so someone who picked
// trackpad and later plugs in a mouse isn't stuck.

import { settings } from './settings.js';

import { SCHEMES, keyMapFor, ALL_ACTIONS } from '@shared/controls.js';

export { SCHEMES };

/** The live binding table for the chosen scheme. */
export function keyMap() {
  return keyMapFor(settings.scheme ?? 'mouse');
}

export const input = {
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  sprint: false,
  crouch: false,
  reload: false,
  use: false,
  lobby: false,
  emoteWave: false,
  emoteYes: false,
  emoteNo: false,
  scoreboard: false,
  firing: false,

  // Aim is three states rather than one, because it can be held (right mouse,
  // left trigger) or latched (the toggle setting, and the trackpad's Q). Keeping
  // them separate means releasing the button can't clear a latch it never set.
  adsHeld: false,
  adsLatched: false,
  get ads() {
    return this.adsHeld || this.adsLatched;
  },

  // Consumed-once flags, drained by the frame that received them.
  pressed: new Set(),

  // Accumulated look delta in raw pixels, from the mouse or trackpad.
  mouseDx: 0,
  mouseDy: 0,
  locked: false,
  weaponSlot: 0, // 1..8 when a number key was hit this frame, else 0
  weaponCycle: 0, // -1 previous, +1 next; mouse wheel, consumed this frame

  // Gamepad contribution, written by gamepad.js. Analogue rather than boolean,
  // so a half-pressed stick walks instead of sprinting.
  padMoveX: 0,
  padMoveZ: 0,
  // Already in radians — a stick is a turn rate, not a pixel delta, so it can't
  // share the mouse's pixels-to-radians scaling.
  padLookDx: 0,
  padLookDy: 0,
  padFiring: false,
  padAds: false,
  // Jump is held rather than tapped, because holding it to hop repeatedly is
  // normal movement. It can't be written straight into input.jump — the pad is
  // polled every frame and would stamp on the keyboard's copy.
  padJump: false,
  padCrouch: false,
  padSprint: false,
  padScoreboard: false,
};

let canvas = null;
const listeners = { lockChange: [] };

export function onLockChange(fn) {
  listeners.lockChange.push(fn);
}

/**
 * Aim input arrived. Held or latched depending on the setting, which is what
 * makes one code path serve right-mouse, the trigger and the trackpad's Q.
 */
function pressAds() {
  if (settings.adsToggle) input.adsLatched = !input.adsLatched;
  else input.adsHeld = true;
}

function releaseAds() {
  if (!settings.adsToggle) input.adsHeld = false;
}

/** Drop the latch — on death, on a weapon change, on leaving a match. */
export function clearAds() {
  input.adsHeld = false;
  input.adsLatched = false;
}

function applyKey(action, down) {
  if (action === 'adsKey') {
    if (down) pressAds();
    else releaseAds();
    return;
  }

  input[action] = down;
  if (!down) return;

  input.pressed.add(action);
  // Firing from the keyboard has to look exactly like a mouse click, or
  // semi-automatics won't register the press.
  if (action === 'firing') input.pressed.add('fire');
}

export function initInput(canvasEl) {
  canvas = canvasEl;

  window.addEventListener('keydown', (e) => {
    // Let the browser have its shortcuts when we're not in a match.
    if (!input.locked && e.code !== 'Escape') return;

    const action = keyMap()[e.code];
    if (action) {
      // Ignore auto-repeat: a held key must not re-toggle the aim latch or
      // re-fire a semi-automatic.
      if (!e.repeat) applyKey(action, true);
      // Space and Tab scroll the page otherwise.
      if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
    }

    const num = e.code.match(/^Digit([1-8])$/);
    if (num) input.weaponSlot = Number(num[1]);
  });

  window.addEventListener('keyup', (e) => {
    const action = keyMap()[e.code];
    if (action) applyKey(action, false);
  });

  document.addEventListener('mousemove', (e) => {
    if (!input.locked) return;
    input.mouseDx += e.movementX || 0;
    input.mouseDy += (e.movementY || 0) * (settings.invertY ? -1 : 1);
  });

  // Wheel down advances through the inventory, wheel up goes back. Keep this
  // as a single step per frame: high-resolution trackpads can emit dozens of
  // tiny events for one gesture and must not skip the whole loadout.
  document.addEventListener('wheel', (e) => {
    if (!input.locked || e.deltaY === 0) return;
    e.preventDefault();
    input.weaponCycle = e.deltaY > 0 ? 1 : -1;
  }, { passive: false });

  document.addEventListener('mousedown', (e) => {
    if (!input.locked) return;
    e.preventDefault();
    if (e.button === 0) {
      input.firing = true;
      input.pressed.add('fire');
    }
    if (e.button === 2) pressAds();
  });

  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) input.firing = false;
    if (e.button === 2) releaseAds();
  });

  // Right-click is aim-down-sights, so the context menu has to go.
  document.addEventListener('contextmenu', (e) => {
    if (input.locked) e.preventDefault();
  });

  document.addEventListener('pointerlockchange', () => {
    input.locked = document.pointerLockElement === canvas;
    if (!input.locked) releaseAllKeys();
    for (const fn of listeners.lockChange) fn(input.locked);
  });

  // Losing focus mid-game leaves keys stuck down otherwise.
  window.addEventListener('blur', releaseAllKeys);
}

function releaseAllKeys() {
  for (const action of ALL_ACTIONS) {
    if (action !== 'adsKey') input[action] = false;
  }
  input.firing = false;
  clearAds();
  input.mouseDx = 0;
  input.mouseDy = 0;
  clearPressed();
}

export async function requestLock() {
  if (!canvas || input.locked) return;
  try {
    // unadjustedMovement bypasses OS mouse acceleration, which matters a lot
    // for aim consistency. Not supported everywhere, hence the fallback.
    await canvas.requestPointerLock({ unadjustedMovement: true });
  } catch {
    try {
      await canvas.requestPointerLock();
    } catch {
      /* user gesture required, or the browser refused — the resume overlay
         will prompt for another click */
    }
  }
}

export function exitLock() {
  if (document.pointerLockElement) document.exitPointerLock();
}

/** True once per press. */
export function consumePressed(action) {
  if (!input.pressed.has(action)) return false;
  input.pressed.delete(action);
  return true;
}

export function clearPressed() {
  input.pressed.clear();
  input.weaponSlot = 0;
  input.weaponCycle = 0;
}

/**
 * Drain the accumulated look delta, in radians.
 *
 * The two sources are scaled differently on purpose. Mouse movement is a pixel
 * displacement, so it converts at a fixed radians-per-pixel and needs no frame
 * time. Stick deflection is a turn rate that gamepad.js has already multiplied
 * by dt, so it arrives in radians and must not be scaled again — running it
 * through the mouse sensitivity would make the two settings fight.
 */
export function consumeLook() {
  // 0.0022 rad/px at sensitivity 1.0 — roughly 40cm/360° on a typical mouse.
  const scale = 0.0022 * settings.sensitivity;
  const dx = input.mouseDx * scale + input.padLookDx;
  const dy = input.mouseDy * scale + input.padLookDy;
  input.mouseDx = 0;
  input.mouseDy = 0;
  input.padLookDx = 0;
  input.padLookDy = 0;
  return { dx, dy };
}

/**
 * Normalised local-space move direction, merging WASD with the left stick.
 *
 * Only clamped when the combined length exceeds 1, so a stick pushed halfway
 * walks at half speed — analogue movement falls out for free, and holding W
 * while nudging the stick can't make you faster than either alone.
 */
export function moveAxes() {
  let x = (input.right ? 1 : 0) - (input.left ? 1 : 0) + input.padMoveX;
  let z = (input.forward ? 1 : 0) - (input.back ? 1 : 0) + input.padMoveZ;
  const len = Math.hypot(x, z);
  if (len > 1) {
    x /= len;
    z /= len;
  }
  return { x, z };
}

/** Sprint, crouch, fire and the scoreboard, OR-ed across every device. */
export function sprintHeld() {
  return input.sprint || input.padSprint;
}

export function crouchHeld() {
  return input.crouch || input.padCrouch;
}

export function firingHeld() {
  return input.firing || input.padFiring;
}

export function scoreboardHeld() {
  return input.scoreboard || input.padScoreboard;
}

export function jumpHeld() {
  return input.jump || input.padJump;
}
