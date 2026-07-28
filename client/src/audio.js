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

/**
 * A gunshot. `audio` comes from the weapon table: { kind, freq, decay, gain }.
 * `pan` is -1..1 and `distance` in metres; both default to "it's your own gun".
 */
export function playShot(audioSpec, { pan = 0, distance = 0 } = {}) {
  if (!ctx) return;
  const t = now();
  const atten = 1 / (1 + distance * 0.06);
  const gain = audioSpec.gain * atten;
  if (gain < 0.002) return;

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

/** Short bright ping when you land a hit. */
export function playHitmarker(lethal = false) {
  if (!ctx) return;
  const t = now();
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(lethal ? 900 : 1500, t);
  osc.frequency.exponentialRampToValueAtTime(lethal ? 380 : 1100, t + 0.08);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.09, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + (lethal ? 0.18 : 0.07));

  osc.connect(g);
  g.connect(master);
  osc.start(t);
  osc.stop(t + 0.2);
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

/** Mechanical click for reloads and weapon switches. */
export function playClick(pitch = 1) {
  if (!ctx) return;
  const t = now();
  const noise = noiseSource();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2200 * pitch;
  bp.Q.value = 3;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.05, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  noise.connect(bp);
  bp.connect(g);
  g.connect(master);
  noise.start(t);
  noise.stop(t + 0.06);
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
