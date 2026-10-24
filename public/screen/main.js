// Big screen: socket wiring, phase machine, game loop. The screen is the authoritative game.
//   sim.js     → world state (10 Hz)
//   render.js  → canvas + HUD (60 fps)
//   commander  → AI / canned lines
import { EV, ACTIONS, PHASES } from '../shared/protocol.js';
import { LEVELS } from './levels.js';
import { createState, tick, addPlayer, removePlayer, playerView, effectiveCapacity, findDevice, TICK_HZ } from './sim.js';
import { createRenderer, fmtTime } from './render.js';
import { createCommander } from './commander.js';
import { sfx, unlockAudio, toggleMute } from './audio.js';

const $ = (id) => document.getElementById(id);
const socket = window.io();

const renderer = createRenderer($('canvas'), {
  level: $('hud-level'),
  time: $('hud-time'),
  health: $('hud-health'),
  healthBar: $('hud-health-bar'),
  score: $('hud-score'),
  crashes: $('hud-crashes'),
  operators: $('operators'),
  opCount: $('op-count'),
  nodes: $('nodes'),
  banner: $('banner'),
  log: $('log'),
});

const commander = createCommander({
  textEl: $('cmdr-line'),
  faceEl: $('cmdr-face'),
  requestAI: (payload) => socket.emit(EV.AI_REQUEST, payload),
  onSay: (text) => {
    if (!$('overlay-end').hidden) $('end-report').textContent = text;
  },
});

/** playerId -> { playerId, name }, in join order */
const roster = new Map();
let phase = PHASES.LOBBY;
let levelIndex = 0;
let state = null;
let inputs = [];
let countdownEndsAt = 0;
let lastCount = null;
let demo = false;
let botClock = 0;
let lastChatter = 0;

const rosterList = () => [...roster.values()];
const log = (text, kind) => renderer.log(text, kind, state ? state.time : 0);

function aiContext(extra = {}) {
  return {
    level: levelIndex + 1,
    levelName: LEVELS[levelIndex].name,
    score: Math.floor(state?.score ?? 0),
    crashes: state?.crashes ?? 0,
    health: Math.round(state?.health ?? 100),
    players: rosterList().map((p) => p.name),
    ...extra,
  };
}

// ------------------------------------------------------------------ phases

function setPhase(next, extra = {}) {
  phase = next;
  document.body.dataset.phase = next;
  socket.emit(EV.GAME_PHASE, { phase: next, level: levelIndex + 1, levelName: LEVELS[levelIndex].name, ...extra });
}

/** Lobby shows level 1's network with every joined phone attached as a device. */
function buildPreview() {
  state = createState({ level: LEVELS[levelIndex], levelIndex, players: rosterList(), seed: 1 });
  tick(state, 0, []); // fills demand/loads so packets flow on the map
}

function toLobby() {
  levelIndex = 0;
  buildPreview();
  renderer.clearFx();
  $('overlay-end').hidden = true;
  $('overlay-countdown').hidden = true;
  setPhase(PHASES.LOBBY);
}

function startLevel(i) {
  unlockAudio();
  levelIndex = ((i % LEVELS.length) + LEVELS.length) % LEVELS.length;
  const level = LEVELS[levelIndex];
  state = createState({ level, levelIndex, players: rosterList(), seed: Date.now() });
  tick(state, 0, []);
  inputs = [];
  renderer.clearFx();
  commander.setMood('calm');
  $('overlay-end').hidden = true;
  $('countdown-level').textContent = `LEVEL ${levelIndex + 1} // ${level.name.toUpperCase()}`;
  $('countdown-tagline').textContent = level.tagline || '';
  $('overlay-countdown').hidden = false;
  countdownEndsAt = performance.now() + 3000;
  lastCount = null;
  setPhase(PHASES.COUNTDOWN);
  log(`Level ${levelIndex + 1} "${level.name}" incoming`, 'info');
  commander.react('levelStart', aiContext());
}

function beginPlay() {
  $('overlay-countdown').hidden = true;
  lastChatter = 0;
  setPhase(PHASES.PLAYING);
  sfx.go();
}

function endLevel() {
  const passed = state.result === 'passed';
  const hasNext = levelIndex < LEVELS.length - 1;
  setPhase(passed && hasNext ? PHASES.LEVEL_END : PHASES.GAME_OVER, { result: state.result });

  $('end-title').textContent = passed ? (hasNext ? 'LEVEL CLEARED' : 'INTERNET SAVED') : 'NETWORK DOWN';
  $('end-title').className = passed ? 'good' : 'bad';
  $('end-sub').textContent = passed
    ? state.boss
      ? `${state.boss.name} is offline for good, after ${fmtTime(state.time)}.`
      : `"${state.level.name}" survived the full ${fmtTime(state.duration)}.`
    : `Network health hit 0% after ${fmtTime(state.time)}.`;
  const stats = [
    ['Delivered', Math.floor(state.delivered).toLocaleString('en-US')],
    ['Score', Math.floor(state.score).toLocaleString('en-US')],
    ['Crashes', state.crashes],
    ['Health', `${Math.round(state.health)}%`],
  ];
  $('end-stats').replaceChildren(
    ...stats.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = String(v);
      return [dt, dd];
    }),
  );
  $('end-report').textContent = 'Generating post-incident report…';
  $('btn-next').hidden = !(passed && hasNext);
  $('btn-retry').textContent = passed ? 'REPLAY' : 'RETRY';
  $('overlay-end').hidden = false;
  (passed && hasNext ? $('btn-next') : $('btn-retry')).focus();

  log(passed ? `Level ${levelIndex + 1} cleared` : `Level ${levelIndex + 1} failed`, passed ? 'good' : 'bad');
  commander.setMood(passed ? 'calm' : 'alarm');
  commander.react(passed ? 'passed' : 'failed', aiContext());
  passed ? sfx.pass() : sfx.fail();
}

// ------------------------------------------------------------------ sim events → screen

function onSimEvent(e) {
  switch (e.type) {
    case 'crash':
      renderer.fx(e);
      log(`${e.name} CRASHED (overload)`, 'bad');
      sfx.crash();
      commander.react('crash', aiContext({ router: e.name }));
      break;
    case 'recover':
      renderer.fx(e);
      log(`${e.name} back online`, 'good');
      sfx.recover();
      break;
    case 'boost':
      renderer.fx(e);
      log(`${e.name} boosted`, 'info');
      sfx.boost();
      break;
    case 'eventStart':
      renderer.fx(e);
      renderer.banner(`⚠ ${e.name.toUpperCase()}: ${e.text}`, 'event', 5500);
      log(`${e.name.toUpperCase()}: ${e.text}`, 'event');
      sfx.alarm();
      commander.setMood('alarm');
      commander.react('event', aiContext({ event: e.name, eventType: e.eventType, detail: e.text }));
      lastChatter = state.time;
      break;
    case 'eventEnd':
      log(`${e.name} resolved`, 'info');
      if (!state.activeEvents.length) commander.setMood('calm');
      break;
    case 'linkFixed':
      renderer.fx(e);
      log(`Cable ${e.label} repaired`, 'good');
      sfx.recover();
      commander.react('linkFixed', aiContext());
      break;
    case 'tutorial':
      renderer.banner(e.text, 'tutorial', 6000);
      log(e.text, 'info');
      break;
    case 'deviceJoined':
      log(`New ${e.kind} joined ${e.name}`, 'join');
      sfx.join();
      break;
    case 'botAttached':
      log(`${e.droid ? 'Droid' : 'Mini bot'} latched onto ${e.router}`, 'bad');
      if (!e.droid) commander.react('botAttached', aiContext({ router: e.router }));
      break;
    case 'botZapped':
      renderer.fx(e);
      log(`Bot zapped on ${e.router}`, 'good');
      sfx.zap();
      break;
    case 'bossArrive':
      renderer.fx(e);
      renderer.banner(`⚠ ${e.name} ROUND ${e.round}: it's going for ${e.router}! EVERYONE TAP FIX!`, 'event', 6000);
      log(`${e.name} round ${e.round} → ${e.router}`, 'event');
      sfx.alarm();
      commander.setMood('alarm');
      commander.react('bossArrive', aiContext({ event: e.name, detail: `round ${e.round} of ${e.round + e.lives - 1}` }));
      break;
    case 'bossHop':
      log(`${e.name} jumped to ${e.router}`, 'event');
      break;
    case 'bossDown':
      renderer.fx(e);
      renderer.banner(e.livesLeft > 0 ? `${e.name} IS DOWN… for now.` : `${e.name} IS FINISHED!`, 'tutorial', 4000);
      log(`${e.name} knocked down${e.droidRouterIds.length ? `, ${e.droidRouterIds.length} droid(s) fell with it` : ''}`, 'good');
      sfx.pass();
      commander.setMood('calm');
      if (e.livesLeft > 0) commander.react('bossDown', aiContext({ event: e.name }));
      break;
    case 'bossAway':
      log(`${e.name} is rebooting. Back in ${e.returnIn}s`, 'info');
      break;
    case 'deviceMoved':
      log(`${e.by ? `${e.by} sent ` : ''}${e.label} ${e.from} → ${e.to}`, e.by ? 'join' : 'info');
      break;
  }
}

// ------------------------------------------------------------------ demo bots (D key)

function botInputs(s) {
  if (++botClock % 4) return []; // act every 0.4 s
  const out = [];
  for (const r of s.routers) {
    const act = (action) => out.push({ routerId: r.id, action });
    if (r.status === 'crashed') {
      act(ACTIONS.FIX);
      act(ACTIONS.FIX);
      continue;
    }
    const bossUp = s.boss && ['arriving', 'attacking'].includes(s.boss.phase);
    if (bossUp || s.bots.some((b) => b.routerId === r.id && b.state === 'attached')) {
      act(ACTIONS.FIX);
      act(ACTIONS.FIX);
    }
    if (s.links.some((l) => l.cut && (l.a === r.index || l.b === r.index))) act(ACTIONS.FIX);
    const ratio = r.load / effectiveCapacity(r);
    if (ratio > 0.95) {
      if (r.boostCooldown <= 0 && r.overTime > 1) act(ACTIONS.BOOST);
      // Move the hungriest device to the quietest AP if there's real headroom there.
      const load = (x) => (x.status === 'crashed' ? Infinity : x.load / effectiveCapacity(x));
      const quiet = [...s.routers].sort((a, b) => load(a) - load(b))[0];
      const big = r.devices.filter((d) => d.reconnect <= 0).sort((a, b) => b.demand - a.demand)[0];
      if (big && quiet !== r && load(quiet) < 0.7) {
        out.push({ action: ACTIONS.MOVE_DEVICE, deviceId: big.id, routerId: quiet.id });
        continue;
      }
      const L = s.routers[r.index - 1];
      const R = s.routers[r.index + 1];
      const lr = L && L.status !== 'crashed' ? L.load / effectiveCapacity(L) : Infinity;
      const rr = R && R.status !== 'crashed' ? R.load / effectiveCapacity(R) : Infinity;
      if (Math.min(lr, rr) < 0.85) act(lr <= rr ? ACTIONS.PUSH_LEFT : ACTIONS.PUSH_RIGHT);
    } else if (ratio < 0.6 && (r.shareL || r.shareR)) {
      act(ACTIONS.PULL_BACK);
    }
  }
  return out;
}

// ------------------------------------------------------------------ loops

setInterval(() => {
  if (phase === PHASES.COUNTDOWN) {
    const left = Math.ceil((countdownEndsAt - performance.now()) / 1000);
    if (left !== lastCount && left > 0) {
      lastCount = left;
      $('countdown-num').textContent = String(left);
      sfx.count();
    }
    if (left <= 0) beginPlay();
  } else if (phase === PHASES.PLAYING) {
    if (demo) inputs.push(...botInputs(state));
    tick(state, 1 / TICK_HZ, inputs);
    inputs = [];
    for (const e of state.emitted) onSimEvent(e);
    if (state.result) endLevel();
    else if (state.time - lastChatter > 20) {
      lastChatter = state.time;
      commander.react('idle', aiContext());
    }
  }
  renderer.hud(state);
  if (state.players.length && roomCode) {
    socket.emit(EV.PLAYER_STATES, state.players.map((p) => playerView(state, p.id)).filter(Boolean));
  }
}, 1000 / TICK_HZ);

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  renderer.draw(state, dt);
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ sockets

// Each screen hosts one room. The code is kept per browser tab, so a reload reclaims the same room
// (and its players), while a second tab opens a second room.
let roomCode = null;
const ROOM_KEY = 'rr:room';
const savedRoom = () => {
  try { return sessionStorage.getItem(ROOM_KEY); } catch { return null; }
};

socket.on('connect', () => {
  socket.emit(EV.SCREEN_HELLO, { roomCode: roomCode || savedRoom() }, (res) => {
    if (!res || res.error) {
      $('join-url').textContent = res?.error || 'Could not open a room. Is the server running?';
      return;
    }
    const sameRoom = res.roomCode === roomCode;
    roomCode = res.roomCode;
    try { sessionStorage.setItem(ROOM_KEY, roomCode); } catch { /* private mode */ }
    maxPlayers = res.maxPlayers;
    for (const id of ['room-code', 'hud-room', 'room-code-mini']) $(id).textContent = roomCode;
    for (const id of ['qr-big', 'qr-mini']) $(id).src = res.qr;
    for (const id of ['join-url', 'join-url-mini']) $(id).textContent = res.joinUrl;
    $('ai-status').textContent = res.ai ? 'AI commander: online' : 'AI commander: canned lines';
    if (!sameRoom || phase === PHASES.LOBBY) {
      // New room (or still in the lobby): start clean, the server re-sends everyone in the room.
      roster.clear();
      if (phase === PHASES.LOBBY) buildPreview();
      else toLobby();
      log(`Room ${roomCode} is open. Up to ${maxPlayers} players.`, 'info');
    } else {
      // Same room mid-game: drop anyone who left while this screen was offline.
      for (const id of [...roster.keys()]) {
        if (!res.playerIds.includes(id)) {
          roster.delete(id);
          removePlayer(state, id);
        }
      }
    }
    setPhase(phase);
    updateRoomCount();
  });
});
socket.on('disconnect', () => log('Lost connection to server…', 'bad'));

let maxPlayers = 10;
function updateRoomCount() {
  $('room-count').textContent = `${roster.size}/${maxPlayers} players`;
}

socket.on(EV.PLAYER_JOINED, ({ playerId, name }) => {
  if (roster.has(playerId)) return;
  roster.set(playerId, { playerId, name });
  if (phase === PHASES.LOBBY) buildPreview();
  else addPlayer(state, { playerId, name });
  log(`${name} joined the network`, 'join');
  sfx.join();
  commander.react('join', { name });
  updateRoomCount();
});

socket.on(EV.PLAYER_LEFT, ({ playerId }) => {
  const p = roster.get(playerId);
  if (!p) return;
  roster.delete(playerId);
  if (phase === PHASES.LOBBY) buildPreview();
  else removePlayer(state, playerId);
  log(`${p.name} left the network`, 'info');
  updateRoomCount();
});

socket.on(EV.PLAYER_INPUT, ({ playerId, action, deviceId, dir }) => {
  if (phase !== PHASES.PLAYING || !roster.has(playerId)) return;
  inputs.push({ playerId, action, deviceId, dir });
});

socket.on(EV.AI_LINE, (msg) => commander.onAILine(msg));

// ------------------------------------------------------------------ mouse: move devices between APs
// Drag a device onto any AP's column, or click a device and then click an AP's column.

const canvas = $('canvas');
let grab = null; // { id, sx, sy, x, y, moved, target, selected }

function canvasPoint(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function releaseGrab() {
  grab = null;
  renderer.setDrag(null);
}

function commitMove(deviceId, routerIndex) {
  const found = findDevice(state, deviceId);
  const target = state.routers[routerIndex];
  if (found && target && found.router !== target) {
    inputs.push({ action: ACTIONS.MOVE_DEVICE, deviceId, routerId: target.id });
  }
}

canvas.addEventListener('pointerdown', (e) => {
  if (phase !== PHASES.PLAYING) return;
  const { x, y } = canvasPoint(e);
  const id = renderer.pickDevice(x, y);
  if (grab?.selected && !id) {
    // second click of click-then-click
    const target = renderer.routerColumnAt(x);
    if (target != null) commitMove(grab.id, target);
    releaseGrab();
    return;
  }
  if (!id) return releaseGrab();
  canvas.setPointerCapture(e.pointerId);
  grab = { id, sx: x, sy: y, x, y, moved: false, target: null, selected: false };
  renderer.setDrag({ id, x: null, y: null, target: null });
});

canvas.addEventListener('pointermove', (e) => {
  const { x, y } = canvasPoint(e);
  if (!grab) {
    const id = phase === PHASES.PLAYING ? renderer.pickDevice(x, y) : null;
    renderer.setHover(id);
    canvas.style.cursor = id ? 'grab' : 'default';
    return;
  }
  grab.x = x;
  grab.y = y;
  if (Math.hypot(x - grab.sx, y - grab.sy) > 6) grab.moved = true;
  grab.target = renderer.routerColumnAt(x);
  if (grab.moved || grab.selected) {
    canvas.style.cursor = grab.moved ? 'grabbing' : 'pointer';
    renderer.setDrag({ id: grab.id, x: grab.moved ? x : null, y, target: grab.target });
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (!grab) return;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  if (grab.moved) {
    if (grab.target != null) commitMove(grab.id, grab.target);
    releaseGrab();
  } else {
    grab.selected = true; // plain click: now click an AP to move it there
    renderer.setDrag({ id: grab.id, x: null, y: null, target: null });
  }
  canvas.style.cursor = 'default';
});

canvas.addEventListener('pointercancel', releaseGrab);

// ------------------------------------------------------------------ controls

$('btn-start').addEventListener('click', () => startLevel(0));
$('btn-next').addEventListener('click', () => startLevel(levelIndex + 1));
$('btn-retry').addEventListener('click', () => startLevel(levelIndex));
$('btn-lobby').addEventListener('click', toLobby);

window.addEventListener('keydown', (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  unlockAudio();
  const k = e.key.toLowerCase();
  if (k === 's' && phase === PHASES.LOBBY) startLevel(0);
  else if (k === 'l') startLevel(phase === PHASES.LOBBY ? 0 : levelIndex + 1); // debug: skip level
  else if (k === 'd') {
    demo = !demo;
    renderer.banner(demo ? 'DEMO MODE: bots are driving' : 'Demo mode off', 'tutorial', 2500);
    $('demo-flag').hidden = !demo;
  } else if (k === 'k' && phase === PHASES.PLAYING) inputs.push({ debug: 'crash' });
  else if (k === 'e' && phase === PHASES.PLAYING) inputs.push({ debug: 'event' });
  else if (k === 'm') renderer.banner(toggleMute() ? 'Sound muted' : 'Sound on', 'tutorial', 1500);
  else if (k === 'escape' && grab) releaseGrab();
  else if (k === 'escape' && phase !== PHASES.LOBBY) toLobby();
});

// ------------------------------------------------------------------ boot

document.body.dataset.phase = phase;
buildPreview();
renderer.hud(state);
commander.react('boot');
requestAnimationFrame(frame);
