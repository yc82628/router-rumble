// AI Incident Commander: a line queue with canned fallbacks.
// AI lines are requested through the server (key never reaches the browser). If the reply is
// null or doesn't arrive in time, the canned line for that moment is shown instead.
// Owner C: personality lives in CANNED.

const AI_MOMENTS = new Set(['levelStart', 'event', 'bossArrive', 'bossReturn', 'passed', 'failed']);
const CLIENT_TIMEOUT_MS = 3500; // server gives up at 3 s; this covers a dead server
const MIN_SHOW_MS = 2800;
const QUIP_GAP_MS = { crash: 5000, botAttached: 8000 }; // frequent moments don't spam

// {name} {router} {levelName} {crashes} are filled from the context.
const CANNED = {
  boot: [
    'Incident Commander online. I have coffee and low expectations.',
    'Good evening, ops team. The network is fine. For now.',
  ],
  join: [
    '{name} has joined the network. Please do not crash {name}.',
    'New device detected: {name}. Bandwidth just got a little tighter.',
    '{name} is online. Welcome to the on-call rotation.',
    'Say hi to {name}, who is now technically infrastructure.',
  ],
  levelStart: [
    '{levelName}. Keep the lights green and the packets flowing.',
    'Shift starts now: {levelName}. I believe in you. Mostly.',
    'Welcome to {levelName}. Nobody panic. That is my job.',
  ],
  crash: [
    '{router} is down! Somebody hug that router.',
    '{router} just rage-quit. Tap FIX like your Wi-Fi depends on it.',
    'We lost {router}. I am writing this in the report.',
    '{router} has left the chat.',
    'Did someone push traffic onto {router} without asking? Thought so.',
  ],
  botAttached: [
    'A minion is chewing on {router}. Tap FIX and zap it!',
    'Enemy on {router}! It eats bandwidth for breakfast. Zap it.',
    'We have a pest on {router}. FIX it. With prejudice.',
  ],
  bossArrive: [
    'That is {event}. It wants our bandwidth. Everyone, FIX FIX FIX!',
    'Big robot incoming. Its droids are with it. All hands on FIX!',
  ],
  bossReturn: [
    'It is back. Of course it is back. Tap like the internet depends on it!',
    '{event} rebooted, and it brought more droids. FIX FIX FIX!',
  ],
  bossDown: [
    'It is down! It is never really down, is it. Get ready.',
    'Knocked it out. It is rebooting somewhere. Fix your APs while you can!',
    'Its droids fell with it. Enjoy the quiet. It will not last.',
  ],
  linkFixed: [
    'Cable restored. The squirrel has been spoken to.',
    'Link is back up. Duct tape: undefeated.',
  ],
  idle: [
    'Reminder: the big screen has no numbers. Talk to each other.',
    'Pushing traffic is a gift. Ask before gifting.',
    'Boost is a seatbelt, not a lifestyle.',
    'Smart fridge on AP-2 is streaming again. Of course it is.',
    'Green is good. Yellow is a warning. Red is a story for the retro.',
  ],
  passed: [
    'POST-INCIDENT REPORT: {crashes} crash(es), zero excuses accepted. Network survived. Promotion denied.',
    'POST-INCIDENT REPORT: The internet lives. Root cause of success: suspiciously good teamwork.',
    'POST-INCIDENT REPORT: Users noticed nothing, which is the highest praise ops will ever get.',
  ],
  failed: [
    'POST-INCIDENT REPORT: Root cause was "everyone". Action item: try again.',
    'POST-INCIDENT REPORT: {crashes} crashes. The routers have filed a complaint with HR.',
    'POST-INCIDENT REPORT: The network is down and so is my faith. Retry?',
  ],
  eventGeneric: ['Chaos incoming. Stay calm and reroute.'],
  event: {
    giantDownload: [
      'Someone is downloading a 200 GB game "just to try it". Spread that load!',
      'Giant download detected. Neighbours, open your hearts and your bandwidth.',
    ],
    routerReboot: [
      'A router is installing updates mid-shift. Classic. Neighbours, cover for it.',
      'Unscheduled reboot. Nobody touch anything. Actually, touch everything.',
    ],
    ddos: [
      'DDoS! Ten thousand smart toasters want our attention.',
      'We are under attack. Boost now, panic later.',
    ],
    cableCut: [
      'A cable got cut. Whoever owns those routers: FIX, FIX, FIX!',
      'Physical layer problem. Somebody grab the duct tape.',
    ],
    stream4k: [
      'Marketing went live in 4K without telling ops. Of course they did.',
      'New screens joined the network. They all want 4K. Brace.',
    ],
  },
};

export function createCommander({ textEl, faceEl, requestAI, onSay }) {
  let seq = 0;
  const pending = new Map();
  const lastPick = {};
  let queue = [];
  let shownAt = -Infinity;
  let typing = null;
  const lastQuip = {};
  let mood = 'calm';

  const FACES = {
    calm: [' .-----. \n | o o | \n |  -  | \n \'-----\' ', ' .-----. \n | o o | \n |  o  | \n \'-----\' '],
    alarm: [' .-----. \n | O O | \n |  O  | \n \'-----\' ', ' .-----. \n | O O | \n |  0  | \n \'-----\' '],
  };
  const setFace = (open) => {
    faceEl.textContent = FACES[mood][open ? 1 : 0];
    faceEl.dataset.mood = mood;
  };
  setFace(false);

  function fill(text, ctx) {
    return text.replace(/\{(\w+)\}/g, (_, k) => (ctx?.[k] != null ? String(ctx[k]) : 'someone'));
  }

  function canned(moment, ctx) {
    const list = moment === 'event' ? CANNED.event[ctx?.eventType] || CANNED.eventGeneric : CANNED[moment];
    if (!list?.length) return null;
    const key = moment === 'event' ? `event:${ctx?.eventType}` : moment;
    let i = Math.floor(Math.random() * list.length);
    if (list.length > 1 && i === lastPick[key]) i = (i + 1) % list.length;
    lastPick[key] = i;
    return fill(list[i], ctx);
  }

  function show(text) {
    shownAt = performance.now();
    onSay?.(text);
    clearInterval(typing);
    let n = 0;
    textEl.textContent = '';
    typing = setInterval(() => {
      n += 2;
      textEl.textContent = text.slice(0, n);
      setFace(n % 4 < 2);
      if (n >= text.length) {
        clearInterval(typing);
        setFace(false);
      }
    }, 30);
  }

  function say(text, { urgent = false } = {}) {
    if (!text) return;
    if (urgent || performance.now() - shownAt >= MIN_SHOW_MS) show(text);
    else {
      queue.push(text);
      if (queue.length > 2) queue = queue.slice(-2);
    }
  }
  setInterval(() => {
    if (queue.length && performance.now() - shownAt >= MIN_SHOW_MS) show(queue.shift());
  }, 250);

  function resolve(requestId, text) {
    const p = pending.get(requestId);
    if (!p) return; // already fell back
    pending.delete(requestId);
    say(text || p.fallback, { urgent: true });
  }

  /** Something happened; say something about it. ctx feeds both the templates and the AI prompt. */
  function react(moment, ctx = {}) {
    if (QUIP_GAP_MS[moment]) {
      if (performance.now() - (lastQuip[moment] ?? -Infinity) < QUIP_GAP_MS[moment]) return;
      lastQuip[moment] = performance.now();
    }
    const fallback = canned(moment, ctx);
    if (AI_MOMENTS.has(moment) && requestAI) {
      const requestId = ++seq;
      pending.set(requestId, { fallback });
      requestAI({ requestId, context: { moment, ...ctx } });
      setTimeout(() => resolve(requestId, null), CLIENT_TIMEOUT_MS);
    } else {
      say(fallback, { urgent: moment === 'join' || moment === 'bossDown' });
    }
  }

  function onAILine({ requestId, text } = {}) {
    resolve(requestId, typeof text === 'string' && text.trim() ? text.trim() : null);
  }

  function setMood(next) {
    mood = FACES[next] ? next : 'calm';
    setFace(false);
  }

  return { react, say, onAILine, setMood };
}
