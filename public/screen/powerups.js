// Power-up orbs, pure, called from sim.js. Owner B.
//
// Orbs drift around the map (levels with `orbs` in levels.js). The same orb floats across every
// phone; the first player to tap it claims it and it fires on their access point:
//
//   REPEATER       a Wi-Fi repeater docks beside your AP and widens its range: +40 capacity for 10 s
//   VPN            encrypts your AP for 15 s: bots and viruses can't latch on or spread through it
//   ANTIVIRUS      network-wide scan: wipes every bot, virus and droid on the map
//   LOAD BALANCER  evens out traffic across all APs for 6 s
//   REBOOT         power-cycles the network: every crashed AP comes back online at once
//   PHISHING       a decoy (levels with `orbs.phishing`): it looks like a real orb but flickers red.
//                  Tap it and a bot gets into your AP. Look before you tap!

import { phishBot } from './enemies.js';

export const ORB = {
  life: 9, // seconds an unclaimed orb stays on screen
  maxOnScreen: 3,
  repeaterSeconds: 10,
  repeaterCapacity: 40,
  vpnSeconds: 15,
  balancerSeconds: 6,
  claimPoints: 25,
  phishPenalty: 20, // points lost for falling for a PHISHING orb
};

export const ORB_TYPES = {
  repeater: { label: 'REPEATER', icon: '📶', color: '#3df2ff', desc: '+40 capacity on your AP for 10 s' },
  vpn: { label: 'VPN', icon: '🔒', color: '#b38bff', desc: 'No bots or viruses on your AP for 15 s' },
  antivirus: { label: 'ANTIVIRUS', icon: '🛡', color: '#46ff8f', desc: 'Wipes every bot and virus on the network' },
  balancer: { label: 'LOAD BALANCER', icon: '⚖', color: '#ffd23d', desc: 'Evens out traffic on every AP for 6 s' },
  reboot: { label: 'REBOOT', icon: '⚡', color: '#ffad73', desc: 'Every crashed AP comes back online' },
  phishing: { label: 'PHISHING', icon: '🎣', color: '#ff526b', desc: 'A fake orb! It let a bot into your AP' },
};
const REAL_TYPES = Object.keys(ORB_TYPES).filter((t) => t !== 'phishing');

function spawnOrb(state, rand) {
  // ANTIVIRUS and REBOOT are only offered when they'd do something, so they never land as duds.
  const enemies = state.bots.length > 0;
  const crashed = state.routers.some((r) => r.status === 'crashed');
  const pool = REAL_TYPES.filter((t) => (t !== 'antivirus' || enemies) && (t !== 'reboot' || crashed));
  let type = pool[Math.floor(rand() * pool.length)];
  let looks;
  const phishing = state.level.orbs.phishing;
  if (phishing && rand() < phishing) {
    looks = type; // the decoy wears a real orb's icon and label
    type = 'phishing';
  }
  const angle = rand() * Math.PI * 2;
  state.orbs.push({
    id: `o${++state.orbSeq}`,
    type,
    looks,
    x: 0.2 + rand() * 0.6, // map coordinates 0..1
    y: 0.25 + rand() * 0.35,
    vx: Math.cos(angle) * 0.05,
    vy: Math.sin(angle) * 0.04,
    ttl: ORB.life,
  });
  state.emitted.push({ type: 'orbSpawn', orbType: looks || type });
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
    r.repeaterTimer = Math.max(0, (r.repeaterTimer || 0) - dt);
    r.vpnTimer = Math.max(0, (r.vpnTimer || 0) - dt);
  }
  state.balancerTimer = Math.max(0, state.balancerTimer - dt);
}

/**
 * A player tapped an orb. Returns the claim, or null if it's gone (someone else was faster).
 * The effect lands on the player's active AP.
 */
export function claimOrb(state, player, orbId, router, rand) {
  const orb = state.orbs.find((o) => o.id === orbId);
  if (!orb || !router) return null;
  state.orbs = state.orbs.filter((o) => o !== orb);
  const result = {
    type: orb.type, looks: orb.looks, routerId: router.id, router: router.name, by: player.name,
    wiped: [], rebooted: [],
  };

  if (orb.type === 'repeater') {
    router.repeaterTimer = ORB.repeaterSeconds;
  } else if (orb.type === 'vpn') {
    router.vpnTimer = ORB.vpnSeconds;
  } else if (orb.type === 'antivirus') {
    result.wiped = state.bots.map((b) => b.routerId);
    state.bots = [];
  } else if (orb.type === 'balancer') {
    state.balancerTimer = ORB.balancerSeconds;
  } else if (orb.type === 'reboot') {
    for (const r of state.routers) {
      if (r.status !== 'crashed') continue;
      r.status = 'ok';
      r.crashTimer = 0;
      r.overTime = 0;
      result.rebooted.push(r.id);
      state.emitted.push({ type: 'recover', routerId: r.id, name: r.name });
    }
  } else if (orb.type === 'phishing') {
    phishBot(state, router.id, rand); // you clicked the link yourself, so even a VPN can't stop it
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
