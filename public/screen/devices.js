// Devices: the things that actually want traffic. Each device carries its own demand; an AP's
// demand is the sum of its connected devices. Shared by sim.js and events.js. Owner B.

// Relative appetite per kind: an AP's base demand from levels.js is split by these weights.
export const DEVICE_WEIGHT = {
  phone: 1,
  laptop: 2,
  tv: 3,
  console: 2.5,
  fridge: 0.6,
  speaker: 0.8,
  player: 0,
};

/** New device object. `base` = demand before waves/surges/multipliers. */
export function makeDevice(state, kind, base, extra = {}) {
  const seq = ++state.deviceSeq;
  return {
    id: `d${seq}`,
    kind,
    base,
    phase: seq * 2.39996, // golden-angle spread so devices don't wobble in sync
    demand: 0,
    surge: 0, // seconds of surge left
    surgeDur: 0,
    surgePeak: 1,
    surgeMul: 1,
    eventMul: 1,
    reconnect: 0, // seconds offline after being moved to another AP
    isNew: 0, // seconds of "just joined" highlight
    ...extra,
  };
}

/** Devices for one AP from a list of kinds, splitting `total` demand by weight. */
export function makeCluster(state, kinds, total) {
  const weightSum = kinds.reduce((s, k) => s + (DEVICE_WEIGHT[k] ?? 1), 0) || 1;
  return kinds.map((kind) => makeDevice(state, kind, (total * (DEVICE_WEIGHT[kind] ?? 1)) / weightSum));
}
