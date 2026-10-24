// Enemies, pure, called from sim.js. Owner B.
//
//   Minions     fly down from the internet, latch onto an AP and eat its bandwidth (extra load).
//   Viruses     appear in later levels and can spread once to a neighbouring AP.
//   OVERSEER    the final boss: a giant robot that docks onto an AP, drains it hard, launches its own
//               droids at other APs, and keeps coming back stronger after being knocked down.
//
// One rule for players: FIX zaps enemies. Bots on your own AP first; while the boss is attacking,
// every player's FIX hits the boss. Knocking the boss down destroys all of its droids.

export const ENEMY = {
  flightSeconds: 2, // uplink → AP
  bossFlightSeconds: 2.5,
  maxBotsPerAP: 3,
};

const ACTIVE = new Set(['arriving', 'attacking']);
export const bossActive = (boss) => Boolean(boss && !boss.defeated && ACTIVE.has(boss.phase));

export function createBoss(cfg) {
  if (!cfg) return null;
  return {
    name: cfg.name || 'OVERSEER',
    phase: 'away', // away → arriving → attacking → (hop: arriving) → retreating → away …
    timer: cfg.first ?? 4,
    lives: cfg.lives,
    round: 0,
    hp: 0,
    maxHp: 0,
    drain: 0,
    droidEvery: cfg.droidEvery ?? 5,
    routerId: null,
    fromRouterId: null, // where the current flight started (null = the internet uplink)
    t: 0, // flight progress 0 (uplink/from) → 1 (docked)
    droidTimer: 0,
    hopTimer: 0,
    hit: 0,
    defeated: false,
  };
}

function pick(list, rand) {
  return list.length ? list[Math.floor(rand() * list.length)] : null;
}

function spawnBot(state, rand, cfg, fromRouterId = null, options = {}) {
  const count = (r) => state.bots.filter((b) => b.routerId === r.id).length;
  const targets = state.routers.filter(
    (r) => r.status !== 'crashed' && r.id !== fromRouterId &&
      (!options.targetRouterId || r.id === options.targetRouterId) && count(r) < ENEMY.maxBotsPerAP,
  );
  const r = pick(targets, rand);
  if (!r) return;
  const bot = {
    id: ++state.botSeq,
    routerId: r.id,
    fromRouterId,
    droid: options.droid ?? (fromRouterId != null), // launched by the boss
    virus: options.virus ?? Boolean(cfg.virus),
    hp: cfg.hp,
    maxHp: cfg.hp,
    drain: cfg.drain,
    spreadAfter: cfg.spreadAfter ?? 0,
    spreadLimit: cfg.spreadLimit ?? 0,
    spreadDepth: options.spreadDepth ?? 0,
    spreadTimer: (options.virus ?? cfg.virus) ? (cfg.spreadAfter ?? Infinity) : Infinity,
    state: 'flying',
    t: 0,
    spin: rand() * Math.PI * 2,
    hit: 0,
  };
  state.bots.push(bot);
  return bot;
}

/** A virus gets one chance to copy itself to a neighbouring AP, then becomes harmless. */
function spreadVirus(state, bot, rand, dt) {
  if (!bot.virus || bot.spreadDepth >= bot.spreadLimit || !Number.isFinite(bot.spreadTimer)) return;
  bot.spreadTimer -= dt;
  if (bot.spreadTimer > 0) return;

  const source = state.routers.find((r) => r.id === bot.routerId);
  if (!source) return;
  const targets = state.routers.filter((r) =>
    Math.abs(r.index - source.index) === 1 &&
    r.status !== 'crashed' &&
    state.bots.filter((other) => other.routerId === r.id).length < ENEMY.maxBotsPerAP,
  );
  const target = pick(targets, rand);
  if (!target) {
    bot.spreadTimer = 2; // retry if the neighbouring APs are crashed or full
    return;
  }

  const child = spawnBot(state, rand, bot, source.id, {
    droid: false,
    virus: true,
    spreadDepth: bot.spreadDepth + 1,
    targetRouterId: target.id,
  });
  if (!child) {
    bot.spreadTimer = 2;
    return;
  }
  bot.spreadTimer = Infinity;
  state.emitted.push({ type: 'virusSpread', routerId: target.id, router: target.name, from: source.name });
}

function runBoss(state, dt, rand) {
  const boss = state.boss;
  if (!boss || boss.defeated) return;
  const cfg = state.level.boss;
  boss.hit = Math.max(0, boss.hit - dt * 5);

  if (boss.phase === 'away') {
    boss.timer -= dt;
    if (boss.timer > 0) return;
    const target = pick(state.routers.filter((r) => r.status !== 'crashed'), rand) || state.routers[0];
    const players = Math.max(1, state.players.length);
    boss.round++;
    boss.maxHp = boss.hp = Math.round(cfg.hp * players * (1 + 0.5 * (boss.round - 1)));
    boss.drain = cfg.drain + cfg.drainPerRound * (boss.round - 1);
    boss.droidEvery = Math.max(cfg.minDroidEvery ?? 0.5, cfg.droidEvery - cfg.droidRamp * (boss.round - 1));
    boss.routerId = target.id;
    boss.fromRouterId = null;
    boss.phase = 'arriving';
    boss.t = 0;
    state.emitted.push({ type: 'bossArrive', name: boss.name, round: boss.round, lives: boss.lives, routerId: target.id, router: target.name });
  } else if (boss.phase === 'arriving') {
    boss.t = Math.min(1, boss.t + dt / ENEMY.bossFlightSeconds);
    if (boss.t >= 1) {
      boss.phase = 'attacking';
      boss.droidTimer = boss.droidEvery * 0.5;
      boss.hopTimer = cfg.hopEvery;
    }
  } else if (boss.phase === 'attacking') {
    boss.droidTimer -= dt;
    if (boss.droidTimer <= 0) {
      boss.droidTimer = boss.droidEvery;
      const droid = {
        ...cfg.droid,
        hp: cfg.droid.hp + boss.round - 1,
        drain: cfg.droid.drain + 2 * (boss.round - 1),
      };
      spawnBot(state, rand, droid, boss.routerId);
    }
    boss.hopTimer -= dt;
    if (boss.hopTimer <= 0) {
      const next = pick(state.routers.filter((r) => r.id !== boss.routerId && r.status !== 'crashed'), rand);
      if (next) {
        boss.fromRouterId = boss.routerId;
        boss.routerId = next.id;
        boss.phase = 'arriving';
        boss.t = 0;
        state.emitted.push({ type: 'bossHop', name: boss.name, router: next.name, routerId: next.id });
      } else {
        boss.hopTimer = cfg.hopEvery;
      }
    }
  } else if (boss.phase === 'retreating') {
    boss.t -= dt / ENEMY.bossFlightSeconds;
    if (boss.t > 0) return;
    boss.t = 0;
    if (boss.lives <= 0) {
      boss.defeated = true;
      state.emitted.push({ type: 'bossDefeated', name: boss.name });
    } else {
      boss.phase = 'away';
      boss.timer = cfg.returnAfter;
      boss.routerId = null;
      state.emitted.push({ type: 'bossAway', name: boss.name, returnIn: cfg.returnAfter });
    }
  }
}

/** Spawning, flight, and the extra load (r.botLoad) enemies put on each AP this tick. */
export function runEnemies(state, dt, rand) {
  const L = state.level;
  if (L.bots && state.time >= state.nextBotAt) {
    spawnBot(state, rand, L.bots);
    state.nextBotAt = state.time + L.bots.every * (0.75 + 0.5 * rand());
  }
  runBoss(state, dt, rand);

  for (const b of state.bots) {
    b.hit = Math.max(0, b.hit - dt * 5);
    b.spin += dt * 2;
    if (b.state !== 'flying') continue;
    b.t = Math.min(1, b.t + dt / ENEMY.flightSeconds);
    if (b.t >= 1) {
      b.state = 'attached';
      const r = state.routers.find((x) => x.id === b.routerId);
      state.emitted.push({ type: 'botAttached', routerId: b.routerId, router: r?.name, droid: b.droid, virus: b.virus });
    }
  }

  for (const b of [...state.bots]) {
    if (b.state === 'attached' && b.virus) spreadVirus(state, b, rand, dt);
  }

  for (const r of state.routers) r.botLoad = 0;
  const add = (id, amount) => {
    const r = state.routers.find((x) => x.id === id);
    if (r) r.botLoad += amount;
  };
  for (const b of state.bots) if (b.state === 'attached') add(b.routerId, b.drain);
  const boss = state.boss;
  if (boss && boss.phase === 'attacking') add(boss.routerId, boss.drain);
}

/** FIX on AP r: zap one bot latched onto it. Returns 'hit', 'kill', 'virus-kill' or false (no bot). */
export function zapBot(state, r) {
  const b = state.bots.find((x) => x.routerId === r.id && x.state === 'attached');
  if (!b) return false;
  b.hp--;
  b.hit = 1;
  if (b.hp <= 0) {
    state.bots = state.bots.filter((x) => x !== b);
    state.emitted.push({ type: 'botZapped', routerId: r.id, router: r.name, botId: b.id, virus: b.virus });
    return b.virus ? 'virus-kill' : 'kill';
  }
  return 'hit';
}

/** FIX from anyone while the boss is attacking. Returns 'hit', 'down' (knocked out) or false. */
export function zapBoss(state) {
  const boss = state.boss;
  if (!bossActive(boss)) return false;
  boss.hp--;
  boss.hit = 1;
  if (boss.hp > 0) return 'hit';

  boss.lives--;
  boss.phase = 'retreating';
  boss.fromRouterId = null;
  boss.t = 1;
  // Its droids go down with it.
  const droids = state.bots.filter((b) => b.droid);
  state.bots = state.bots.filter((b) => !b.droid);
  state.emitted.push({
    type: 'bossDown',
    name: boss.name,
    livesLeft: boss.lives,
    routerId: boss.routerId,
    droidRouterIds: droids.map((b) => b.routerId),
  });
  return 'down';
}
