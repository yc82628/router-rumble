// Canvas map (uplink, access points, devices, packets, sparks) + DOM HUD panels.
// Reads sim state, never writes it. Owner C: juice lives here.
import { effectiveCapacity, TUNING } from './sim.js';

const TAU = Math.PI * 2;
const MAX_PACKETS = 700;
// How traffic is drawn: 'electric' = crackling arcs along each connection, 'packets' = moving dots.
const FLOW_STYLE = 'electric';

export const COLORS = {
  bg: '#010805',
  grid: 'rgba(43, 255, 173, 0.055)',
  line: '#25654a',
  cyan: '#58ffda',
  green: '#2bffad',
  yellow: '#ffd447',
  red: '#ff526b',
  magenta: '#f178da',
  orange: '#ffad73',
  dim: '#527a67',
  text: '#a0c6b3',
  bright: '#effff5',
};
const C = COLORS;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const quad = (a, c, b, t) => ({
  x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t ** 2 * b.x,
  y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t ** 2 * b.y,
});
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
export function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Words for the big screen: deliberately no numbers (players must call out their load). */
export function statusWord(r) {
  if (r.status === 'crashed') return { text: 'OFFLINE', color: C.red };
  if (r.overTime > 0) return { text: 'OVERLOAD', color: C.red };
  if (r.status === 'warn') return { text: 'STRAINED', color: C.yellow };
  return { text: 'STABLE', color: C.green };
}

/** Devices grow (and warm up in colour) as they need more traffic. */
export const deviceScale = (d) => (d.kind === 'player' ? 1 : clamp(Math.sqrt(d.demand / 14), 0.75, 2.6));
const deviceColor = (d) => (d.kind === 'player' ? d.playerColor || C.magenta : d.demand > 50 ? C.red : d.demand > 32 ? C.yellow : C.cyan);

function loadColor(r) {
  if (r.status === 'crashed') return C.red;
  const ratio = r.load / effectiveCapacity(r);
  return ratio > 1 ? C.red : ratio > TUNING.warnRatio ? C.yellow : C.green;
}

export function createRenderer(canvas, dom) {
  const ctx = canvas.getContext('2d');
  const FONT = getComputedStyle(document.body).fontFamily || 'monospace';
  const operatorGhost = new Image();
  operatorGhost.src = '/screen/operator-ghost.png';
  const operatorStatic = new Image();
  operatorStatic.src = '/screen/operator-static.gif';
  const deviceIcons = Array.from({ length: 9 }, (_, i) => {
    const image = new Image();
    image.src = `/screen/device-icons/icon-${i}.png`;
    return image;
  });
  const tintedIcons = new Map();
  const iconIndex = (device) => {
    const sequence = Number(String(device.id).slice(1));
    return Number.isFinite(sequence) ? Math.abs(sequence) % deviceIcons.length : 0;
  };
  function tintedIcon(device, color) {
    const source = deviceIcons[iconIndex(device)];
    if (!source.complete || !source.naturalWidth) return null;
    const key = `${iconIndex(device)}:${color}`;
    if (tintedIcons.has(key)) return tintedIcons.get(key);
    const icon = document.createElement('canvas');
    icon.width = source.naturalWidth;
    icon.height = source.naturalHeight;
    const iconCtx = icon.getContext('2d');
    iconCtx.drawImage(source, 0, 0);
    iconCtx.globalCompositeOperation = 'source-in';
    iconCtx.fillStyle = color;
    iconCtx.fillRect(0, 0, icon.width, icon.height);
    tintedIcons.set(key, icon);
    return icon;
  }
  let W = 1;
  let H = 1;
  let dpr = 1;
  let clock = 0;
  let shake = 0;
  let staticTimer = 0;
  let lay = null;
  let lastState = null;
  let packets = [];
  let sparks = [];
  const devPos = new Map(); // deviceId -> animated {x, y}; devices slide when moved
  let drag = null; // { id, x, y, target } while the mouse is moving a device
  let hoverId = null;
  const spawnAcc = new Map();
  let bannerTimer = 0;
  const hudCache = { ops: '', nodes: '' };

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, rect.width);
    H = Math.max(1, rect.height);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  new ResizeObserver(resize).observe(canvas.parentElement);
  resize();

  // ---------------------------------------------------------------- layout

  function layout(state) {
    const n = state.routers.length;
    const padX = W * 0.05;
    const span = W - padX * 2;
    const cell = span / n;
    const R = clamp(Math.min(cell * 0.17, H * 0.075), 16, 48);
    const uplink = { x: W / 2, y: H * 0.095 };
    const routers = state.routers.map((_, i) => ({ x: padX + cell * (i + 0.5), y: H * 0.375 }));
    const targets = new Map();
    state.routers.forEach((r, i) => {
      const m = r.devices.length;
      const spread = Math.min(cell * 0.92, m * 95);
      r.devices.forEach((d, k) => {
        targets.set(d.id, {
          x: routers[i].x + (m === 1 ? 0 : (k / (m - 1) - 0.5) * spread),
          y: H * 0.79 + (k % 2 ? 28 : 0),
        });
      });
    });
    return { n, R, cell, padX, uplink, routers, targets };
  }

  /** Ease each device toward its slot, so a moved device visibly travels to its new AP. */
  function animateDevices(dt) {
    const k = 1 - Math.exp(-dt * 10);
    for (const [id, t] of lay.targets) {
      const p = devPos.get(id);
      if (!p) devPos.set(id, { x: t.x, y: t.y });
      else {
        p.x += (t.x - p.x) * k;
        p.y += (t.y - p.y) * k;
      }
    }
    for (const id of devPos.keys()) if (!lay.targets.has(id)) devPos.delete(id);
  }

  // ---------------------------------------------------------------- particles

  function spawn(state, dt) {
    const add = (key, rate, make) => {
      let acc = (spawnAcc.get(key) || 0) + rate * dt;
      while (acc >= 1) {
        acc -= 1;
        const p = make();
        if (p && FLOW_STYLE === 'packets' && packets.length < MAX_PACKETS) packets.push(p);
      }
      spawnAcc.set(key, acc);
    };
    // Traffic flows upstream: devices → their AP → (neighbour AP) → internet uplink.
    for (const r of state.routers) {
      const i = r.index;
      const crashed = r.status === 'crashed';
      if (!crashed || r.failover) {
        for (const d of r.devices) {
          if (d.reconnect <= 0) add(`d${d.id}`, d.demand / 4.5, () => ({ kind: 'dev', a: i, id: d.id, t: 0, v: 1.15, tone: d.surge > 0 ? 'surge' : d.demand > 25 ? 'heavy' : 'normal' }));
        }
      }
      if (crashed) {
        add(`s${i}`, 14, () => {
          const p = lay.routers[i];
          sparks.push(makeSpark(p.x, p.y, Math.random() < 0.5 ? C.red : C.yellow, 120));
        });
        continue;
      }
      add(`u${i}`, Math.min(r.load, effectiveCapacity(r)) / 6, () => ({ kind: 'up', a: i, t: 0, v: 0.95 }));
      if (r.overflow > 0) {
        add(`x${i}`, r.overflow / 2, () => {
          const p = lay.routers[i];
          sparks.push(makeSpark(p.x + (Math.random() - 0.5) * lay.R, p.y - lay.R, C.red, 60));
        });
      }
    }
    for (const l of state.links) {
      add(`ab${l.a}`, l.flowAB / 5, () => ({ kind: 'side', a: l.a, b: l.b, t: 0, v: 1.3 }));
      add(`ba${l.a}`, l.flowBA / 5, () => ({ kind: 'side', a: l.b, b: l.a, t: 0, v: 1.3 }));
    }
  }

  function packetPos(p) {
    if (p.kind === 'up') {
      const r = lay.routers[p.a];
      return r && lerp({ x: r.x, y: r.y - lay.R }, lay.uplink, p.t);
    }
    if (p.kind === 'side') {
      const a = lay.routers[p.a];
      const b = lay.routers[p.b];
      if (!a || !b) return null;
      const dir = Math.sign(b.x - a.x);
      return lerp({ x: a.x + dir * lay.R, y: a.y }, { x: b.x - dir * lay.R, y: b.y }, p.t);
    }
    const r = lay.routers[p.a];
    const d = devPos.get(p.id);
    if (!r || !d) return null;
    const a = { x: r.x, y: r.y + lay.R + 34 };
    return quad(d, deviceControl(a, d), a, p.t);
  }

  function deviceControl(ap, device) {
    return {
      x: ap.x + (device.x - ap.x) * 0.18,
      y: ap.y + (device.y - ap.y) * 0.55,
    };
  }

  function makeSpark(x, y, color, speed = 160) {
    const a = Math.random() * TAU;
    const v = speed * (0.4 + Math.random());
    return { x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40, life: 0.5 + Math.random() * 0.6, color };
  }
  function burst(x, y, n, colors, speed) {
    for (let i = 0; i < n; i++) sparks.push(makeSpark(x, y, colors[i % colors.length], speed));
  }

  /** React to a sim event (state.emitted entry) with screen juice. */
  function fx(e) {
    if (!lay || !lastState) return;
    const idx = lastState.routers.findIndex((r) => r.id === e.routerId);
    const p = lay.routers[idx];
    if (e.type === 'crash') {
      shake = 12;
      if (p) burst(p.x, p.y, 60, [C.red, C.yellow, C.bright], 260);
    } else if (e.type === 'recover' && p) {
      burst(p.x, p.y, 28, [C.green, C.cyan], 140);
    } else if (e.type === 'boost' && p) {
      burst(p.x, p.y, 24, [C.yellow], 180);
    } else if (e.type === 'eventStart') {
      shake = Math.max(shake, 6);
      if (e.eventType === 'ddos') staticTimer = Math.max(staticTimer, 0.42);
      if (p) burst(p.x, p.y, 30, [C.yellow, C.magenta], 200);
    } else if (e.type === 'virusSpread') {
      staticTimer = Math.max(staticTimer, 0.32);
    } else if (e.type === 'botZapped' && p) {
      burst(p.x, p.y - lay.R, 26, [C.orange, C.yellow], 180);
    } else if (e.type === 'bossArrive' || e.type === 'bossDown') {
      const down = e.type === 'bossDown';
      shake = Math.max(shake, down ? 18 : 8);
      if (p) burst(p.x, p.y - lay.R - 60, down ? 100 : 30, [C.red, C.orange, C.bright], down ? 360 : 200);
      for (const id of e.droidRouterIds || []) {
        const q = lay.routers[lastState.routers.findIndex((r) => r.id === id)];
        if (q) burst(q.x, q.y, 20, [C.red, C.orange], 160);
      }
    } else if (e.type === 'linkFixed') {
      const link = lastState.links.find((l) => l.id === e.linkId);
      if (link) {
        const a = lay.routers[link.a];
        const b = lay.routers[link.b];
        burst((a.x + b.x) / 2, a.y, 30, [C.green, C.cyan], 160);
      }
    }
  }

  // ---------------------------------------------------------------- drawing

  function drawBackground() {
    ctx.fillStyle = C.bg;
    ctx.fillRect(-20, -20, W + 40, H + 40);

    // Use the supplied glitch texture as a steady background layer; only its static pattern animates.
    if (operatorStatic.complete && operatorStatic.naturalWidth) {
      const scale = Math.max(W / operatorStatic.naturalWidth, H / operatorStatic.naturalHeight);
      const staticW = operatorStatic.naturalWidth * scale;
      const staticH = operatorStatic.naturalHeight * scale;
      ctx.globalAlpha = 0.18;
      ctx.drawImage(operatorStatic, (W - staticW) / 2, (H - staticH) / 2, staticW, staticH);
      ctx.globalAlpha = 1;
    }

    if (operatorGhost.complete && operatorGhost.naturalWidth) {
      const ghostH = H * 1.18;
      const ghostW = ghostH * operatorGhost.naturalWidth / operatorGhost.naturalHeight;
      ctx.globalAlpha = 0.34;
      ctx.drawImage(operatorGhost, -W * 0.025, -H * 0.18, ghostW, ghostH);
      ctx.globalAlpha = 1;
    }

    const atmosphere = ctx.createRadialGradient(W * 0.5, H * 0.38, H * 0.03, W * 0.5, H * 0.38, W * 0.68);
    atmosphere.addColorStop(0, 'rgba(30, 137, 83, 0.17)');
    atmosphere.addColorStop(1, 'rgba(2, 9, 6, 0)');
    ctx.fillStyle = atmosphere;
    ctx.fillRect(0, 0, W, H);

    // A restrained CRT texture in the distance, then a receding floor grid.
    ctx.strokeStyle = 'rgba(43, 255, 173, 0.025)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = (W / 2) % 40; x < W; x += 40) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, H);
    }
    for (let y = 0; y < H; y += 40) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(W, y + 0.5);
    }
    ctx.stroke();

    const horizon = H * 0.19;
    ctx.strokeStyle = rgba(C.green, 0.085);
    ctx.beginPath();
    for (let i = -10; i <= 10; i++) {
      ctx.moveTo(W / 2 + i * W * 0.008, horizon);
      ctx.lineTo(W / 2 + i * W * 0.1, H);
    }
    for (const t of [0.22, 0.32, 0.43, 0.55, 0.68, 0.82, 1]) {
      const y = horizon + (H - horizon) * t * t;
      const half = W * (0.08 + t * 0.48);
      ctx.moveTo(W / 2 - half, y);
      ctx.lineTo(W / 2 + half, y);
    }
    ctx.stroke();

    ctx.strokeStyle = rgba(C.green, 0.055);
    ctx.lineWidth = 1;
    for (const radius of [H * 0.34, H * 0.62]) {
      ctx.beginPath();
      ctx.ellipse(W / 2, H * 0.39, radius * 1.35, radius * 0.45, 0, 0, TAU);
      ctx.stroke();
    }

    // Soft scanlines and sparse chromatic tearing evoke a noisy video feed.
    // Keep this under the network so names, links, and enemies stay readable.
    ctx.fillStyle = 'rgba(211, 218, 255, 0.025)';
    for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1);
    const glitchColors = ['#ff3b9d', '#35f4ff', '#9bff55'];
    ctx.save();
    ctx.globalAlpha = 0.055;
    for (let i = 0; i < 9; i++) {
      const y = Math.random() * H;
      const x = Math.random() * W * 0.72;
      ctx.fillStyle = glitchColors[i % glitchColors.length];
      ctx.fillRect(x, y, W * (0.04 + Math.random() * 0.22), 1 + Math.random() * 2);
    }
    ctx.restore();

    if (staticTimer > 0) {
      const strength = Math.min(1, staticTimer / 0.18);
      ctx.save();
      ctx.globalAlpha = 0.12 * strength;
      for (let i = 0; i < 20; i++) {
        const y = Math.random() * H;
        const x = Math.random() * W * 0.6;
        const width = W * (0.04 + Math.random() * 0.34);
        const height = 1 + Math.random() * 3;
        ctx.fillStyle = glitchColors[Math.floor(Math.random() * glitchColors.length)];
        ctx.fillRect(x, y, width, height);
        // Tiny offset copies create the RGB split of a damaged camera signal.
        if (Math.random() > 0.58) {
          ctx.globalAlpha = 0.08 * strength;
          ctx.fillStyle = glitchColors[(i + 1) % glitchColors.length];
          ctx.fillRect(x + 2 + Math.random() * 5, y + 1, width * (0.25 + Math.random() * 0.5), 1);
          ctx.globalAlpha = 0.12 * strength;
        }
      }
      // A few dim horizontal bars make the interference read as video static.
      ctx.globalAlpha = 0.09 * strength;
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = i % 2 ? '#e7f7ff' : '#aaffea';
        ctx.fillRect(0, Math.random() * H, W, 1);
      }
      ctx.restore();
    }
  }

  function channel(x1, y1, x2, y2, color, strength = 1, control = null) {
    for (const [alpha, width] of [[0.16 * strength, 11], [0.77 * strength, 2]]) {
      ctx.strokeStyle = rgba(color, alpha);
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      if (control) ctx.quadraticCurveTo(control.x, control.y, x2, y2);
      else ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }

  function drawLinks(state) {
    const { R } = lay;
    // uplink → APs
    for (const r of state.routers) {
      const p = lay.routers[r.index];
      channel(lay.uplink.x, lay.uplink.y, p.x, p.y - R, r.status === 'crashed' ? C.red : C.cyan, 0.62);
    }
    // devices → AP
    for (const r of state.routers) {
      const p = lay.routers[r.index];
      for (const dev of r.devices) {
        const d = devPos.get(dev.id);
        if (!d) continue;
        const start = { x: p.x, y: p.y + R + 34 };
        const trafficColor = r.status === 'crashed' ? C.dim : loadColor(r);
        channel(start.x, start.y, d.x, d.y, trafficColor, 0.9, deviceControl(start, d));
      }
    }
    // AP ↔ AP
    ctx.font = `bold 16px ${FONT}`;
    ctx.textBaseline = 'middle';
    for (const l of state.links) {
      const a = lay.routers[l.a];
      const b = lay.routers[l.b];
      const x1 = a.x + R + 6;
      const x2 = b.x - R - 6;
      const mid = (x1 + x2) / 2;
      if (l.cut) {
        ctx.strokeStyle = C.red;
        ctx.setLineDash([6, 6]);
        ctx.lineDashOffset = -clock * 20;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x1, a.y);
        ctx.lineTo(x2, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = C.red;
        ctx.textAlign = 'center';
        ctx.fillText('✂ CUT', mid, a.y - 14);
        ctx.font = `11px ${FONT}`;
        ctx.fillText(`FIX ${l.fixTaps}/${TUNING.cableFixTaps}`, mid, a.y + 14);
        ctx.font = `bold 16px ${FONT}`;
        continue;
      }
      channel(x1, a.y, x2, b.y, C.cyan, 1.1);
      // Forward-share chevrons: › per 10% pushed right (above), ‹ per 10% pushed left (below).
      const right = state.routers[l.a].shareR;
      const left = state.routers[l.b].shareL;
      ctx.fillStyle = C.yellow;
      if (right) {
        ctx.textAlign = 'center';
        ctx.fillText('›'.repeat(right), mid, a.y - 12);
      }
      if (left) {
        ctx.textAlign = 'center';
        ctx.fillText('‹'.repeat(left), mid, a.y + 13);
      }
    }
  }

  function drawPackets(dt) {
    ctx.globalCompositeOperation = 'lighter';
    const keep = [];
    for (const p of packets) {
      p.t += dt * p.v;
      if (p.t >= 1) continue;
      const pos = packetPos(p);
      if (!pos) continue;
      keep.push(p);
      const router = lastState?.routers[p.a];
      const statusColor = router ? loadColor(router) : C.green;
      const color = p.kind === 'side' ? C.yellow
        : statusColor === C.red ? C.red
        : statusColor === C.yellow ? (p.tone === 'surge' ? C.red : C.yellow)
        : p.kind === 'up' ? C.cyan
        : p.tone === 'surge' ? C.red : p.tone === 'heavy' ? C.yellow : C.cyan;
      const tail = packetPos({ ...p, t: Math.max(0, p.t - 0.035) });
      if (tail) {
        ctx.strokeStyle = rgba(color, 0.75);
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(tail.x, tail.y);
        ctx.lineTo(pos.x, pos.y);
        ctx.stroke();
      }
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.fillStyle = color;
      ctx.fillRect(pos.x - 3.5, pos.y - 3.5, 7, 7);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = rgba(color, 0.45);
      ctx.lineWidth = 1;
      ctx.strokeRect(pos.x - 5.5, pos.y - 5.5, 11, 11);
      ctx.fillStyle = rgba(C.bright, 0.88);
      ctx.fillRect(pos.x - 1, pos.y - 1, 2, 2);
    }
    packets = keep;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---------------------------------------------------------------- electric flow
  // Each live connection carries a small spark drifting slowly from source to sink (device → AP →
  // internet), dragging a thin, flickering lightning trail behind it. Busier links get a brighter
  // spark, a longer trail, and (when very busy) a second spark.

  /** Cheap deterministic noise in [-1, 1] for (seed, step). */
  const noise = (seed, step) => {
    const s = Math.sin(seed * 127.1 + step * 311.7) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };

  const SPARK_SECONDS = 6; // a calm spark takes ~6 s to cross a link (busy links a bit faster)
  const TRAIL = 0.28; // trail length as a fraction of the link

  /**
   * Sparks along one path. `at(t)` gives the point at t∈[0,1] (from source to sink).
   * level 0..1 = how much traffic; color = traffic colour; seed keeps each path distinct.
   */
  function drawArc(at, level, color, seed) {
    if (level <= 0.01) return;
    const a = at(0);
    const b = at(1);
    if (Math.hypot(b.x - a.x, b.y - a.y) < 4) return;
    const frame = Math.floor(clock * 16); // trail re-crackles ~16 times a second
    const speed = (1 + level * 0.6) / SPARK_SECONDS;
    const trail = TRAIL * (0.6 + level * 0.6);
    const sparks = level > 0.65 ? 2 : 1;
    const amp = 1.5 + level * 3;
    const STEPS = 12;

    for (let k = 0; k < sparks; k++) {
      const head = (clock * speed + (noise(seed, 3) + 1) / 2 + k / sparks) % 1;
      // Lightning trail: jagged points from the head back along the path, fading out.
      const pts = [];
      for (let i = 0; i <= STEPS; i++) {
        const t = head - (trail * i) / STEPS;
        if (t < 0) break;
        const p = at(t);
        const q = at(Math.min(1, t + 0.01));
        const r = at(Math.max(0, t - 0.01));
        let nx = -(q.y - r.y);
        let ny = q.x - r.x;
        const n = Math.hypot(nx, ny) || 1;
        nx /= n;
        ny /= n;
        const jag = i === 0 ? 0 : noise(seed + k * 17, frame * 29 + i) * amp * Math.min(1, i / 3);
        pts.push({ x: p.x + nx * jag, y: p.y + ny * jag, fade: 1 - i / STEPS });
      }
      for (let i = 1; i < pts.length; i++) {
        const p0 = pts[i - 1];
        const p1 = pts[i];
        const f = p1.fade;
        ctx.lineWidth = 3 + level * 2;
        ctx.strokeStyle = rgba(color, 0.12 * f);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
        ctx.lineWidth = 1 + level * 0.6;
        ctx.strokeStyle = rgba(color, (0.45 + level * 0.4) * f);
        ctx.stroke();
      }
      // The spark itself: dot-sized, bright core with a soft glow.
      const h = pts[0];
      if (!h) continue;
      const g = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, 7 + level * 4);
      g.addColorStop(0, rgba(color, 0.55));
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(h.x, h.y, 7 + level * 4, 0, TAU);
      ctx.fill();
      ctx.fillStyle = rgba(C.bright, 0.95);
      ctx.beginPath();
      ctx.arc(h.x, h.y, 1.6 + level * 1.1, 0, TAU);
      ctx.fill();
    }
  }

  function drawElectric(state) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const { R } = lay;
    for (const r of state.routers) {
      const i = r.index;
      const ap = lay.routers[i];
      if (!ap) continue;
      const crashed = r.status === 'crashed';
      const apColor = loadColor(r);
      // devices → AP
      if (!crashed || r.failover) {
        const sink = { x: ap.x, y: ap.y + R + 34 };
        for (const d of r.devices) {
          const pos = devPos.get(d.id);
          if (!pos || d.reconnect > 0) continue;
          const ctl = deviceControl(sink, pos);
          const color = d.surge > 0 || apColor === C.red ? C.red : d.demand > 25 || apColor === C.yellow ? C.yellow : C.cyan;
          const id = Number(String(d.id).replace(/\D/g, '')) || i;
          drawArc((t) => quad(pos, ctl, sink, t), clamp(d.demand / 45, 0.12, 1), color, id * 1.37);
        }
      }
      // AP → internet uplink
      if (!crashed) {
        const served = Math.min(r.load, effectiveCapacity(r));
        const from = { x: ap.x, y: ap.y - R };
        drawArc((t) => lerp(from, lay.uplink, t), clamp(served / 110, 0.1, 1), apColor === C.red ? C.red : C.cyan, 500 + i * 7.3);
      }
    }
    // AP ↔ AP forwarded traffic
    for (const l of state.links) {
      if (l.cut) continue;
      const a = lay.routers[l.a];
      const b = lay.routers[l.b];
      if (!a || !b) continue;
      const ab = (t) => lerp({ x: a.x + R, y: a.y }, { x: b.x - R, y: b.y }, t);
      const ba = (t) => ab(1 - t);
      if (l.flowAB > 0.5) drawArc(ab, clamp(l.flowAB / 35, 0.15, 1), C.yellow, 900 + l.a * 3.1);
      if (l.flowBA > 0.5) drawArc(ba, clamp(l.flowBA / 35, 0.15, 1), C.yellow, 950 + l.a * 3.7);
    }
    ctx.restore();
  }

  function drawUplink() {
    const { x, y } = lay.uplink;
    const pulse = 0.5 + 0.5 * Math.sin(clock * 3);
    ctx.strokeStyle = rgba(C.cyan, 0.25 + 0.25 * pulse);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, 22 + pulse * 8, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = '#071822';
    ctx.strokeStyle = C.cyan;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + Math.PI / 6;
      ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * 18, y + Math.sin(a) * 18);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = C.cyan;
    ctx.font = `bold 10px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('WAN', x, y + 1);
    ctx.fillStyle = C.text;
    ctx.fillText('INTERNET UPLINK', x, y - 32);
  }

  function drawWifi(x, y, size, color, bars) {
    ctx.lineCap = 'round';
    for (let i = 1; i <= 3; i++) {
      ctx.strokeStyle = i <= bars ? color : rgba(C.dim, 0.9);
      ctx.lineWidth = Math.max(2, size * 0.12);
      ctx.beginPath();
      ctx.arc(x, y, (size * i) / 3, -Math.PI * 0.78, -Math.PI * 0.22);
      ctx.stroke();
    }
    ctx.fillStyle = bars > 0 ? color : C.dim;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2, size * 0.1), 0, TAU);
    ctx.fill();
    ctx.lineCap = 'butt';
  }

  function drawRouter(state, r) {
    const { R } = lay;
    const { x, y } = lay.routers[r.index];
    const crashed = r.status === 'crashed';
    const col = loadColor(r);
    const font = FONT;
    const cap = effectiveCapacity(r);
    const ratio = crashed ? 0 : r.load / cap;

    // A luminous elliptical deck grounds each AP on the receding network plane.
    ctx.fillStyle = rgba(col, 0.08);
    ctx.strokeStyle = rgba(col, 0.56);
    ctx.lineWidth = 2;
    ctx.shadowColor = col;
    ctx.shadowBlur = 20;
    ctx.beginPath();
    ctx.ellipse(x, y + R * 0.52, R * 1.62, R * 0.61, 0, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = rgba(col, 0.25);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(x, y + R * 0.52, R * 1.9, R * 0.78, 0, 0, TAU);
    ctx.stroke();

    // halo
    const g = ctx.createRadialGradient(x, y, R * 0.55, x, y, R * 2.5);
    g.addColorStop(0, rgba(col, crashed ? 0.42 + 0.2 * Math.sin(clock * 12) : 0.36));
    g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, R * 2.5, 0, TAU);
    ctx.fill();

    // Concentric instrumentation makes the APs read as the primary controls.
    ctx.strokeStyle = rgba(col, 0.38);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, R + 12, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = rgba(col, 0.92);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, R + 12, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(ratio / 1.5, 0, 1));
    ctx.stroke();
    ctx.strokeStyle = rgba(col, 0.55);
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * TAU;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(angle) * (R + 16), y + Math.sin(angle) * (R + 16));
      ctx.lineTo(x + Math.cos(angle) * (R + 19), y + Math.sin(angle) * (R + 19));
      ctx.stroke();
    }

    // body
    ctx.fillStyle = crashed ? '#190609' : '#041b10';
    ctx.strokeStyle = col;
    ctx.lineWidth = 2.5 + r.fixPulse * 3;
    ctx.shadowColor = col;
    ctx.shadowBlur = 20;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    const bars = crashed ? 0 : ratio > 1 ? 1 : ratio > TUNING.warnRatio ? 2 : 3;
    drawWifi(x, y + R * 0.32, R * 0.72, col, bars);
    if (crashed) {
      ctx.strokeStyle = C.red;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x - R * 0.4, y - R * 0.4);
      ctx.lineTo(x + R * 0.4, y + R * 0.4);
      ctx.moveTo(x + R * 0.4, y - R * 0.4);
      ctx.lineTo(x - R * 0.4, y + R * 0.4);
      ctx.stroke();
      // recovery progress
      ctx.strokeStyle = rgba(C.bright, 0.8);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, R + 6, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - r.crashTimer / TUNING.crashSeconds));
      ctx.stroke();
    }

    // overload countdown ring
    if (r.overTime > 0 && !crashed) {
      ctx.strokeStyle = C.red;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(x, y, R + 6, -Math.PI / 2, -Math.PI / 2 + TAU * (r.overTime / TUNING.overloadSeconds));
      ctx.stroke();
    }

    // boost ring
    if (r.boostTimer > 0) {
      ctx.strokeStyle = C.yellow;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 7]);
      ctx.lineDashOffset = -clock * 30;
      ctx.beginPath();
      ctx.arc(x, y, R + 12, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Compact status tag, readable against the operator and moving packets.
    const tagW = Math.min(108, lay.cell * 0.75);
    const tagY = y - R - 55;
    ctx.fillStyle = 'rgba(1, 12, 7, 0.89)';
    ctx.fillRect(x - tagW / 2, tagY, tagW, 35);
    ctx.strokeStyle = rgba(col, 0.65);
    ctx.lineWidth = 1;
    ctx.strokeRect(x - tagW / 2 + 0.5, tagY + 0.5, tagW - 1, 34);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.bright;
    ctx.font = `bold ${Math.round(clamp(R * 0.45, 12, 16))}px ${font}`;
    ctx.fillText(r.name, x, tagY + 15);
    const sw = statusWord(r);
    ctx.fillStyle = sw.color;
    ctx.font = `10px ${font}`;
    ctx.fillText(crashed ? 'OFFLINE' : r.boostTimer > 0 ? 'BOOSTED' : sw.text, x, tagY + 29);

    // load bar (no numbers): capacity mark sits at 2/3 of the bar
    const bw = Math.max(52, R * 2.5);
    const bx = x - bw / 2;
    const by = y + R + 12;
    ctx.fillStyle = '#02060a';
    ctx.fillRect(bx, by, bw, 8);
    ctx.fillStyle = col;
    ctx.fillRect(bx, by, bw * clamp(ratio / 1.5, 0, 1), 8);
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, 7);
    ctx.fillStyle = C.bright;
    ctx.fillRect(bx + (bw * 2) / 3, by - 2, 1.5, 12);

    // owners
    const owners = r.ownerIds.map((id) => state.players.find((p) => p.id === id)).filter(Boolean);
    ctx.font = `11px ${font}`;
    if (owners.length) {
      const label = owners.map((p) => p.name).join(' + ');
      let left = x - ctx.measureText(label).width / 2;
      for (const [i, owner] of owners.entries()) {
        ctx.fillStyle = owner.color || C.magenta;
        ctx.textAlign = 'left';
        ctx.fillText(owner.name, left, by + 22);
        left += ctx.measureText(owner.name).width;
        if (i < owners.length - 1) {
          ctx.fillStyle = C.dim;
          ctx.fillText(' + ', left, by + 22);
          left += ctx.measureText(' + ').width;
        }
      }
      ctx.textAlign = 'center';
    } else {
      ctx.fillStyle = C.dim;
      ctx.fillText('unassigned', x, by + 22);
    }
  }

  function drawDevice(d, pos, online) {
    const isPlayer = d.kind === 'player';
    const reconnecting = d.reconnect > 0;
    const live = online && !reconnecting;
    const col = online ? deviceColor(d) : C.dim;
    const s = deviceScale(d);
    const { x, y } = pos;
    const picked = drag?.id === d.id || hoverId === d.id;

    // "just joined" ring, selection ring
    if (d.isNew > 0) {
      ctx.strokeStyle = rgba(C.green, Math.min(1, d.isNew));
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 14 * s + 6 + Math.sin(clock * 8) * 2, 0, TAU);
      ctx.stroke();
    }
    if (picked) {
      ctx.strokeStyle = C.bright;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(x, y, 13 * s + 5, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (live && d.surge > 0) {
      const g = ctx.createRadialGradient(x, y, 2, x, y, 16 * s);
      g.addColorStop(0, rgba(col, 0.35));
      g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, 16 * s, 0, TAU);
      ctx.fill();
    }

    ctx.strokeStyle = rgba(col, live ? 0.55 : 0.28);
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.ellipse(x, y + 10 * s, 14 * s, 4 * s, 0, 0, TAU);
    ctx.stroke();

    ctx.save();
    ctx.globalAlpha = reconnecting ? 0.35 + 0.35 * Math.sin(clock * 20) : 1;
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.strokeStyle = col;
    ctx.fillStyle = online ? rgba(col, 0.24) : 'transparent';
    ctx.lineWidth = (isPlayer ? 2.5 : 2.1) / s;
    ctx.shadowColor = col;
    ctx.shadowBlur = live ? 8 : 0;
    const box = (w, h) => {
      ctx.beginPath();
      ctx.rect(-w / 2, -h / 2, w, h);
      ctx.fill();
      ctx.stroke();
    };
    const line = (x1, y1, x2, y2) => {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };
    const icon = tintedIcon(d, col);
    if (icon) {
      const size = 20;
      const ratio = size / Math.max(icon.width, icon.height);
      ctx.drawImage(icon, -(icon.width * ratio) / 2, -(icon.height * ratio) / 2, icon.width * ratio, icon.height * ratio);
    } else switch (d.kind) {
      case 'player':
        if (online) {
          ctx.fillStyle = rgba(C.magenta, 0.25 + 0.15 * Math.sin(clock * 4));
          ctx.beginPath();
          ctx.arc(0, 0, 14, 0, TAU);
          ctx.fill();
          ctx.fillStyle = rgba(col, 0.15);
        }
        box(10, 17);
        break;
      case 'phone':
        box(8, 14);
        break;
      case 'laptop':
        box(16, 10);
        line(-11, 7, 11, 7);
        break;
      case 'tv':
        box(20, 13);
        line(-5, 9, 5, 9);
        break;
      case 'console':
        box(16, 7);
        break;
      case 'fridge':
        box(11, 18);
        line(-5.5, -2, 5.5, -2);
        break;
      default: // speaker
        ctx.beginPath();
        ctx.arc(0, 0, 6, 0, TAU);
        ctx.fill();
        ctx.stroke();
    }
    ctx.restore();

    const label = isPlayer ? d.name : d.isNew > 0 ? 'NEW' : d.label;
    if (label) {
      ctx.fillStyle = d.isNew > 0 && !isPlayer ? C.green : col;
      ctx.font = `${isPlayer ? 'bold 12px' : 'bold 9px'} ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(label, x, y + 10 * s + 4);
    }
  }

  /** Column highlight + rubber band while a device is being dragged or is selected. */
  function drawDrag(state) {
    if (!drag) return;
    const from = devPos.get(drag.id);
    if (!from) return;
    if (drag.target != null && lay.routers[drag.target]) {
      const r = lay.routers[drag.target];
      ctx.fillStyle = rgba(C.cyan, 0.06);
      ctx.fillRect(r.x - lay.cell / 2 + 4, 0, lay.cell - 8, H);
      ctx.strokeStyle = rgba(C.cyan, 0.5);
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x - lay.cell / 2 + 4.5, 0.5, lay.cell - 9, H - 1);
      ctx.fillStyle = C.cyan;
      ctx.font = `bold 12px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(`CONNECT TO ${state.routers[drag.target].name}`, r.x, H - 12);
    }
    if (drag.x != null) {
      ctx.strokeStyle = rgba(C.bright, 0.7);
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(drag.x, drag.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function drawSparks(dt) {
    ctx.globalCompositeOperation = 'lighter';
    sparks = sparks.filter((s) => (s.life -= dt) > 0);
    if (sparks.length > 800) sparks = sparks.slice(-800);
    for (const s of sparks) {
      s.vy += 380 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      ctx.fillStyle = rgba(s.color, clamp(s.life * 1.6, 0, 1));
      ctx.fillRect(s.x - 1.5, s.y - 1.5, 3, 3);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---------------------------------------------------------------- enemies

  const routerIndex = (state, id) => state.routers.findIndex((r) => r.id === id);
  const bossSize = () => clamp(lay.R * 1.5, 34, 64);
  const bossDock = (p) => ({ x: p.x, y: p.y - lay.R - 34 - bossSize() });

  /** Where a bot is: flying from the uplink (or the boss's AP) to its AP, then orbiting it. */
  function botPos(state, b, k) {
    const p = lay.routers[routerIndex(state, b.routerId)];
    if (!p) return null;
    if (b.state === 'attached') {
      const a = b.spin + k * 2.1;
      return { x: p.x + Math.cos(a) * (lay.R + 22), y: p.y + Math.sin(a) * (lay.R + 14) };
    }
    const fromI = b.fromRouterId != null ? routerIndex(state, b.fromRouterId) : -1;
    const from = fromI >= 0 ? bossDock(lay.routers[fromI]) : lay.uplink;
    const t = 1 - (1 - b.t) * (1 - b.t); // ease out
    return lerp(from, { x: p.x, y: p.y - lay.R - 10 }, t);
  }

  function drawBot(b, pos) {
    const col = b.hit > 0 ? C.bright : b.virus ? C.magenta : b.droid ? C.red : C.orange;
    ctx.save();
    ctx.translate(pos.x, pos.y);
    if (b.droid) {
      ctx.scale(0.85, 0.85);
      // Interceptor droid rotors.
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-12, -7);
      ctx.lineTo(12, -7);
      ctx.stroke();
      const blade = 4 + Math.abs(Math.sin(clock * 30)) * 3;
      for (const x of [-12, 12]) {
        ctx.beginPath();
        ctx.ellipse(x, -8, blade, 1.5, 0, 0, TAU);
        ctx.stroke();
      }
      ctx.fillStyle = '#1c0b06';
      ctx.beginPath();
      ctx.arc(0, 0, 7, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.shadowColor = col;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(Math.sin(clock * 3 + b.id) * 2, 0.5, 2.5, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
    } else if (b.virus) {
      // Temporary code-drawn virus until the supplied enemy art is ready.
      ctx.rotate(clock * 0.8 + b.spin * 0.15);
      ctx.strokeStyle = col;
      ctx.fillStyle = '#14091a';
      ctx.lineWidth = 2;
      for (let i = 0; i < 8; i++) {
        const a = (i * TAU) / 8;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 6, Math.sin(a) * 6);
        ctx.lineTo(Math.cos(a) * 12, Math.sin(a) * 12);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(0, 0, 7, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.shadowColor = col;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(0, 0, 2.5, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
    } else {
      // Horned minion silhouette, drawn in code so the stock-watermarked reference isn't shipped.
      ctx.strokeStyle = col;
      ctx.fillStyle = '#1c0b06';
      ctx.lineWidth = 1.6;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(side * 4, -4);
        ctx.lineTo(side * 10, -13);
        ctx.lineTo(side * 9, -3);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(-7, -5);
      ctx.quadraticCurveTo(-8, -9, -4, -9);
      ctx.lineTo(4, -9);
      ctx.quadraticCurveTo(8, -9, 7, -5);
      ctx.lineTo(8, 5);
      ctx.quadraticCurveTo(7, 9, 3, 9);
      ctx.lineTo(-3, 9);
      ctx.quadraticCurveTo(-8, 9, -8, 5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.shadowColor = col;
      ctx.shadowBlur = 6;
      for (const eye of [-3, 3]) {
        ctx.beginPath();
        ctx.arc(eye, -1, 1.5, 0, TAU);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }
    ctx.restore();
    // hp pips
    if (b.state === 'attached') {
      ctx.fillStyle = col;
      for (let i = 0; i < b.hp; i++) ctx.fillRect(pos.x - b.maxHp * 3 + i * 6, pos.y + 11, 4, 3);
    }
  }

  function drawBots(state) {
    state.bots.forEach((b, k) => {
      const pos = botPos(state, b, k);
      if (!pos) return;
      if (b.state === 'attached') {
        const p = lay.routers[routerIndex(state, b.routerId)];
        const tether = b.virus ? C.magenta : b.droid ? C.red : C.orange;
        ctx.strokeStyle = rgba(tether, 0.35 + 0.2 * Math.sin(clock * 12 + k));
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      drawBot(b, pos);
    });
  }

  function bossPos(state) {
    const boss = state.boss;
    const i = routerIndex(state, boss.routerId);
    const to = lay.routers[i] ? bossDock(lay.routers[i]) : lay.uplink;
    const fromI = boss.fromRouterId != null ? routerIndex(state, boss.fromRouterId) : -1;
    const from = fromI >= 0 ? bossDock(lay.routers[fromI]) : { x: lay.uplink.x, y: lay.uplink.y - 40 };
    const t = boss.t * boss.t * (3 - 2 * boss.t); // smoothstep
    const p = lerp(from, to, t);
    p.y += Math.sin(clock * 2) * 4; // hover bob
    return p;
  }

  /** ULTRON: a hovering mech with a broad red smile-mask and intercepting claws. */
  function drawBoss(state) {
    const boss = state.boss;
    if (!boss || boss.defeated) return;
    if (boss.phase === 'away') {
      ctx.fillStyle = rgba(C.red, 0.6 + 0.4 * Math.sin(clock * 6));
      ctx.font = `bold 12px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(`${boss.name} RETURNS IN ${Math.ceil(boss.timer)}s`, lay.uplink.x, lay.uplink.y + 44);
      return;
    }
    const S = bossSize();
    const { x, y } = bossPos(state);
    const jitter = boss.hit > 0 ? (Math.random() - 0.5) * 6 : 0;
    const col = boss.hit > 0 ? C.bright : C.red;
    const docked = boss.phase === 'attacking';
    const ap = lay.routers[routerIndex(state, boss.routerId)];

    // drain beam into the AP
    if (docked && ap) {
      ctx.strokeStyle = rgba(C.red, 0.7);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y + S * 0.6);
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        ctx.lineTo(x + (i < steps ? (Math.random() - 0.5) * 14 : 0), y + S * 0.6 + (ap.y - lay.R - y - S * 0.6) * t);
      }
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(x + jitter, y);
    // aura
    const g = ctx.createRadialGradient(0, 0, S * 0.3, 0, 0, S * 2);
    g.addColorStop(0, rgba(C.red, 0.25));
    g.addColorStop(1, rgba(C.red, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, S * 2, 0, TAU);
    ctx.fill();

    ctx.strokeStyle = col;
    ctx.fillStyle = '#16060a';
    ctx.lineWidth = 2.5;
    // arms + claws (reach further down when docked)
    const reach = docked ? S * 1.1 : S * 0.6;
    for (const side of [-1, 1]) {
      const ex = side * S * 0.55;
      const ey = S * 0.3 + reach;
      ctx.beginPath();
      ctx.moveTo(side * S * 0.85, -S * 0.05);
      ctx.lineTo(side * S * 1.1, S * 0.45);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ex - 6, ey + 8);
      ctx.lineTo(ex, ey);
      ctx.lineTo(ex + 6, ey + 8);
      ctx.stroke();
    }
    // torso
    ctx.beginPath();
    ctx.moveTo(-S * 0.9, -S * 0.1);
    ctx.lineTo(S * 0.9, -S * 0.1);
    ctx.lineTo(S * 0.5, S * 0.65);
    ctx.lineTo(-S * 0.5, S * 0.65);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // pulsing core
    ctx.fillStyle = rgba(C.red, 0.5 + 0.5 * Math.sin(clock * 5));
    ctx.beginPath();
    ctx.arc(0, S * 0.22, S * 0.14, 0, TAU);
    ctx.fill();
    // shoulder spikes
    ctx.fillStyle = '#16060a';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * S * 0.6, -S * 0.1);
      ctx.lineTo(side * S * 1.0, -S * 0.55);
      ctx.lineTo(side * S * 0.95, -S * 0.1);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    // Broad face plate with glowing eyes and a grin.
    ctx.beginPath();
    ctx.moveTo(-S * 0.58, -S * 0.9);
    ctx.quadraticCurveTo(-S * 0.7, -S * 0.94, -S * 0.72, -S * 0.75);
    ctx.lineTo(-S * 0.66, -S * 0.2);
    ctx.quadraticCurveTo(0, S * 0.05, S * 0.66, -S * 0.2);
    ctx.lineTo(S * 0.72, -S * 0.75);
    ctx.quadraticCurveTo(S * 0.7, -S * 0.94, S * 0.58, -S * 0.9);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.shadowColor = C.red;
    ctx.shadowBlur = 12;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(side * S * 0.32, -S * 0.58, S * 0.12, S * 0.16, side * -0.16, 0, TAU);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.moveTo(-S * 0.42, -S * 0.43);
    ctx.quadraticCurveTo(0, -S * 0.06, S * 0.42, -S * 0.43);
    ctx.strokeStyle = col;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Antenna crest.
    ctx.beginPath();
    ctx.moveTo(0, -S * 0.75);
    ctx.lineTo(0, -S * 1.0);
    ctx.stroke();
    ctx.restore();

    // name + HP bar
    const bw = S * 2.6;
    const by = y - S * 1.25;
    ctx.fillStyle = '#02060a';
    ctx.fillRect(x - bw / 2, by, bw, 7);
    ctx.fillStyle = C.red;
    ctx.fillRect(x - bw / 2, by, (bw * boss.hp) / Math.max(1, boss.maxHp), 7);
    ctx.strokeStyle = rgba(C.red, 0.6);
    ctx.lineWidth = 1;
    ctx.strokeRect(x - bw / 2 + 0.5, by + 0.5, bw - 1, 6);
    ctx.fillStyle = C.red;
    ctx.font = `bold 12px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const total = state.level.boss?.lives ?? boss.round;
    ctx.fillText(`${boss.name} · ROUND ${boss.round}/${total}`, x, by - 5);
  }

  /** Called every animation frame. */
  function draw(state, dt) {
    lastState = state;
    clock += dt;
    staticTimer = Math.max(0, staticTimer - dt);
    lay = layout(state);
    animateDevices(dt);
    spawn(state, dt);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (shake > 0) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
      shake = Math.max(0, shake - dt * 30);
    }
    drawBackground();
    drawDrag(state);
    drawLinks(state);
    if (FLOW_STYLE === 'electric') drawElectric(state);
    else drawPackets(dt);
    drawUplink();
    for (const r of state.routers) drawRouter(state, r);
    for (const r of state.routers) {
      const online = r.status !== 'crashed' || r.failover;
      for (const d of r.devices) {
        const p = devPos.get(d.id);
        if (p) drawDevice(d, p, online);
      }
    }
    drawBots(state);
    drawBoss(state);
    drawSparks(dt);

    if (state.tint === 'ddos') {
      ctx.fillStyle = rgba(C.red, 0.1 + 0.06 * Math.sin(clock * 10));
      ctx.fillRect(-20, -20, W + 40, H + 40);
    }
  }

  // ---------------------------------------------------------------- mouse picking (canvas CSS px)

  /** Device id under the point, or null. Bigger devices are easier to grab. */
  function pickDevice(x, y) {
    if (!lay || !lastState) return null;
    let best = null;
    let bestDist = Infinity;
    for (const r of lastState.routers) {
      for (const d of r.devices) {
        const p = devPos.get(d.id);
        if (!p) continue;
        const dist = Math.hypot(p.x - x, p.y - y);
        if (dist < Math.max(16, 13 * deviceScale(d)) && dist < bestDist) {
          best = d.id;
          bestDist = dist;
        }
      }
    }
    return best;
  }

  /** AP index whose column contains x (the whole column is a drop target). */
  function routerColumnAt(x) {
    if (!lay) return null;
    const i = Math.floor((x - lay.padX) / lay.cell);
    return i >= 0 && i < lay.n ? i : null;
  }

  function setDrag(next) {
    drag = next;
  }
  function setHover(id) {
    hoverId = id;
  }

  // ---------------------------------------------------------------- DOM HUD

  function hud(state) {
    dom.level.textContent = `${state.levelIndex + 1} · ${state.level.name}`;
    dom.time.textContent = Number.isFinite(state.duration) ? fmtTime(Math.ceil(state.duration - state.time)) : 'BOSS';
    const h = Math.round(state.health);
    dom.health.textContent = `${h}%`;
    dom.healthBar.style.width = `${h}%`;
    dom.healthBar.style.background = h > 60 ? C.green : h > 30 ? C.yellow : C.red;
    dom.score.textContent = Math.floor(state.score).toLocaleString('en-US');
    dom.crashes.textContent = String(state.crashes);

    const routerName = (id) => state.routers.find((r) => r.id === id)?.name ?? '-';
    const ops = state.players.map((p) => {
      return { name: p.name, routers: p.routerIds.map(routerName).join(' '), color: p.color || C.magenta };
    });
    const opsKey = JSON.stringify(ops);
    if (opsKey !== hudCache.ops) {
      hudCache.ops = opsKey;
      dom.opCount.textContent = `(${ops.length})`;
      dom.operators.replaceChildren(
        ...(ops.length
          ? ops.map((o) => {
            const name = span(o.name, 'op-name');
            name.style.color = o.color;
            return row([dot(o.color), name, span(o.routers, 'op-ap')]);
          })
          : [row([span('No operators yet. Scan the QR code.', 'muted')])]),
      );
    }

    const nodes = state.routers.map((r) => ({ name: r.name, ...statusWord(r), boost: r.boostTimer > 0 }));
    const nodesKey = JSON.stringify(nodes);
    if (nodesKey !== hudCache.nodes) {
      hudCache.nodes = nodesKey;
      dom.nodes.replaceChildren(
        ...nodes.map((n) => {
          const word = span(n.text + (n.boost ? ' ⚡' : ''), 'node-status');
          word.style.color = n.color;
          return row([dot(n.color), span(n.name, 'node-name'), word]);
        }),
      );
    }
  }

  function row(children) {
    const li = document.createElement('li');
    li.append(...children);
    return li;
  }
  function span(text, cls) {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }
  function dot(color) {
    const s = span('', 'dot');
    s.style.background = color;
    s.style.boxShadow = `0 0 8px ${color}`;
    return s;
  }

  function banner(text, kind = 'event', ms = 4500) {
    dom.banner.textContent = text;
    dom.banner.className = kind;
    dom.banner.hidden = false;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => (dom.banner.hidden = true), ms);
  }

  function log(text, kind = 'info', t = 0) {
    if (!dom.log) return; // the incident log panel is optional (removed from the big screen)
    const li = document.createElement('li');
    li.className = kind;
    li.append(span(`[${fmtTime(t)}]`, 'ts'), ' ', text);
    dom.log.append(li);
    while (dom.log.children.length > 80) dom.log.firstChild.remove();
    dom.log.scrollTop = dom.log.scrollHeight;
  }

  function clearFx() {
    packets = [];
    sparks = [];
    shake = 0;
    spawnAcc.clear();
    devPos.clear(); // device ids restart every level
    drag = null;
    hoverId = null;
  }

  return { draw, hud, fx, banner, log, clearFx, pickDevice, routerColumnAt, setDrag, setHover };
}
