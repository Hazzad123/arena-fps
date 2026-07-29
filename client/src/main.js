// Entry point: owns the renderer, the frame loop, and the screen state machine.
//
// Screens: menu -> practice | lobby -> match. Only one is live at a time, and
// each cleans up after itself, because map rotation means this runs repeatedly
// across a long session.

import * as THREE from 'three';
import {
  PHYSICS_DT, MIN_FOV, MAX_FOV, TEAMS, RESPAWN_DELAY_MS, MAX_PLAYERS, BARREL_RADIUS,
  BR_LOOT_RADIUS,
} from '@shared/constants.js';
import { getMap, mapList } from '@shared/maps/index.js';
import {
  ALL_WEAPON_IDS, getWeapon, PRIMARY_IDS, getPrimary,
  WEAPON_TYPES, weaponsOfType,
} from '@shared/weapons.js';
import { raycastBoxes, raycastPlayers } from '@shared/collision.js';
import { C2S, S2C, PHASE, FLAG, MODE_NAMES } from '@shared/protocol.js';

import { settings, saveSettings, ensureNickname } from './settings.js';
import { initInput, input, requestLock, exitLock, onLockChange, consumePressed, consumeLook } from './input.js';
import {
  createRenderer, createCamera, createWorld, loadMap, unloadMap, scorchBarrel,
} from './mapRenderer.js';
import {
  createLocalPlayer, setLoadout, spawnAt, updateLocalPlayer, applyToCamera,
  currentWeapon, tryFire, handleWeaponInput, eyePosition,
} from './localPlayer.js';
import {
  createWeaponView, setViewWeapon, updateWeaponView, weaponViewFire,
  renderWeaponView, resizeWeaponView, isScoped,
  createTracers, spawnTracer, updateTracers,
  createImpacts, spawnImpact, updateImpacts, muzzleWorldPosition,
  createExplosions, spawnExplosion, updateExplosions,
} from './weaponView.js';
import * as hud from './hud.js';
import {
  createRange, updateRange, raycastTargets, registerHit, registerShot, resetRange, disposeRange,
} from './practice.js';
import * as net from './net.js';
import { createRemotePlayers, syncRemotePlayers, clearRemotePlayers, hitboxesFrom } from './remotePlayers.js';
import * as audio from './audio.js';
import { createMinimap, drawMinimap, noteGunfire, clearMinimap } from './minimap.js';
import {
  createPickups, loadPickups, setPickupTaken, syncPickups, updatePickups, clearPickups,
  collectLocally,
} from './pickups.js';
import {
  createChat, openChat, addChatLine, clearChat,
  chatIsOpen, setTeamChatAvailable,
} from './chat.js';
import {
  createBattleRoyale, setZone, setLoot, removeLoot, nearestLoot,
  updateBattleRoyale, clearBattleRoyale, isOutsideZone,
} from './battleroyale.js';

// ---------------------------------------------------------------------- setup

const canvas = document.getElementById('game');
const renderer = createRenderer(canvas);
const world = createWorld(renderer);
const camera = createCamera(settings.fov);

const player = createLocalPlayer();
const weaponView = createWeaponView();
const tracers = createTracers(world.scene);
const impacts = createImpacts(world.scene);
const explosions = createExplosions(world.scene);
const remotes = createRemotePlayers(world.scene);
const connection = net.createNet();
const minimap = createMinimap();
const pickups = createPickups(world.scene);
const royale = createBattleRoyale(world.scene);

// Chat has to cooperate with pointer lock: typing needs the lock released, but a
// released lock is also what opens the pause menu, so the lock handler checks
// chatIsOpen() before doing that.
const chat = createChat({
  onSend: (text, team) => net.send(connection, C2S.CHAT, { t: text, team }),
  onOpenChange: (open) => {
    if (open) exitLock();
    else if (app.screen === 'match' || app.screen === 'practice') requestLock();
  },
});

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
    result: null,
    nextMapId: null,
    // Ids of players who asked to regroup in the lobby after this round.
    regroup: [],

    // Lobby, also mirrored. startsAt is on the local clock; 0 means no clock is
    // running (not enough people have readied up yet).
    lobby: {
      hostId: null,
      capacity: MAX_PLAYERS,
      minPlayers: 2,
      startsAt: 0,
    },
  },
  pendingReports: { fallDamage: 0, void: false },
  deathAt: 0,
  killedBy: '',
  // Finishing position, in the modes where death is final. 0 means "respawning".
  placed: 0,
  lastCountdownBeep: -1,
  nearLoot: null,
  aliveCount: 0,
  aliveTotal: 0,
  // Camera shake, decayed every frame. Explosions are the only thing that sets
  // it; a blast you can feel is worth more than a bigger fireball.
  shake: 0,
  wasReloading: false,
  lobbyNotice: '',
  lobbyNoticeTimer: null,
  lockCheckTimer: null,
  // Our own class. The server holds the authoritative copy; this is what the
  // pickers highlight, and it survives across sessions via settings.
  myGun: getPrimary(settings.primaryId),
};

// ----------------------------------------------------------------- dom handles

const dom = {};
for (const id of [
  'menu', 'lobby', 'nickname', 'menu-error', 'menu-footer',
  'btn-practice', 'btn-quickplay', 'btn-join', 'btn-create', 'room-code', 'mode-select',
  'sens', 'sens-val', 'fov', 'fov-val', 'vol', 'vol-val', 'invert-y',
  'lobby-code', 'lobby-mode', 'lobby-count', 'lobby-slots', 'lobby-status',
  'lobby-host', 'lobby-mode-select', 'lobby-map-select', 'lobby-class', 'lobby-class-picker',
  'btn-copy-link', 'btn-leave', 'btn-ready', 'btn-start',
  'pause', 'pause-note', 'pause-class', 'pause-class-picker', 'pause-guns',
  'pause-gun-picker', 'pause-settings', 'btn-resume', 'btn-quit', 'btn-to-lobby',
  'p-sens', 'p-sens-val', 'p-fov', 'p-fov-val', 'p-vol', 'p-vol-val', 'p-invert-y',
  'respawn-class', 'respawn-class-picker',
]) dom[id] = document.getElementById(id);

// The host's map picker offers exactly the rotation — the practice range isn't a
// multiplayer map.
for (const m of mapList()) {
  const option = document.createElement('option');
  option.value = m.id;
  option.textContent = m.name;
  dom['lobby-map-select'].appendChild(option);
}

// ------------------------------------------------------------------- settings

dom.nickname.value = settings.nickname;
dom.nickname.addEventListener('input', () => {
  settings.nickname = dom.nickname.value.slice(0, 14);
  saveSettings();
});

// The same four controls appear in the menu and in the pause menu. They're bound
// generically rather than twice over, so the two can't disagree — and every set
// is re-synced on any change, because changing the FOV mid-match should be
// reflected next time you open the main menu.
const SETTING_PANELS = [
  { sens: 'sens', fov: 'fov', vol: 'vol', invert: 'invert-y' },
  { sens: 'p-sens', fov: 'p-fov', vol: 'p-vol', invert: 'p-invert-y' },
];

function syncSettingInputs() {
  for (const p of SETTING_PANELS) {
    dom[p.sens].value = settings.sensitivity;
    dom[p.fov].value = settings.fov;
    dom[p.vol].value = Math.round(settings.volume * 100);
    dom[p.invert].checked = settings.invertY;
    dom[`${p.sens}-val`].textContent = Number(settings.sensitivity).toFixed(2);
    dom[`${p.fov}-val`].textContent = settings.fov;
    dom[`${p.vol}-val`].textContent = Math.round(settings.volume * 100);
  }
}

function commit(change) {
  change();
  syncSettingInputs();
  saveSettings();
}

for (const p of SETTING_PANELS) {
  dom[p.sens].addEventListener('input', () =>
    commit(() => {
      settings.sensitivity = Number(dom[p.sens].value);
    }));
  dom[p.fov].addEventListener('input', () =>
    commit(() => {
      settings.fov = Math.max(MIN_FOV, Math.min(MAX_FOV, Number(dom[p.fov].value)));
    }));
  dom[p.vol].addEventListener('input', () =>
    commit(() => {
      settings.volume = Number(dom[p.vol].value) / 100;
      audio.setVolume(settings.volume);
    }));
  dom[p.invert].addEventListener('change', () =>
    commit(() => {
      settings.invertY = dom[p.invert].checked;
    }));
}

syncSettingInputs();

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
    // The class travels with the join. Joining a match already in progress spawns
    // you immediately, so telling the server afterwards would always cost you
    // your first life on the wrong class.
    net.send(connection, action, { ...payload, primaryId: app.myGun });
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
    // copied by hand rather than silently doing nothing. It goes through the
    // notice slot because the status line is rewritten every frame.
    showLobbyNotice(url, 8000);
  }
});

// ------------------------------------------------------------------- screens

function applyMap(mapId) {
  app.map = getMap(mapId);
  loadMap(world, app.map);
  loadPickups(pickups, app.map);
  clearRemotePlayers(remotes);
  clearMinimap(minimap);
  clearPickups(pickups);
  clearBattleRoyale(royale);
  hud.setBattleRoyaleVisible(false);
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
  hud.setMinimapVisible(false);
  hud.setStateBanner('');
  hud.updatePracticeStats(app.range.stats);
  hud.highlightWeapon(player.inventory[player.slotIndex]);
  grabPointer();
}

function enterLobby() {
  app.screen = 'lobby';
  exitLock();
  dom.menu.classList.add('hidden');
  dom.lobby.classList.remove('hidden');
  hud.showHud(false);
  hud.showRespawn(false);
  hud.showResults(false);
  // A round can end while the pause menu is open; the lobby has its own buttons.
  showPause(false);
  renderLobby();
}

function enterMatch() {
  app.screen = 'match';
  dom.menu.classList.add('hidden');
  dom.lobby.classList.add('hidden');
  hud.showHud(true);
  hud.setPracticeMode(false);
  hud.setMinimapVisible(true);
  hud.setTeamScoresVisible(app.match.mode === 'tdm');
  grabPointer();
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
  app.match.lobby.hostId = null;
  app.match.lobby.startsAt = 0;
  app.lobbyNotice = '';
  clearTimeout(app.lobbyNoticeTimer);

  history.replaceState(null, '', location.pathname);
  hud.showHud(false);
  hud.showScoreboard(false);
  hud.showRespawn(false);
  hud.showResults(false);
  hud.clearKillfeed();
  clearChat(chat);
  showPause(false);
  dom.lobby.classList.add('hidden');
  dom.menu.classList.remove('hidden');
}

// ---------------------------------------------------------------- pickers
//
// One builder for the class picker, used in three places: the lobby, the pause
// menu and the death screen. Every entry shows its number key, because on the
// death screen the pointer is still locked to the canvas and the keyboard is the
// only way to choose.

const GUN_PICKERS = ['lobby-class-picker', 'pause-class-picker', 'respawn-class-picker'];

function buildPicker(container, entries, onPick) {
  container.replaceChildren();
  let lastGroup = null;
  for (const entry of entries) {
    // A heading per weapon type. Fifteen guns in a flat list is a wall; grouped
    // by what they are, it's a choice.
    if (entry.group && entry.group !== lastGroup) {
      lastGroup = entry.group;
      const head = document.createElement('div');
      head.className = 'pick-group';
      head.textContent = entry.group;
      container.appendChild(head);
    }
    const button = document.createElement('button');
    button.className = 'pick';
    button.type = 'button';
    button.dataset.pick = entry.id;

    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = entry.key ?? '';
    key.classList.toggle('hidden', entry.key === undefined);

    const body = document.createElement('span');
    body.className = 'body';
    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = entry.name;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = entry.sub;
    body.append(name, sub);

    button.append(key, body);
    button.addEventListener('click', () => onPick(entry.id));
    container.appendChild(button);
  }
}

function highlightPicker(container, activeId) {
  for (const button of container.children) {
    button.classList.toggle('active', button.dataset.pick === activeId);
  }
}

/** One entry per selectable gun, grouped under its type. */
function gunEntries() {
  const out = [];
  for (const type of WEAPON_TYPES) {
    for (const weapon of weaponsOfType(type.id)) {
      if (!PRIMARY_IDS.includes(weapon.id)) continue;
      out.push({
        id: weapon.id,
        group: type.name,
        name: weapon.name,
        sub: describeGun(weapon),
      });
    }
  }
  return out;
}

/**
 * A one-line read on a gun, generated from its own numbers rather than written
 * per weapon — so it can't drift out of date when the balance changes.
 */
function describeGun(w) {
  const shots = Math.ceil(100 / (w.damage * (w.pellets > 1 ? w.pellets * 0.7 : 1)));
  const ttk = shots <= 1 ? 'one shot' : `${shots} shots`;
  const reach = w.falloffEnd >= 120 ? 'long range'
    : w.falloffEnd >= 55 ? 'mid range'
      : 'close range';
  return `${ttk} · ${w.rpm}rpm · ${reach}`;
}

function buildGunPickers() {
  for (const id of GUN_PICKERS) buildPicker(dom[id], gunEntries(), chooseGun);
}

function refreshGunPickers() {
  for (const id of GUN_PICKERS) highlightPicker(dom[id], app.myGun);
}

/**
 * Number keys pick a *type*, not a specific gun: there are fifteen guns and ten
 * digits, and an arbitrary slice of the first nine would be worse than useless.
 * So 1-6 grab the first gun of each type — enough to say "give me a shotgun"
 * without the mouse — and the picker is there for the exact one.
 */
function quickPickType(index) {
  const type = WEAPON_TYPES[index - 1];
  if (!type) return;
  const first = weaponsOfType(type.id).find((w) => PRIMARY_IDS.includes(w.id));
  if (first) chooseGun(first.id);
}

/** Ask the server for a gun. It decides when that takes effect. */
function chooseGun(primaryId) {
  if (!PRIMARY_IDS.includes(primaryId)) return;
  app.myGun = primaryId;
  settings.primaryId = primaryId;
  saveSettings();
  refreshGunPickers();
  audio.playClick();
  if (connection.connected) net.send(connection, C2S.SET_PRIMARY, { primaryId });
}

/** The practice range's mouse-driven gun list. The number keys still work; this
 *  exists because nothing on screen told anyone that. */
function buildGunPicker() {
  const entries = ALL_WEAPON_IDS.map((id) => ({
    id,
    key: getWeapon(id).slot,
    name: getWeapon(id).name,
    sub: `${getWeapon(id).mag === Infinity ? '∞' : getWeapon(id).mag} rounds`,
  }));
  buildPicker(dom['pause-gun-picker'], entries, (id) => {
    const index = player.inventory.indexOf(id);
    if (index < 0) return;
    player.slotIndex = index;
    setViewWeapon(weaponView, id);
    hud.highlightWeapon(id);
    highlightPicker(dom['pause-gun-picker'], id);
    audio.playClick();
  });
}

buildGunPickers();
buildGunPicker();

// ------------------------------------------------------------------- pause

function pauseVisible() {
  return !dom.pause.classList.contains('hidden');
}

/**
 * Whether picking a gun means anything in this mode. Gun Game marches everyone up
 * the same ladder, and battle royale drops everyone with the same pistol — in both
 * cases the server ignores your choice, so offering the picker is a lie.
 */
function gunChoiceMatters(mode) {
  return mode !== 'gungame' && mode !== 'br';
}

function showPause(visible) {
  dom.pause.classList.toggle('hidden', !visible);
  if (!visible) return;

  const inMatch = app.screen === 'match';
  dom['pause-note'].textContent = inMatch
    ? 'The match is still running — you are not invisible.'
    : 'Practice range';
  // Choosing a gun is a multiplayer concept, and not every mode lets you.
  dom['pause-class'].classList.toggle('hidden', !inMatch || !gunChoiceMatters(app.match.mode));
  dom['pause-guns'].classList.toggle('hidden', app.screen !== 'practice');

  // Regrouping only means anything between rounds, which is also the only time
  // the mouse is any use for it — hence the same action on `L` on the results
  // screen, where the pointer is still locked.
  const canRegroup = inMatch && app.match.phase === PHASE.SCOREBOARD;
  dom['btn-to-lobby'].classList.toggle('hidden', !canRegroup);
  if (canRegroup) {
    const asked = app.match.regroup.includes(connection.myId);
    dom['btn-to-lobby'].textContent = asked ? 'Back to lobby ✓' : 'Back to lobby';
    dom['btn-to-lobby'].classList.toggle('asked', asked);
  }

  if (app.screen === 'practice') {
    highlightPicker(dom['pause-gun-picker'], player.inventory[player.slotIndex]);
  }
  refreshGunPickers();
}

// Deliberately doesn't hide the panel itself — onLockChange does that once the
// lock actually lands. Chrome refuses a re-lock for about a second after Escape
// released it, and hiding optimistically would drop you into the game with no
// cursor, no crosshair control and nothing to click.
dom['btn-resume'].addEventListener('click', () => requestLock());

dom['btn-to-lobby'].addEventListener('click', () => toggleRegroup());

dom['btn-quit'].addEventListener('click', () => leaveToMenu());

/**
 * Take the pointer when entering the game, and if the browser refuses, fall back
 * to the pause menu so there's always a visible way in. The delay is there
 * because the lock arrives as an event a frame or two later, and showing the
 * panel in the meantime would flash it on every single spawn.
 */
function grabPointer() {
  requestLock();
  clearTimeout(app.lockCheckTimer);
  app.lockCheckTimer = setTimeout(() => {
    const inGame = app.screen === 'practice' || app.screen === 'match';
    if (inGame && !input.locked) showPause(true);
  }, 600);
}

// ------------------------------------------------------------------- lobby

function me() {
  return app.match.roster.get(connection.myId) ?? null;
}

function iAmHost() {
  return app.match.lobby.hostId === connection.myId;
}

/** One slot. `player` is null for an empty seat. */
function lobbySlot(player, teamColor) {
  const row = document.createElement('div');
  row.className = 'slot';

  const dot = document.createElement('span');
  dot.className = 'dot';

  const name = document.createElement('span');
  name.className = 'nm';

  if (!player) {
    row.classList.add('empty');
    name.textContent = 'Open';
    row.append(dot, name);
    return row;
  }

  dot.style.background = teamColor;
  name.textContent = player.name;
  row.append(dot, name);

  if (player.id === app.match.lobby.hostId) {
    const crown = document.createElement('span');
    crown.className = 'crown';
    crown.textContent = '★';
    crown.title = 'Host';
    row.appendChild(crown);
  }
  if (player.id === connection.myId) row.classList.add('me');

  const tag = document.createElement('span');
  if (player.ready) {
    row.classList.add('is-ready');
    tag.className = 'tag ready';
    tag.textContent = 'ready';
  } else {
    tag.className = 'tag';
    tag.textContent = player.id === connection.myId ? 'you' : 'waiting';
  }
  row.appendChild(tag);

  return row;
}

function renderLobby() {
  const m = app.match;
  const capacity = m.lobby.capacity || MAX_PLAYERS;
  const players = [...m.roster.values()];

  dom['lobby-code'].textContent = m.code ?? '----';
  dom['lobby-mode'].textContent = `${MODE_NAMES[m.mode] ?? m.mode} · ${app.map?.name ?? ''}`;
  dom['lobby-count'].textContent = `${players.length} / ${capacity}`;

  dom['lobby-slots'].replaceChildren();

  if (m.mode === 'tdm') {
    // Split by team so the lobby shows the balance you'll actually play with.
    const half = Math.ceil(capacity / 2);
    for (const team of [TEAMS.A, TEAMS.B]) {
      const col = document.createElement('div');
      col.className = 'slot-col';
      const head = document.createElement('div');
      head.className = `slot-head ${team.toLowerCase()}`;
      head.textContent = `Team ${team}`;
      col.appendChild(head);

      // Rebalancing keeps the teams within one of each other, so half the room
      // per column is right — but never render fewer slots than there are
      // people, or a player would silently vanish from the lobby.
      const members = players.filter((p) => p.team === team);
      for (let i = 0; i < Math.max(half, members.length); i++) {
        col.appendChild(lobbySlot(members[i] ?? null, `var(--team-${team.toLowerCase()})`));
      }
      dom['lobby-slots'].appendChild(col);
    }
  } else {
    for (let i = 0; i < capacity; i++) {
      dom['lobby-slots'].appendChild(lobbySlot(players[i] ?? null, 'var(--accent)'));
    }
  }

  // Host controls. Everyone else just sees the mode and map in the header.
  dom['lobby-host'].classList.toggle('hidden', !iAmHost());
  dom['lobby-mode-select'].value = m.mode;
  dom['lobby-map-select'].value = app.map?.id ?? '';

  // Everything below is only actionable once the room is actually in the lobby;
  // between rounds you're just waiting to be dropped into the next one.
  const inLobbyPhase = m.phase === PHASE.LOBBY;
  dom['btn-start'].classList.toggle('hidden', !iAmHost());
  dom['btn-start'].disabled = !inLobbyPhase || players.length < (m.lobby.minPlayers || 2);
  dom['btn-ready'].disabled = !inLobbyPhase;
  for (const select of [dom['lobby-mode-select'], dom['lobby-map-select']]) {
    select.disabled = !inLobbyPhase;
  }

  dom['lobby-class'].classList.toggle('hidden', !gunChoiceMatters(m.mode));
  refreshGunPickers();

  const mine = me();
  const ready = !!mine?.ready;
  dom['btn-ready'].textContent = ready ? 'Ready ✓' : 'Ready up';
  dom['btn-ready'].classList.toggle('is-ready', ready);
  dom['btn-ready'].title = ready ? 'Click to un-ready' : '';

  updateLobbyStatus();
}

/** m:ss. The grace period is well under a minute today, but the constant is
 *  meant to be tuned and "0:90" would be a silly thing to ship. */
function clock(totalSeconds) {
  const mins = Math.floor(totalSeconds / 60);
  return `${mins}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

/** Temporarily takes over the status line. */
function showLobbyNotice(text, ms) {
  app.lobbyNotice = text;
  clearTimeout(app.lobbyNoticeTimer);
  app.lobbyNoticeTimer = setTimeout(() => {
    app.lobbyNotice = '';
  }, ms);
}

/** Status line only. Called every frame so the grace countdown ticks without
 *  rebuilding the slot grid. */
function updateLobbyStatus() {
  const m = app.match;
  const players = [...m.roster.values()];
  const readyCount = players.filter((p) => p.ready).length;
  const min = m.lobby.minPlayers || 2;
  const status = dom['lobby-status'];

  if (app.lobbyNotice) {
    status.textContent = app.lobbyNotice;
    return;
  }

  // Joining between rounds lands you on the lobby panel while the room is still
  // finishing its scoreboard. Readying up is rejected until the room is actually
  // in the lobby, so say what's happening rather than offering a button that
  // silently does nothing.
  if (m.phase !== PHASE.LOBBY) {
    status.textContent = 'Round in progress — you’ll be dropped in when the next one starts.';
    return;
  }

  if (players.length < min) {
    const need = min - players.length;
    status.textContent = `Waiting for ${need} more player${need === 1 ? '' : 's'} — share the code above.`;
    return;
  }

  if (m.lobby.startsAt > 0) {
    const left = Math.max(0, m.lobby.startsAt - performance.now());
    const secs = Math.ceil(left / 1000);
    const waiting = players.length - readyCount;
    status.replaceChildren(
      document.createTextNode('Starting in '),
      Object.assign(document.createElement('b'), { textContent: clock(secs) }),
      document.createTextNode(
        ` — waiting on ${waiting} player${waiting === 1 ? '' : 's'} to ready up.`,
      ),
    );
    return;
  }

  status.textContent =
    readyCount === 0
      ? `${players.length} here. Ready up when you are — ${min} ready starts the clock.`
      : `${readyCount} of ${players.length} ready — ${min} ready starts the clock.`;
}

dom['btn-ready'].addEventListener('click', () => {
  net.send(connection, C2S.READY, { ready: !me()?.ready });
  audio.playClick();
});

dom['btn-start'].addEventListener('click', () => {
  net.send(connection, C2S.START, {});
});

dom['lobby-mode-select'].addEventListener('change', () => {
  net.send(connection, C2S.LOBBY_SET, { mode: dom['lobby-mode-select'].value });
});

dom['lobby-map-select'].addEventListener('change', () => {
  net.send(connection, C2S.LOBBY_SET, { mapId: dom['lobby-map-select'].value });
});

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
  // After applyMap, so the map ids already agree and it doesn't rebuild.
  if (msg.lobby) applyLobbyState(msg.lobby);
  setLoadout(player, msg.inventory ?? ['rifle', 'pistol', 'knife']);
  setViewWeapon(weaponView, player.inventory[0]);

  history.replaceState(null, '', `#${msg.code}`);
  hud.setTeamScoresVisible(m.mode === 'tdm');
  setTeamChatAvailable(chat, m.mode === 'tdm');
  hud.setBattleRoyaleVisible(m.mode === 'br');
  hud.updateScores(m.teamScores.A, m.teamScores.B);

  for (const index of msg.barrelsGone ?? []) scorchBarrel(world, index);
  syncPickups(pickups, msg.pickupsTaken);
  if (msg.loot) setLoot(royale, msg.loot);
  if (msg.zone) setZone(royale, msg.zone);
  hud.setBattleRoyaleVisible(m.mode === 'br');

  if (msg.phase === PHASE.LIVE || msg.phase === PHASE.COUNTDOWN) enterMatch();
  else enterLobby();
});

net.on(connection, S2C.ROSTER, (msg) => {
  updateRoster(msg.roster);
  app.match.teamScores = msg.teamScores ?? app.match.teamScores;
  hud.updateScores(app.match.teamScores.A, app.match.teamScores.B);
  if (app.screen === 'lobby') renderLobby();
});

/** Mirror a lobby update from the server. Also handles the host changing the
 *  mode or map, which changes what we render behind the panel. */
function applyLobbyState(msg) {
  const m = app.match;
  m.mode = msg.mode ?? m.mode;
  m.lobby.hostId = msg.hostId ?? null;
  m.lobby.capacity = msg.capacity ?? MAX_PLAYERS;
  m.lobby.minPlayers = msg.minPlayers ?? 2;
  m.lobby.startsAt = msg.startsInMs > 0 ? performance.now() + msg.startsInMs : 0;
  if (msg.roster) updateRoster(msg.roster);
  if (msg.mapId && msg.mapId !== app.map?.id) applyMap(msg.mapId);
}

net.on(connection, S2C.LOBBY, (msg) => {
  applyLobbyState(msg);
  if (app.screen === 'lobby') renderLobby();
});

net.on(connection, S2C.PHASE, (msg) => {
  const m = app.match;
  const previous = m.phase;
  const wasScoreboard = previous === PHASE.SCOREBOARD;
  m.phase = msg.phase;
  m.phaseEndsAt = performance.now() + (msg.msLeft ?? 0);
  m.teamScores = msg.teamScores ?? m.teamScores;
  m.resultText = msg.resultText ?? null;
  m.result = msg.result ?? null;
  m.nextMapId = msg.nextMapId ?? null;
  m.regroup = msg.regroup ?? [];
  m.mode = msg.mode ?? m.mode;
  if (msg.roster) updateRoster(msg.roster);

  // A regroup request re-sends the scoreboard phase to everyone. Redraw the
  // footer rather than the whole panel, so it doesn't flicker mid-read.
  if (wasScoreboard && msg.phase === PHASE.SCOREBOARD) {
    updateResultsFooter();
    if (pauseVisible()) showPause(true); // relabel its regroup button
    return;
  }

  // Map rotates between rounds.
  if (msg.mapId && msg.mapId !== app.map?.id) applyMap(msg.mapId);

  hud.updateScores(m.teamScores.A, m.teamScores.B);

  switch (msg.phase) {
    case PHASE.COUNTDOWN:
      if (app.screen !== 'match') enterMatch();
      hud.showScoreboard(false);
      hud.showResults(false);
      hud.clearKillfeed();
      app.lastCountdownBeep = -1;
      hud.setStateBanner('Get ready');
      break;

    case PHASE.LIVE:
      hud.showScoreboard(false);
      hud.showResults(false);
      hud.setStateBanner('');
      if (previous !== PHASE.LIVE) audio.playFanfare(true);
      break;

    case PHASE.SCOREBOARD:
      hud.setStateBanner('');
      hud.showRespawn(false);
      hud.showScoreboard(false);
      showResults();
      // Back-to-lobby only exists between rounds, so the pause menu needs to
      // pick the button up if it was already open when the round ended.
      if (pauseVisible()) showPause(true);
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
  app.placed = 0;
});

net.on(connection, S2C.LOADOUT, (msg) => {
  setLoadout(player, msg.inventory);
  setViewWeapon(weaponView, player.inventory[0]);
  // The server confirming a class change is the authoritative answer.
  if (msg.primaryId && PRIMARY_IDS.includes(msg.primaryId)) {
    app.myGun = msg.primaryId;
    refreshGunPickers();
  }
  if (msg.promoted) {
    hud.setStateBanner(`Promoted: ${getWeapon(msg.inventory[0]).name}`);
    setTimeout(() => hud.setStateBanner(''), 1600);
    audio.playClick(1.4);
  }
});

net.on(connection, S2C.DAMAGE, (msg) => {
  if (msg.self) {
    player.health = msg.health;
    // A health pack arrives on the same message; it isn't damage.
    if (msg.heal) return;
    audio.playHurt();
    hud.damageIndicator(msg.from ? directionTo(msg.from) : null);
    if (msg.health <= 0) player.alive = false;
  } else {
    // Server confirmed our hit landed. Everything below is feedback for the
    // shooter — it's the moment the game most needs to feel good, so it gets a
    // marker, a sound, a number on the target and, on a kill, a banner.
    const kind = msg.lethal ? 'kill' : msg.head ? 'head' : 'hit';
    hud.hitmarker(kind);
    audio.playHitmarker(kind);

    if (msg.at) {
      const screen = projectToScreen(msg.at);
      if (screen) hud.damageNumber(msg.amount, screen.x, screen.y, kind);
      // A burst of blood on the body reads at any distance, unlike a number.
      spawnImpact(impacts, msg.at, performance.now(), 0xffffff, true);
    }

    if (msg.lethal) hud.killBanner(msg.name, msg.head);
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
    app.placed = msg.placed || 0;
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

  // Radar mark wherever an enemy fired. Teammates don't give themselves away —
  // otherwise a full lobby of friendlies floods the dial and hides the one mark
  // that actually matters.
  const shooter = app.match.roster.get(msg.id);
  const friendly = app.match.mode === 'tdm' && shooter?.team && shooter.team === app.match.myTeam;
  if (!friendly) noteGunfire(minimap, origin);
});

net.on(connection, S2C.ZONE, (msg) => {
  setZone(royale, msg);
});

net.on(connection, S2C.LOOT, (msg) => {
  if (msg.all) setLoot(royale, msg.all);
  if (msg.taken) removeLoot(royale, msg.taken);
});

net.on(connection, S2C.ALIVE, (msg) => {
  app.aliveCount = msg.alive;
  app.aliveTotal = msg.total;
  hud.updateAlive(msg.alive, msg.total);
});

net.on(connection, S2C.PICKUP, (msg) => {
  setPickupTaken(pickups, msg.index, !!msg.taken);
  if (!msg.taken) return;

  // A rising two-tone for the person who took it, a positioned blip for everyone
  // else — so you know a pack has gone even if you didn't see who took it.
  if (msg.by === connection.myId) {
    audio.playFanfare(true);
  } else if (msg.at) {
    const eye = eyePosition(player);
    const { pan, distance } = audio.spatialise(msg.at, eye, player.yaw);
    audio.playClick(1.5, { pan, distance });
  }
});

net.on(connection, S2C.PICKUPS, (msg) => {
  syncPickups(pickups, msg.taken);
});

net.on(connection, S2C.BARREL_HIT, (msg) => {
  // Not destroyed yet: a spark and a metallic clang so you know it's damaged and
  // worth another shot.
  const now = performance.now();
  spawnImpact(impacts, msg.at, now, 0xffc46a);
  const eye = eyePosition(player);
  const { pan, distance } = audio.spatialise(msg.at, eye, player.yaw);
  audio.playClick(0.6 + Math.random() * 0.15, { pan, distance });
});

net.on(connection, S2C.EXPLODE, (msg) => {
  const now = performance.now();
  spawnExplosion(explosions, msg.at, BARREL_RADIUS * 0.55, now);
  scorchBarrel(world, msg.index);

  const eye = eyePosition(player);
  const { pan, distance } = audio.spatialise(msg.at, eye, player.yaw);
  audio.playExplosion({ pan, distance });

  // Shake falls off with distance, so a blast across the map is a rumble and one
  // at your feet throws the camera.
  const falloff = Math.max(0, 1 - distance / (BARREL_RADIUS * 3));
  app.shake = Math.min(1, app.shake + falloff * falloff * 1.1);
});

net.on(connection, S2C.BARRELS, (msg) => {
  // Round reset: every barrel is back, so drop the scorched visuals by reloading
  // nothing — the map itself is reloaded on a phase change. Only the explicit
  // "already gone" list needs applying.
  for (const index of msg.gone ?? []) scorchBarrel(world, index);
});

net.on(connection, S2C.CHAT, (msg) => {
  addChatLine(chat, msg, connection.myId);
});

function updateRoster(list) {
  if (!list) return;
  app.match.roster.clear();
  for (const p of list) app.match.roster.set(p.id, p);

  // Our own team can change under us — rebalancing moves the most recent joiner
  // when someone leaves, and switching mode reassigns everyone. Track it here or
  // we'd keep colouring by a team we're no longer on, which shows teammates as
  // enemies.
  const mine = app.match.roster.get(connection.myId);
  if (mine) app.match.myTeam = mine.team ?? null;
}

const tmpProject = new THREE.Vector3();

/**
 * World position to screen pixels, or null if it's behind the camera.
 * Used to put damage numbers on the player you actually hit.
 */
function projectToScreen(worldPos) {
  tmpProject.set(worldPos[0], worldPos[1], worldPos[2]).project(camera);
  if (tmpProject.z > 1) return null;
  return {
    x: ((tmpProject.x + 1) / 2) * window.innerWidth,
    y: ((1 - tmpProject.y) / 2) * window.innerHeight,
  };
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

// ------------------------------------------------------------- end of match

function showResults() {
  const m = app.match;
  hud.showResults(true, {
    result: m.result,
    resultText: m.resultText,
    mode: m.mode,
    teamScores: m.teamScores,
    players: [...m.roster.values()],
    myId: connection.myId,
  });
  updateResultsFooter();
}

/** Footer only — the countdown to the next round and the regroup state. */
function updateResultsFooter() {
  const m = app.match;
  hud.updateResultsFooter({
    nextMapName: m.nextMapId ? getMap(m.nextMapId).name : null,
    msLeft: Math.max(0, m.phaseEndsAt - performance.now()),
    regrouping: m.regroup.length,
    askedByMe: m.regroup.includes(connection.myId),
    returning: m.regroup.length > 0,
  });
}

/** Ask to go back to the lobby instead of rolling into the next round. */
function toggleRegroup() {
  if (app.match.phase !== PHASE.SCOREBOARD) return;
  const on = !app.match.regroup.includes(connection.myId);
  net.send(connection, C2S.TO_LOBBY, { on });
  audio.playClick();
}

// ------------------------------------------------------------- pointer lock UX

// Losing the pointer is the pause: Escape releases it, and the browser also
// releases it on tab switches and alerts. Either way you land here.
onLockChange((locked) => {
  const inGame = app.screen === 'practice' || app.screen === 'match';
  if (locked) {
    showPause(false);
    audio.resumeAudio();
  } else if (inGame && !chatIsOpen(chat)) {
    // Typing releases the lock deliberately; that isn't a request to pause.
    showPause(true);
  }
});

window.addEventListener('keydown', (e) => {
  // Don't hijack keys while a select or a text field has focus.
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '');

  // Enter opens chat in a match; Shift+Enter opens it in team mode. Handled here
  // rather than in input.js because input.js only sees keys while the pointer is
  // locked, and the whole point of chat is that it isn't.
  if (!typing && app.screen === 'match' && !pauseVisible()
      && (e.code === 'Enter' || e.code === 'NumpadEnter')) {
    e.preventDefault();
    openChat(chat, { team: e.shiftKey });
    return;
  }

  if (app.screen === 'lobby') {
    if (e.code === 'Escape') leaveToMenu();
    else if (e.code === 'Enter' && !typing) dom['btn-ready'].click();
    return;
  }

  if (!pauseVisible()) return;

  // Escape both opens and closes the pause menu. Chrome enforces a short cooldown
  // before a pointer lock released by Escape can be reacquired, so the menu is
  // dismissed by onLockChange when the lock actually lands — not optimistically
  // here, which would leave you staring at the game with no controls.
  if (e.code === 'Escape') {
    requestLock();
    return;
  }

  // Number keys pick a weapon type from the pause menu too, matching the death
  // screen.
  const num = e.code.match(/^Digit([1-9])$/);
  if (num && !typing && !dom['pause-class'].classList.contains('hidden')) {
    quickPickType(Number(num[1]));
  }
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
  const barrelsHit = [];
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
        // A downed plate is the range's equivalent of a kill.
        const kind = damage >= 100 ? 'kill' : 'hit';
        hud.hitmarker(kind);
        audio.playHitmarker(kind);
        const screen = projectToScreen(end);
        if (screen) hud.damageNumber(damage, screen.x, screen.y, kind);
        hitAnything = true;
      } else {
        spawnImpact(impacts, end, now);
        // A barrel is an ordinary solid, so the wall raycast already found it —
        // it just needs reporting so the server can count the hit.
        if (wallHit?.box?.tag?.startsWith('barrel:')) barrelsHit.push(wallHit.box.index);
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
      barrels: barrelsHit,
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
    // The lobby's start clock is server-owned but ticked locally, same as the
    // round timer — one message tells us the deadline, the panel counts down.
    if (app.screen === 'lobby') updateLobbyStatus();
    renderer.render(world.scene, camera);
    return;
  }

  // Look is sampled once per frame, not per physics step, so a 200Hz mouse
  // doesn't turn faster than a 60Hz one.
  const look = consumeLook();

  // Slow the aim down while sighted, most of all through the sniper's 4x optic.
  // Without this, a magnified view multiplies every hand movement by the zoom
  // factor and the scope becomes unusable — one flick crosses the whole screen.
  const aimed = currentWeapon(player);
  const adsScale = 1 + (aimed.adsSensitivity - 1) * player.adsProgress;
  look.dx *= adsScale;
  look.dy *= adsScale;

  player.yaw -= look.dx;
  player.pitch = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, player.pitch - look.dy));
  app.lookDelta = look;

  // While dead the number keys pick your next class rather than a weapon — you
  // have no weapon to switch to, and the pointer is still locked so the mouse
  // can't reach the picker on screen. Has to run before handleWeaponInput,
  // which consumes the same keypress.
  if (app.screen === 'match' && !player.alive && app.match.mode !== 'gungame' && input.weaponSlot > 0) {
    quickPickType(input.weaponSlot);
    input.weaponSlot = 0;
  }

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

  // E picks up the loot you're standing on. Battle royale only: it's the one mode
  // where what you're holding is found rather than chosen.
  if (consumePressed('use') && app.match.mode === 'br' && app.nearLoot) {
    net.send(connection, C2S.TAKE_LOOT, {});
  }

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
        // Name tags are DOM, so they need the map to know what's hiding a player.
        solids: app.map.solids,
        // Drives the character animation mixers.
        dt,
      });
    }
    updateMatchHud(now);
    drawMinimap(minimap, {
      map: app.map,
      player,
      states: worldStates,
      myId: connection.myId,
      mode: app.match.mode,
      myTeam: app.match.myTeam,
      roster: app.match.roster,
      zone: royale.active ? royale.zone : null,
    });
  }

  applyToCamera(player, camera, settings.fov);

  // Explosion shake, applied after the camera is otherwise final. Rotational
  // rather than positional so it can't shove the eye through a wall.
  if (app.shake > 0.002) {
    const k = app.shake * 0.035;
    camera.rotation.x += (Math.random() - 0.5) * k;
    camera.rotation.y += (Math.random() - 0.5) * k;
    camera.rotation.z += (Math.random() - 0.5) * k * 1.6;
  }
  updateWeaponView(weaponView, dt, now, player, app.lookDelta);
  updateTracers(tracers, now);
  updateImpacts(impacts, now);
  updateExplosions(explosions, now);
  updatePickups(pickups, now);
  updateBattleRoyale(royale, now, dt);

  // The practice range has no server, so it collects its own health packs.
  if (app.screen === 'practice') {
    const healed = collectLocally(pickups, player, now);
    if (healed > 0) audio.playFanfare(true);
  }

  if (app.match.mode === 'br' && royale.active) {
    // Loot prompt: nearest pickup within arm's reach.
    app.nearLoot = player.alive ? nearestLoot(royale, player.pos, BR_LOOT_RADIUS + 0.6) : null;
    hud.showLootPrompt(app.nearLoot);
    hud.updateZone({
      state: royale.zone?.state,
      msToNext: royale.zone?.msToNext ?? 0,
      outside: player.alive && isOutsideZone(royale, player.pos),
      dps: royale.zone?.dps ?? 0,
    });
  }
  app.shake *= Math.max(0, 1 - 6.5 * dt);

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

/**
 * What the death screen should say. Three genuinely different situations wearing
 * the same overlay: a short wait, a long wait, and no wait at all.
 */
function deathScreenText(mode, elapsed) {
  if (mode === 'br') {
    // No respawn is coming. Placement is the score, so lead with it.
    const total = app.aliveTotal || app.match.roster.size;
    return {
      title: 'ELIMINATED',
      status: app.placed > 0 ? `#${app.placed} of ${total}` : 'out of the match',
    };
  }
  if (mode === 'waves') {
    // Revived at the top of the next wave, which is however long your team takes.
    return { title: 'DOWN', status: 'back up next wave' };
  }
  const msLeft = Math.max(0, RESPAWN_DELAY_MS - elapsed);
  return {
    title: 'DOWN',
    status: msLeft > 0 ? `respawning in ${(msLeft / 1000).toFixed(1)}s` : 'respawning…',
  };
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
    const death = deathScreenText(m.mode, elapsed);
    hud.showRespawn(true, app.killedBy, death.status, death.title);
    // Being dead is the other moment you'd want to change gun, and the only one
    // where it's free.
    dom['respawn-class'].classList.toggle('hidden', !gunChoiceMatters(m.mode));
  }

  // Tab holds the scoreboard open mid-round.
  if (m.phase === PHASE.LIVE) {
    if (input.scoreboard) showFullScoreboard();
    else hud.showScoreboard(false);
  }

  if (m.phase === PHASE.SCOREBOARD) {
    updateResultsFooter();
    // Pointer lock is still held at round end, so the results screen is worked
    // with the keyboard — same reason the death screen is.
    if (consumePressed('lobby')) toggleRegroup();
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
