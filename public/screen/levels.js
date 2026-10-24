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
    demand: [50, 75, 45],
    wave: { amp: 0.15, period: 18 },
    ramp: 0.1,
    surges: { first: 8, every: 9, peak: [1.8, 2.4], dur: [8, 13] },
    joins: { first: 20, every: 18, max: 3, kinds: ['phone', 'laptop', 'tv'], demandPerWeight: 7 },
    spikes: [{ at: 45, dur: 12, mul: 1.25, router: 1 }], // someone starts a console update
    bots: { first: 28, every: 20, hp: 3, drain: 12 },
    events: null,
    devices: [
      ['phone', 'laptop', 'tv'],
      ['laptop', 'console', 'fridge', 'phone'],
      ['phone', 'speaker', 'laptop'],
    ],
    tutorial: [
      { at: 1, text: 'Each phone runs one access point. Watch your load bar.' },
      { at: 14, text: 'Overloaded? PUSH traffic to a neighbour, but don\'t melt their AP.' },
      { at: 22, text: 'Devices grow when they need more traffic. Move a big one to a quieter AP!' },
      { at: 30, text: 'A mini bot is eating bandwidth! Tap FIX on that AP to zap it.' },
      { at: 45, text: 'BOOST = +50% capacity for 5 s. FIX also revives a crashed AP.' },
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
    surges: { first: 5, every: 7, peak: [1.8, 2.6], dur: [8, 14] },
    joins: { first: 12, every: 14, max: 4, kinds: ['laptop', 'phone', 'tv'], demandPerWeight: 7 },
    spikes: [
      { at: 15, dur: 10, mul: 1.35 }, // stand-up call
      { at: 58, dur: 12, mul: 1.45 }, // all-hands call
    ],
    bots: { first: 10, every: 14, hp: 3, drain: 12 },
    events: { first: 35, every: 0, max: 1, pool: ALL_EVENTS },
    devices: [
      ['laptop', 'laptop', 'phone'],
      ['laptop', 'tv', 'phone', 'laptop'],
      ['laptop', 'speaker', 'phone'],
      ['laptop', 'fridge', 'phone'],
    ],
    tutorial: [{ at: 2, text: 'Monday. 9am. Video calls in 3, 2, 1…' }],
  },
  // ---- Drafts for owner B (still being tuned).
  {
    id: 3,
    name: 'Launch Day',
    tagline: 'Our product just went viral. The network did not get the memo.',
    duration: 90,
    routers: 5,
    capacity: 100,
    demand: [55, 65, 75, 65, 50],
    wave: { amp: 0.18, period: 12 },
    ramp: 0.1,
    surges: { first: 4, every: 7, peak: [1.8, 2.4], dur: [8, 12] },
    joins: { first: 8, every: 14, max: 4, kinds: ['phone', 'laptop', 'tv', 'console'], demandPerWeight: 6 },
    spikes: [
      { at: 20, dur: 8, mul: 1.4 },
      { at: 50, dur: 10, mul: 1.5 },
      { at: 75, dur: 8, mul: 1.5 },
    ],
    bots: { first: 6, every: 9, hp: 4, drain: 14 },
    events: { first: 12, every: 20, max: 4, pool: ALL_EVENTS },
    devices: [
      ['phone', 'phone', 'laptop'],
      ['laptop', 'tv', 'phone'],
      ['phone', 'phone', 'phone', 'laptop'],
      ['console', 'laptop', 'phone'],
      ['phone', 'speaker', 'fridge'],
    ],
    tutorial: [],
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
      drain: 30, // bandwidth it eats from the AP it docks on (+drainPerRound each round)
      drainPerRound: 10,
      droidEvery: 5, // launches a droid at another AP this often
      hopEvery: 14, // jumps to a different AP if you're too slow
      returnAfter: 10, // seconds it stays away after being knocked down
      droid: { hp: 2, drain: 10 },
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
