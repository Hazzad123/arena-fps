// HUD. Plain DOM rather than rendered-in-3D text: it's sharper, it's free, and
// it reflows for free on any window size.
//
// Everything here is write-only — the HUD never owns game state, it just renders
// whatever it's handed each frame.

import { MAX_HEALTH } from '@shared/constants.js';
import { getWeapon, ALL_WEAPON_IDS } from '@shared/weapons.js';

const el = {};

export function initHud() {
  const ids = [
    'hud', 'crosshair', 'hitmarker', 'damage-vignette', 'hud-top', 'hud-state',
    'score-a', 'score-b', 'round-timer', 'killfeed', 'health-fill', 'health-num',
    'weapon-name', 'ammo', 'ammo-mag', 'reload-hint', 'practice-stats',
    'pr-hits', 'pr-shots', 'pr-acc', 'pr-streak', 'respawn', 'respawn-by',
    'respawn-timer', 'scoreboard', 'scope', 'weapon-rack',
  ];
  for (const id of ids) el[id] = document.getElementById(id);
}

export function showHud(visible) {
  el.hud.classList.toggle('hidden', !visible);
}

export function setTeamScoresVisible(visible) {
  el['score-a'].style.visibility = visible ? 'visible' : 'hidden';
  el['score-b'].style.visibility = visible ? 'visible' : 'hidden';
}

export function setPracticeMode(on) {
  el['practice-stats'].classList.toggle('hidden', !on);
  el['hud-top'].classList.toggle('hidden', on);
  el['weapon-rack'].classList.toggle('hidden', !on);
  if (on) buildWeaponRack();
}

/**
 * The practice range hands you every weapon, but nothing previously said so —
 * you'd start on the rifle and never learn the number keys did anything. Built
 * from the weapon table rather than hardcoded, so it can't drift from the real
 * key bindings.
 */
function buildWeaponRack() {
  el['weapon-rack'].replaceChildren();
  for (const id of ALL_WEAPON_IDS) {
    const weapon = getWeapon(id);
    const row = document.createElement('div');
    row.className = 'wr-item';
    row.dataset.weapon = id;

    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = weapon.slot;

    const name = document.createElement('span');
    name.textContent = weapon.name;

    row.append(key, name);
    el['weapon-rack'].appendChild(row);
  }
}

export function highlightWeapon(weaponId) {
  for (const row of el['weapon-rack'].children) {
    row.classList.toggle('active', row.dataset.weapon === weaponId);
  }
}

/** Show or hide the sniper optic. */
export function setScoped(scoped) {
  el.scope.classList.toggle('hidden', !scoped);
}

// ------------------------------------------------------------------- vitals

export function updateVitals(health) {
  const pct = Math.max(0, Math.min(100, (health / MAX_HEALTH) * 100));
  el['health-fill'].style.width = `${pct}%`;
  el['health-fill'].classList.toggle('low', pct <= 35);
  el['health-num'].textContent = Math.max(0, Math.ceil(health));
}

export function updateWeapon(player, now) {
  const id = player.inventory[player.slotIndex];
  const weapon = getWeapon(id);
  el['weapon-name'].textContent = weapon.name;

  const mag = player.ammo[id];
  const infinite = weapon.mag === Infinity;
  el['ammo-mag'].textContent = infinite ? '∞' : mag;
  el.ammo.classList.toggle('empty', !infinite && mag === 0);

  const reloading = now < player.reloadingUntil;
  el['reload-hint'].classList.toggle('hidden', !reloading);
}

/**
 * Crosshair gap tracks actual spread, so the reticle tells you the truth about
 * where your shots will go.
 */
export function updateCrosshair(spreadDeg, adsProgress, weaponId) {
  const px = 2.5 + spreadDeg * 3.4;
  el.crosshair.style.setProperty('--spread', `${px.toFixed(1)}px`);
  // A scoped sniper gets no crosshair — the scope overlay is the aim point.
  el.crosshair.classList.toggle('hide-cross', weaponId === 'sniper' && adsProgress > 0.75);
}

// ------------------------------------------------------------------ feedback

export function hitmarker(kill = false) {
  el.hitmarker.classList.remove('show', 'kill');
  // Force a reflow so the animation restarts on rapid consecutive hits.
  void el.hitmarker.offsetWidth;
  el.hitmarker.classList.add('show');
  if (kill) el.hitmarker.classList.add('kill');
}

/**
 * Red vignette weighted toward the direction the damage came from, so you know
 * where to turn without reading anything.
 */
export function damageIndicator(fromDirection = null) {
  const v = el['damage-vignette'];
  if (fromDirection) {
    v.style.setProperty('--dmg-x', `${50 + fromDirection.x * 45}%`);
    v.style.setProperty('--dmg-y', `${50 + fromDirection.y * 45}%`);
  } else {
    v.style.setProperty('--dmg-x', '50%');
    v.style.setProperty('--dmg-y', '50%');
  }
  v.style.transition = 'none';
  v.style.opacity = '1';
  requestAnimationFrame(() => {
    v.style.transition = 'opacity 0.45s';
    v.style.opacity = '0';
  });
}

// ------------------------------------------------------------------ killfeed

const KILLFEED_MS = 5000;

export function addKillfeed({ killer, victim, weapon, killerIsMe, victimIsMe }) {
  const row = document.createElement('div');
  row.className = 'kf';

  const name = (text, mine) => {
    const s = document.createElement('span');
    s.textContent = text;
    if (mine) s.style.color = 'var(--accent)';
    return s;
  };

  if (killer) row.appendChild(name(killer, killerIsMe));
  const w = document.createElement('span');
  w.className = 'w';
  w.textContent = weapon ? `▸ ${weapon}` : '▸';
  row.appendChild(w);
  row.appendChild(name(victim, victimIsMe));

  el.killfeed.appendChild(row);
  while (el.killfeed.children.length > 5) el.killfeed.firstChild.remove();

  setTimeout(() => {
    row.classList.add('fade');
    setTimeout(() => row.remove(), 500);
  }, KILLFEED_MS);
}

export function clearKillfeed() {
  el.killfeed.replaceChildren();
}

// -------------------------------------------------------------- round state

export function updateTimer(msRemaining) {
  const total = Math.max(0, Math.ceil(msRemaining / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  el['round-timer'].textContent = `${m}:${String(s).padStart(2, '0')}`;
  el['round-timer'].classList.toggle('urgent', total <= 30);
}

export function updateScores(a, b) {
  el['score-a'].textContent = a;
  el['score-b'].textContent = b;
}

export function setStateBanner(text) {
  el['hud-state'].textContent = text ?? '';
}

export function showRespawn(visible, killerName = '', msLeft = 0) {
  el.respawn.classList.toggle('hidden', !visible);
  if (!visible) return;
  el['respawn-by'].textContent = killerName ? `killed by ${killerName}` : '';
  el['respawn-timer'].textContent = msLeft > 0 ? `respawning in ${(msLeft / 1000).toFixed(1)}s` : 'respawning…';
}

// ------------------------------------------------------------------ practice

export function updatePracticeStats({ hits, shots, streak, best }) {
  el['pr-hits'].textContent = hits;
  el['pr-shots'].textContent = shots;
  el['pr-acc'].textContent = shots > 0 ? `${Math.round((hits / shots) * 100)}%` : '—';
  el['pr-streak'].textContent = `${streak} (best ${best})`;
}

// ---------------------------------------------------------------- scoreboard

export function showScoreboard(visible, data = null) {
  el.scoreboard.classList.toggle('hidden', !visible);
  if (!visible || !data) return;

  const { title, mode, players, myId } = data;
  const teamMode = mode === 'tdm';

  const rows = [...players].sort((a, b) => b.score - a.score || a.deaths - b.deaths);

  const head = teamMode
    ? '<tr><th>Player</th><th>Team</th><th class="num">Score</th><th class="num">K</th><th class="num">D</th></tr>'
    : '<tr><th>Player</th><th class="num">Score</th><th class="num">K</th><th class="num">D</th></tr>';

  const body = rows
    .map((p) => {
      const cls = p.id === myId ? ' class="me"' : '';
      const swatch = teamMode
        ? `<span class="swatch" style="background:${p.team === 'A' ? 'var(--team-a)' : 'var(--team-b)'}"></span>`
        : '';
      const teamCell = teamMode ? `<td>${p.team}</td>` : '';
      const label = escapeHtml(p.name);
      return `<tr${cls}><td>${swatch}${label}</td>${teamCell}<td class="num">${p.score}</td><td class="num">${p.kills}</td><td class="num">${p.deaths}</td></tr>`;
    })
    .join('');

  el.scoreboard.innerHTML = `<h2>${escapeHtml(title)}</h2><table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

// Player names come from other people, so they never go into innerHTML raw.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}
