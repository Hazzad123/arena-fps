import { compileBoxes } from '../collision.js';
import warehouse from './warehouse.js';
import rooftops from './rooftops.js';
import alley from './alley.js';
import practice from './practice.js';

// The three competitive maps, in rotation order.
export const ROTATION = ['warehouse', 'rooftops', 'alley'];

const RAW = { warehouse, rooftops, alley, practice };

// Boxes are compiled to min/max form once, on first request, and cached. Both
// the client and the server go through here so neither can end up with a
// different view of the world.
const cache = new Map();

export function getMap(id) {
  if (cache.has(id)) return cache.get(id);

  const raw = RAW[id];
  if (!raw) throw new Error(`unknown map: ${id}`);

  const map = { ...raw, solids: compileBoxes(raw.boxes) };
  cache.set(id, map);
  return map;
}

export function nextMap(currentId) {
  const i = ROTATION.indexOf(currentId);
  return ROTATION[(i + 1) % ROTATION.length];
}

/** Map metadata for menus — no geometry, so it's cheap to send. */
export function mapList() {
  return ROTATION.map((id) => ({
    id,
    name: RAW[id].name,
    blurb: RAW[id].blurb,
  }));
}

export const MAP_IDS = Object.keys(RAW);
