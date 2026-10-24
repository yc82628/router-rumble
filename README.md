# Router Rumble

> Keep the internet alive together, while the internet tries to kill you.

A co-op party game. One big screen shows a HackNet-style netops console with the Wi-Fi network:
an internet uplink, a row of access points (APs) and the devices hanging off them. Every player's
phone is a controller **and** a device on that network. Routers overload, crash, and the team
has to reroute traffic before the network health hits 0.

## Run it

```bash
npm install
npm start
```

- **Big screen:** open `http://localhost:3000/` on the laptop that's connected to the projector.
- **Phones:** scan the QR code in the lobby (it points to `http://<laptop-LAN-IP>:3000/play`).
- Press **START SHIFT** (or `S`) once everyone has joined.

Requires Node 20+. Optional: `cp .env.example .env` and fill in values.

**Windows:** the first time you run `npm start`, Windows Firewall asks whether Node may accept
connections. Allow it on **private networks**, or phones can't connect. If you clicked "Cancel",
allow `node.exe` under *Windows Security → Firewall → Allow an app through firewall*.

### When phones can't connect (venue Wi-Fi)

Venue Wi-Fi often isolates clients from each other. In order of preference:

1. **Phone hotspot:** connect the laptop and all phones to one phone's hotspot. Restart the
   server so the QR code picks up the new IP.
2. **Tunnel:** `cloudflared tunnel --url http://localhost:3000` (or `ngrok http 3000`), then set
   `PUBLIC_URL=https://<the-tunnel-host>` in `.env` and restart. The QR code now points to the
   tunnel.
3. **Wrong IP in the QR code** (VPN/virtual adapters): the server prints every candidate IP on
   startup. Set `PUBLIC_URL=http://<right-ip>:3000`.
4. **Nothing works:** press `D` for demo mode (bots play) and use the backup video.

### AI Incident Commander

Set `OPENAI_API_KEY` and `OPENAI_MODEL` in `.env`. The server calls the OpenAI Chat Completions
API with a 3 s timeout (`AI_TIMEOUT_MS`). With no key, a timeout or any error, the commander
silently uses the canned lines in `public/screen/commander.js`. The game never waits on the AI and
runs fully offline.

## Keys on the big screen

| Key | Does |
|---|---|
| `S` | Start from the lobby |
| `L` | Skip to the next level (debug / demo) |
| `D` | Demo mode: bots press buttons |
| `K` | Crash a random AP (debug) |
| `E` | Fire a random chaos event (debug) |
| `M` | Mute |
| `Esc` | Back to lobby |

## How it plays

- Each player owns an AP (with more APs than players, some own two and get a **Switch AP** button).
- Phone buttons: **Push Left/Right** (+10% of local traffic to that neighbour, sticky, max 50%),
  **Pull Back** (reset to 0%), **Boost** (+50% capacity for 5 s, 20 s cooldown), **Fix** (tap fast
  to revive a crashed AP, or 10 taps to repair a cut cable next to you).
- Traffic flows **upstream**: devices → their AP → (neighbour AP) → internet uplink.
- Every device has its own demand. Devices **surge** at random (they grow on the map and turn
  yellow/red) and **new devices join** during the level.
- **Move devices from your phone:** your AP's devices are listed as chips (hungriest first,
  bigger text = more traffic). Tap one and the Push buttons turn into **SEND ◀ / SEND ▶** to the
  neighbouring AP; Pull Back becomes Cancel. You can only send devices off an AP you run.
- **Move devices on the big screen:** drag a device onto any AP's column, or click it and then
  click an AP (anything, anywhere: handy for the host and for demos).
- A moved device reconnects (offline for 1 s) and its traffic now lands on the new AP. Moving
  devices off a crashed AP brings them back online.
- An AP above capacity for 3 s crashes for 5 s. Its devices go offline and health drains.
- **Enemies (one rule: FIX zaps them).**
  - Levels 1–3: **mini bots** fly down from the internet, latch onto an AP and eat its
    bandwidth. Tap FIX on that AP to zap them (3–4 taps each).
  - Level 4 is the final boss, **OVERSEER**: a giant robot that docks onto an AP, drains it hard
    and launches droids at the other APs. While it attacks, **everyone's FIX hits it**. Knock it
    down and its droids fall with it, but it comes back stronger. Beat it 3 times to win (no
    timer on this level). Boss HP scales with the number of players.
- The phone shows exact load numbers; the big screen only shows bars and status words. Talk!
- Survive 90 s to clear a level. Health 0% = network down.

## Architecture

```
Phone (/play) ──socket.io──▶ server.js ──socket.io──▶ Screen (/)
  buttons, private view  ◀──  relay only, QR, AI  ◀──  AUTHORITATIVE sim + render
```

- **server.js**: static files, relays messages, assigns player IDs, QR code, AI proxy. No game logic.
  A phone that drops gets 15 s to reconnect before it's removed. The most recent screen to
  connect is the one whose state gets relayed, so keep only one screen tab open.
- **Screen** runs the simulation at 10 Hz and renders at 60 fps. Sends each phone its private
  state 10×/s.
- **Phone** sends inputs, shows `player:state`, vibrates on crash.

### Files and owners

| Owner | Area | Files |
|---|---|---|
| **A** | Server, phone UX, networking, QR/tunnel, haptics | `server.js`, `public/play/*` |
| **B** | Simulation, levels 3–4, chaos events, enemies, role shuffle, difficulty | `public/screen/sim.js`, `levels.js`, `events.js`, `devices.js`, `enemies.js` |
| **C** | Visuals/juice, sound, commander personality, post-incident report | `public/screen/render.js`, `style.css`, `audio.js`, `commander.js` |
| shared | Socket protocol: **change only here, tell the team** | `public/shared/protocol.js` |
| shared | Phase machine, wiring, demo bots, debug keys | `public/screen/main.js` |

```
router-rumble/
├── server.js
├── public/shared/protocol.js   event names, actions, phases, PlayerState typedef
├── public/screen/
│   ├── index.html, style.css   console layout (top bar, commander + log, map, operators)
│   ├── main.js                 sockets, lobby → countdown → playing → levelEnd/gameOver
│   ├── sim.js                  pure sim: createState(), tick(state, dt, inputs), playerView()
│   ├── levels.js               level table (data only)
│   ├── devices.js              device weights + factory (demand lives on devices)
│   ├── enemies.js              mini bots + OVERSEER boss (spawn, flight, zapping)
│   ├── events.js               chaos events (start/each/end hooks)
│   ├── render.js               canvas map, packets, sparks, HUD panels
│   ├── commander.js            line queue, AI requests, canned lines
│   └── audio.js                synthesized SFX stubs
└── public/play/
    ├── index.html, play.css
    └── play.js                 join, controls, private AP view
```

### Tuning (owner B)

- `TUNING` at the top of `sim.js`: overload/crash timings, boost, health drain, player scaling.
- `levels.js`: per-level demand, waves, spikes, event schedule, tutorial prompts.
- `sim.js` is pure (no DOM, seeded RNG), so you can run it in Node to balance levels:

```js
import { createState, tick } from './public/screen/sim.js';
import { LEVELS } from './public/screen/levels.js';
const s = createState({ level: LEVELS[0], players: [{ playerId: 'a', name: 'A' }, { playerId: 'b', name: 'B' }] });
while (!s.result) tick(s, 0.1, []);
console.log(s.result, s.health, s.crashes);
```

### Not done yet (the Codex phase)

- Levels 3–4 are drafts in `levels.js` (they load and play, but are untuned).
- Role shuffle (from the brief) is not implemented.
- Real sound, art polish, TTS for the commander.

## Rules

- Never commit `.env` or API keys. Keys stay on the server.
- Original assets only: everything is drawn in code, sounds are synthesized.
