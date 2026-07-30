// Radar.
//
// Top-down 2D canvas rather than a second three.js camera: a render-to-texture
// pass would cost a whole extra draw of the level every frame, and a radar wants
// to be schematic anyway — you need to read it in a glance, not admire it.
//
// The level's walls are baked once per map into an offscreen canvas and blitted;
// only the dots move each frame. So the per-frame cost is a handful of circles
// regardless of how much geometry the map has.

import { FLAG, hasFlag } from '@shared/protocol.js';
import { TEAM_COLORS, FFA_COLOR, PLAYER_HEIGHT } from '@shared/constants.js';
import { hasLineOfSight } from '@shared/collision.js';

// World metres visible across the radar.
//
// Scaled to the map rather than fixed: 46m is right for a 60m arena, and on the
// 284m battle-royale island it shows 16% of the width — you could not see the
// zone, the fight, or where you were going. Capped so an arena map doesn't zoom
// out into uselessness either.
const BASE_RANGE = 46;
function rangeFor(map) {
  const span = Math.max(map.bounds.max[0] - map.bounds.min[0], map.bounds.max[2] - map.bounds.min[2]);
  const cap = map.battleRoyale ? 320 : 150;
  return Math.min(cap, Math.max(BASE_RANGE, span * 0.42));
}

// How long an enemy's gunfire stays on the radar. Long enough to turn and look,
// short enough that it's information about *now*.
const BLIP_MS = 2600;

// A body seen recently stays drawn briefly after it breaks line of sight, so a
// contact doesn't strobe as someone crosses behind a pillar.
const CONTACT_MEMORY_MS = 700;

const COLORS = {
  zone: 'rgba(95, 200, 255, 0.9)',
  zoneNext: 'rgba(95, 200, 255, 0.35)',
  bg: 'rgba(10, 13, 18, 0.62)',
  wall: 'rgba(196, 208, 224, 0.30)',
  wallTall: 'rgba(210, 222, 238, 0.46)',
  self: '#ffffff',
  enemyFire: '#ff4436',
  barrel: 'rgba(220, 96, 60, 0.85)',
};

export function createMinimap() {
  const canvas = document.getElementById('minimap-canvas');
  const fullCanvas = document.getElementById('full-map-canvas');
  return {
    canvas,
    ctx: canvas?.getContext('2d') ?? null,
    areaLabel: document.getElementById('minimap-area'),
    areaId: null,
    baked: null, // offscreen canvas of the map's walls
    bakedFor: null, // which map id it was baked from
    blips: [], // { x, z, until } gunfire marks
    contacts: new Map(), // id -> { x, z, until, team }
    full: document.getElementById('full-map'),
    fullCanvas,
    fullCtx: fullCanvas?.getContext('2d') ?? null,
    fullVisible: false,
  };
}

/**
 * Draw the static geometry once. Boxes are drawn as rectangles, shaded by height
 * so a chest-high crate and a full wall are distinguishable.
 */
function bake(minimap, map) {
  const size = 512;
  const off = document.createElement('canvas');
  off.width = size;
  off.height = size;
  const c = off.getContext('2d');

  const b = map.bounds;
  const spanX = b.max[0] - b.min[0];
  const spanZ = b.max[2] - b.min[2];
  const span = Math.max(spanX, spanZ);
  const scale = size / span;

  // World -> baked pixels.
  const px = (x) => (x - b.min[0]) * scale;
  const pz = (z) => (z - b.min[2]) * scale;

  const floorY = b.min[1];

  for (const s of map.solids) {
    const h = s.max[1] - s.min[1];
    const w = s.max[0] - s.min[0];
    const d = s.max[2] - s.min[2];

    // Skip the floor slab and anything that isn't really an obstacle: a huge
    // flat plate drawn on a radar just fills it in solid.
    if (h < 0.35) continue;
    if (w * d > span * span * 0.3) continue;
    // Skip things below the playable floor (Rooftops' void filler).
    if (s.max[1] < floorY + 0.2) continue;

    if (s.tag?.startsWith('barrel:')) {
      c.fillStyle = COLORS.barrel;
      c.fillRect(px(s.min[0]) - 1, pz(s.min[2]) - 1, w * scale + 2, d * scale + 2);
      continue;
    }

    // Taller than a player reads as a wall; lower reads as cover.
    c.fillStyle = h >= PLAYER_HEIGHT ? COLORS.wallTall : COLORS.wall;
    c.fillRect(px(s.min[0]), pz(s.min[2]), Math.max(1, w * scale), Math.max(1, d * scale));
  }

  minimap.baked = { canvas: off, size, scale, min: [b.min[0], b.min[2]], span };
  minimap.bakedFor = map.id;
}

export function noteGunfire(minimap, at) {
  minimap.blips.push({ x: at[0], z: at[2], until: performance.now() + BLIP_MS });
  // Cap it: a full lobby on automatics would otherwise grow this without bound.
  if (minimap.blips.length > 40) minimap.blips.splice(0, minimap.blips.length - 40);
}

export function clearMinimap(minimap) {
  minimap.blips.length = 0;
  minimap.contacts.clear();
  minimap.areaId = null;
  minimap.areaLabel?.classList.add('hidden');
  minimap.baked = null;
  minimap.bakedFor = null;
  setFullMapVisible(minimap, false);
}

export function setFullMapVisible(minimap, visible) {
  minimap.fullVisible = !!visible;
  minimap.full?.classList.toggle('hidden', !visible);
}

export function toggleFullMap(minimap) {
  setFullMapVisible(minimap, !minimap.fullVisible);
  return minimap.fullVisible;
}

/** Fixed-north tactical overview. It deliberately shares the radar's knowledge:
 * contacts do not become wallhacks merely because the player pressed M. */
export function drawFullMap(minimap, {
  map, player, states, myId, mode, myTeam, roster, zone, vehicles,
}) {
  if (!minimap.fullVisible || !minimap.fullCtx || !map) return;
  if (minimap.bakedFor !== map.id) bake(minimap, map);
  const baked = minimap.baked;
  if (!baked) return;

  const ctx = minimap.fullCtx;
  const canvas = minimap.fullCanvas;
  const size = canvas.width;
  const margin = 42;
  const drawSize = size - margin * 2;
  const ppm = drawSize / baked.span;
  const worldX = (x) => margin + (x - baked.min[0]) * ppm;
  const worldZ = (z) => margin + (z - baked.min[1]) * ppm;
  const now = performance.now();

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#06100d';
  ctx.fillRect(0, 0, size, size);
  ctx.globalAlpha = 0.82;
  ctx.drawImage(baked.canvas, margin, margin, drawSize, drawSize);
  ctx.globalAlpha = 1;

  ctx.strokeStyle = 'rgba(57,255,163,.12)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 8; i++) {
    const p = margin + (drawSize * i) / 8;
    ctx.beginPath(); ctx.moveTo(p, margin); ctx.lineTo(p, size - margin); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(margin, p); ctx.lineTo(size - margin, p); ctx.stroke();
  }

  const ring = (centre, radius, stroke, width, dash = []) => {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.arc(worldX(centre[0]), worldZ(centre[1]), radius * ppm, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  if (zone) {
    if (zone.state === 'shrink' && zone.targetRadius < zone.radius) {
      ring(zone.targetCentre, zone.targetRadius, 'rgba(255,190,72,.9)', 4, [12, 9]);
    }
    ring(zone.centre, zone.radius, 'rgba(57,255,163,.95)', 5);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 20px ui-monospace, monospace';
  for (const area of map.areas ?? []) {
    const x = worldX(area.pos[0]);
    const z = worldZ(area.pos[1]);
    ctx.fillStyle = 'rgba(2,10,8,.76)';
    const width = ctx.measureText(area.name.toUpperCase()).width + 18;
    ctx.fillRect(x - width / 2, z - 13, width, 26);
    ctx.fillStyle = 'rgba(174,255,218,.9)';
    ctx.fillText(area.name.toUpperCase(), x, z);
  }

  ctx.fillStyle = '#ff654f';
  for (const blip of minimap.blips) {
    if (blip.until <= now) continue;
    ctx.beginPath();
    ctx.arc(worldX(blip.x), worldZ(blip.z), 6, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const [id, state] of states ?? []) {
    if (id === myId || hasFlag(state.flags, FLAG.DEAD)) continue;
    const info = roster?.get(id);
    const friendly = mode === 'tdm' && info?.team === myTeam;
    const memory = minimap.contacts.get(id);
    if (!friendly && (!memory || memory.until <= now)) continue;
    const pos = friendly ? state.pos : [memory.x, 0, memory.z];
    ctx.fillStyle = friendly ? '#62b6ff' : '#ff654f';
    ctx.beginPath();
    ctx.arc(worldX(pos[0]), worldZ(pos[2]), 6, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const entry of vehicles?.entries?.values?.() ?? []) {
    ctx.save();
    ctx.translate(worldX(entry.group.position.x), worldZ(entry.group.position.z));
    ctx.rotate(entry.group.rotation.y);
    ctx.fillStyle = entry.driverId ? '#ffbd4a' : 'rgba(255,189,74,.72)';
    ctx.fillRect(-5, -9, 10, 18);
    ctx.restore();
  }

  const x = worldX(player.pos[0]);
  const z = worldZ(player.pos[2]);
  ctx.save();
  ctx.translate(x, z);
  ctx.rotate(player.yaw);
  ctx.fillStyle = '#fff';
  ctx.shadowColor = '#39ffa3';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(0, -13); ctx.lineTo(9, 10); ctx.lineTo(0, 6); ctx.lineTo(-9, 10);
  ctx.closePath(); ctx.fill();
  ctx.restore();

  ctx.strokeStyle = 'rgba(57,255,163,.65)';
  ctx.lineWidth = 3;
  ctx.strokeRect(margin, margin, drawSize, drawSize);
}

function updateAreaLabel(minimap, map, pos) {
  if (!minimap.areaLabel) return;
  const area = map.areas?.find(
    (candidate) => Math.hypot(pos[0] - candidate.pos[0], pos[2] - candidate.pos[1]) <= candidate.radius,
  );
  const id = area?.id ?? null;
  if (id === minimap.areaId) return;
  minimap.areaId = id;
  minimap.areaLabel.textContent = area?.name ?? '';
  minimap.areaLabel.classList.toggle('hidden', !area);
}

/**
 * Redraw. Called every frame from the main loop.
 *
 * Enemies appear only while you can actually see them (plus a short memory), so
 * the radar never tells you something your eyes couldn't. Teammates are always
 * shown. Gunfire leaves a red mark wherever an enemy fired, whether or not you
 * can see them — that's the one thing the radar knows and you don't.
 */
export function drawMinimap(minimap, { map, player, states, myId, mode, myTeam, roster, zone }) {
  const { ctx, canvas } = minimap;
  if (!ctx || !map) return;

  if (minimap.bakedFor !== map.id) bake(minimap, map);
  updateAreaLabel(minimap, map, player.pos);
  const baked = minimap.baked;
  if (!baked) return;

  const now = performance.now();
  const size = canvas.width;
  const half = size / 2;
  // Radar pixels per world metre.
  const ppm = size / rangeFor(map);

  ctx.clearRect(0, 0, size, size);

  // Round mask, so the geometry can't spill outside the dial.
  ctx.save();
  ctx.beginPath();
  ctx.arc(half, half, half - 1, 0, Math.PI * 2);
  ctx.clip();

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, size, size);

  // Rotate so the direction you're facing is always up — much easier to read
  // than a fixed-north radar when you're turning constantly. Canvas Y points
  // down and world -Z is forward at yaw zero, so the radar rotates by the
  // positive player yaw. Using the inverse angle mirrors every turn.
  ctx.translate(half, half);
  ctx.rotate(player.yaw);

  // Blit the baked map, scaled from its own resolution to radar pixels and
  // offset so the player sits at the centre.
  const bakedPpm = baked.scale; // baked px per metre
  const drawScale = ppm / bakedPpm;
  ctx.drawImage(
    baked.canvas,
    -(player.pos[0] - baked.min[0]) * bakedPpm * drawScale,
    -(player.pos[2] - baked.min[1]) * bakedPpm * drawScale,
    baked.size * drawScale,
    baked.size * drawScale,
  );

  // ---- battle royale zone ----
  // Drawn in the rotated space so it lines up with the geometry, and both circles
  // are shown while it's closing: where you're safe now, and where you need to be.
  if (zone) {
    const ring = (cx, cz, r, stroke, width) => {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.arc((cx - player.pos[0]) * ppm, (cz - player.pos[2]) * ppm, r * ppm, 0, Math.PI * 2);
      ctx.stroke();
    };
    if (zone.state === 'shrink' && zone.targetRadius < zone.radius) {
      ring(zone.targetCentre[0], zone.targetCentre[1], zone.targetRadius, COLORS.zoneNext, 2);
    }
    ring(zone.centre[0], zone.centre[1], zone.radius, COLORS.zone, 2.5);
  }

  // ---- gunfire blips ----
  for (let i = minimap.blips.length - 1; i >= 0; i--) {
    const blip = minimap.blips[i];
    if (blip.until <= now) {
      minimap.blips.splice(i, 1);
      continue;
    }
    const life = (blip.until - now) / BLIP_MS;
    const x = (blip.x - player.pos[0]) * ppm;
    const z = (blip.z - player.pos[2]) * ppm;
    if (Math.hypot(x, z) > half) continue;

    // A dot with an expanding ring, so a fresh shot draws the eye.
    ctx.globalAlpha = Math.min(1, life * 1.4);
    ctx.fillStyle = COLORS.enemyFire;
    ctx.beginPath();
    ctx.arc(x, z, 3.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = life * 0.55;
    ctx.strokeStyle = COLORS.enemyFire;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(x, z, 3.4 + (1 - life) * 11, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // ---- players ----
  const eye = [player.pos[0], player.pos[1] + PLAYER_HEIGHT - 0.15, player.pos[2]];

  for (const [id, state] of states ?? []) {
    if (id === myId) continue;
    if (hasFlag(state.flags, FLAG.DEAD)) {
      minimap.contacts.delete(id);
      continue;
    }

    const info = roster?.get(id);
    const friendly = mode === 'tdm' && info?.team && info.team === myTeam;

    let show = friendly;
    if (!friendly) {
      // Enemies only while visible. Checked against the torso, so someone behind
      // waist-high cover still counts as seen.
      const torso = [state.pos[0], state.pos[1] + PLAYER_HEIGHT * 0.6, state.pos[2]];
      if (hasLineOfSight(eye, torso, map.solids, 0.4)) {
        minimap.contacts.set(id, { x: state.pos[0], z: state.pos[2], until: now + CONTACT_MEMORY_MS });
        show = true;
      } else {
        const memory = minimap.contacts.get(id);
        if (memory && memory.until > now) {
          // Draw the last known position rather than the live one — a radar
          // shouldn't track someone through a wall.
          drawBlip(ctx, (memory.x - player.pos[0]) * ppm, (memory.z - player.pos[2]) * ppm,
            half, TEAM_COLORS.B, 0.45, state.yaw, false);
        }
        continue;
      }
    }

    const colour = mode === 'tdm'
      ? (friendly ? TEAM_COLORS.A : TEAM_COLORS.B)
      : FFA_COLOR;
    drawBlip(ctx, (state.pos[0] - player.pos[0]) * ppm, (state.pos[2] - player.pos[2]) * ppm,
      half, colour, 1, state.yaw, true);
  }

  ctx.restore();

  // ---- own marker, drawn unrotated so it always points up ----
  ctx.save();
  ctx.translate(half, half);
  ctx.fillStyle = COLORS.self;
  ctx.beginPath();
  ctx.moveTo(0, -6.5);
  ctx.lineTo(4.6, 5);
  ctx.lineTo(0, 2.6);
  ctx.lineTo(-4.6, 5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Dial rim.
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(half, half, half - 1, 0, Math.PI * 2);
  ctx.stroke();
}

function drawBlip(ctx, x, z, half, colourHex, alpha, yaw, showFacing) {
  if (Math.hypot(x, z) > half - 3) return;
  const colour = `#${colourHex.toString(16).padStart(6, '0')}`;

  ctx.globalAlpha = alpha;
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(x, z, 4, 0, Math.PI * 2);
  ctx.fill();

  if (showFacing) {
    // A short whisker showing which way they're looking.
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(x, z);
    ctx.lineTo(x - Math.sin(yaw) * 9, z - Math.cos(yaw) * 9);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
