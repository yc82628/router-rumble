// Load test: fake big screens + fake phones hammer the server, then report what got through.
//
//   npm run loadtest                         # 3 rooms x 10 phones for 20 s against localhost:3000
//   npm run loadtest -- --rooms 10 --players 10 --seconds 30 --url http://localhost:3000
//
// Each fake screen sends a PlayerState batch at 10 Hz (like the real one); each fake phone taps a
// random button ~8 times a second. When the room is full, one extra phone tries to join (should be
// refused), and one "spammer" taps 100 times a second (should be rate-limited to ~20/s after a
// short burst). Test rooms linger ~3 minutes after the test (like a host that reloads), so
// back-to-back runs count toward the server's room limit.
import { io } from 'socket.io-client';
import { EV, ACTION_LIST } from '../public/shared/protocol.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, a, i, all) => (a.startsWith('--') ? [...pairs, [a.slice(2), all[i + 1]]] : pairs), []),
);
const URL = args.url || 'http://localhost:3000';
const ROOMS = Number(args.rooms) || 3;
const PLAYERS = Number(args.players) || 10;
const SECONDS = Number(args.seconds) || 20;
const TAPS_PER_SECOND = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () =>
  new Promise((resolve, reject) => {
    const s = io(URL, { transports: ['websocket'], reconnection: false, timeout: 5000 });
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
const ask = (socket, event, payload) => socket.timeout(5000).emitWithAck(event, payload);

/** Roughly the size of a real PlayerState (with its device list). */
function fakeState(playerId, t) {
  return {
    playerId,
    routerId: 'r0',
    routerName: 'AP-1',
    routerSlot: 1,
    ownedCount: 1,
    load: 50 + Math.round(30 * Math.sin(t)),
    capacity: 100,
    sL: 0.1,
    sR: 0,
    status: 'ok',
    boostReadyIn: 0,
    boostLeft: 0,
    crashLeft: 0,
    overload: 0,
    left: null,
    right: { name: 'AP-2', owners: ['Someone'], blocked: false, crashed: false },
    fix: null,
    cableTaps: 0,
    cableNeeded: 10,
    botHp: 0,
    boss: false,
    health: 100,
    timeLeft: 60,
    devices: Array.from({ length: 5 }, (_, i) => ({
      id: `d${i}`, kind: 'laptop', label: 'laptop', demand: 20 + i, surging: false, isNew: false, reconnecting: false, mine: false,
    })),
  };
}

async function runRoom(index) {
  const stats = { room: '?', joined: 0, refused: '', statesPerPhone: 0, inputsAtScreen: 0, spamAccepted: 0, errors: [] };
  const sockets = [];
  try {
    const screen = await connect();
    sockets.push(screen);
    const hello = await ask(screen, EV.SCREEN_HELLO, {});
    if (hello.error) throw new Error(hello.error);
    stats.room = hello.roomCode;

    const ids = new Set();
    let spammerId = null;
    screen.on(EV.PLAYER_JOINED, ({ playerId }) => ids.add(playerId));
    screen.on(EV.PLAYER_INPUT, ({ playerId }) => {
      if (playerId === spammerId) stats.spamAccepted++;
      else stats.inputsAtScreen++;
    });
    let t = 0;
    const stateTimer = setInterval(() => {
      t += 0.1;
      screen.emit(EV.PLAYER_STATES, [...ids].map((id) => fakeState(id, t)));
    }, 100);

    // PLAYERS - 1 normal phones + 1 spammer = a full room.
    const phones = [];
    for (let i = 0; i < PLAYERS; i++) {
      const s = await connect();
      sockets.push(s);
      const res = await ask(s, EV.PLAYER_JOIN, { room: stats.room, name: `R${index}P${i}` });
      if (res.error) throw new Error(`join ${i}: ${res.error}`);
      stats.joined++;
      phones.push({ socket: s, id: res.playerId, states: 0 });
    }
    const spammer = phones.pop();
    spammerId = spammer.id;
    for (const p of phones) p.socket.on(EV.PLAYER_STATE, () => p.states++);

    if (PLAYERS >= hello.maxPlayers) {
      const extra = await connect();
      sockets.push(extra);
      stats.refused = (await ask(extra, EV.PLAYER_JOIN, { room: stats.room, name: 'TooMany' })).error ? 'yes' : 'NO (room overfilled!)';
    } else {
      stats.refused = 'n/a (room not full)';
    }

    const tapTimers = phones.map((p) =>
      setInterval(() => p.socket.emit(EV.PLAYER_INPUT, { action: ACTION_LIST[Math.floor(Math.random() * 5)] }), 1000 / TAPS_PER_SECOND),
    );
    const spamTimer = setInterval(() => spammer.socket.emit(EV.PLAYER_INPUT, { action: 'fix' }), 10);

    await sleep(SECONDS * 1000);
    clearInterval(stateTimer);
    clearInterval(spamTimer);
    tapTimers.forEach(clearInterval);

    stats.statesPerPhone = phones.reduce((n, p) => n + p.states, 0) / phones.length / SECONDS;
    stats.inputsAtScreen /= SECONDS;
    stats.spamAccepted /= SECONDS;
  } catch (err) {
    stats.errors.push(err.message);
  } finally {
    sockets.forEach((s) => s.disconnect());
  }
  return stats;
}

console.log(`Load test: ${ROOMS} rooms x ${PLAYERS} phones for ${SECONDS}s against ${URL}\n`);
const started = Date.now();
const results = await Promise.all(Array.from({ length: ROOMS }, (_, i) => runRoom(i)));
const health = await fetch(`${URL}/api/health`).then((r) => r.json()).catch(() => null);

console.table(
  results.map((r) => ({
    room: r.room,
    phones: r.joined,
    'states/s per phone (want ~10)': r.statesPerPhone.toFixed(1),
    [`inputs/s at screen (want ~${(PLAYERS - 1) * TAPS_PER_SECOND})`]: r.inputsAtScreen.toFixed(0),
    'spam allowed/s (want <=20)': r.spamAccepted.toFixed(1),
    'extra player refused': r.refused,
    errors: r.errors.join('; ') || '-',
  })),
);
console.log('Server health after test:', health);
console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(results.some((r) => r.errors.length || r.refused.startsWith('NO')) ? 1 : 0);
