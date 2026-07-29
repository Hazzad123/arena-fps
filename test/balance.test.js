// Weapon balance, as properties rather than as a table of expected numbers.
//
// Asserting exact TTKs would mean editing this file every time a gun is tuned,
// which trains you to update the test until it passes. These check the *rules*
// instead: nothing kills absurdly fast, nothing is strictly worse than a sibling,
// and each type still does the job it exists to do.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WEAPONS, WEAPON_TYPES, PRIMARY_IDS, weaponsOfType,
  damageAtDistance, fireIntervalMs,
} from '../shared/weapons.js';
import { MAX_HEALTH } from '../shared/constants.js';

/** Shots to kill a full-health player at point blank. */
function shotsToKill(w, distance = 0) {
  const perShot = damageAtDistance(w, distance) * w.pellets;
  if (perShot <= 0) return Infinity;
  return Math.ceil(MAX_HEALTH / perShot);
}

/** Milliseconds from first shot to kill, ignoring reloads. */
function ttk(w, distance = 0) {
  const stk = shotsToKill(w, distance);
  if (!Number.isFinite(stk)) return Infinity;
  return (stk - 1) * fireIntervalMs(w);
}

/**
 * How far the gun still hits meaningfully hard: the distance at which sustained
 * damage output has fallen below 55% of its point-blank value.
 *
 * Deliberately continuous. The obvious metric — "furthest distance you still kill
 * in the same number of shots" — is quantised by that integer, so a gun with a
 * *worse* point-blank shots-to-kill scores a longer reach, and the test then
 * reports the rifle as strictly worse than the carbine. Falloff is the thing
 * actually being compared, so measure falloff.
 */
function reach(w) {
  const dps = (d) => damageAtDistance(w, d) * w.pellets * (w.rpm / 60);
  const pointBlank = dps(0);
  if (pointBlank <= 0) return 0;
  for (let d = 0; d <= w.range; d += 0.5) {
    if (dps(d) < pointBlank * 0.55) return d;
  }
  return w.range;
}

const guns = Object.values(WEAPONS).filter((w) => w.type !== 'melee');

test('no gun kills faster than a shotgun at range, and none is hopeless', () => {
  for (const w of guns) {
    const t = ttk(w);
    // One-shot weapons are 0 and that's the design.
    if (t === 0) continue;
    assert.ok(t >= 240, `${w.id} kills in ${Math.round(t)}ms — too fast to react to`);
    assert.ok(t <= 500, `${w.id} takes ${Math.round(t)}ms — nobody would pick it`);
  }
});

test('no gun is strictly worse than another of the same type', () => {
  // Strictly worse = no faster to kill, no further reaching, no bigger magazine,
  // and no better mobility. A gun like that is a trap: it exists only to be a
  // mistake. This is the check that caught the Carbine and the Compact SMG both
  // being dominated by the plain rifle and SMG.
  for (const type of WEAPON_TYPES) {
    const family = weaponsOfType(type.id).filter((w) => PRIMARY_IDS.includes(w.id));
    for (const a of family) {
      for (const b of family) {
        if (a.id === b.id) continue;
        const worseOrEqual =
          ttk(a) >= ttk(b)
          && reach(a) <= reach(b)
          && a.mag <= b.mag
          && a.moveMult <= b.moveMult;
        const strictlyWorse = worseOrEqual
          && (ttk(a) > ttk(b) || reach(a) < reach(b) || a.mag < b.mag);
        assert.ok(
          !strictlyWorse,
          `${a.id} is strictly worse than ${b.id}: `
          + `ttk ${Math.round(ttk(a))} vs ${Math.round(ttk(b))}, `
          + `reach ${reach(a)}m vs ${reach(b)}m, `
          + `mag ${a.mag} vs ${b.mag}, move ${a.moveMult} vs ${b.moveMult}`,
        );
      }
    }
  }
});

test('within a type, faster kills come with shorter reach', () => {
  // The trade that makes a family a choice rather than a ranking.
  for (const type of WEAPON_TYPES) {
    const family = weaponsOfType(type.id)
      .filter((w) => PRIMARY_IDS.includes(w.id) && Number.isFinite(ttk(w)) && ttk(w) > 0)
      .sort((a, b) => ttk(a) - ttk(b));
    if (family.length < 2) continue;

    for (let i = 1; i < family.length; i++) {
      const faster = family[i - 1];
      const slower = family[i];
      assert.ok(
        reach(faster) <= reach(slower) + 1,
        `${faster.id} kills faster than ${slower.id} AND reaches further `
        + `(${reach(faster)}m vs ${reach(slower)}m) — pick one`,
      );
    }
  }
});

test('shotguns one-shot up close and do nothing at range', () => {
  for (const w of weaponsOfType('shotgun')) {
    assert.ok(shotsToKill(w, 1) <= 2, `${w.id} should be lethal in 1-2 shots point blank`);
    assert.equal(
      shotsToKill(w, w.range + 1), Infinity,
      `${w.id} still does damage past its stated range`,
    );
    assert.ok(reach(w) < 22, `${w.id} reaches ${reach(w)}m — too far for a shotgun`);
  }
});

test('snipers kill in one shot at any range they can reach', () => {
  for (const id of ['sniper', 'antimateriel']) {
    const w = WEAPONS[id];
    assert.equal(shotsToKill(w, 0), 1, `${id} should one-shot`);
    assert.equal(shotsToKill(w, w.range - 1), 1, `${id} should one-shot at its full range`);
  }
});

test('the Marksman is not simply a better rifle', () => {
  // It was, briefly: buffed to a 218ms TTK while holding full damage to 120m.
  const dmr = WEAPONS.dmr;
  const rifle = WEAPONS.rifle;
  assert.ok(
    ttk(dmr) > ttk(rifle),
    `Marksman kills in ${Math.round(ttk(dmr))}ms vs the rifle's ${Math.round(ttk(rifle))}ms — `
    + 'it out-ranges the rifle, so it must not also out-pace it',
  );
});

test('every sidearm is worse than every primary of the same reach', () => {
  // Pistols are what you fall back on, not what you pick.
  const sidearm = WEAPONS.pistol;
  for (const w of guns) {
    if (w.type === 'pistol' || w.type === 'shotgun') continue;
    if (ttk(w) === 0) continue;
    assert.ok(
      ttk(w) < ttk(sidearm),
      `${w.id} is slower to kill than the default sidearm — something is wrong`,
    );
  }
});

test('every gun has coherent falloff numbers', () => {
  for (const w of guns) {
    assert.ok(w.falloffStart <= w.falloffEnd, `${w.id}: falloffStart is past falloffEnd`);
    assert.ok(w.falloffEnd <= w.range, `${w.id}: falloff ends past its range`);
    assert.ok(w.falloffFloor > 0 && w.falloffFloor <= 1, `${w.id}: falloffFloor out of range`);
    assert.ok(w.rpm > 0 && w.mag > 0, `${w.id}: rpm and mag must be positive`);
    assert.ok(w.adsSpread <= w.spread, `${w.id}: aiming should never widen the cone`);
  }
});
