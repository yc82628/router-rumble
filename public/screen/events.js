// Chaos events: data + hooks. Called only from sim.js, so keep them pure (no DOM, no Math.random:
// use the `rand` passed in).
//
//   start(state, ev, rand)  apply one-time effects; return the announcement text, or null to skip
//   each(state, ev)         re-applied every tick while active (multipliers are reset each tick)
//   end(state, ev)          cleanup
//   isDone(state, ev)       optional; otherwise the event ends after `duration` seconds
//   duration                seconds; 0 = instant (start only)
import { makeDevice } from './devices.js';

const up = (r) => r.status !== 'crashed';
const pick = (list, rand) => (list.length ? list[Math.floor(rand() * list.length)] : null);
const routerOf = (state, ev) => state.routers.find((r) => r.id === ev.routerId);

export const EVENT_DEFS = {
  giantDownload: {
    name: 'Giant Download',
    duration: 10,
    start(state, ev, rand) {
      const r = pick(state.routers.filter((x) => up(x) && x.devices.some((d) => d.kind !== 'player')), rand);
      if (!r) return null;
      const d = pick(r.devices.filter((x) => x.kind !== 'player'), rand);
      ev.routerId = r.id;
      ev.deviceId = d.id;
      return `A ${d.kind} on ${r.name} is downloading the entire internet. Move it or spread the load!`;
    },
    each(state, ev) {
      // The device can be moved mid-event; the event follows it.
      for (const r of state.routers) {
        const d = r.devices.find((x) => x.id === ev.deviceId);
        if (d) {
          d.eventMul *= 4;
          ev.routerId = r.id;
        }
      }
    },
  },

  routerReboot: {
    name: 'Router Reboot',
    duration: 6,
    start(state, ev, rand) {
      const r = pick(state.routers.filter(up), rand);
      if (!r) return null;
      ev.routerId = r.id;
      r.status = 'crashed';
      r.crashTimer = 6;
      r.overTime = 0;
      r.load = 0;
      return `${r.name} decided to install updates. Neighbours, absorb its traffic!`;
    },
    each(state, ev) {
      const r = routerOf(state, ev);
      if (r) r.failover = true; // a crashed AP with failover hands its demand to its neighbours
    },
  },

  ddos: {
    name: 'DDoS',
    duration: 8,
    start() {
      return 'A botnet of smart toasters is attacking. All demand +40%!';
    },
    each(state) {
      state.globalMul *= 1.4;
      state.tint = 'ddos';
    },
  },

  cableCut: {
    name: 'Cable Cut',
    duration: Infinity,
    start(state, ev, rand) {
      const link = pick(state.links.filter((l) => !l.cut), rand);
      if (!link) return null;
      link.cut = true;
      link.fixTaps = 0;
      ev.linkId = link.id;
      const a = state.routers[link.a].name;
      const b = state.routers[link.b].name;
      return `A squirrel bit the cable between ${a} and ${b}. Tap FIX 10 times!`;
    },
    isDone(state, ev) {
      const link = state.links.find((l) => l.id === ev.linkId);
      return !link || !link.cut;
    },
  },

  stream4k: {
    name: '4K Stream',
    duration: 0,
    start(state, ev, rand) {
      const r = pick(state.routers, rand);
      if (!r) return null;
      ev.routerId = r.id;
      for (let i = 0; i < 2; i++) r.devices.push(makeDevice(state, 'tv', 12, { label: '4K', isNew: 4 }));
      return `Marketing went live in 4K on ${r.name}. New screens just joined.`;
    },
  },
};

export const EVENT_TYPES = Object.keys(EVENT_DEFS);
