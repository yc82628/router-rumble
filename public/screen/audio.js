// Sound effect stubs: tiny synthesized blips (no asset files). Owner C: replace with real SFX.
// Browsers only allow audio after a user gesture, so call unlockAudio() from a click/keypress.

let ctx = null;
let muted = false;

export function unlockAudio() {
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    ctx = null;
  }
}

export function toggleMute() {
  muted = !muted;
  return muted;
}

function tone(freq, dur, { type = 'square', vol = 0.04, slide = 0, delay = 0 } = {}) {
  if (!ctx || muted) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export const sfx = {
  join: () => { tone(660, 0.08, { type: 'triangle' }); tone(990, 0.1, { type: 'triangle', delay: 0.08 }); },
  count: () => tone(440, 0.12, { type: 'square', vol: 0.03 }),
  go: () => tone(880, 0.3, { type: 'square', vol: 0.04 }),
  crash: () => { tone(180, 0.5, { type: 'sawtooth', vol: 0.07, slide: -140 }); tone(90, 0.6, { type: 'square', vol: 0.05, delay: 0.05 }); },
  recover: () => { tone(520, 0.08, { type: 'triangle' }); tone(780, 0.12, { type: 'triangle', delay: 0.07 }); },
  alarm: () => { for (let i = 0; i < 3; i++) tone(i % 2 ? 620 : 880, 0.12, { type: 'square', vol: 0.035, delay: i * 0.14 }); },
  zap: () => tone(1200, 0.12, { type: 'square', vol: 0.04, slide: -900 }),
  boost: () => tone(300, 0.35, { type: 'sawtooth', vol: 0.035, slide: 600 }),
  pass: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.18, { type: 'triangle', vol: 0.05, delay: i * 0.12 })),
  fail: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.25, { type: 'sawtooth', vol: 0.04, delay: i * 0.18 })),
};
