// Power-up orbs, pure, called from sim.js. Owner B.
//
// Orbs drift around the map (levels with `orbs` in levels.js). The same orb floats across every
// phone; the first player to tap it claims it and it fires on their access point:
//
//   HOTSPOT        a temporary Wi-Fi hotspot beside your AP: +40 capacity for 10 s
//   VPN            encrypts your AP for 15 s: bots and viruses can't latch on or spread through it
//   ANTIVIRUS      network-wide scan: wipes every bot, virus and droid on the map
//   LOAD BALANCER  evens out traffic across all APs for 6 s

export const ORB = {
  life: 9, // seconds an unclaimed orb stays on screen
  maxOnScreen: 2,
  hotspotSeconds: 10,
  hotspotCapacity: 40,
  vpnSeconds: 15,
  balancerSeconds: 6,
  claimPoints: 25,
};

export const ORB_TYPES = {
  hotspot: { label: 'HOTSPOT', icon: '📡', color: '#3df2ff', desc: '+40 capacity on your AP for 10 s' },
  vpn: { label: 'VPN', icon: '🔒', color: '#b38bff', desc: 'No bots or viruses on your AP for 15 s' },
  antivirus: { label: 'ANTIVIRUS', icon: '🛡', color: '#46ff8f', desc: 'Wipes every bot and virus on the network' },
  balancer: { label: 'LOAD BALANCER', icon: '⚖', color: '#ffd23d', desc: 'Evens out traffic on every AP for 6 s' },
};
const TYPE_LIST = Object.keys(ORB_TYPES);

function spawnOrb(state, rand) {
  // ANTIVIRUS is only offered when there's something to wipe, so it never lands as a dud.
  const enemies = state.bots.length > 0;
  const pool = TYPE_LIST.filter((t) => t !== 'antivirus' || enemies);
  const type = pool[Math.floor(rand() * pool.length)];
  const angle = rand() * Math.PI * 2;
  state.orbs.push({
    id: `o${++state.orbSeq}`,
    type,
    x: 0.2 + rand() * 0.6, // map coordinates 0..1
    y: 0.25 + rand() * 0.35,
    vx: Math.cos(angle) * 0.05,
    vy: Math.sin(angle) * 0.04,
    ttl: ORB.life,
  });
  state.emitted.push({ type: 'orbSpawn', orbType: type });
}

/** Spawning, drifting, expiry, and the countdowns of active effects. */
export function runOrbs(state, dt, rand) {
  const cfg = state.level.orbs;
  if (cfg && state.time >= state.nextOrbAt) {
    if (state.orbs.length < ORB.maxOnScreen) spawnOrb(state, rand);
    state.nextOrbAt = state.time + cfg.every * (0.8 + 0.4 * rand());
  }
  for (const o of state.orbs) {
    o.ttl -= dt;
    o.x += o.vx * dt;
    o.y += o.vy * dt;
    if (o.x < 0.12 || o.x > 0.88) o.vx *= -1;
    if (o.y < 0.2 || o.y > 0.65) o.vy *= -1;
  }
  state.orbs = state.orbs.filter((o) => o.ttl > 0);

  for (const r of state.routers) {
    r.hotspotTimer = Math.max(0, (r.hotspotTimer || 0) - dt);
    r.vpnTimer = Math.max(0, (r.vpnTimer || 0) - dt);
  }
  state.balancerTimer = Math.max(0, state.balancerTimer - dt);
}

/**
 * A player tapped an orb. Returns the claim, or null if it's gone (someone else was faster).
 * The effect lands on the player's active AP.
 */
export function claimOrb(state, player, orbId, router) {
  const orb = state.orbs.find((o) => o.id === orbId);
  if (!orb || !router) return null;
  state.orbs = state.orbs.filter((o) => o !== orb);
  const result = { type: orb.type, routerId: router.id, router: router.name, by: player.name, wiped: [] };

  if (orb.type === 'hotspot') {
    router.hotspotTimer = ORB.hotspotSeconds;
  } else if (orb.type === 'vpn') {
    router.vpnTimer = ORB.vpnSeconds;
  } else if (orb.type === 'antivirus') {
    result.wiped = state.bots.map((b) => b.routerId);
    state.bots = [];
  } else if (orb.type === 'balancer') {
    state.balancerTimer = ORB.balancerSeconds;
  }
  state.emitted.push({ type: 'orbClaimed', orbType: orb.type, ...result });
  return result;
}

/** LOAD BALANCER: share the total load across live APs in proportion to their capacity. */
export function balanceLoads(state, capacityOf) {
  if (state.balancerTimer <= 0) return;
  const live = state.routers.filter((r) => r.status !== 'crashed');
  const total = live.reduce((n, r) => n + r.load, 0);
  const capacity = live.reduce((n, r) => n + capacityOf(r), 0);
  if (!capacity) return;
  for (const r of live) r.load = (total * capacityOf(r)) / capacity;
}
