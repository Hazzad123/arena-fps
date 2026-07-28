// Mode rules: what a kill is worth, what you spawn holding, and when it's over.
//
// Everything mode-specific lives here so room.js stays a plain state machine.

import { TEAMS, SCORE_LIMIT, MAX_PLAYERS } from '../shared/constants.js';
import { GUNGAME_LADDER, loadoutForClass } from '../shared/weapons.js';

export function isTeamMode(mode) {
  return mode === 'tdm';
}

/**
 * Put a joining player on the smaller team. On a tie, alternate — otherwise
 * everyone who joins an empty room piles onto team A.
 */
export function assignTeam(room, player) {
  if (!isTeamMode(room.mode)) return null;

  let a = 0;
  let b = 0;
  for (const p of room.players.values()) {
    if (p === player) continue;
    if (p.team === TEAMS.A) a++;
    else if (p.team === TEAMS.B) b++;
  }
  if (a < b) return TEAMS.A;
  if (b < a) return TEAMS.B;
  return (a + b) % 2 === 0 ? TEAMS.A : TEAMS.B;
}

/**
 * Rebalance if the teams have drifted more than one apart — happens naturally
 * when people leave mid-match.
 */
export function rebalance(room) {
  if (!isTeamMode(room.mode)) return [];

  const byTeam = { A: [], B: [] };
  for (const p of room.players.values()) byTeam[p.team]?.push(p);

  const moved = [];
  while (Math.abs(byTeam.A.length - byTeam.B.length) > 1) {
    const from = byTeam.A.length > byTeam.B.length ? 'A' : 'B';
    const to = from === 'A' ? 'B' : 'A';
    // Move the most recent joiner — least disruptive to anyone mid-fight.
    const victim = byTeam[from].sort((x, y) => y.joinedAt - x.joinedAt)[0];
    if (!victim) break;
    byTeam[from] = byTeam[from].filter((p) => p !== victim);
    victim.team = to;
    byTeam[to].push(victim);
    moved.push(victim);
  }
  return moved;
}

export function loadoutFor(room, player) {
  if (room.mode === 'gungame') {
    const id = GUNGAME_LADDER[Math.min(player.ladderIndex, GUNGAME_LADDER.length - 1)];
    // Only the current rung — that's the whole point of the mode, and it's why
    // Gun Game ignores your class.
    return [id];
  }
  return loadoutForClass(player.classId);
}

/** Does the player's own class choice decide their loadout in this mode? */
export function usesClasses(mode) {
  return mode !== 'gungame';
}

export function spawnPointsFor(room, map, player) {
  if (isTeamMode(room.mode)) return map.spawns[player.team] ?? map.spawns.ffa;
  return map.spawns.ffa;
}

export function canDamage(room, attacker, victim) {
  if (attacker.id === victim.id) return false;
  // Friendly fire off. With coworkers, accidental teamkills generate far more
  // friction than they generate interesting decisions.
  if (isTeamMode(room.mode) && attacker.team === victim.team) return false;
  return true;
}

/**
 * Apply the scoring consequences of a kill. Returns anything the clients need
 * to be told about beyond the kill itself (a gun-game promotion, say).
 */
export function onKill(room, killer, victim, weaponId) {
  victim.deaths += 1;

  if (!killer || killer.id === victim.id) {
    // Suicide, fall damage or the void: costs you, but nobody gains.
    if (killer) killer.score = Math.max(0, killer.score - 1);
    return { promoted: false, newWeapon: null };
  }

  killer.kills += 1;

  if (room.mode === 'gungame') {
    killer.ladderIndex += 1;
    killer.score = killer.ladderIndex;
    const finished = killer.ladderIndex >= GUNGAME_LADDER.length;
    return {
      promoted: !finished,
      newWeapon: finished ? null : GUNGAME_LADDER[killer.ladderIndex],
    };
  }

  killer.score += 1;
  if (isTeamMode(room.mode)) {
    room.teamScores[killer.team] = (room.teamScores[killer.team] ?? 0) + 1;
  }

  return { promoted: false, newWeapon: null };
}

/**
 * Has anyone won outright? Returns a result object, or null to keep playing
 * until the clock runs out.
 */
export function checkWin(room) {
  if (room.mode === 'gungame') {
    for (const p of room.players.values()) {
      if (p.ladderIndex >= GUNGAME_LADDER.length) {
        return { reason: 'ladder', winnerId: p.id, winnerName: p.name };
      }
    }
    return null;
  }

  const limit = SCORE_LIMIT[room.mode];
  if (!limit) return null;

  if (isTeamMode(room.mode)) {
    for (const team of [TEAMS.A, TEAMS.B]) {
      if ((room.teamScores[team] ?? 0) >= limit) {
        return { reason: 'scorelimit', winnerTeam: team };
      }
    }
    return null;
  }

  for (const p of room.players.values()) {
    if (p.score >= limit) {
      return { reason: 'scorelimit', winnerId: p.id, winnerName: p.name };
    }
  }
  return null;
}

/** Who won when the clock ran out. */
export function resultAtTimeUp(room) {
  if (isTeamMode(room.mode)) {
    const a = room.teamScores.A ?? 0;
    const b = room.teamScores.B ?? 0;
    if (a === b) return { reason: 'draw' };
    return { reason: 'timeup', winnerTeam: a > b ? TEAMS.A : TEAMS.B };
  }

  let best = null;
  let tied = false;
  for (const p of room.players.values()) {
    if (!best || p.score > best.score) {
      best = p;
      tied = false;
    } else if (best && p.score === best.score) {
      tied = true;
    }
  }
  if (!best) return { reason: 'draw' };
  if (tied) return { reason: 'draw' };
  return { reason: 'timeup', winnerId: best.id, winnerName: best.name };
}

export function describeResult(room, result) {
  if (!result) return 'Round over';
  if (result.reason === 'draw') return 'Draw';
  if (result.winnerTeam) {
    return `Team ${result.winnerTeam} wins`;
  }
  if (result.reason === 'ladder') return `${result.winnerName} ran the table`;
  return `${result.winnerName} wins`;
}

export function resetScores(room) {
  room.teamScores = { A: 0, B: 0 };
  for (const p of room.players.values()) {
    p.score = 0;
    p.kills = 0;
    p.deaths = 0;
    p.ladderIndex = 0;
  }
}

export const ROOM_CAPACITY = MAX_PLAYERS;
