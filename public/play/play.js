// Phone controller: join form, big buttons, private view of the player's own access point.
// Owner A. The phone never simulates anything; it only sends inputs and shows player:state.
import { EV, ACTIONS, PHASES } from '../shared/protocol.js';
import { cipherReveal } from '../shared/cipher.js';
import { ORB_TYPES } from '../screen/powerups.js';

const $ = (id) => document.getElementById(id);
const socket = window.io();

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

let me = null; // { playerId, name, room }
let phase = { phase: PHASES.LOBBY };
let view = null; // latest PlayerState
let lastStatus = 'ok';
let hostOnline = true;

// Browsers only allow vibration after the player has touched the page.
const vibrate = (pattern) => {
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  try { navigator.vibrate?.(pattern); } catch { /* unsupported */ }
};

// ------------------------------------------------------------------ join

// The QR code links to /play?room=CODE, so most players never type the code.
const urlRoom = new URLSearchParams(location.search).get('room');
$('room').value = (urlRoom || store.get('pp:room') || '').toUpperCase().slice(0, 4);
$('name').value = store.get('pp:name') || '';
$('room').addEventListener('input', () => {
  $('room').value = $('room').value.toUpperCase().replace(/[^A-Z]/g, '');
});

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('name').value.trim();
  const room = $('room').value.trim();
  if (!name || !room) return;
  // Reuse my player id only for the room it belongs to (rejoin after a reload).
  join(name, room, store.get('pp:room') === room ? store.get('pp:id') : null);
});

function join(name, room, playerId) {
  $('join-btn').disabled = true;
  $('join-error').textContent = '';
  socket.timeout(5000).emit(EV.PLAYER_JOIN, { room, name, playerId: playerId || undefined }, (err, res) => {
    $('join-btn').disabled = false;
    if (err || !res || res.error) {
      $('join-error').textContent = res?.error || 'Could not reach the game. Check your connection and try again.';
      if (me && res?.error) leaveRoom(res.error); // my room vanished while I was away
      return;
    }
    me = res;
    hostOnline = res.hostOnline;
    store.set('pp:name', res.name);
    store.set('pp:id', res.playerId);
    store.set('pp:room', res.room);
    $('name').blur();
    requestWakeLock();
    render();
  });
}

async function requestWakeLock() {
  try { await navigator.wakeLock?.request('screen'); } catch { /* needs HTTPS; fine without */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && me) requestWakeLock();
});

// ------------------------------------------------------------------ socket

socket.on('connect', () => {
  $('conn').hidden = true;
  if (me) join(me.name, me.room, me.playerId); // rejoin with the same id after a drop
});
socket.on(EV.HOST_STATUS, ({ online }) => {
  hostOnline = online;
  render();
});
socket.on(EV.ROOM_CLOSED, ({ reason } = {}) => leaveRoom(reason || 'The game has ended.'));

function leaveRoom(message) {
  me = null;
  view = null;
  phase = { phase: PHASES.LOBBY };
  document.body.classList.remove('crashed');
  render();
  $('join-error').textContent = message;
}
socket.on('disconnect', () => {
  if (me) $('conn').hidden = false;
});
socket.on(EV.GAME_PHASE, (p) => {
  phase = p || { phase: PHASES.LOBBY };
  render();
});
socket.on(EV.PLAYER_STATE, (s) => {
  if (!me || s.playerId !== me.playerId) return;
  if (s.status === 'crashed' && lastStatus !== 'crashed') vibrate([220, 80, 220, 80, 320]);
  lastStatus = s.status;
  const first = !view;
  view = s;
  if (first) render();
  renderControl();
  handleFeedback(s);
  handleUnlocks(s);
  renderOrbs(s);
});

// ------------------------------------------------------------------ feedback pop-ups
// The game sends short messages ("+50 BOT ZAPPED!", "🔥 x3 STREAK!"); each shows once as a
// floating pop-up, and real achievements buzz the phone so players feel their impact.

let feedbackRun = null;
let feedbackSeen = 0;

function popup(text, kind = 'small') {
  const layer = $('pops');
  const el = document.createElement('div');
  el.className = `pop ${kind}`;
  el.textContent = text;
  if (kind === 'small' || kind === 'local') el.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 120)}px`);
  layer.append(el);
  while (layer.children.length > 8) layer.firstChild.remove();
  if (kind !== 'small' && kind !== 'local') $('pop-announce').textContent = text; // screen readers: big moments only
  el.addEventListener('animationend', () => el.remove());
}

function handleFeedback(s) {
  if (s.feedbackRun !== feedbackRun) {
    feedbackRun = s.feedbackRun; // new level: sequence numbers restart
    feedbackSeen = 0;
  }
  for (const f of s.feedback || []) {
    if (f.seq <= feedbackSeen) continue;
    feedbackSeen = f.seq;
    popup(f.text, f.kind);
    if (f.kind === 'big') vibrate([30, 40, 70]);
    else if (f.kind === 'team') vibrate([60, 50, 60, 50, 140]);
  }
}

// ------------------------------------------------------------------ control unlocks
// Level 1 only has PUSH and FIX; BOOST and SEND unlock later with a little celebration.

const ALL_CONTROLS = ['push', 'fix', 'boost', 'send'];
const UNLOCK_TEXT = {
  boost: 'NEW: BOOST UNLOCKED! +50% capacity for 5 s',
  send: 'NEW: SEND UNLOCKED! Tap a device, then SEND it to a neighbour',
};
let knownControls = null;

function handleUnlocks(s) {
  const now = s.controls || ALL_CONTROLS;
  if (knownControls) {
    for (const c of now) {
      if (knownControls.includes(c) || !UNLOCK_TEXT[c]) continue;
      popup(UNLOCK_TEXT[c], 'unlock');
      vibrate([40, 60, 40, 60, 120]);
      const target = c === 'boost' ? $('b-boost') : $('devices');
      target.classList.add('just-unlocked');
      setTimeout(() => target.classList.remove('just-unlocked'), 5000);
    }
  }
  knownControls = now;
}

// ------------------------------------------------------------------ buttons

const send = (action) => socket.emit(EV.PLAYER_INPUT, { action });

// Device move mode: tap a device chip, then the Push buttons become "send this device left/right".
let selected = null;
let selectTimer = 0;

function select(id) {
  selected = selected === id ? null : id;
  clearTimeout(selectTimer);
  if (selected) {
    selectTimer = setTimeout(() => {
      selected = null;
      renderControl();
    }, 6000);
  }
  vibrate(10);
  renderControl();
}

$('devices').addEventListener('pointerdown', (e) => {
  const chip = e.target.closest('[data-id]');
  if (!chip) return;
  e.preventDefault();
  select(chip.dataset.id);
});

for (const btn of document.querySelectorAll('.grid button')) {
  const fire = () => {
    if (btn.disabled) return;
    const action = btn.dataset.action;
    if (selected && (action === ACTIONS.PUSH_LEFT || action === ACTIONS.PUSH_RIGHT)) {
      socket.emit(EV.PLAYER_INPUT, {
        action: ACTIONS.MOVE_DEVICE,
        deviceId: selected,
        dir: action === ACTIONS.PUSH_LEFT ? 'left' : 'right',
      });
      select(selected); // toggles off
    } else if (selected && action === ACTIONS.PULL_BACK) {
      select(selected); // cancel
    } else {
      send(action);
      localFeedback(action);
    }
    vibrate(action === ACTIONS.FIX ? 6 : 12);
    btn.classList.add('pressed');
    setTimeout(() => btn.classList.remove('pressed'), 110);
  };
  // pointerdown instead of click: no 300 ms delay, and rapid Fix taps all count
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    fire();
  });
  btn.addEventListener('click', (e) => {
    if (e.detail === 0) fire(); // keyboard activation only
  });
}
/** Instant confirmation for my own taps (FIX feedback comes from the game, with points). */
function localFeedback(action) {
  const s = view;
  if (!s) return;
  if (action === ACTIONS.PUSH_LEFT && s.left) popup(`+10% ◀ ${s.left.name}`, 'local');
  else if (action === ACTIONS.PUSH_RIGHT && s.right) popup(`+10% ▶ ${s.right.name}`, 'local');
  else if (action === ACTIONS.PULL_BACK) popup('PULLED BACK', 'local');
  else if (action === ACTIONS.BOOST) {
    popup('BOOST ON ⚡', 'big');
    vibrate([20, 30, 60]);
  }
}

document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

// ------------------------------------------------------------------ views

function show(id) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== id;
}

function overlay(title, sub = '', cls = '') {
  $('phase-overlay').hidden = !title;
  $('phase-title').textContent = title || '';
  $('phase-title').className = cls;
  $('phase-sub').textContent = sub;
}

function render() {
  if (!me) {
    show('view-join');
    overlay(null);
    return;
  }
  const p = phase.phase;
  const levelLabel = `LEVEL ${phase.level ?? 1}${phase.levelName ? ` · ${phase.levelName}` : ''}`;

  if (p === PHASES.LOBBY || !view) {
    show('view-wait');
    $('wait-title').textContent = `You're on the network, ${me.name}.`;
    $('wait-room').textContent = `Room ${me.room}`;
    $('wait-ap').textContent = view?.routerName ? `You'll be running ${view.routerName}.` : '';
  } else {
    show('view-control');
  }

  if (p !== PHASES.PLAYING) clearOrbs();
  if (!hostOnline) overlay('HOST OFFLINE', 'The big screen dropped. Hang on, it usually comes right back…', 'bad');
  else if (p === PHASES.COUNTDOWN) overlay('GET READY', levelLabel);
  else if (p === PHASES.LEVEL_END) {
    overlay(`LEVEL CLEARED ${'★'.repeat(phase.stars || 0)}`, `${myScoreLine()}\nNext level: beat your score!`, 'good');
  } else if (p === PHASES.GAME_OVER) {
    const won = phase.result === 'passed';
    overlay(
      won ? 'INTERNET SAVED' : 'NETWORK DOWN',
      `${myScoreLine()}\n${won ? 'Legends. Check the high-score board!' : 'One more run? Beat the high score!'}`,
      won ? 'good' : 'bad',
    );
  } else overlay(null);
}

function pct(v) {
  return `${Math.round(v * 100)}%`;
}

function sideLabel(side, arrow, left) {
  if (!side) return 'edge of network';
  const who = side.owners.length ? ` (${side.owners.join(', ')})` : '';
  const txt = `${side.name}${who}${side.blocked ? ' ✕' : ''}`;
  return left ? `${arrow} ${txt}` : `${txt} ${arrow}`;
}

const KIND_LABEL = { phone: 'PHONE', laptop: 'LAPTOP', tv: 'TV', console: 'CONSOLE', fridge: 'FRIDGE', speaker: 'SPEAKER' };
const MAX_CHIPS = 6;
const deviceIconIndex = (id) => {
  const sequence = Number(String(id).slice(1));
  return Number.isFinite(sequence) ? Math.abs(sequence) % 9 : 0;
};

function renderDevices(s) {
  const list = s.devices || [];
  if (selected && !list.some((d) => d.id === selected)) selected = null; // moved away or AP switched
  const moving = list.find((d) => d.id === selected);
  const title = $('dev-title');
  title.textContent = moving
    ? `SEND ${moving.mine ? 'YOUR PHONE' : moving.label.toUpperCase()} TO…`
    : `DEVICES ON ${s.routerName} · tap one to move it`;
  title.classList.toggle('move', Boolean(moving));

  // Always keep the selected chip visible, even if it's not among the hungriest.
  const room = list.length > MAX_CHIPS ? MAX_CHIPS - 1 : MAX_CHIPS; // leave a slot for "+N"
  let shown = list.slice(0, room);
  if (moving && !shown.includes(moving)) shown = [...shown.slice(0, room - 1), moving];
  const chips = shown.map((d) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.dataset.id = d.id;
    el.setAttribute('aria-pressed', String(d.id === selected));
    el.setAttribute('aria-label', `${d.mine ? 'Your phone' : d.label}, demand ${d.demand}`);
    el.className = [
      'chip-dev',
      d.kind === 'player' ? 'player' : d.demand > 50 ? 'hot' : d.demand > 32 ? 'warm' : '',
      d.isNew ? 'new' : '',
      d.surging ? 'surge' : '',
      d.reconnecting ? 'recon' : '',
      d.id === selected ? 'sel' : '',
    ].join(' ');
    if (d.playerColor) el.style.setProperty('--player-color', d.playerColor);
    el.style.fontSize = `${Math.min(18, 11 + d.demand / 8)}px`; // hungrier = bigger, like on the map
    const icon = document.createElement('span');
    icon.className = 'dev-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.style.setProperty('--device-icon', `url("/screen/device-icons/icon-${deviceIconIndex(d.id)}.png")`);
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = d.mine ? 'YOU' : d.kind === 'player' ? d.label : KIND_LABEL[d.kind] || d.label;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(d.demand);
    el.append(icon, k, n);
    return el;
  });
  if (list.length > shown.length) {
    const more = document.createElement('div');
    more.className = 'chip-more';
    more.textContent = `+${list.length - shown.length}`;
    chips.push(more);
  }
  $('devices').replaceChildren(...chips);
}

function renderControl() {
  const s = view;
  if (!s || !s.routerId) return;
  const crashed = s.status === 'crashed';
  const over = !crashed && s.overload > 0;

  $('c-router').textContent = s.ownedCount > 1 ? `${s.routerName} (${s.routerSlot}/${s.ownedCount})` : s.routerName;
  $('player-name').textContent = s.playerName || 'PLAYER';
  $('player-color-name').textContent = s.playerColorName || 'PINK';
  $('player-color-dot').style.backgroundColor = s.playerColor || '#ff4fd8';
  $('player-color-dot').style.boxShadow = `0 0 10px ${s.playerColor || '#ff4fd8'}`;
  document.documentElement.style.setProperty('--player-color', s.playerColor || '#ff4fd8');
  const chip = $('c-status');
  chip.textContent = crashed ? `OFFLINE ${Math.ceil(s.crashLeft)}s` : over ? 'OVERLOAD' : s.status === 'warn' ? 'STRAINED' : 'ONLINE';
  chip.className = `chip ${crashed ? 'crashed' : over ? 'over' : s.status}`;
  document.body.classList.toggle('crashed', crashed);

  $('c-event').hidden = !s.event;
  $('c-event').textContent = s.event ? `⚠ ${s.event}` : '';

  const ratio = s.capacity ? s.load / s.capacity : 0;
  const fill = $('c-load-fill');
  fill.style.width = `${Math.min(1, ratio / 1.5) * 100}%`;
  fill.style.background = crashed || ratio > 1 ? 'var(--red)' : ratio > 0.85 ? 'var(--yellow)' : 'var(--green)';
  $('c-load-text').textContent = crashed ? 'NO SIGNAL' : `${s.load} / ${s.capacity}${s.boostLeft > 0 ? ' ⚡' : ''}`;
  $('c-overload').textContent = over ? `CRASH IN ${Math.max(0, 3 * (1 - s.overload)).toFixed(1)}s` : '';

  $('c-left-label').textContent = sideLabel(s.left, '◀', true);
  $('c-right-label').textContent = sideLabel(s.right, '▶', false);
  $('c-sl').textContent = s.left ? pct(s.sL) : '—';
  $('c-sr').textContent = s.right ? pct(s.sR) : '—';

  // Controls this level hasn't unlocked yet are hidden, not just disabled, to keep it simple.
  const allow = (c) => !s.controls || s.controls.includes(c);
  const canSend = allow('send');
  if (!canSend) selected = null;
  $('dev-title').hidden = !canSend;
  $('devices').hidden = !canSend;
  $('b-boost').hidden = !allow('boost');
  $('b-pull').classList.toggle('wide', !allow('boost'));

  if (canSend) renderDevices(s);
  const moving = s.devices?.find((d) => d.id === selected);
  for (const b of [$('b-left'), $('b-right'), $('b-pull')]) b.classList.toggle('send', Boolean(moving));
  if (moving) {
    $('b-left').textContent = s.left ? `SEND ◀\n${s.left.name}` : 'SEND ◀';
    $('b-right').textContent = s.right ? `SEND ▶\n${s.right.name}` : 'SEND ▶';
    $('b-pull').textContent = 'CANCEL';
    $('b-left').disabled = !s.left || s.left.crashed;
    $('b-right').disabled = !s.right || s.right.crashed;
    $('b-pull').disabled = false;
  } else {
    $('b-left').textContent = '◀ PUSH\nLEFT';
    $('b-right').textContent = 'PUSH ▶\nRIGHT';
    $('b-pull').textContent = 'PULL\nBACK';
    $('b-left').disabled = !s.left || s.sL >= 0.5;
    $('b-right').disabled = !s.right || s.sR >= 0.5;
    $('b-pull').disabled = s.sL + s.sR === 0;
  }

  const boost = $('b-boost');
  boost.classList.toggle('active', s.boostLeft > 0);
  boost.classList.toggle('ready', s.boostLeft <= 0 && s.boostReadyIn <= 0 && !crashed);
  boost.disabled = crashed || s.boostLeft > 0 || s.boostReadyIn > 0;
  boost.textContent = s.boostLeft > 0 ? `BOOST ${Math.ceil(s.boostLeft)}s` : s.boostReadyIn > 0 ? `BOOST ${Math.ceil(s.boostReadyIn)}s` : 'BOOST ⚡';

  const fix = $('b-fix');
  fix.classList.toggle('hot', Boolean(s.fix));
  fix.textContent =
    s.fix === 'crash' ? 'TAP TAP TAP! FIX'
      : s.fix === 'virus' ? `CONTAIN VIRUS ⚠ ${s.botHp}`
      : s.fix === 'bot' ? `ZAP BOT ⚡ ${s.botHp}`
      : s.fix === 'cable' ? `REPAIR CABLE ${s.cableTaps}/${s.cableNeeded}`
      : s.fix === 'boss' ? `ZAP ${s.boss.name} ${s.boss.hp}/${s.boss.maxHp}`
      : 'FIX';

  const sw = $('b-switch');
  sw.hidden = !(s.ownedCount > 1);
  sw.textContent = `SWITCH AP (${s.routerSlot}/${s.ownedCount})`;

  $('c-health').textContent = `HEALTH ${s.health}%`;
  $('c-points').textContent = `${(s.points || 0).toLocaleString('en-US')} pts${s.teamSize > 1 ? ` · #${s.rank}` : ''}`;
  $('c-mult').textContent = s.mult > 1 ? `🔥x${s.mult}` : '';
  const powers = [
    s.hotspotLeft > 0 && `📡 HOTSPOT ${Math.ceil(s.hotspotLeft)}s`,
    s.vpnLeft > 0 && `🔒 VPN ${Math.ceil(s.vpnLeft)}s`,
  ].filter(Boolean);
  $('c-powers').hidden = !powers.length;
  $('c-powers').textContent = powers.join(' · ');
  const t = Math.max(0, s.timeLeft ?? 0);
  $('c-time').textContent = s.timeLeft == null ? 'BOSS' : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** "You scored 1,240 pts (#2) · MVP: Ana" from the level-end phase payload. */
function myScoreLine() {
  const mine = me && phase.points?.[me.playerId];
  const parts = [];
  if (mine) parts.push(`You scored ${mine.points.toLocaleString('en-US')} pts (#${mine.rank})`);
  if (phase.mvp) parts.push(phase.mvp === me?.name ? 'YOU ARE THE MVP! 🏆' : `MVP: ${phase.mvp}`);
  return parts.join(' · ');
}

// ------------------------------------------------------------------ full screen
// Android/desktop: real full screen. iPhone Safari doesn't allow it for web pages, so we explain
// "Add to Home Screen", which opens the game without browser bars (the page is set up for it).

const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
document.body.classList.toggle('standalone', standalone);
const canFullscreen = Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);

function toast(text, ms = 5000) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($('toast').hidden = true), ms);
}

function toggleFullscreen() {
  if (!canFullscreen) {
    toast('On iPhone: tap Share ⬆ then "Add to Home Screen", and open the game from there for full screen.', 7000);
    return;
  }
  const el = document.documentElement;
  const p = isFullscreen()
    ? (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)
    : (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el, { navigationUI: 'hide' });
  Promise.resolve(p).catch(() => toast('Full screen is blocked here. Try your browser menu instead.'));
}

// One button both ways: "⛶ FULL SCREEN" when windowed, "✕ EXIT" when full screen (also updates
// when the player leaves full screen with the back gesture).
const isFullscreen = () => Boolean(document.fullscreenElement || document.webkitFullscreenElement);
function syncFullscreenButtons() {
  const full = isFullscreen();
  for (const b of document.querySelectorAll('.fs-toggle')) {
    b.textContent = full ? '✕' : '⛶';
    b.setAttribute('aria-label', full ? 'Exit full screen' : 'Enter full screen');
    b.setAttribute('aria-pressed', String(full));
  }
}
for (const b of document.querySelectorAll('.fs-toggle')) b.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', syncFullscreenButtons);
document.addEventListener('webkitfullscreenchange', syncFullscreenButtons);
syncFullscreenButtons();

cipherReveal(document.querySelector('#view-join h1'));
// ------------------------------------------------------------------ power-up orbs
// Orbs drift across every phone at once; the first player to tap one grabs it, and it fires on
// their AP (HOTSPOT, VPN) or on the whole network (ANTIVIRUS, LOAD BALANCER).

const orbEls = new Map(); // orbId -> button

function clearOrbs() {
  for (const el of orbEls.values()) el.remove();
  orbEls.clear();
}

function renderOrbs(s) {
  const live = new Set((s.orbs || []).map((o) => o.id));
  for (const [id, el] of orbEls) {
    if (live.has(id)) continue;
    el.classList.add('gone'); // claimed by someone or expired
    setTimeout(() => el.remove(), 300);
    orbEls.delete(id);
  }
  if (phase.phase !== PHASES.PLAYING) return;
  for (const o of s.orbs || []) {
    if (orbEls.has(o.id)) continue;
    const t = ORB_TYPES[o.type];
    if (!t) continue;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'orb';
    el.setAttribute('aria-label', `Grab ${t.label}: ${t.desc}`);
    el.style.setProperty('--orb', t.color);
    // a random drift path across the middle of the screen
    const rnd = (a, b) => `${Math.round(a + Math.random() * (b - a))}%`;
    el.style.setProperty('--x0', rnd(8, 70));
    el.style.setProperty('--y0', rnd(18, 62));
    el.style.setProperty('--x1', rnd(8, 70));
    el.style.setProperty('--y1', rnd(18, 62));
    const icon = document.createElement('span');
    icon.className = 'orb-icon';
    icon.textContent = t.icon;
    const label = document.createElement('span');
    label.className = 'orb-label';
    label.textContent = t.label;
    el.append(icon, label);
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      socket.emit(EV.PLAYER_INPUT, { action: ACTIONS.CLAIM_ORB, orbId: o.id });
      el.classList.add('grabbed');
      vibrate(20);
    });
    el.addEventListener('click', (e) => {
      if (e.detail === 0) socket.emit(EV.PLAYER_INPUT, { action: ACTIONS.CLAIM_ORB, orbId: o.id }); // keyboard
    });
    $('orbs').append(el);
    orbEls.set(o.id, el);
  }
}

render();
