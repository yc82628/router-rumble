// Sound: synthesized effects + a small adaptive synthwave soundtrack. No audio files, so no
// licensing questions. Browsers only allow audio after a user gesture, so call unlockAudio()
// from a click/keypress (main.js does on START and on any key).
//
//   sfx.crash() …           one-shot effects
//   startMusic() / stopMusic()
//   setIntensity(0..1)      calm → frantic: faster tempo, brighter filter, more drums and notes

let ctx = null;
let master = null; // everything → compressor → speakers
let sfxBus = null;
let musicBus = null;
let noiseBuffer = null;
let muted = false;

const MUSIC_VOLUME = 0.32; // relative to effects
const SFX_VOLUME = 0.9;

export function unlockAudio() {
  try {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(comp).connect(ctx.destination);
      sfxBus = ctx.createGain();
      sfxBus.gain.value = SFX_VOLUME;
      sfxBus.connect(master);
      musicBus = ctx.createGain();
      musicBus.gain.value = 0;
      musicBus.connect(master);
      noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    ctx = null;
  }
}

export function toggleMute() {
  muted = !muted;
  if (master) master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.05);
  return muted;
}

// ------------------------------------------------------------------ building blocks

function tone(freq, dur, { type = 'square', vol = 0.05, slide = 0, delay = 0, bus = sfxBus, attack = 0.005 } = {}) {
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(bus);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Filtered noise burst: crashes, zaps, hi-hats. */
function noise(dur, { vol = 0.1, freq = 2000, q = 1, type = 'bandpass', delay = 0, sweep = 0, bus = sfxBus } = {}) {
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(freq, t0);
  if (sweep) filter.frequency.exponentialRampToValueAtTime(Math.max(40, freq + sweep), t0 + dur);
  filter.Q.value = q;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(gain).connect(bus);
  src.start(t0, Math.random() * 0.5);
  src.stop(t0 + dur + 0.02);
}

// ------------------------------------------------------------------ effects

export const sfx = {
  join: () => { tone(660, 0.08, { type: 'triangle' }); tone(990, 0.12, { type: 'triangle', delay: 0.08 }); },
  count: () => tone(440, 0.14, { type: 'square', vol: 0.04 }),
  go: () => { tone(880, 0.35, { type: 'square', vol: 0.05 }); tone(1320, 0.35, { type: 'triangle', vol: 0.03 }); },
  crash: () => {
    noise(0.7, { vol: 0.35, freq: 900, sweep: -800, type: 'lowpass' });
    tone(160, 0.6, { type: 'sawtooth', vol: 0.09, slide: -120 });
    tone(55, 0.5, { type: 'sine', vol: 0.18, slide: -20 });
  },
  recover: () => { tone(520, 0.08, { type: 'triangle' }); tone(780, 0.1, { type: 'triangle', delay: 0.07 }); tone(1040, 0.14, { type: 'triangle', delay: 0.14 }); },
  alarm: () => {
    for (let i = 0; i < 3; i++) tone(620, 0.22, { type: 'sawtooth', vol: 0.045, slide: 380, delay: i * 0.24 });
  },
  zap: () => {
    tone(1500, 0.14, { type: 'square', vol: 0.05, slide: -1200 });
    noise(0.08, { vol: 0.12, freq: 5000, q: 2 });
  },
  boost: () => { tone(260, 0.45, { type: 'sawtooth', vol: 0.05, slide: 900 }); noise(0.4, { vol: 0.06, freq: 800, sweep: 3000 }); },
  streak: () => [659, 784, 988].forEach((f, i) => tone(f, 0.16, { type: 'square', vol: 0.045, delay: i * 0.07 })),
  bossArrive: () => {
    tone(110, 1.4, { type: 'sawtooth', vol: 0.09, slide: -60, attack: 0.2 });
    tone(55, 1.6, { type: 'sine', vol: 0.2, attack: 0.3 });
    for (let i = 0; i < 4; i++) tone(440, 0.3, { type: 'square', vol: 0.04, slide: 220, delay: 0.3 + i * 0.32 });
  },
  bossDown: () => {
    noise(1.2, { vol: 0.4, freq: 1200, sweep: -1100, type: 'lowpass' });
    tone(80, 1.0, { type: 'sine', vol: 0.22, slide: -50 });
    [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.2, { type: 'triangle', vol: 0.05, delay: 0.5 + i * 0.1 }));
  },
  orbSpawn: () => [988, 1319].forEach((f, i) => tone(f, 0.18, { type: 'sine', vol: 0.05, delay: i * 0.09 })),
  orbClaim: () => {
    [523, 784, 1047, 1568].forEach((f, i) => tone(f, 0.14, { type: 'square', vol: 0.045, delay: i * 0.05 }));
    noise(0.3, { vol: 0.08, freq: 3000, sweep: 4000 });
  },
  pass: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, { type: 'triangle', vol: 0.06, delay: i * 0.12 })),
  fail: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.3, { type: 'sawtooth', vol: 0.05, delay: i * 0.18 })),
};

// ------------------------------------------------------------------ adaptive music
// A 16-step loop in A minor: kick + bass always, hats and arpeggio come in as intensity rises.

const BASS = [45, 45, 45, 48, 43, 43, 43, 47, 41, 41, 41, 45, 40, 40, 43, 47]; // MIDI notes, one per step
const ARP = [69, 72, 76, 72, 67, 71, 74, 71, 65, 69, 72, 69, 64, 67, 71, 74];
const midi = (n) => 440 * 2 ** ((n - 69) / 12);

let playing = false;
let intensity = 0;
let step = 0;
let nextTime = 0;
let timer = null;
let musicFilter = null;

export function setIntensity(x) {
  intensity = Math.max(0, Math.min(1, x));
}

function scheduleStep(t) {
  const i = step % 16;
  const level = intensity;
  // kick on every beat (4 steps), plus off-beats when frantic
  if (i % 4 === 0 || (level > 0.7 && i % 4 === 2)) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(g).connect(musicFilter);
    osc.start(t);
    osc.stop(t + 0.22);
  }
  // bass: eighth notes
  if (i % 2 === 0) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(midi(BASS[i]), t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(g).connect(musicFilter);
    osc.start(t);
    osc.stop(t + 0.25);
  }
  // hi-hats once things heat up
  if (level > 0.25 && (i % 2 === 1 || level > 0.6)) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05 + level * 0.04, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(f).connect(g).connect(musicBus);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.06);
  }
  // arpeggio: sparse when calm, every step when frantic
  if (level > 0.15 && (level > 0.55 || i % 2 === 0)) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(midi(ARP[i] + (level > 0.85 ? 12 : 0)), t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.035, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    osc.connect(g).connect(musicBus);
    osc.start(t);
    osc.stop(t + 0.14);
  }
}

function scheduler() {
  if (!ctx || !playing) return;
  const bpm = 104 + intensity * 46; // 104 → 150
  const stepLength = 60 / bpm / 4;
  musicFilter.frequency.setTargetAtTime(500 + intensity * 4500, ctx.currentTime, 0.3);
  while (nextTime < ctx.currentTime + 0.12) {
    scheduleStep(nextTime);
    nextTime += stepLength;
    step++;
  }
}

export function startMusic() {
  if (!ctx || playing) return;
  playing = true;
  if (!musicFilter) {
    musicFilter = ctx.createBiquadFilter();
    musicFilter.type = 'lowpass';
    musicFilter.Q.value = 6;
    musicFilter.connect(musicBus);
  }
  step = 0;
  nextTime = ctx.currentTime + 0.05;
  musicBus.gain.setTargetAtTime(MUSIC_VOLUME, ctx.currentTime, 0.4);
  timer = setInterval(scheduler, 25);
}

export function stopMusic() {
  if (!ctx || !playing) return;
  playing = false;
  clearInterval(timer);
  musicBus.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
}
