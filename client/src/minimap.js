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

// World metres visible across the radar. Small enough to be useful, large enough
// to show where the fight is.
const RANGE = 46;

// How long an enemy's gunfire stays on the radar. Long enough to turn and look,
// short enough that it's information about *now*.
const BLIP_MS = 2600;

// A body seen recently stays drawn briefly after it breaks line of sight, so a
// contact doesn't strobe as someone crosses behind a pillar.
const CONTACT_MEMORY_MS = 700;

const COLORS = {
  bg: 'rgba(10, 13, 18, 0.62)',
  wall: 'rgba(196, 208, 224, 0.30)',
  wallTall: 'rgba(210, 222, 238, 0.46)',
  self: '#ffffff',
  enemyFire: '#ff4436',
  barrel: 'rgba(220, 96, 60, 0.85)',
};

export function createMinimap() {
  const canvas = document.getElementById('minimap-canvas');
  return {
    canvas,
    ctx: canvas?.getContext('2d') ?? null,
    baked: null, // offscreen canvas of the map's walls
    bakedFor: null, // which map id it was baked from
    blips: [], // { x, z, until } gunfire marks
    contacts: new Map(), // id -> { x, z, until, team }
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
  minimap.baked = null;
  minimap.bakedFor = null;
}

/**
 * Redraw. Called every frame from the main loop.
 *
 * Enemies appear only while you can actually see them (plus a short memory), so
 * the radar never tells you something your eyes couldn't. Teammates are always
 * shown. Gunfire leaves a red mark wherever an enemy fired, whether or not you
 * can see them — that's the one thing the radar knows and you don't.
 */
export function drawMinimap(minimap, { map, player, states, myId, mode, myTeam, roster }) {
  const { ctx, canvas } = minimap;
  if (!ctx || !map) return;

  if (minimap.bakedFor !== map.id) bake(minimap, map);
  const baked = minimap.baked;
  if (!baked) return;

  const now = performance.now();
  const size = canvas.width;
  const half = size / 2;
  // Radar pixels per world metre.
  const ppm = size / RANGE;

  ctx.clearRect(0, 0, size, size);

  // Round mask, so the geometry can't spill outside the dial.
  ctx.save();
  ctx.beginPath();
  ctx.arc(half, half, half - 1, 0, Math.PI * 2);
  ctx.clip();

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, size, size);

  // Rotate so the direction you're facing is always up — much easier to read
  // than a fixed-north radar when you're turning constantly.
  ctx.translate(half, half);
  ctx.rotate(-player.yaw);

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
