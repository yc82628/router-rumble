// Daily challenge: one level + one twist per UTC day, the same for everyone in the world. The
// day also fixes the random seed, so every team faces the same surges, events and enemies.
// Scores go on the "Daily" leaderboard. Owner B: add twists to MODIFIERS.
import { LEVELS } from './levels.js';

export const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

function hash(text) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

const MODIFIERS = [
  {
    id: 'surge-storm',
    name: 'Surge Storm',
    desc: 'Devices surge twice as often, and harder.',
    apply(L) {
      if (L.surges) L.surges = { ...L.surges, every: L.surges.every * 0.55, peak: L.surges.peak.map((p) => p + 0.3) };
    },
  },
  {
    id: 'brownout',
    name: 'Brownout',
    desc: 'No BOOST today. PUSH, SEND and FIX only.',
    apply(L) {
      L.controls = ['push', 'fix', 'send'];
    },
  },
  {
    id: 'viral-day',
    name: 'Viral Day',
    desc: 'Viruses arrive faster and can spread twice.',
    apply(L) {
      const bots = L.bots || { first: 12, every: 14, hp: 3, drain: 12 };
      L.bots = { ...bots, virus: true, every: bots.every * 0.7, spreadAfter: 9, spreadLimit: 2 };
    },
  },
  {
    id: 'crowded-cafe',
    name: 'Crowded Café',
    desc: 'Free Wi-Fi! New devices keep joining all game.',
    apply(L) {
      L.joins = { first: 6, every: 7, max: 8, kinds: ['phone', 'phone', 'laptop', 'tv'], demandPerWeight: 5 };
    },
  },
  {
    id: 'power-hour',
    name: 'Power Hour',
    desc: 'Power-up orbs everywhere. Grab them fast!',
    apply(L) {
      L.orbs = { ...(L.orbs || {}), first: 4, every: 6 };
    },
  },
  {
    id: 'lag-spike',
    name: 'Lag Spikes',
    desc: 'Huge traffic spikes every 15 seconds.',
    apply(L) {
      L.spikes = Array.from({ length: 5 }, (_, i) => ({ at: 12 + i * 15, dur: 6, mul: 1.4 }));
    },
  },
  {
    id: 'boss-rush',
    name: 'Boss Rush',
    desc: 'Straight to the OVERSEER, and its droids are faster.',
    levelIndex: 3,
    apply(L) {
      L.boss = { ...L.boss, first: 3, droidEvery: L.boss.droidEvery * 0.8 };
    },
  },
];
export const DAILY_MODIFIERS = MODIFIERS;

/** Today's challenge (or another day's, for tests): { day, id, name, desc, level, levelIndex, seed }. */
export function dailyChallenge(day = utcDay(), forceModifier = null) {
  const n = hash(`router-rumble:${day}`);
  const mod = forceModifier || MODIFIERS[n % MODIFIERS.length];
  const levelIndex = mod.levelIndex ?? 1 + (Math.floor(n / MODIFIERS.length) % 2); // level 2 or 3
  const level = structuredClone(LEVELS[levelIndex]);
  mod.apply(level);
  level.name = `Daily: ${mod.name}`;
  level.tagline = mod.desc;
  level.daily = true;
  level.tutorial = [{ at: 2, text: `DAILY CHALLENGE · ${mod.name}: ${mod.desc}` }, ...(level.tutorial || []).filter((t) => t.at > 6)];
  return { day, id: mod.id, name: mod.name, desc: mod.desc, level, levelIndex, seed: n | 0 };
}
