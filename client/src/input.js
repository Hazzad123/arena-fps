// Keyboard and mouse. Owns pointer lock, because that's what makes this feel
// like a shooter rather than a web page.
//
// Mouse deltas accumulate between frames and are drained by the player
// controller, so look speed doesn't depend on how often mousemove fires.

import { settings } from './settings.js';

const KEY_MAP = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'jump',
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
  ads: false,
  // Consumed-once flags, drained by the frame that received them.
  pressed: new Set(),
  // Accumulated look delta in raw pixels.
  mouseDx: 0,
  mouseDy: 0,
  locked: false,
  weaponSlot: 0, // 1..8 when a number key was hit this frame, else 0
  weaponCycle: 0, // -1 previous, +1 next; mouse wheel, consumed this frame
};

let canvas = null;
const listeners = { lockChange: [] };

export function onLockChange(fn) {
  listeners.lockChange.push(fn);
}

export function initInput(canvasEl) {
  canvas = canvasEl;

  window.addEventListener('keydown', (e) => {
    // Let the browser have its shortcuts when we're not in a match.
    if (!input.locked && e.code !== 'Escape') return;

    const action = KEY_MAP[e.code];
    if (action) {
      input[action] = true;
      input.pressed.add(action);
      // Space and Tab scroll the page otherwise.
      if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
    }

    const num = e.code.match(/^Digit([1-8])$/);
    if (num) input.weaponSlot = Number(num[1]);
  });

  window.addEventListener('keyup', (e) => {
    const action = KEY_MAP[e.code];
    if (action) input[action] = false;
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
    if (e.button === 2) input.ads = true;
  });

  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) input.firing = false;
    if (e.button === 2) input.ads = false;
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
  for (const action of Object.values(KEY_MAP)) input[action] = false;
  input.firing = false;
  input.ads = false;
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

/** Drain accumulated look delta, scaled to radians. */
export function consumeLook() {
  // 0.0022 rad/px at sensitivity 1.0 — roughly 40cm/360° on a typical mouse.
  const scale = 0.0022 * settings.sensitivity;
  const dx = input.mouseDx * scale;
  const dy = input.mouseDy * scale;
  input.mouseDx = 0;
  input.mouseDy = 0;
  return { dx, dy };
}

/** Normalised local-space move direction from WASD. */
export function moveAxes() {
  let x = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  let z = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
  const len = Math.hypot(x, z);
  if (len > 1) {
    x /= len;
    z /= len;
  }
  return { x, z };
}
