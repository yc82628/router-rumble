// Router Rumble simulation. No DOM, no sockets, no timers, no Math.random (seeded RNG in state).
//
//   const state = createState({ level, levelIndex, players, seed });
//   tick(state, dt, inputs);         // advances the world, returns state
//   state.emitted                    // what happened this tick: crash, recover, eventStart, ...
//
// Model (see brief §2): APs in a line. Each AP forwards shares sL/sR of its local demand to its
// neighbours; forwarded traffic cannot be forwarded again.
//   D_r    = sum of the demand of the devices connected to AP r
//   load_r = D_r * (1 - sL - sR) + forwardedIn_r
// Devices surge (need more traffic for a while), new devices join, and devices can be moved to
// another AP (they go offline for a moment while they reconnect).
import { ACTIONS } from '../shared/protocol.js';
import { EVENT_DEFS, EVENT_TYPES } from './events.js';
import { makeCluster, makeDevice, DEVICE_WEIGHT } from './devices.js';
import { createBoss, runEnemies, zapBot, zapBoss, bossActive } from './enemies.js';

export const TICK_HZ = 10;

export const TUNING = {
  overloadSeconds: 3, // above capacity this long → crash
  crashSeconds: 5,
  fixSeconds: 0.35, // each Fix tap shortens a crash by this much
  boostMul: 1.5,
  boostSeconds: 5,
  boostCooldown: 20,
  maxShareSteps: 5, // shares are stored in tenths: 0..5 → 0%..50%
  warnRatio: 0.85,
  playerDeviceDemand: 3, // each joined phone adds this much demand to its AP
  perPlayerScale: 0.03, // extra demand per player beyond 2 (more players already means more APs to juggle)
  cableFixTaps: 10,
  reconnectSeconds: 1, // a moved device is offline this long
  newDeviceGlow: 4, // seconds a freshly joined device is highlighted
  crashPenalty: 500,
  offlinePenalty: 0.5, // score lost per unit of offline demand per second
  healthLossOffline: 22, // health/s when 100% of demand is offline
  healthLossDrop: 10, // health/s when 100% of demand is dropped by overload
  healthRegen: 1.2, // health/s when nothing is lost
  maxRouters: 8,
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = (v) => Math.round(v * 10) / 10;

/** mulberry32 on state.seed: deterministic per level. */
export function random(state) {
  state.seed = (state.seed + 0x6d2b79f5) | 0;
  let t = state.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const routerById = (state, id) => state.routers.find((r) => r.id === id);
export const effectiveCapacity = (r) => r.capacity * (r.boostTimer > 0 ? TUNING.boostMul : 1);
const playerDeviceCount = (r) => r.devices.reduce((n, d) => n + (d.kind === 'player' ? 1 : 0), 0);

// ------------------------------------------------------------------ setup

export function createState({ level, levelIndex = 0, players = [], seed = 1 }) {
  const count = Math.min(TUNING.maxRouters, Math.max(3, level.routers, players.length + 1));
  const routers = Array.from({ length: count }, (_, i) => ({
    id: `r${i}`,
    index: i,
    name: `AP-${i + 1}`,
    capacity: level.capacity,
    devices: [],
    shareL: 0,
    shareR: 0,
    demand: 0,
    local: 0,
    forwardedIn: 0,
    outL: 0,
    outR: 0,
    load: 0,
    overflow: 0,
    offline: 0,
    overTime: 0,
    status: 'ok',
    crashTimer: 0,
    failover: false,
    boostTimer: 0,
    boostCooldown: 0,
    fixPulse: 0,
    eventMul: 1,
    botLoad: 0, // bandwidth eaten by bots / the boss (enemies.js)
    ownerIds: [],
  }));
  const links = routers.slice(1).map((_, i) => ({ id: `l${i}`, a: i, b: i + 1, cut: false, fixTaps: 0, flowAB: 0, flowBA: 0 }));

  const state = {
    levelIndex,
    level,
    time: 0,
    duration: level.duration,
    routers,
    links,
    players: [],
    health: 100,
    score: 0,
    crashes: 0,
    delivered: 0,
    flow: { total: 0, served: 0, dropped: 0, offline: 0 },
    globalMul: 1,
    tint: null,
    activeEvents: [],
    eventSeq: 0,
    eventsFired: 0,
    nextEventAt: level.events ? level.events.first : Infinity,
    tutorialIndex: 0,
    deviceSeq: 0,
    nextSurgeAt: level.surges ? level.surges.first ?? level.surges.every : Infinity,
    nextJoinAt: level.joins ? level.joins.first ?? level.joins.every : Infinity,
    bots: [],
    botSeq: 0,
    nextBotAt: level.bots ? level.bots.first : Infinity,
    boss: createBoss(level.boss),
    joinsFired: 0,
    result: null,
    seed: seed | 0,
    emitted: [],
  };
  routers.forEach((r, i) => {
    r.devices = makeCluster(state, level.devices[i % level.devices.length], level.demand[i % level.demand.length]);
  });
  for (const p of players) addPlayer(state, p);
  return state;
}

/** Spread APs over players round-robin. With more players than APs, APs get co-owners. */
export function assignOwners(state) {
  const { routers, players } = state;
  for (const r of routers) r.ownerIds = [];
  if (players.length) {
    const slots = Math.max(routers.length, players.length);
    for (let k = 0; k < slots; k++) {
      const r = routers[k % routers.length];
      const p = players[k % players.length];
      if (!r.ownerIds.includes(p.id)) r.ownerIds.push(p.id);
    }
  }
  for (const p of players) {
    p.routerIds = routers.filter((r) => r.ownerIds.includes(p.id)).map((r) => r.id);
    if (!p.routerIds.includes(p.activeRouter)) p.activeRouter = p.routerIds[0] ?? null;
  }
}

export function addPlayer(state, { playerId, name }) {
  if (state.players.some((p) => p.id === playerId)) return;
  const player = { id: playerId, name, routerIds: [], activeRouter: null };
  state.players.push(player);
  assignOwners(state);
  // The player's phone shows up as a device on their own AP (or the emptiest one).
  const home = routerById(state, player.activeRouter) ||
    state.routers.reduce((best, r) => (playerDeviceCount(r) < playerDeviceCount(best) ? r : best));
  home.devices.push(makeDevice(state, 'player', 0, { playerId, name }));
}

export const findDevice = (state, deviceId) => {
  for (const r of state.routers) {
    const d = r.devices.find((x) => x.id === deviceId);
    if (d) return { device: d, router: r };
  }
  return null;
};

function moveDevice(state, deviceId, routerId, by = null) {
  const found = findDevice(state, deviceId);
  const target = routerById(state, routerId);
  if (!found || !target || found.router === target) return;
  found.router.devices = found.router.devices.filter((d) => d !== found.device);
  target.devices.push(found.device);
  found.device.reconnect = TUNING.reconnectSeconds;
  state.emitted.push({
    type: 'deviceMoved',
    deviceId,
    kind: found.device.kind,
    label: found.device.name || found.device.kind,
    from: found.router.name,
    to: target.name,
    by,
  });
}

/** Phone move: only devices on an AP the player runs, only to the AP next door. */
function moveDeviceToNeighbour(state, deviceId, dir, player) {
  const found = findDevice(state, deviceId);
  if (!found || !player.routerIds.includes(found.router.id)) return;
  const target = state.routers[found.router.index + (dir === 'left' ? -1 : 1)];
  if (target && target.status !== 'crashed') moveDevice(state, deviceId, target.id, player.name);
}

export function removePlayer(state, playerId) {
  state.players = state.players.filter((p) => p.id !== playerId);
  for (const r of state.routers) r.devices = r.devices.filter((d) => d.playerId !== playerId);
  assignOwners(state);
}

// ------------------------------------------------------------------ tick

export function tick(state, dt, inputs = []) {
  state.emitted = [];
  if (state.result) return state;
  state.time += dt;

  for (const input of inputs) applyInput(state, input);
  runTutorial(state);
  runEvents(state, dt);
  runDevices(state, dt);
  runEnemies(state, dt, () => random(state));
  runTimers(state, dt);
  computeDemand(state);
  computeLoads(state);
  resolveOverload(state, dt);
  score(state, dt);

  if (state.health <= 0) {
    state.result = 'failed';
    state.emitted.push({ type: 'levelFailed' });
  } else if (state.boss?.defeated || state.time >= state.duration) {
    state.result = 'passed';
    state.emitted.push({ type: 'levelPassed' });
  }
  return state;
}

function applyInput(state, input) {
  if (input.debug === 'crash') {
    const r = pickRandom(state, state.routers.filter((x) => x.status !== 'crashed'));
    if (r) crashRouter(state, r);
    return;
  }
  if (input.debug === 'event') {
    startRandomEvent(state, EVENT_TYPES);
    return;
  }

  const player = input.playerId ? state.players.find((p) => p.id === input.playerId) : null;
  if (input.action === ACTIONS.MOVE_DEVICE) {
    if (player) moveDeviceToNeighbour(state, input.deviceId, input.dir, player);
    else if (!input.playerId) moveDevice(state, input.deviceId, input.routerId); // screen mouse / bots
    return;
  }
  if (input.action === ACTIONS.SWITCH_ROUTER) {
    if (player && player.routerIds.length > 1) {
      const i = player.routerIds.indexOf(player.activeRouter);
      player.activeRouter = player.routerIds[(i + 1) % player.routerIds.length];
    }
    return;
  }

  const r = input.routerId ? routerById(state, input.routerId) : player ? routerById(state, player.activeRouter) : null;
  if (!r) return;
  const last = state.routers.length - 1;

  switch (input.action) {
    case ACTIONS.PUSH_LEFT:
      if (r.index > 0) r.shareL = Math.min(TUNING.maxShareSteps, r.shareL + 1);
      break;
    case ACTIONS.PUSH_RIGHT:
      if (r.index < last) r.shareR = Math.min(TUNING.maxShareSteps, r.shareR + 1);
      break;
    case ACTIONS.PULL_BACK:
      r.shareL = 0;
      r.shareR = 0;
      break;
    case ACTIONS.BOOST:
      if (r.status !== 'crashed' && r.boostCooldown <= 0) {
        r.boostTimer = TUNING.boostSeconds;
        r.boostCooldown = TUNING.boostCooldown;
        state.emitted.push({ type: 'boost', routerId: r.id, name: r.name });
      }
      break;
    case ACTIONS.FIX:
      fix(state, r);
      break;
  }
}

/** FIX does the most urgent thing: revive my AP, zap a bot on it, repair a cable, hit the boss. */
function fix(state, r) {
  if (r.status === 'crashed') {
    r.crashTimer = Math.max(0, r.crashTimer - TUNING.fixSeconds);
    r.fixPulse = 1;
    return;
  }
  if (zapBot(state, r)) return;
  const link = state.links.find((l) => l.cut && (l.a === r.index || l.b === r.index));
  if (!link) {
    zapBoss(state);
    return;
  }
  link.fixTaps++;
  if (link.fixTaps >= TUNING.cableFixTaps) {
    link.cut = false;
    link.fixTaps = 0;
    state.emitted.push({
      type: 'linkFixed',
      linkId: link.id,
      label: `${state.routers[link.a].name}↔${state.routers[link.b].name}`,
    });
  }
}

function crashRouter(state, r) {
  r.status = 'crashed';
  r.crashTimer = TUNING.crashSeconds;
  r.overTime = 0;
  r.load = 0;
  state.crashes++;
  state.score = Math.max(0, state.score - TUNING.crashPenalty);
  state.emitted.push({ type: 'crash', routerId: r.id, name: r.name });
}

function pickRandom(state, list) {
  return list.length ? list[Math.floor(random(state) * list.length)] : null;
}

function runTutorial(state) {
  const steps = state.level.tutorial || [];
  while (state.tutorialIndex < steps.length && state.time >= steps[state.tutorialIndex].at) {
    state.emitted.push({ type: 'tutorial', text: steps[state.tutorialIndex].text });
    state.tutorialIndex++;
  }
}

// ------------------------------------------------------------------ chaos events

export function startEvent(state, type) {
  const def = EVENT_DEFS[type];
  if (!def) return false;
  const ev = { id: ++state.eventSeq, type, elapsed: 0 };
  const text = def.start(state, ev, () => random(state));
  if (!text) return false;
  ev.text = text;
  state.eventsFired++;
  if (def.duration > 0 || def.isDone) state.activeEvents.push(ev);
  state.emitted.push({
    type: 'eventStart',
    eventType: type,
    name: def.name,
    text,
    routerId: ev.routerId ?? null,
    linkId: ev.linkId ?? null,
  });
  return true;
}

function startRandomEvent(state, pool) {
  const order = [...pool];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random(state) * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order.some((type) => startEvent(state, type));
}

function runEvents(state, dt) {
  const cfg = state.level.events;
  if (cfg && state.time >= state.nextEventAt && state.eventsFired < (cfg.max ?? Infinity)) {
    startRandomEvent(state, cfg.pool);
    state.nextEventAt = cfg.every ? state.time + cfg.every * (0.75 + 0.5 * random(state)) : Infinity;
  }

  // Event modifiers are rebuilt from scratch each tick, so nothing drifts.
  state.globalMul = 1;
  state.tint = null;
  for (const r of state.routers) {
    r.eventMul = 1;
    r.failover = false;
    for (const d of r.devices) d.eventMul = 1;
  }
  for (const ev of state.activeEvents) {
    ev.elapsed += dt;
    EVENT_DEFS[ev.type].each?.(state, ev);
  }
  state.activeEvents = state.activeEvents.filter((ev) => {
    const def = EVENT_DEFS[ev.type];
    const done = def.isDone ? def.isDone(state, ev) : ev.elapsed >= def.duration;
    if (done) {
      def.end?.(state, ev);
      state.emitted.push({ type: 'eventEnd', eventType: ev.type, name: def.name });
    }
    return !done;
  });
}

// ------------------------------------------------------------------ physics

function runTimers(state, dt) {
  for (const r of state.routers) {
    r.boostTimer = Math.max(0, r.boostTimer - dt);
    r.boostCooldown = Math.max(0, r.boostCooldown - dt);
    r.fixPulse = Math.max(0, r.fixPulse - dt * 3);
    if (r.status === 'crashed') {
      r.crashTimer -= dt;
      if (r.crashTimer <= 0) {
        r.crashTimer = 0;
        r.status = 'ok';
        r.overTime = 0;
        state.emitted.push({ type: 'recover', routerId: r.id, name: r.name });
      }
    }
  }
}

function spikeMul(spikes = [], t, index) {
  let m = 1;
  for (const s of spikes) {
    if (s.router != null && s.router !== index) continue;
    const k = Math.min(1, (t - s.at) / 1.5, (s.at + s.dur - t) / 1.5); // 1.5 s ease in/out
    if (k > 0) m *= 1 + (s.mul - 1) * k;
  }
  return m;
}

const between = (state, [lo, hi]) => lo + (hi - lo) * random(state);

/** Device timers, surges ("this laptop suddenly needs way more traffic") and new devices joining. */
function runDevices(state, dt) {
  const L = state.level;
  const all = state.routers.flatMap((r) => r.devices);

  for (const d of all) {
    d.reconnect = Math.max(0, d.reconnect - dt);
    d.isNew = Math.max(0, d.isNew - dt);
    if (d.surge > 0) {
      d.surge = Math.max(0, d.surge - dt);
      const k = Math.min(1, (d.surgeDur - d.surge) / 1.5, d.surge / 1.5); // 1.5 s ease in/out
      d.surgeMul = 1 + (d.surgePeak - 1) * Math.max(0, k);
    } else {
      d.surgeMul = 1;
    }
  }

  if (L.surges && state.time >= state.nextSurgeAt) {
    const calm = all.filter((d) => d.kind !== 'player' && d.surge <= 0);
    const d = calm.length ? calm[Math.floor(random(state) * calm.length)] : null;
    if (d) {
      d.surgeDur = d.surge = between(state, L.surges.dur);
      d.surgePeak = between(state, L.surges.peak);
    }
    state.nextSurgeAt = state.time + L.surges.every * (0.7 + 0.6 * random(state));
  }

  if (L.joins && state.time >= state.nextJoinAt && state.joinsFired < (L.joins.max ?? Infinity)) {
    const kind = L.joins.kinds[Math.floor(random(state) * L.joins.kinds.length)];
    const r = state.routers[Math.floor(random(state) * state.routers.length)];
    const d = makeDevice(state, kind, (DEVICE_WEIGHT[kind] ?? 1) * L.joins.demandPerWeight);
    d.isNew = TUNING.newDeviceGlow;
    r.devices.push(d);
    state.joinsFired++;
    state.nextJoinAt = state.time + L.joins.every * (0.8 + 0.4 * random(state));
    state.emitted.push({ type: 'deviceJoined', deviceId: d.id, kind, routerId: r.id, name: r.name });
  }
}

function computeDemand(state) {
  const L = state.level;
  const t = state.time;
  const ramp = 1 + (L.ramp || 0) * clamp(t / state.duration, 0, 1);
  const scale = 1 + TUNING.perPlayerScale * Math.max(0, state.players.length - 2);
  for (const r of state.routers) {
    const routerMul = ramp * spikeMul(L.spikes, t, r.index) * r.eventMul * state.globalMul * scale;
    let sum = 0;
    for (const d of r.devices) {
      if (d.kind === 'player') {
        d.demand = TUNING.playerDeviceDemand;
      } else {
        const wave = L.wave ? 1 + L.wave.amp * Math.sin((2 * Math.PI * t) / L.wave.period + d.phase) : 1;
        d.demand = d.base * wave * d.surgeMul * d.eventMul * routerMul;
      }
      if (d.reconnect <= 0) sum += d.demand; // reconnecting devices aren't using the AP yet
    }
    r.demand = sum;
  }
}

function canForward(state, i, dir) {
  const j = i + dir;
  const neighbour = state.routers[j];
  if (!neighbour) return false;
  return !state.links[Math.min(i, j)].cut && neighbour.status !== 'crashed';
}

function computeLoads(state) {
  const R = state.routers;
  for (const r of R) {
    r.forwardedIn = 0;
    r.outL = 0;
    r.outR = 0;
    r.local = 0;
    r.offline = 0;
  }
  for (const r of R) {
    const canL = canForward(state, r.index, -1);
    const canR = canForward(state, r.index, 1);
    if (r.status === 'crashed') {
      if (r.failover && (canL || canR)) {
        const n = (canL ? 1 : 0) + (canR ? 1 : 0);
        if (canL) r.outL = r.demand / n;
        if (canR) r.outR = r.demand / n;
      } else {
        r.offline = r.demand;
      }
    } else {
      r.outL = canL ? (r.demand * r.shareL) / 10 : 0;
      r.outR = canR ? (r.demand * r.shareR) / 10 : 0;
      r.local = r.demand - r.outL - r.outR;
    }
    if (r.outL) R[r.index - 1].forwardedIn += r.outL;
    if (r.outR) R[r.index + 1].forwardedIn += r.outR;
  }
  for (const l of state.links) {
    l.flowAB = R[l.a].outR;
    l.flowBA = R[l.b].outL;
  }
  for (const r of R) r.load = r.status === 'crashed' ? 0 : r.local + r.forwardedIn + r.botLoad;
}

function resolveOverload(state, dt) {
  for (const r of state.routers) {
    r.overflow = 0;
    if (r.status === 'crashed') continue;
    const cap = effectiveCapacity(r);
    r.overflow = Math.max(0, r.load - cap);
    if (r.load > cap) r.overTime += dt;
    else r.overTime = Math.max(0, r.overTime - dt * 1.5);

    if (r.overTime >= TUNING.overloadSeconds) crashRouter(state, r);
    else r.status = r.overTime > 0 || r.load > cap * TUNING.warnRatio ? 'warn' : 'ok';
  }
}

function score(state, dt) {
  let total = 0;
  let served = 0;
  let dropped = 0;
  let offline = 0;
  for (const r of state.routers) {
    total += r.demand;
    offline += r.offline;
    dropped += r.overflow;
    // bots eat capacity first; only what's left over counts as real traffic delivered
    if (r.status !== 'crashed') served += Math.max(0, Math.min(r.load, effectiveCapacity(r)) - r.botLoad);
  }
  state.flow = { total, served, dropped, offline };
  if (dt <= 0 || total <= 0) return;

  const loss = (offline / total) * TUNING.healthLossOffline + (dropped / total) * TUNING.healthLossDrop;
  state.health = clamp(state.health + (loss > 0.001 ? -loss : TUNING.healthRegen) * dt, 0, 100);
  state.delivered += served * dt;
  state.score = Math.max(0, state.score + served * dt - offline * TUNING.offlinePenalty * dt);
}

// ------------------------------------------------------------------ views

/** The private, numbers-included view one phone gets (see PlayerState in protocol.js). */
export function playerView(state, playerId) {
  const p = state.players.find((x) => x.id === playerId);
  if (!p) return null;
  const r = routerById(state, p.activeRouter);
  const left = state.duration - state.time;
  const base = { playerId, health: Math.round(state.health), timeLeft: Number.isFinite(left) ? Math.ceil(Math.max(0, left)) : null };
  if (!r) return { ...base, routerId: null, status: 'ok' };

  const leftR = state.routers[r.index - 1];
  const rightR = state.routers[r.index + 1];
  const linkL = leftR ? state.links[r.index - 1] : null;
  const linkR = rightR ? state.links[r.index] : null;
  const owners = (x) => x.ownerIds.map((id) => state.players.find((pp) => pp.id === id)?.name).filter(Boolean);
  const side = (x, link) =>
    x ? { name: x.name, owners: owners(x), blocked: link.cut || x.status === 'crashed', crashed: x.status === 'crashed' } : null;
  const cutLink = [linkL, linkR].find((l) => l && l.cut);
  const botHp = state.bots.filter((b) => b.routerId === r.id && b.state === 'attached').reduce((n, b) => n + b.hp, 0);
  const boss = bossActive(state.boss);
  const ev = state.activeEvents.find(
    (e) => e.routerId === r.id || (e.linkId && (e.linkId === linkL?.id || e.linkId === linkR?.id)) || (!e.routerId && !e.linkId),
  );

  return {
    ...base,
    routerId: r.id,
    routerName: r.name,
    routerSlot: p.routerIds.indexOf(r.id) + 1,
    ownedCount: p.routerIds.length,
    load: Math.round(r.load),
    capacity: Math.round(effectiveCapacity(r)),
    sL: r.shareL / 10,
    sR: r.shareR / 10,
    status: r.status,
    boostReadyIn: round1(r.boostCooldown),
    boostLeft: round1(r.boostTimer),
    crashLeft: round1(r.crashTimer),
    overload: clamp(r.overTime / TUNING.overloadSeconds, 0, 1),
    left: side(leftR, linkL),
    right: side(rightR, linkR),
    fix: r.status === 'crashed' ? 'crash' : botHp ? 'bot' : cutLink ? 'cable' : boss ? 'boss' : null,
    cableTaps: cutLink ? cutLink.fixTaps : 0,
    cableNeeded: TUNING.cableFixTaps,
    botHp,
    boss: boss && { name: state.boss.name, hp: state.boss.hp, maxHp: state.boss.maxHp, here: state.boss.routerId === r.id },
    event: botHp
      ? `A bot is eating your bandwidth! Tap FIX to zap it.`
      : boss
        ? `${state.boss.name} is attacking ${routerById(state, state.boss.routerId)?.name}! Everyone tap FIX!`
        : ev?.text,
    devices: r.devices
      .map((d) => ({
        id: d.id,
        kind: d.kind,
        label: d.kind === 'player' ? d.name : d.label || d.kind,
        demand: Math.round(d.demand),
        surging: d.surge > 0,
        isNew: d.isNew > 0,
        reconnecting: d.reconnect > 0,
        mine: d.playerId === playerId,
      }))
      .sort((a, b) => b.demand - a.demand),
  };
}
