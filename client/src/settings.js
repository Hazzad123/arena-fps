// Persisted player settings. localStorage only — there are no accounts, so this
// is the entire notion of "your profile".

import { DEFAULT_FOV, DEFAULT_SENSITIVITY, MIN_FOV, MAX_FOV } from '@shared/constants.js';
import { getPrimary, DEFAULT_PRIMARY } from '@shared/weapons.js';

const KEY = 'arena.settings.v1';

/**
 * Sensible starting points per control scheme, applied when the scheme is chosen
 * rather than baked in as global defaults.
 *
 * The trackpad numbers are the interesting ones. A trackpad has perhaps a tenth
 * of the usable travel of a mouse on a desk, and you have to lift and reposition
 * constantly, which stops the motion dead. So it gets a much higher sensitivity —
 * enough to turn 180° inside one comfortable swipe — and aim-as-a-toggle, because
 * holding a key down while dragging is precisely the thing that doesn't work.
 */
export const SCHEME_DEFAULTS = {
  mouse: { sensitivity: DEFAULT_SENSITIVITY, adsToggle: false },
  trackpad: { sensitivity: 2.1, adsToggle: true },
  pad: { sensitivity: DEFAULT_SENSITIVITY, adsToggle: false },
};

const DEFAULTS = {
  nickname: '',
  sensitivity: DEFAULT_SENSITIVITY,
  fov: DEFAULT_FOV,
  volume: 0.7,
  invertY: false,
  // Whichever gun you picked last. People settle on one and shouldn't have to
  // re-pick it every time they open the tab.
  primaryId: DEFAULT_PRIMARY,

  // 'mouse' | 'trackpad' | 'pad'. Null until the chooser has been answered,
  // which is also how we know whether to show it.
  scheme: null,
  // Stick look multiplier. Separate from mouse sensitivity because the two are
  // different units entirely — see consumeLook in input.js.
  padSensitivity: 1,
  // Aim latches instead of being held. Essential on a trackpad, and a genuine
  // accessibility win everywhere else.
  adsToggle: false,
  // Slow the aim near a target, for stick users only. Without it a pad simply
  // cannot compete with a mouse in an aim duel.
  aimAssist: true,
};

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      nickname: String(parsed.nickname ?? '').slice(0, 14),
      sensitivity: clamp(Number(parsed.sensitivity) || DEFAULT_SENSITIVITY, 0.2, 4),
      fov: clamp(Number(parsed.fov) || DEFAULT_FOV, MIN_FOV, MAX_FOV),
      volume: clamp(Number(parsed.volume ?? DEFAULTS.volume), 0, 1),
      invertY: Boolean(parsed.invertY),
      primaryId: getPrimary(parsed.primaryId),
      scheme: SCHEME_DEFAULTS[parsed.scheme] ? parsed.scheme : null,
      padSensitivity: clamp(Number(parsed.padSensitivity) || 1, 0.3, 3),
      adsToggle: Boolean(parsed.adsToggle),
      aimAssist: parsed.aimAssist === undefined ? true : Boolean(parsed.aimAssist),
    };
  } catch {
    // Corrupt or blocked storage shouldn't stop someone playing.
    return { ...DEFAULTS };
  }
}

export const settings = load();

export function saveSettings() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private browsing — settings just won't persist */
  }
}

/**
 * Adopt a control scheme and its defaults.
 *
 * Only overwrites the tuning values the scheme actually has an opinion about, and
 * only when switching to a different scheme — re-picking the one you're already
 * on shouldn't silently throw away a sensitivity you've tuned by hand.
 */
export function applyScheme(scheme) {
  if (!SCHEME_DEFAULTS[scheme]) return false;
  const changed = settings.scheme !== scheme;
  settings.scheme = scheme;
  if (changed) Object.assign(settings, SCHEME_DEFAULTS[scheme]);
  saveSettings();
  return changed;
}

/** True until the player has answered the control-scheme question. */
export function needsSchemeChoice() {
  return !settings.scheme;
}

/**
 * Best guess at the right scheme, used to pre-select an option in the chooser.
 *
 * Deliberately a hint and not a decision: touch-capable laptops and external
 * mice make this unreliable, so it only decides which card is highlighted.
 */
export function guessScheme() {
  if (typeof navigator === 'undefined') return 'mouse';
  // A gamepad already attached is the one strong signal available.
  const pads = navigator.getGamepads?.() ?? [];
  if ([...pads].some((p) => p && p.mapping === 'standard')) return 'pad';
  // `any-pointer: fine` with no hover usually means a trackpad-only laptop, but
  // macOS reports hover for trackpads too, so lean on the platform instead.
  const mac = /Mac/i.test(navigator.platform ?? '') || /Mac OS X/i.test(navigator.userAgent ?? '');
  if (mac && !matchMedia('(pointer: coarse)').matches) return 'trackpad';
  return 'mouse';
}

/** A friendly fallback so nobody is forced to type a name to play. */
export function ensureNickname() {
  if (settings.nickname.trim()) return settings.nickname.trim();
  const n = `Player${Math.floor(Math.random() * 900 + 100)}`;
  settings.nickname = n;
  saveSettings();
  return n;
}
