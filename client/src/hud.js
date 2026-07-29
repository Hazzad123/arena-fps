// HUD. Plain DOM rather than rendered-in-3D text: it's sharper, it's free, and
// it reflows for free on any window size.
//
// Everything here is write-only — the HUD never owns game state, it just renders
// whatever it's handed each frame.

import { MAX_HEALTH } from '@shared/constants.js';
import { getWeapon, ALL_WEAPON_IDS } from '@shared/weapons.js';

const el = {};

/** How many rows the end-of-round table shows before it starts eliding. */
const TABLE_LIMIT = 10;

export function initHud() {
  const ids = [
    'hud', 'crosshair', 'hitmarker', 'damage-vignette', 'hud-top', 'hud-state',
    'score-a', 'score-b', 'round-timer', 'killfeed', 'health-fill', 'health-num',
    'weapon-name', 'ammo', 'ammo-mag', 'reload-hint', 'practice-stats',
    'pr-hits', 'pr-shots', 'pr-acc', 'pr-streak', 'respawn', 'respawn-title',
    'respawn-by', 'respawn-timer', 'scoreboard', 'scope', 'weapon-rack',
    'damage-numbers', 'kill-banner', 'minimap',
    'br-alive', 'br-alive-n', 'br-zone', 'br-prompt',
    'results', 'rs-headline', 'rs-score', 'rs-table', 'rs-next', 'rs-regroup',
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

/** Battle royale HUD: alive counter, zone status, loot prompt. */
export function setBattleRoyaleVisible(visible) {
  el['br-alive'].classList.toggle('hidden', !visible);
  el['br-zone'].classList.toggle('hidden', !visible);
  if (!visible) el['br-prompt'].classList.add('hidden');
  // The alive counter takes the top-right corner the killfeed normally owns, and
  // battle royale is where the killfeed is busiest — thirty players means it's
  // never empty. Drop it below the counter for the duration.
  el.killfeed.classList.toggle('below-alive', !!visible);
}

export function updateAlive(alive, total) {
  el['br-alive-n'].textContent = alive;
  el['br-alive'].title = `${alive} of ${total} still standing`;
}

export function updateZone({ state, msToNext, outside, dps }) {
  const z = el['br-zone'];
  z.classList.toggle('danger', !!outside);
  if (outside) {
    z.textContent = `OUTSIDE THE ZONE — ${Math.round(dps)} damage a second. Get inside.`;
    return;
  }
  const secs = Math.ceil(msToNext / 1000);
  z.textContent = state === 'shrink'
    ? `Zone closing — ${secs}s`
    : `Zone holds for ${secs}s`;
}

export function showLootPrompt(loot) {
  const p = el['br-prompt'];
  p.classList.toggle('hidden', !loot);
  if (!loot) return;
  p.innerHTML = '';
  const key = document.createElement('span');
  key.className = 'key';
  key.textContent = 'E';
  const name = document.createElement('span');
  name.className = `tier-${loot.tier}`;
  name.textContent = `Pick up ${loot.name}`;
  p.append(key, name);
}

/** The radar is match-only — the practice range has nobody to track. */
export function setMinimapVisible(visible) {
  el.minimap?.classList.toggle('hidden', !visible);
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

/**
 * Hitmarker. `kind` is 'hit', 'head' or 'kill' — three visually distinct states,
 * because "I hit them", "I hit their head" and "they're dead" are three different
 * pieces of information and a single white cross conveys none of them.
 */
export function hitmarker(kind = 'hit') {
  el.hitmarker.classList.remove('show', 'kill', 'head');
  // Force a reflow so the animation restarts on rapid consecutive hits.
  void el.hitmarker.offsetWidth;
  if (kind === 'kill') el.hitmarker.classList.add('kill');
  else if (kind === 'head') el.hitmarker.classList.add('head');
  el.hitmarker.classList.add('show');
}

/**
 * Floating damage number at a screen position, so the number appears over the
 * player you hit rather than in the abstract middle of the display.
 *
 * Elements remove themselves when the animation ends — a burst of shotgun
 * pellets can spawn several at once and none of them should outlive their fade.
 */
export function damageNumber(amount, screenX, screenY, kind = 'hit') {
  const node = document.createElement('div');
  node.className = `dmg-num${kind === 'hit' ? '' : ` ${kind}`}`;
  node.textContent = Math.round(amount);
  // A little horizontal scatter so simultaneous hits don't stack illegibly.
  node.style.left = `${screenX + (Math.random() - 0.5) * 26}px`;
  node.style.top = `${screenY}px`;
  node.addEventListener('animationend', () => node.remove());
  el['damage-numbers'].appendChild(node);

  // Belt and braces: if the animation never fires (element hidden mid-flight),
  // don't leak nodes into the layer forever.
  setTimeout(() => node.remove(), 1500);
}

export function killBanner(name, headshot = false) {
  el['kill-banner'].innerHTML = '';
  const verb = document.createElement('div');
  verb.className = 'verb';
  verb.textContent = headshot ? 'Headshot' : 'Eliminated';
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = name ?? '';
  el['kill-banner'].append(verb, who);

  el['kill-banner'].classList.remove('show');
  void el['kill-banner'].offsetWidth;
  el['kill-banner'].classList.add('show');
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

/**
 * The death screen. `title` and `status` are passed in rather than derived here,
 * because what being dead means depends entirely on the mode: in Team Deathmatch
 * it's a five-second wait, in survival it's sitting out until the wave is cleared,
 * and in battle royale it's the end of your match. Telling a battle royale player
 * they're "respawning…" is simply false.
 */
export function showRespawn(visible, killerName = '', status = '', title = 'DOWN') {
  el.respawn.classList.toggle('hidden', !visible);
  if (!visible) return;
  el['respawn-title'].textContent = title;
  el['respawn-by'].textContent = killerName ? `killed by ${killerName}` : '';
  el['respawn-timer'].textContent = status;
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

// -------------------------------------------------------------- end of match

/**
 * The results screen. Deliberately not the Tab scoreboard with a different title:
 * mid-round you want a glance at who's winning, and at the end you want the
 * result, where you placed, and what happens next.
 */
export function showResults(visible, data = null) {
  el.results.classList.toggle('hidden', !visible);
  if (!visible || !data) return;

  const { result, resultText, mode, players, myId, teamScores } = data;
  const teamMode = mode === 'tdm';

  // ---- headline, in the winning team's colour ----
  const headline = el['rs-headline'];
  headline.textContent = resultText ?? 'Round over';
  headline.className =
    result?.winnerTeam === 'A' ? 'team-a' : result?.winnerTeam === 'B' ? 'team-b' : 'neutral';

  // ---- final score ----
  const rows = [...players].sort(
    (a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths,
  );
  const score = el['rs-score'];

  if (teamMode) {
    score.innerHTML =
      `<span class="a">${teamScores?.A ?? 0}</span>` +
      '<span class="dash">–</span>' +
      `<span class="b">${teamScores?.B ?? 0}</span>`;
  } else if (rows[0]) {
    score.innerHTML =
      `${rows[0].score}` +
      `<span class="sub">${escapeHtml(rows[0].name)} · ${rows[0].kills} kills</span>`;
  } else {
    score.textContent = '';
  }

  // ---- table ----
  const best = rows[0]?.score ?? 0;
  const head =
    '<tr><th></th><th>Player</th>' +
    (teamMode ? '<th>Team</th>' : '') +
    '<th class="num">Score</th><th class="num">K</th><th class="num">D</th><th class="num">K/D</th></tr>';

  // Battle royale puts thirty names in here. All thirty overflow the panel, and
  // the one row you actually care about — your own — ends up below the fold, where
  // pointer lock makes it awkward to scroll to. So past a dozen players it shows
  // the leaderboard and your own line, with a gap between.
  const myIndex = rows.findIndex((p) => p.id === myId);
  let shown = rows.map((p, i) => ({ p, place: i + 1 }));
  if (shown.length > TABLE_LIMIT + 2) {
    shown = shown.slice(0, TABLE_LIMIT);
    if (myIndex >= TABLE_LIMIT) {
      shown.push({ gap: true });
      shown.push({ p: rows[myIndex], place: myIndex + 1 });
    }
  }

  const body = shown
    .map(({ p, place, gap }) => {
      if (gap) {
        const span = teamMode ? 7 : 6;
        return `<tr class="gap"><td colspan="${span}">⋯</td></tr>`;
      }
      const i = place - 1;
      const mine = p.id === myId ? ' class="me"' : '';
      const swatch = teamMode
        ? `<span class="swatch" style="background:${p.team === 'A' ? 'var(--team-a)' : 'var(--team-b)'}"></span>`
        : '';
      // Top of the table, not "everyone tied on score" — the sort already breaks
      // ties on kills then fewest deaths, so first place is a single player. And
      // only when somebody actually scored.
      const mvp = i === 0 && best > 0 ? '<span class="mvp">MVP</span>' : '';
      const teamCell = teamMode ? `<td>${p.team ?? '–'}</td>` : '';
      // Dividing by zero deaths isn't a ratio, it's a flawless round.
      const ratio = p.deaths === 0 ? (p.kills === 0 ? '—' : '∞') : (p.kills / p.deaths).toFixed(2);
      return (
        `<tr${mine}><td class="place">${i + 1}</td>` +
        `<td>${swatch}${escapeHtml(p.name)}${mvp}</td>${teamCell}` +
        `<td class="num">${p.score}</td><td class="num">${p.kills}</td>` +
        `<td class="num">${p.deaths}</td><td class="num">${ratio}</td></tr>`
      );
    })
    .join('');

  el['rs-table'].innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

/** Ticked every frame while the results are up, so it stays cheap to update. */
export function updateResultsFooter({ nextMapName, msLeft, regrouping, askedByMe, returning }) {
  const secs = Math.max(0, Math.ceil(msLeft / 1000));

  el['rs-next'].innerHTML = returning
    ? `Back to the lobby in <b>${secs}s</b>`
    : `Next up <b>${escapeHtml(nextMapName ?? '—')}</b> in <b>${secs}s</b>`;

  const regroup = el['rs-regroup'];
  regroup.classList.toggle('asked', askedByMe);

  if (regrouping > 0) {
    regroup.innerHTML = askedByMe
      ? `You asked to regroup — press <span class="key">L</span> to cancel`
      : `${regrouping} ${regrouping === 1 ? 'player wants' : 'players want'} to regroup in the lobby`;
  } else {
    regroup.innerHTML = `Press <span class="key">L</span> to go back to the lobby instead`;
  }
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
