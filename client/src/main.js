// Entry point: owns the renderer, the frame loop, and the screen state machine.
//
// Screens: menu -> practice | lobby -> match. Only one is live at a time, and
// each cleans up after itself, because map rotation means this runs repeatedly
// across a long session.

import * as THREE from 'three';
import { PHYSICS_DT, MIN_FOV, MAX_FOV, TEAMS, RESPAWN_DELAY_MS } from '@shared/constants.js';
import { getMap } from '@shared/maps/index.js';
import { ALL_WEAPON_IDS, getWeapon } from '@shared/weapons.js';
import { raycastBoxes, raycastPlayers } from '@shared/collision.js';
import { C2S, S2C, PHASE, FLAG, MODE_NAMES } from '@shared/protocol.js';

import { settings, saveSettings, ensureNickname } from './settings.js';
import { initInput, input, requestLock, exitLock, onLockChange, consumePressed, consumeLook } from './input.js';
import { createRenderer, createCamera, createWorld, loadMap, unloadMap } from './mapRenderer.js';
import {
  createLocalPlayer, setLoadout, spawnAt, updateLocalPlayer, applyToCamera,
  currentWeapon, tryFire, handleWeaponInput, eyePosition,
} from './localPlayer.js';
import {
  createWeaponView, setViewWeapon, updateWeaponView, weaponViewFire,
  renderWeaponView, resizeWeaponView, isScoped,
  createTracers, spawnTracer, updateTracers,
  createImpacts, spawnImpact, updateImpacts, muzzleWorldPosition,
} from './weaponView.js';
import * as hud from './hud.js';
import {
  createRange, updateRange, raycastTargets, registerHit, registerShot, resetRange, disposeRange,
} from './practice.js';
import * as net from './net.js';
import { createRemotePlayers, syncRemotePlayers, clearRemotePlayers, hitboxesFrom } from './remotePlayers.js';
import * as audio from './audio.js';

// ---------------------------------------------------------------------- setup

const canvas = document.getElementById('game');
const renderer = createRenderer(canvas);
const world = createWorld(renderer);
const camera = createCamera(settings.fov);

const player = createLocalPlayer();
const weaponView = createWeaponView();
const tracers = createTracers(world.scene);
const impacts = createImpacts(world.scene);
const remotes = createRemotePlayers(world.scene);
const connection = net.createNet();

initInput(canvas);
hud.initHud();

const app = {
  screen: 'menu',
  map: null,
  range: null,
  lastFrame: performance.now(),
  accumulator: 0,
  lookDelta: { dx: 0, dy: 0 },

  // Match state, mirrored from the server.
  match: {
    code: null,
    mode: 'tdm',
    myTeam: null,
    phase: PHASE.LOBBY,
    phaseEndsAt: 0,
    teamScores: { A: 0, B: 0 },
    roster: new Map(),
    resultText: null,
  },
  pendingReports: { fallDamage: 0, void: false },
  deathAt: 0,
  killedBy: '',
  lastCountdownBeep: -1,
  wasReloading: false,
};

// ----------------------------------------------------------------- dom handles

const dom = {};
for (const id of [
  'menu', 'lobby', 'resume', 'nickname', 'menu-error', 'menu-footer',
  'btn-practice', 'btn-quickplay', 'btn-join', 'btn-create', 'room-code', 'mode-select',
  'sens', 'sens-val', 'fov', 'fov-val', 'vol', 'vol-val', 'invert-y',
  'lobby-code', 'lobby-mode', 'lobby-players', 'lobby-status', 'btn-copy-link', 'btn-leave',
]) dom[id] = document.getElementById(id);

// ------------------------------------------------------------------- settings

dom.nickname.value = settings.nickname;
dom.nickname.addEventListener('input', () => {
  settings.nickname = dom.nickname.value.slice(0, 14);
  saveSettings();
});

dom.sens.value = settings.sensitivity;
dom.fov.value = settings.fov;
dom.vol.value = Math.round(settings.volume * 100);
dom['invert-y'].checked = settings.invertY;

function syncSettingLabels() {
  dom['sens-val'].textContent = Number(settings.sensitivity).toFixed(2);
  dom['fov-val'].textContent = settings.fov;
  dom['vol-val'].textContent = Math.round(settings.volume * 100);
}
syncSettingLabels();

dom.sens.addEventListener('input', () => {
  settings.sensitivity = Number(dom.sens.value);
  syncSettingLabels();
  saveSettings();
});
dom.fov.addEventListener('input', () => {
  settings.fov = Math.max(MIN_FOV, Math.min(MAX_FOV, Number(dom.fov.value)));
  syncSettingLabels();
  saveSettings();
});
dom.vol.addEventListener('input', () => {
  settings.volume = Number(dom.vol.value) / 100;
  audio.setVolume(settings.volume);
  syncSettingLabels();
  saveSettings();
});
dom['invert-y'].addEventListener('change', () => {
  settings.invertY = dom['invert-y'].checked;
  saveSettings();
});

dom['room-code'].addEventListener('input', () => {
  dom['room-code'].value = dom['room-code'].value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
});
dom['room-code'].addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinByCode();
});

// -------------------------------------------------------------------- menu

function showError(msg) {
  dom['menu-error'].textContent = msg;
  dom['menu-error'].classList.remove('hidden');
}
function clearError() {
  dom['menu-error'].classList.add('hidden');
}

function setMenuBusy(busy) {
  for (const b of ['btn-quickplay', 'btn-join', 'btn-create', 'btn-practice']) dom[b].disabled = busy;
}

dom['btn-practice'].addEventListener('click', () => {
  audio.initAudio();
  audio.resumeAudio();
  startPractice();
});

dom['btn-quickplay'].addEventListener('click', () => enterMultiplayer(C2S.QUICKPLAY, {}));
dom['btn-create'].addEventListener('click', () =>
  enterMultiplayer(C2S.CREATE, { mode: dom['mode-select'].value }));
dom['btn-join'].addEventListener('click', joinByCode);

function joinByCode() {
  const code = dom['room-code'].value.trim().toUpperCase();
  if (code.length !== 4) {
    showError('Room codes are four characters.');
    return;
  }
  enterMultiplayer(C2S.JOIN, { code });
}

async function enterMultiplayer(action, payload) {
  clearError();
  setMenuBusy(true);
  audio.initAudio();
  audio.resumeAudio();
  const name = ensureNickname();
  dom.nickname.value = name;

  try {
    if (!connection.connected) await net.connect(connection, { name });
    net.send(connection, action, payload);
  } catch (err) {
    showError(`Couldn’t reach the server. ${err.message}`);
  } finally {
    setMenuBusy(false);
  }
}

dom['btn-leave'].addEventListener('click', () => leaveToMenu());

dom['btn-copy-link'].addEventListener('click', async () => {
  const url = `${location.origin}/#${app.match.code}`;
  try {
    await navigator.clipboard.writeText(url);
    dom['btn-copy-link'].textContent = 'Copied';
    setTimeout(() => (dom['btn-copy-link'].textContent = 'Copy invite link'), 1500);
  } catch {
    // Clipboard needs permission in some contexts; show the link so it can be
    // copied by hand rather than silently doing nothing.
    dom['lobby-status'].textContent = url;
  }
});

// ------------------------------------------------------------------- screens

function applyMap(mapId) {
  app.map = getMap(mapId);
  loadMap(world, app.map);
  clearRemotePlayers(remotes);
}

function startPractice() {
  clearError();
  ensureNickname();
  applyMap('practice');

  app.range = createRange(world.scene, app.map);
  setLoadout(player, ALL_WEAPON_IDS);
  player.slotIndex = Math.max(0, ALL_WEAPON_IDS.indexOf('rifle'));
  spawnAt(player, app.map.spawns.ffa[0], app.map.solids, app.map.spawnYaw ?? 0);
  setViewWeapon(weaponView, player.inventory[player.slotIndex]);

  app.screen = 'practice';
  dom.menu.classList.add('hidden');
  dom.lobby.classList.add('hidden');
  hud.showHud(true);
  hud.setPracticeMode(true);
  hud.setStateBanner('');
  hud.updatePracticeStats(app.range.stats);
  hud.highlightWeapon(player.inventory[player.slotIndex]);
  requestLock();
}

function enterLobby() {
  app.screen = 'lobby';
  exitLock();
  dom.menu.classList.add('hidden');
  dom.lobby.classList.remove('hidden');
  hud.showHud(false);
  renderLobby();
}

function enterMatch() {
  app.screen = 'match';
  dom.menu.classList.add('hidden');
  dom.lobby.classList.add('hidden');
  hud.showHud(true);
  hud.setPracticeMode(false);
  hud.setTeamScoresVisible(app.match.mode === 'tdm');
  requestLock();
}

function leaveToMenu() {
  exitLock();
  net.disconnect(connection);

  if (app.range) {
    disposeRange(app.range);
    app.range = null;
  }
  clearRemotePlayers(remotes);
  unloadMap(world);
  app.map = null;
  app.screen = 'menu';
  app.match.code = null;
  app.match.roster.clear();

  history.replaceState(null, '', location.pathname);
  hud.showHud(false);
  hud.showScoreboard(false);
  hud.clearKillfeed();
  dom.resume.classList.add('hidden');
  dom.lobby.classList.add('hidden');
  dom.menu.classList.remove('hidden');
}

function renderLobby() {
  const m = app.match;
  dom['lobby-code'].textContent = m.code ?? '----';
  dom['lobby-mode'].textContent = `${MODE_NAMES[m.mode] ?? m.mode} · ${app.map?.name ?? ''}`;

  dom['lobby-players'].replaceChildren();
  for (const p of m.roster.values()) {
    const row = document.createElement('div');
    row.className = 'lobby-player';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background =
      m.mode === 'tdm' ? (p.team === TEAMS.A ? 'var(--team-a)' : 'var(--team-b)') : 'var(--accent)';
    const name = document.createElement('span');
    name.textContent = p.name;
    row.append(dot, name);
    if (p.id === connection.myId) {
      const you = document.createElement('span');
      you.className = 'you';
      you.textContent = 'you';
      row.appendChild(you);
    }
    dom['lobby-players'].appendChild(row);
  }

  const count = m.roster.size;
  dom['lobby-status'].textContent =
    count < 2 ? 'Waiting for one more player…' : `${count} players ready — starting shortly`;
}

// ------------------------------------------------------------- network events

net.on(connection, S2C.ERROR, (msg) => {
  showError(msg.message ?? 'Something went wrong.');
  if (app.screen !== 'menu') leaveToMenu();
});

net.on(connection, 'disconnected', () => {
  if (app.screen === 'menu') return;
  leaveToMenu();
  showError('Lost connection to the server.');
});

net.on(connection, S2C.JOINED, (msg) => {
  const m = app.match;
  m.code = msg.code;
  m.mode = msg.mode;
  m.myTeam = msg.you.team;
  m.phase = msg.phase;
  m.phaseEndsAt = performance.now() + (msg.phaseMsLeft ?? 0);
  m.teamScores = msg.teamScores ?? { A: 0, B: 0 };
  updateRoster(msg.roster);

  applyMap(msg.mapId);
  setLoadout(player, msg.inventory ?? ['rifle', 'pistol', 'knife']);
  setViewWeapon(weaponView, player.inventory[0]);

  history.replaceState(null, '', `#${msg.code}`);
  hud.setTeamScoresVisible(m.mode === 'tdm');
  hud.updateScores(m.teamScores.A, m.teamScores.B);

  if (msg.phase === PHASE.LIVE || msg.phase === PHASE.COUNTDOWN) enterMatch();
  else enterLobby();
});

net.on(connection, S2C.ROSTER, (msg) => {
  updateRoster(msg.roster);
  app.match.teamScores = msg.teamScores ?? app.match.teamScores;
  hud.updateScores(app.match.teamScores.A, app.match.teamScores.B);
  if (app.screen === 'lobby') renderLobby();
});

net.on(connection, S2C.PHASE, (msg) => {
  const m = app.match;
  const previous = m.phase;
  m.phase = msg.phase;
  m.phaseEndsAt = performance.now() + (msg.msLeft ?? 0);
  m.teamScores = msg.teamScores ?? m.teamScores;
  m.resultText = msg.resultText ?? null;
  if (msg.roster) updateRoster(msg.roster);

  // Map rotates between rounds.
  if (msg.mapId && msg.mapId !== app.map?.id) applyMap(msg.mapId);

  hud.updateScores(m.teamScores.A, m.teamScores.B);

  switch (msg.phase) {
    case PHASE.COUNTDOWN:
      if (app.screen !== 'match') enterMatch();
      hud.showScoreboard(false);
      hud.clearKillfeed();
      app.lastCountdownBeep = -1;
      hud.setStateBanner('Get ready');
      break;

    case PHASE.LIVE:
      hud.showScoreboard(false);
      hud.setStateBanner('');
      if (previous !== PHASE.LIVE) audio.playFanfare(true);
      break;

    case PHASE.SCOREBOARD:
      hud.setStateBanner(m.resultText ?? 'Round over');
      hud.showRespawn(false);
      showFullScoreboard();
      audio.playFanfare(false);
      break;

    case PHASE.LOBBY:
      enterLobby();
      break;

    default:
      break;
  }
});

net.on(connection, S2C.RESPAWN, (msg) => {
  setLoadout(player, msg.inventory ?? player.inventory);
  spawnAt(player, msg.pos, app.map.solids, msg.yaw ?? 0);
  player.health = msg.health;
  setViewWeapon(weaponView, player.inventory[player.slotIndex]);
  hud.showRespawn(false);
  app.deathAt = 0;
});

net.on(connection, S2C.LOADOUT, (msg) => {
  setLoadout(player, msg.inventory);
  setViewWeapon(weaponView, player.inventory[0]);
  if (msg.promoted) {
    hud.setStateBanner(`Promoted: ${getWeapon(msg.inventory[0]).name}`);
    setTimeout(() => hud.setStateBanner(''), 1600);
    audio.playClick(1.4);
  }
});

net.on(connection, S2C.DAMAGE, (msg) => {
  if (msg.self) {
    player.health = msg.health;
    audio.playHurt();
    hud.damageIndicator(msg.from ? directionTo(msg.from) : null);
    if (msg.health <= 0) player.alive = false;
  } else {
    // Server confirmed our hit landed.
    hud.hitmarker(msg.lethal);
    audio.playHitmarker(msg.lethal);
  }
});

net.on(connection, S2C.KILL, (msg) => {
  const iAmKiller = msg.killer === connection.myId;
  const iAmVictim = msg.victim === connection.myId;

  hud.addKillfeed({
    killer: msg.killerName,
    victim: msg.victimName,
    weapon: msg.weapon ? getWeapon(msg.weapon)?.name ?? msg.weapon : null,
    killerIsMe: iAmKiller,
    victimIsMe: iAmVictim,
  });

  if (iAmVictim) {
    player.alive = false;
    app.deathAt = performance.now();
    app.killedBy = msg.killerName ?? '';
  }
});

net.on(connection, S2C.SHOTS, (msg) => {
  // Somebody else fired: tracer plus a positioned bang.
  const weapon = getWeapon(msg.w);
  if (!weapon || !msg.o || !msg.d) return;

  const origin = msg.o;
  const dir = msg.d;
  const hit = raycastBoxes(origin, dir, app.map.solids, weapon.range);
  const dist = hit ? hit.t : weapon.range;
  const end = [origin[0] + dir[0] * dist, origin[1] + dir[1] * dist, origin[2] + dir[2] * dist];

  if (msg.w !== 'knife') spawnTracer(tracers, origin, end, weapon.tracerColor, performance.now());
  if (hit) spawnImpact(impacts, end, performance.now());

  const eye = eyePosition(player);
  const { pan, distance } = audio.spatialise(origin, eye, player.yaw);
  audio.playShot(weapon.audio, { pan, distance });
});

function updateRoster(list) {
  if (!list) return;
  app.match.roster.clear();
  for (const p of list) app.match.roster.set(p.id, p);
}

function directionTo(worldPos) {
  // Screen-space-ish direction for the damage vignette.
  const eye = eyePosition(player);
  const dx = worldPos[0] - eye[0];
  const dz = worldPos[2] - eye[2];
  const rightX = Math.cos(player.yaw);
  const rightZ = -Math.sin(player.yaw);
  const forwardX = -Math.sin(player.yaw);
  const forwardZ = -Math.cos(player.yaw);
  const len = Math.hypot(dx, dz) || 1;
  return {
    x: (dx * rightX + dz * rightZ) / len,
    y: -(dx * forwardX + dz * forwardZ) / len,
  };
}

function showFullScoreboard() {
  hud.showScoreboard(true, {
    title: app.match.resultText ?? 'Round over',
    mode: app.match.mode,
    players: [...app.match.roster.values()],
    myId: connection.myId,
  });
}

// ------------------------------------------------------------- pointer lock UX

onLockChange((locked) => {
  const inGame = app.screen === 'practice' || app.screen === 'match';
  dom.resume.classList.toggle('hidden', locked || !inGame);
  if (locked) audio.resumeAudio();
});

dom.resume.addEventListener('click', () => requestLock());

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape') return;
  const inGame = app.screen === 'practice' || app.screen === 'match';
  if (inGame && !input.locked) leaveToMenu();
});

// -------------------------------------------------------------------- firing

const tmpMuzzle = new THREE.Vector3();

function handleFiring(now, worldStates) {
  const firePressed = consumePressed('fire');
  const shot = tryFire(player, now, firePressed);
  if (!shot) return;

  const weapon = shot.weapon;
  weaponViewFire(weaponView, now, weapon);
  audio.playShot(weapon.audio);

  muzzleWorldPosition(weaponView, camera, tmpMuzzle);
  const from = [tmpMuzzle.x, tmpMuzzle.y, tmpMuzzle.z];

  const hitboxes = worldStates ? hitboxesFrom(worldStates, connection.myId) : [];
  const reportedHits = [];
  let hitAnything = false;

  for (const dir of shot.dirs) {
    const wallHit = raycastBoxes(shot.origin, dir, app.map.solids, weapon.range);
    const targetHit = app.range ? raycastTargets(app.range, shot.origin, dir, weapon.range) : null;
    const playerHit = hitboxes.length
      ? raycastPlayers(shot.origin, dir, hitboxes, weapon.range, connection.myId)
      : null;

    // Nearest wins. You can't shoot anyone through a wall, and the server
    // re-checks line of sight anyway.
    const candidates = [
      wallHit && { t: wallHit.t, kind: 'wall' },
      targetHit && { t: targetHit.t, kind: 'target' },
      playerHit && { t: playerHit.t, kind: 'player' },
    ].filter(Boolean);
    candidates.sort((a, b) => a.t - b.t);
    const nearest = candidates[0];

    let end;
    if (!nearest) {
      end = [
        shot.origin[0] + dir[0] * weapon.range,
        shot.origin[1] + dir[1] * weapon.range,
        shot.origin[2] + dir[2] * weapon.range,
      ];
    } else {
      end = [
        shot.origin[0] + dir[0] * nearest.t,
        shot.origin[1] + dir[1] * nearest.t,
        shot.origin[2] + dir[2] * nearest.t,
      ];

      if (nearest.kind === 'player') {
        reportedHits.push({ id: playerHit.player.id, z: playerHit.zone });
        spawnImpact(impacts, end, now, 0xffffff, true);
        hitAnything = true;
      } else if (nearest.kind === 'target') {
        const { damage } = registerHit(app.range, targetHit.target, now, targetHit.t, weapon);
        spawnImpact(impacts, end, now, 0xffffff, true);
        hud.hitmarker(damage >= 100);
        audio.playHitmarker(damage >= 100);
        hitAnything = true;
      } else {
        spawnImpact(impacts, end, now);
      }
    }

    if (weapon.id !== 'knife') {
      spawnTracer(tracers, from, end, weapon.tracerColor, now, weapon.id === 'sniper' ? 0.03 : 0.02);
    }
  }

  if (app.range) {
    registerShot(app.range, hitAnything);
    hud.updatePracticeStats(app.range.stats);
  }

  if (app.screen === 'match') {
    net.sendShot(connection, {
      weaponId: weapon.id,
      origin: shot.origin,
      dir: shot.dirs[0],
      hits: reportedHits,
    });
  }
}

// --------------------------------------------------------------------- loop

function currentFlags() {
  let f = 0;
  if (player.crouching) f |= FLAG.CROUCH;
  if (!player.onGround) f |= FLAG.AIRBORNE;
  if (input.sprint) f |= FLAG.SPRINT;
  if (input.ads) f |= FLAG.ADS;
  if (input.firing) f |= FLAG.FIRING;
  if (!player.alive) f |= FLAG.DEAD;
  return f;
}

function frame() {
  requestAnimationFrame(frame);

  const now = performance.now();
  let dt = (now - app.lastFrame) / 1000;
  app.lastFrame = now;
  // A backgrounded tab pauses rAF entirely, so the first frame back returns a
  // huge dt. Clamp it or we teleport through walls catching up.
  dt = Math.min(dt, 0.1);

  step(dt, now);
}

/** One frame of simulation and rendering. Split out from the rAF wrapper so the
 *  dev console and tests can drive it with an explicit dt. */
function step(dt, now) {
  if (app.screen === 'menu' || app.screen === 'lobby' || !app.map) {
    renderer.render(world.scene, camera);
    return;
  }

  // Look is sampled once per frame, not per physics step, so a 200Hz mouse
  // doesn't turn faster than a 60Hz one.
  const look = consumeLook();
  player.yaw -= look.dx;
  player.pitch = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, player.pitch - look.dy));
  app.lookDelta = look;

  const previousWeapon = player.inventory[player.slotIndex];
  const wasReloading = app.wasReloading;
  handleWeaponInput(player, now);

  // Bookend the reload animation with mechanical clicks — magazine out, and the
  // fresh one seated.
  const reloadingNow = player.reloadingUntil > now;
  if (reloadingNow !== wasReloading) {
    audio.playClick(reloadingNow ? 0.75 : 1.35);
    app.wasReloading = reloadingNow;
  }
  const activeWeapon = player.inventory[player.slotIndex];
  if (activeWeapon !== previousWeapon) {
    setViewWeapon(weaponView, activeWeapon);
    audio.playClick();
    if (app.screen === 'practice') hud.highlightWeapon(activeWeapon);
    if (app.screen === 'match') net.sendSwitch(connection, activeWeapon);
  }

  const worldStates = app.screen === 'match' ? net.sampleWorld(connection) : null;

  const frozen = app.screen === 'match' && app.match.phase !== PHASE.LIVE;
  if (input.locked && !frozen) handleFiring(now, worldStates);

  if (app.screen === 'practice' && consumePressed('resetPractice')) {
    resetRange(app.range);
    hud.updatePracticeStats(app.range.stats);
  }

  // Fixed-step physics.
  app.accumulator += dt;
  let steps = 0;
  while (app.accumulator >= PHYSICS_DT && steps < 5) {
    const result = updateLocalPlayer(player, PHYSICS_DT, app.map.solids, {
      frozen,
      lethalFallY: app.map.lethalFallY ?? null,
    });
    if (result.fallDamage > 0) app.pendingReports.fallDamage += result.fallDamage;
    if (result.died) app.pendingReports.void = true;
    app.accumulator -= PHYSICS_DT;
    steps++;
  }
  if (steps === 5) app.accumulator = 0; // fell too far behind; drop the backlog

  if (app.range) updateRange(app.range, now);

  // ---- networking ----
  if (app.screen === 'match') {
    const extra =
      app.pendingReports.fallDamage > 0 || app.pendingReports.void
        ? { fallDamage: app.pendingReports.fallDamage, void: app.pendingReports.void }
        : null;
    net.sendState(connection, player, currentFlags(), now, extra);
    if (extra && net.renderTime(connection) >= 0) {
      app.pendingReports.fallDamage = 0;
      app.pendingReports.void = false;
    }

    if (worldStates) {
      syncRemotePlayers(remotes, worldStates, {
        myId: connection.myId,
        mode: app.match.mode,
        myTeam: app.match.myTeam,
        roster: app.match.roster,
        camera,
      });
    }
    updateMatchHud(now);
  }

  applyToCamera(player, camera, settings.fov);
  updateWeaponView(weaponView, dt, now, player, app.lookDelta);
  updateTracers(tracers, now);
  updateImpacts(impacts, now);

  const weapon = currentWeapon(player);
  hud.updateVitals(player.health);
  hud.updateWeapon(player, now);
  hud.updateCrosshair(
    weapon.spread + (weapon.adsSpread - weapon.spread) * player.adsProgress,
    player.adsProgress,
    weapon.id,
  );
  hud.setScoped(isScoped(weapon.id, player.adsProgress));

  renderer.render(world.scene, camera);
  renderWeaponView(weaponView, renderer);
}

function updateMatchHud(now) {
  const m = app.match;
  const msLeft = Math.max(0, m.phaseEndsAt - now);

  if (m.phase === PHASE.LIVE) {
    hud.updateTimer(msLeft);
  } else if (m.phase === PHASE.COUNTDOWN) {
    const secs = Math.ceil(msLeft / 1000);
    hud.updateTimer(msLeft);
    hud.setStateBanner(secs > 0 ? `Starting in ${secs}` : 'Go');
    if (secs !== app.lastCountdownBeep && secs <= 3 && secs > 0) {
      app.lastCountdownBeep = secs;
      audio.playBeep(secs === 1);
    }
  }

  // Death screen with the respawn countdown. The server owns the actual respawn
  // and will send RESPAWN when it's due; this is just the local clock ticking
  // down so the wait doesn't feel indefinite.
  if (!player.alive && m.phase === PHASE.LIVE) {
    const elapsed = app.deathAt > 0 ? now - app.deathAt : 0;
    hud.showRespawn(true, app.killedBy, Math.max(0, RESPAWN_DELAY_MS - elapsed));
  }

  // Tab holds the scoreboard open mid-round.
  if (m.phase === PHASE.LIVE) {
    if (input.scoreboard) showFullScoreboard();
    else hud.showScoreboard(false);
  }
}

// -------------------------------------------------------------------- resize

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  resizeWeaponView(weaponView);
});

// An invite link lands here with the code in the hash.
const hashCode = location.hash.replace('#', '').toUpperCase();
if (/^[A-Z0-9]{4}$/.test(hashCode)) {
  dom['room-code'].value = hashCode;
  dom['menu-footer'].textContent = `Invite code ${hashCode} ready — press Join.`;
} else {
  dom['menu-footer'].textContent = 'Desktop only: needs a mouse and keyboard.';
}

if (import.meta.env.DEV) {
  window.__arena = {
    app, player, world, camera, weaponView, renderer, input, hud, connection, net, remotes,
    startPractice, leaveToMenu, handleFiring, step, enterMultiplayer,
    forceLock: (v) => { input.locked = v; },
    // Drive the loop by hand: a hidden tab pauses rAF, which is exactly the
    // situation an automated browser is always in.
    stepFrames: (count, dt = 1 / 60) => {
      let t = performance.now();
      for (let i = 0; i < count; i++) {
        t += dt * 1000;
        step(dt, t);
      }
      return t;
    },
  };
}

frame();
