// Persisted player settings. localStorage only — there are no accounts, so this
// is the entire notion of "your profile".

import { DEFAULT_FOV, DEFAULT_SENSITIVITY, MIN_FOV, MAX_FOV } from '@shared/constants.js';
import { CLASSES, DEFAULT_CLASS } from '@shared/weapons.js';

const KEY = 'arena.settings.v1';

const DEFAULTS = {
  nickname: '',
  sensitivity: DEFAULT_SENSITIVITY,
  fov: DEFAULT_FOV,
  volume: 0.7,
  invertY: false,
  // Whichever class you picked last. People settle on one and shouldn't have to
  // re-pick it every time they open the tab.
  classId: DEFAULT_CLASS,
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
      sensitivity: clamp(Number(parsed.sensitivity) || DEFAULT_SENSITIVITY, 0.2, 3),
      fov: clamp(Number(parsed.fov) || DEFAULT_FOV, MIN_FOV, MAX_FOV),
      volume: clamp(Number(parsed.volume ?? DEFAULTS.volume), 0, 1),
      invertY: Boolean(parsed.invertY),
      classId: CLASSES[parsed.classId] ? parsed.classId : DEFAULT_CLASS,
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

/** A friendly fallback so nobody is forced to type a name to play. */
export function ensureNickname() {
  if (settings.nickname.trim()) return settings.nickname.trim();
  const n = `Player${Math.floor(Math.random() * 900 + 100)}`;
  settings.nickname = n;
  saveSettings();
  return n;
}
