import { compileBoxes } from '../collision.js';
import warehouse from './warehouse.js';
import rooftops from './rooftops.js';
import alley from './alley.js';
import practice from './practice.js';
import island from './island.js';
import courtyard from './courtyard.js';
import foundry from './foundry.js';
import switchyard from './switchyard.js';

// Competitive maps, in rotation order.
export const ROTATION = ['warehouse', 'rooftops', 'alley', 'courtyard', 'foundry', 'switchyard'];

const RAW = { warehouse, rooftops, alley, courtyard, foundry, switchyard, practice, island };

// Boxes are compiled to min/max form once, on first request, and cached. Both
// the client and the server go through here so neither can end up with a
// different view of the world.
const cache = new Map();

export function getMap(id) {
  if (cache.has(id)) return cache.get(id);

  const raw = RAW[id];
  if (!raw) throw new Error(`unknown map: ${id}`);

  const solids = compileBoxes(raw.boxes);

  // Stamp each solid with its own index. A raycast hands back the solid it hit,
  // and the only way to say "that one" over the wire is by index.
  solids.forEach((s, i) => {
    s.index = i;
  });

  // Explosive barrels, pulled out once so neither side has to scan the whole
  // solid list to find them.
  const barrels = solids
    .filter((s) => s.tag?.startsWith('barrel:'))
    .map((s) => ({
      index: s.index,
      pos: [
        (s.min[0] + s.max[0]) / 2,
        (s.min[1] + s.max[1]) / 2,
        (s.min[2] + s.max[2]) / 2,
      ],
    }));

  // Geometry an explosion checks line of sight against — everything except the
  // barrels themselves. A blast originates at a barrel's own centre, so with the
  // barrels included the ray leaves the origin already inside a solid and every
  // barrel perfectly shields itself: they detonated and did no damage at all.
  // Thin metal drums shouldn't stop a blast anyway.
  const blastSolids = barrels.length ? solids.filter((s) => !s.tag?.startsWith('barrel:')) : solids;

  // Health pickups, normalised into objects with an index so the server can refer
  // to one over the wire. Deliberately absent from `solids`: a pickup you bump
  // into is a pickup you can't collect.
  const healthPacks = (raw.healthPacks ?? []).map((pos, index) => ({ index, pos: [...pos] }));

  // Loot spawn points, normalised like the pickups. Battle royale only.
  const lootPoints = (raw.lootPoints ?? []).map((pos, index) => ({ index, pos: [...pos] }));

  const map = { ...raw, solids, barrels, blastSolids, healthPacks, lootPoints };
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
