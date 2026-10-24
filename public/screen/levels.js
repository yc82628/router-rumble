// Level table: data only. Tuning knobs for owner B.
//
// demand   starting demand per access point, split over its devices by kind (devices.js weights)
// wave     slow sine wobble per device: demand * (1 + amp * sin(2πt / period + phase))
// surges   { every, peak: [lo, hi], dur: [lo, hi] }  a random device needs xpeak traffic for a while
// joins    { every, max, kinds, demandPerWeight }  new devices connect to a random AP
// ramp     demand grows linearly by this fraction over the level (0.3 → +30% at the end)
// spikes   { at, dur, mul, router? }  temporary multiplier (all APs, or one AP index)
// events   { first, every, max, pool }  chaos-event schedule; `every: 0` → only one
// devices  starting devices per AP: phone | laptop | tv | console | fridge | speaker
// bots     { first, every, hp, drain }  mini bots that latch onto an AP and eat bandwidth (FIX zaps)
// boss     the final boss, see enemies.js. Level is won by beating it `lives` times; no timer.
// tutorial { at, text } prompts shown as banners (keep them in time order)

const ALL_EVENTS = ['giantDownload', 'routerReboot', 'ddos', 'cableCut', 'stream4k'];

export const LEVELS = [
  {
    id: 1,
    name: 'Home Wi-Fi',
    tagline: 'Three access points, one family, zero patience.',
    duration: 90,
    routers: 3,
    capacity: 100,
    // Tutorial pace, but not a free win: a team that does nothing usually loses or earns 0-2 stars.
    demand: [47, 64, 43],
    wave: { amp: 0.15, period: 18 },
    ramp: 0.08,
    surges: { first: 14, every: 11, peak: [1.6, 2.1], dur: [6, 10] },
    joins: { first: 26, every: 20, max: 2, kinds: ['phone', 'laptop', 'tv'], demandPerWeight: 6 },
    spikes: [{ at: 58, dur: 8, mul: 1.2, router: 1 }], // a gentle console update spike
    bots: { first: 36, every: 22, hp: 2, drain: 12 },
    events: null,
    devices: [
      ['phone', 'laptop', 'tv'],
      ['laptop', 'console', 'fridge', 'phone'],
      ['phone', 'speaker', 'laptop'],
    ],
    tutorial: [
      { at: 1, text: 'Each phone runs one access point. Watch your load bar.' },
      { at: 14, text: 'Overloaded? PUSH traffic to a neighbour, but don\'t melt their AP.' },
      { at: 26, text: 'Devices grow when they need more traffic. Move a big one to a quieter AP!' },
      { at: 34, text: 'A minion is coming. Tap FIX on its AP to zap it.' },
      { at: 54, text: 'BOOST = +50% capacity for 5 s. FIX also revives a crashed AP.' },
    ],
  },
  {
    id: 2,
    name: 'Monday 9am',
    tagline: 'Everyone joins the same video call. At the same time.',
    duration: 90,
    routers: 4,
    capacity: 100,
    demand: [60, 70, 65, 55],
    wave: { amp: 0.12, period: 15 },
    ramp: 0.05,
    surges: { first: 8, every: 10, peak: [1.6, 2.1], dur: [7, 10] },
    joins: { first: 18, every: 18, max: 3, kinds: ['laptop', 'phone', 'tv'], demandPerWeight: 6 },
    spikes: [
      { at: 20, dur: 8, mul: 1.25 }, // stand-up call
      { at: 62, dur: 10, mul: 1.35 }, // all-hands call
    ],
    // First virus wave is a readable warning, then each infected AP can copy it once.
    bots: { first: 26, every: 22, hp: 3, drain: 12, virus: true, spreadAfter: 12, spreadLimit: 1 },
    events: { first: 35, every: 0, max: 1, pool: ALL_EVENTS },
    devices: [
      ['laptop', 'laptop', 'phone'],
      ['laptop', 'tv', 'phone', 'laptop'],
      ['laptop', 'speaker', 'phone'],
      ['laptop', 'fridge', 'phone'],
    ],
    tutorial: [
      { at: 2, text: 'Monday. 9am. Video calls in 3, 2, 1…' },
      { at: 18, text: 'Viruses can spread to a neighbour AP. FIX them before they copy!' },
    ],
  },
  // ---- Drafts for owner B (still being tuned).
  {
    id: 3,
    name: 'Launch Day',
    tagline: 'Our product just went viral. The network did not get the memo.',
    duration: 90,
    routers: 5,
    capacity: 100,
    // Tuned so a coordinated 2-10 player team usually clears it; idle teams always lose.
    demand: [50, 58, 64, 58, 46],
    wave: { amp: 0.18, period: 12 },
    ramp: 0.08,
    surges: { first: 4, every: 7, peak: [1.8, 2.4], dur: [8, 12] },
    joins: { first: 8, every: 14, max: 4, kinds: ['phone', 'laptop', 'tv', 'console'], demandPerWeight: 6 },
    spikes: [
      { at: 20, dur: 8, mul: 1.4 },
      { at: 50, dur: 10, mul: 1.5 },
      { at: 75, dur: 8, mul: 1.5 },
    ],
    // Faster, tougher viruses arrive amid more frequent chaos events.
    bots: { first: 12, every: 14, hp: 4, drain: 12, virus: true, spreadAfter: 10, spreadLimit: 1 },
    events: { first: 15, every: 24, max: 3, pool: ALL_EVENTS },
    devices: [
      ['phone', 'phone', 'laptop'],
      ['laptop', 'tv', 'phone'],
      ['phone', 'phone', 'phone', 'laptop'],
      ['console', 'laptop', 'phone'],
      ['phone', 'speaker', 'fridge'],
    ],
    tutorial: [{ at: 3, text: 'VIRAL OUTBREAK. Contain each virus before it infects another AP!' }],
  },
  {
    id: 4,
    name: 'The Overseer',
    tagline: 'A giant robot has seized the uplink. It commands droids. It always comes back.',
    duration: Infinity, // boss level: win by beating the boss
    routers: 5,
    capacity: 100,
    demand: [50, 60, 55, 60, 50],
    wave: { amp: 0.12, period: 14 },
    ramp: 0,
    surges: { first: 6, every: 9, peak: [1.6, 2.2], dur: [8, 12] },
    joins: null,
    spikes: [],
    events: null,
    bots: null, // the boss brings its own droids
    boss: {
      name: 'OVERSEER',
      first: 5, // seconds before it first arrives
      lives: 3, // knock it down this many times
      hp: 40, // FIX taps per player to knock it down in round 1 (+50% each round)
      drain: 32, // bandwidth it eats from the AP it docks on (+drainPerRound each round)
      drainPerRound: 12,
      droidEvery: 5, // launches a droid at another AP this often; the wave speeds up each round
      droidRamp: 0.7,
      minDroidEvery: 3.6,
      hopEvery: 13, // jumps to a different AP if you're too slow
      returnAfter: 10, // seconds it stays away after being knocked down
      droid: { hp: 2, drain: 12 },
    },
    devices: [
      ['phone', 'laptop', 'tv'],
      ['phone', 'speaker', 'laptop'],
      ['laptop', 'console', 'phone'],
      ['phone', 'tv', 'phone'],
      ['phone', 'laptop', 'fridge'],
    ],
    tutorial: [{ at: 2, text: 'Final boss. When it attacks, EVERYONE taps FIX!' }],
  },
];
