// All sound is synthesised at runtime with WebAudio. No files, no licences,
// nothing to download, and a gunshot is only a handful of numbers anyway:
// a burst of filtered noise with a fast decay, plus a low sine thump for body.
//
// Distance attenuation and stereo panning are applied for other players' shots,
// which is most of what "positional audio" needs to be in a game this size.

import { settings } from './settings.js';

let ctx = null;
let master = null;
let noiseBuffer = null;

export function initAudio() {
  if (ctx) return ctx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;

  ctx = new Ctx();
  master = ctx.createGain();
  master.gain.value = settings.volume;
  master.connect(ctx.destination);

  // One second of white noise, reused for every shot.
  noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  return ctx;
}

/** Browsers suspend the context until a user gesture. Call this on any click. */
export function resumeAudio() {
  if (ctx?.state === 'suspended') ctx.resume();
}

export function setVolume(v) {
  if (master) master.gain.value = v;
}

function now() {
  return ctx.currentTime;
}

function noiseSource() {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  // Random offset so consecutive shots don't sound identical.
  src.playbackRate.value = 0.9 + Math.random() * 0.2;
  return src;
}

// The quietest shot worth building a node graph for.
//
// This used to be 0.002, which sounds like a reasonable floor and is in practice
// no floor at all: with the 1/(1+0.06d) attenuation, a typical 0.25-gain weapon
// only falls below it at about two kilometres, and Crown Island is 540m across. So
// every shot from all thirty players was assembling six-odd audio nodes, however
// far away and however inaudible. 0.012 is roughly where a shot stops being
// audible at all against the master gain, and it cuts a 0.25-gain weapon at ~260m
// — still the far side of most maps.
const AUDIBLE_FLOOR = 0.012;

// Concurrency budget. Thirty players on automatics is around three hundred shots a
// second, and each one creates and tears down a small graph; past a certain rate
// the extra voices are inaudible mush that costs real CPU on a weak laptop. Shots
// are dropped rather than queued, because a late gunshot is worse than none.
const VOICE_WINDOW_S = 0.05;
const VOICE_BUDGET = 12;
let voiceWindowStart = 0;
let voicesThisWindow = 0;

function claimVoice(t) {
  if (t - voiceWindowStart > VOICE_WINDOW_S) {
    voiceWindowStart = t;
    voicesThisWindow = 0;
  }
  if (voicesThisWindow >= VOICE_BUDGET) return false;
  voicesThisWindow += 1;
  return true;
}

/**
 * A gunshot. `audio` comes from the weapon table: { kind, freq, decay, gain }.
 * `pan` is -1..1 and `distance` in metres; both default to "it's your own gun".
 */
export function playShot(audioSpec, { pan = 0, distance = 0 } = {}) {
  if (!ctx) return;
  const t = now();
  const atten = 1 / (1 + distance * 0.06);
  const gain = audioSpec.gain * atten;
  if (gain < AUDIBLE_FLOOR) return;
  if (!claimVoice(t)) return;

  const out = ctx.createGain();
  out.gain.value = 1;
  const panner = ctx.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  out.connect(panner);
  panner.connect(master);

  // ---- crack: filtered noise burst ----
  const noise = noiseSource();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = audioSpec.freq * 4;
  bp.Q.value = 0.7;
  // Distant shots lose their high end before they lose their volume.
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = Math.max(700, 8000 - distance * 90);

  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(gain, t);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + audioSpec.decay);

  noise.connect(bp);
  bp.connect(lp);
  lp.connect(noiseGain);
  noiseGain.connect(out);
  noise.start(t);
  noise.stop(t + audioSpec.decay + 0.02);

  // ---- body: a short low sine thump ----
  if (audioSpec.kind !== 'swipe') {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(audioSpec.freq, t);
    osc.frequency.exponentialRampToValueAtTime(audioSpec.freq * 0.4, t + audioSpec.decay);

    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(gain * 0.7, t);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, t + audioSpec.decay * 1.1);

    osc.connect(oscGain);
    oscGain.connect(out);
    osc.start(t);
    osc.stop(t + audioSpec.decay * 1.2 + 0.02);
  }

  // ---- tail: a hint of reverb indoors ----
  if (distance > 4) {
    const tail = noiseSource();
    const tailFilter = ctx.createBiquadFilter();
    tailFilter.type = 'lowpass';
    tailFilter.frequency.value = 1400;
    const tailGain = ctx.createGain();
    tailGain.gain.setValueAtTime(gain * 0.18, t + 0.02);
    tailGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    tail.connect(tailFilter);
    tailFilter.connect(tailGain);
    tailGain.connect(out);
    tail.start(t);
    tail.stop(t + 0.3);
  }
}

/**
 * Hit confirmation. `kind` is 'hit', 'head' or 'kill'.
 *
 * Three audibly different cues, layered rather than one beep at different
 * pitches: a body hit is a short click, a headshot adds a bright bell on top,
 * and a kill is a descending two-note stab you can recognise without looking.
 * Being able to tell these apart by ear is most of what makes shooting feel good.
 */
export function playHitmarker(kind = 'hit') {
  if (!ctx) return;
  const t = now();

  const blip = (type, from, to, gain, dur, delay = 0) => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t + delay);
    osc.frequency.exponentialRampToValueAtTime(to, t + delay + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t + delay);
    g.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t + delay);
    osc.stop(t + delay + dur + 0.02);
  };

  // Body: a tight click with a touch of noise so it cuts through gunfire.
  blip('square', 1600, 1150, 0.1, 0.06);

  if (kind === 'head') {
    // Bright bell on top — unmistakably different from a body hit.
    blip('sine', 2600, 1900, 0.075, 0.14, 0.01);
    blip('triangle', 1300, 950, 0.05, 0.1, 0.02);
  }

  if (kind === 'kill') {
    blip('square', 900, 420, 0.11, 0.16, 0.03);
    blip('triangle', 520, 240, 0.09, 0.26, 0.1);
    // A short noise tail gives the stab some body.
    const noise = noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    noise.connect(bp);
    bp.connect(g);
    g.connect(master);
    noise.start(t + 0.03);
    noise.stop(t + 0.24);
  }
}

/** Dull thud when you take damage. */
export function playHurt() {
  if (!ctx) return;
  const t = now();
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(160, t);
  osc.frequency.exponentialRampToValueAtTime(70, t + 0.16);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.16, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
  osc.connect(g);
  g.connect(master);
  osc.start(t);
  osc.stop(t + 0.22);
}

/**
 * Mechanical click for reloads and weapon switches.
 *
 * Optionally positioned, which is what makes it double as the metallic clang of a
 * bullet striking a barrel somewhere across the map.
 */
export function playClick(pitch = 1, { pan = 0, distance = 0 } = {}) {
  if (!ctx) return;
  const t = now();
  const atten = 1 / (1 + distance * 0.08);
  const noise = noiseSource();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2200 * pitch;
  bp.Q.value = 3;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.05 * atten, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);

  const panner = ctx.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));

  noise.connect(bp);
  bp.connect(g);
  g.connect(panner);
  panner.connect(master);
  noise.start(t);
  noise.stop(t + 0.06);
}

/**
 * A barrel going off: a low thump, a broadband roar and a long tail.
 *
 * Much longer and lower than a gunshot on purpose — an explosion has to be
 * instantly distinguishable from someone firing at you.
 */
export function playExplosion({ pan = 0, distance = 0 } = {}) {
  if (!ctx) return;
  const t = now();
  const atten = 1 / (1 + distance * 0.045);
  if (atten < 0.02) return;

  const panner = ctx.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  panner.connect(master);

  // Body: a pitch-collapsing sine, which is what gives it weight.
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(90, t);
  osc.frequency.exponentialRampToValueAtTime(28, t + 0.55);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.75 * atten, t);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
  osc.connect(og);
  og.connect(panner);
  osc.start(t);
  osc.stop(t + 0.7);

  // Roar: noise through a filter that closes over time, so the blast dulls as it
  // decays rather than hissing all the way out.
  const noise = noiseSource();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(Math.max(600, 5200 - distance * 120), t);
  lp.frequency.exponentialRampToValueAtTime(220, t + 0.8);
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.6 * atten, t);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
  noise.connect(lp);
  lp.connect(ng);
  ng.connect(panner);
  noise.start(t);
  noise.stop(t + 0.95);

  // Crack on the front, so it starts sharply.
  const crack = noiseSource();
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 1200;
  const cg = ctx.createGain();
  cg.gain.setValueAtTime(0.35 * atten, t);
  cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  crack.connect(hp);
  hp.connect(cg);
  cg.connect(panner);
  crack.start(t);
  crack.stop(t + 0.14);
}

/** Rising two-tone for round start, falling for round end. */
export function playFanfare(up = true) {
  if (!ctx) return;
  const t = now();
  const notes = up ? [440, 660] : [520, 330];
  notes.forEach((f, i) => {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t + i * 0.13);
    g.gain.linearRampToValueAtTime(0.1, t + i * 0.13 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.13 + 0.3);
    osc.connect(g);
    g.connect(master);
    osc.start(t + i * 0.13);
    osc.stop(t + i * 0.13 + 0.32);
  });
}

/** Countdown tick. */
export function playBeep(final = false) {
  if (!ctx) return;
  const t = now();
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = final ? 880 : 550;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.08, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + (final ? 0.4 : 0.12));
  osc.connect(g);
  g.connect(master);
  osc.start(t);
  osc.stop(t + 0.45);
}

/**
 * Pan and distance for a world-space sound relative to the listener.
 * Uses the camera's right vector so panning follows where you're facing.
 */
export function spatialise(sourcePos, listenerPos, listenerYaw) {
  const dx = sourcePos[0] - listenerPos[0];
  const dy = sourcePos[1] - listenerPos[1];
  const dz = sourcePos[2] - listenerPos[2];
  const distance = Math.hypot(dx, dy, dz);
  if (distance < 0.001) return { pan: 0, distance: 0 };

  // Right vector for a yaw where forward is -Z.
  const rightX = Math.cos(listenerYaw);
  const rightZ = -Math.sin(listenerYaw);
  const pan = (dx * rightX + dz * rightZ) / distance;

  return { pan, distance };
}
