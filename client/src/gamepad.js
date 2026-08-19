// Gamepad support.
//
// The Gamepad API is poll-only. There are no events for sticks or buttons, and
// the objects handed back are immutable snapshots, so this is driven from the
// frame loop and writes into the same `input` object the keyboard and mouse write
// into. Nothing downstream needs to know a controller exists — moveAxes() and
// consumeLook() merge the sources, and the held-button helpers OR across devices.
//
// Three things make a stick different from a mouse, and all three are why this
// file exists rather than just mapping axes onto mouse deltas:
//
// 1. A mouse reports displacement; a stick reports deflection. Mouse look is
//    frame-rate independent for free, stick look is a turn *rate* and has to be
//    multiplied by dt or you turn faster on a better machine.
// 2. A stick at rest is not at zero. Every pad has slop and worn ones have a lot,
//    so an untreated stick drifts the view continuously.
// 3. A stick has roughly a centimetre of travel to cover what a mouse gets a
//    whole desk for. Without a response curve you get either twitchy aim or
//    sluggish turning, never both.

import { settings } from './settings.js';
import { input } from './input.js';
import { DEADZONE, stickVector, lookCurve } from '@shared/controls.js';

export { stickVector, lookCurve };

// Radians per second at full deflection, before sensitivity. ~220°/s, a normal
// console turn rate.
const LOOK_RATE = 3.9;

// How far a trigger travels before it counts as pressed.
const TRIGGER_THRESHOLD = 0.4;

// A pad is "in use" for this long after the last input. Gates the rule that
// losing pointer lock opens the pause menu — a controller never locks the
// pointer, so without this a pad player would sit in a permanent pause screen.
const ACTIVITY_GRACE_MS = 30_000;

// Standard Gamepad layout, which every mainstream pad reports. We check
// `mapping === 'standard'` before trusting any of it.
const BUTTON = {
  A: 0,     // jump
  B: 1,     // crouch (hold)
  X: 2,     // reload
  Y: 3,     // use / pick up loot
  LB: 4,    // previous weapon
  RB: 5,    // next weapon
  LT: 6,    // aim down sights
  RT: 7,    // fire
  BACK: 8,  // scoreboard (hold)
  START: 9, // pause
  L3: 10,   // sprint
  R3: 11,   // knife
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
};

const AXIS = { MOVE_X: 0, MOVE_Y: 1, LOOK_X: 2, LOOK_Y: 3 };

/** Buttons that act on the press rather than while held. */
const TAP_ACTIONS = [
  [BUTTON.X, 'reload'],
  [BUTTON.Y, 'use'],
  [BUTTON.DPAD_LEFT, 'emoteWave'],
  [BUTTON.DPAD_UP, 'emoteYes'],
  [BUTTON.DPAD_DOWN, 'emoteNo'],
];

const state = {
  // Index of the pad we listen to. The first one actually touched wins, so a
  // plugged-in-but-idle second pad can't fight the first.
  index: null,
  lastActivityAt: 0,
  connected: false,
  // Previous frame's button states, for edge detection.
  wasDown: new Map(),
  // Set on the frame START is tapped; drained by the caller.
  pausePressed: false,
  knifePressed: false,
};

function pads() {
  return typeof navigator !== 'undefined' && navigator.getGamepads
    ? [...navigator.getGamepads()]
    : [];
}

/** Has a controller been used recently enough to be driving the game? */
export function padEngaged(now = performance.now()) {
  return state.connected && now - state.lastActivityAt < ACTIVITY_GRACE_MS;
}

export function padConnected() {
  return state.connected;
}

/** Consume the pause request from START. */
export function consumePadPause() {
  if (!state.pausePressed) return false;
  state.pausePressed = false;
  return true;
}

/** Consume the melee request from clicking the right stick. */
export function consumePadKnife() {
  if (!state.knifePressed) return false;
  state.knifePressed = false;
  return true;
}

function isDown(pad, index) {
  const button = pad.buttons[index];
  return !!button && button.pressed;
}

function analogue(pad, index) {
  const button = pad.buttons[index];
  if (!button) return 0;
  // Triggers report a continuous value on most pads and only `pressed` on some.
  return button.value > 0 ? button.value : (button.pressed ? 1 : 0);
}

/** Fire once per press, mirroring consumePressed()'s contract for the keyboard. */
function edge(pad, index) {
  const down = isDown(pad, index);
  const was = state.wasDown.get(index) ?? false;
  state.wasDown.set(index, down);
  return down && !was;
}

/**
 * Read nothing but START.
 *
 * Called while the pause menu or chat is open, where a resting stick must not
 * nudge the view and a resting trigger must not fire — but START still has to
 * work, because on a controller it is the only way back out. Polling nothing at
 * all here is what left a pad player able to open the pause menu and never close
 * it again.
 */
export function pollGamepadPauseOnly() {
  for (const pad of pads()) {
    if (!pad || pad.mapping !== 'standard') continue;
    if (edge(pad, BUTTON.START)) {
      state.pausePressed = true;
      state.lastActivityAt = performance.now();
    }
  }
}

/**
 * Poll the active pad and fold it into `input`.
 *
 * `dt` is the frame time in seconds, because stick look is a rate.
 * `lookScale` lets the caller slow the aim near a target — see aimAssistScale in
 * main.js. It multiplies the pad only, so mouse players are untouched by it.
 *
 * Returns true if a pad contributed this frame.
 */
export function pollGamepads(dt, { lookScale = 1, allowLook = true } = {}) {
  const list = pads();
  state.connected = list.some((pad) => pad && pad.mapping === 'standard');

  let active = null;
  // Stay with the pad already chosen, while it's still attached.
  if (state.index !== null && list[state.index]) {
    active = list[state.index];
  } else {
    state.index = null;
    // Otherwise adopt the first pad showing deflection or a button down. Waiting
    // for actual input avoids latching onto a connected-but-unused pad.
    for (const pad of list) {
      if (!pad || pad.mapping !== 'standard') continue;
      const touched = pad.buttons.some((b) => b.pressed || b.value > TRIGGER_THRESHOLD)
        || pad.axes.some((a) => Math.abs(a) > DEADZONE + 0.1);
      if (touched) {
        state.index = pad.index;
        active = pad;
        break;
      }
    }
  }

  if (!active) return false;
  const now = performance.now();

  // ---- sticks ----
  const move = stickVector(active.axes[AXIS.MOVE_X] ?? 0, active.axes[AXIS.MOVE_Y] ?? 0);
  // Stick Y is positive downward; forward is negative.
  input.padMoveX = move.x;
  input.padMoveZ = -move.y;
  if (move.magnitude > 0) state.lastActivityAt = now;

  if (allowLook) {
    const look = stickVector(active.axes[AXIS.LOOK_X] ?? 0, active.axes[AXIS.LOOK_Y] ?? 0);
    const rate = LOOK_RATE * settings.padSensitivity * lookScale * dt;
    input.padLookDx += lookCurve(look.x) * rate;
    input.padLookDy += lookCurve(look.y) * rate * (settings.invertY ? -1 : 1);
    if (look.magnitude > 0) state.lastActivityAt = now;
  }

  // ---- held ----
  input.padFiring = analogue(active, BUTTON.RT) >= TRIGGER_THRESHOLD;
  input.padJump = isDown(active, BUTTON.A);
  input.padCrouch = isDown(active, BUTTON.B);
  input.padSprint = isDown(active, BUTTON.L3);
  input.padScoreboard = isDown(active, BUTTON.BACK);

  // Aim goes through the same held/latched path as the mouse, so the toggle
  // setting applies to the trigger too.
  const adsDown = analogue(active, BUTTON.LT) >= TRIGGER_THRESHOLD;
  if (adsDown !== (state.wasDown.get(BUTTON.LT) ?? false)) {
    state.wasDown.set(BUTTON.LT, adsDown);
    if (settings.adsToggle) {
      if (adsDown) input.adsLatched = !input.adsLatched;
    } else {
      input.padAds = adsDown;
      input.adsHeld = adsDown;
    }
  }

  if (input.padFiring || input.padJump || input.padCrouch || input.padSprint || adsDown) {
    state.lastActivityAt = now;
  }

  // ---- tapped ----
  for (const [button, action] of TAP_ACTIONS) {
    if (edge(active, button)) {
      input.pressed.add(action);
      state.lastActivityAt = now;
    }
  }

  // Shoulder buttons step through the inventory; the wheel path already handles
  // one step per frame, so reuse it rather than inventing a second mechanism.
  if (edge(active, BUTTON.RB)) {
    input.weaponCycle = 1;
    state.lastActivityAt = now;
  } else if (edge(active, BUTTON.LB)) {
    input.weaponCycle = -1;
    state.lastActivityAt = now;
  }

  if (edge(active, BUTTON.R3)) {
    state.knifePressed = true;
    state.lastActivityAt = now;
  }
  if (edge(active, BUTTON.START)) {
    state.pausePressed = true;
    state.lastActivityAt = now;
  }

  return true;
}

/**
 * Zero the pad's contribution to movement, aim and firing.
 *
 * Deliberately leaves the edge-detection history alone. This runs every frame the
 * pause menu is open, and clearing `wasDown` there would make a held START button
 * look like a fresh press on every single frame — the menu would strobe open and
 * shut. Forgetting which buttons were down is resetGamepad's job, not this one.
 */
export function releaseGamepad() {
  input.padMoveX = 0;
  input.padMoveZ = 0;
  input.padLookDx = 0;
  input.padLookDy = 0;
  input.padFiring = false;
  input.padAds = false;
  input.padJump = false;
  input.padCrouch = false;
  input.padSprint = false;
  input.padScoreboard = false;
}

/** Forget the pad entirely, so a different controller can claim the slot. */
export function resetGamepad() {
  state.index = null;
  state.wasDown.clear();
  state.pausePressed = false;
  state.knifePressed = false;
  releaseGamepad();
}
