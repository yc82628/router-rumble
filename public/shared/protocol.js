// Router Rumble socket protocol: the single source of truth.
// Imported by server.js (Node), the screen and the phone (browser ES modules).
// Change event names or payloads ONLY here, and tell the team.

// Rooms: every big screen hosts its own game in a room with a 4-letter code (shown on screen and
// carried by the QR code as /play?room=CODE). Phones join a room by code. All events below are
// scoped to the sender's room by the server.

export const EV = Object.freeze({
  // screen → server  { roomCode? }   roomCode = reclaim my room after a reload/reconnect.
  //                  ack → { roomCode, joinUrl, qr, maxPlayers, ai, playerIds } | { error }
  SCREEN_HELLO: 'screen:hello',
  // phone → server   { room, name, playerId? }   playerId = rejoin after a reload/reconnect.
  //                  ack → { playerId, name, room, hostOnline } | { error }
  PLAYER_JOIN: 'player:join',
  // server → screen  { playerId, name }
  PLAYER_JOINED: 'player:joined',
  // server → screen  { playerId }   (sent after a short grace period, so a phone that locks briefly doesn't vanish)
  PLAYER_LEFT: 'player:left',
  // phone → server   { action, deviceId?, dir? }  →  server → screen { playerId, action, deviceId?, dir? }
  //                  (server stamps playerId; deviceId/dir only for moveDevice)
  PLAYER_INPUT: 'player:input',
  // screen → server   PlayerState[]   one batch per tick for the whole room
  PLAYER_STATES: 'player:states',
  // server → one phone   PlayerState (see below), split out of the batch
  PLAYER_STATE: 'player:state',
  // server → phones   { online }   the room's big screen dropped / came back
  HOST_STATUS: 'host:status',
  // server → phones   { reason }   the room is gone (host left for good); go back to the join form
  ROOM_CLOSED: 'room:closed',
  // screen → server → all phones  { phase, level, levelName?, result? }
  GAME_PHASE: 'game:phase',
  // screen → server  { requestId, context }
  AI_REQUEST: 'ai:request',
  // server → screen  { requestId, text }   text === null → use a canned line
  AI_LINE: 'ai:line',
});

export const ACTIONS = Object.freeze({
  PUSH_LEFT: 'pushLeft',
  PUSH_RIGHT: 'pushRight',
  PULL_BACK: 'pullBack',
  BOOST: 'boost',
  FIX: 'fix',
  SWITCH_ROUTER: 'switchRouter',
  // Reconnect a device to another AP.
  //   phone:  { deviceId, dir: 'left'|'right' }  only devices on an AP the player runs, to a neighbour
  //   screen: { deviceId, routerId }             the big screen's mouse can move anything anywhere
  MOVE_DEVICE: 'moveDevice',
});
export const ACTION_LIST = Object.freeze(Object.values(ACTIONS));

export const PHASES = Object.freeze({
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  LEVEL_END: 'levelEnd',
  GAME_OVER: 'gameOver',
});

export const STATUS = Object.freeze({ OK: 'ok', WARN: 'warn', CRASHED: 'crashed' });

/**
 * PlayerState: what one phone sees about its own router (built by playerView() in screen/sim.js).
 * @typedef {object} PlayerState
 * @property {string} playerId
 * @property {string|null} routerId
 * @property {string} routerName      e.g. "AP-2"
 * @property {number} routerSlot      1-based index among the routers this player owns
 * @property {number} ownedCount      how many routers this player owns (>1 → show Switch)
 * @property {number} load            current load (rounded)
 * @property {number} capacity        effective capacity incl. boost (rounded)
 * @property {number} sL              share forwarded left, 0..0.5
 * @property {number} sR              share forwarded right, 0..0.5
 * @property {'ok'|'warn'|'crashed'} status
 * @property {number} boostReadyIn    seconds until Boost can be used again (0 = ready)
 * @property {number} boostLeft       seconds of active boost remaining
 * @property {number} crashLeft       seconds until a crashed router comes back
 * @property {number} overload        0..1, how close an overloaded router is to crashing
 * @property {{name:string, owners:string[], blocked:boolean}|null} left
 * @property {{name:string, owners:string[], blocked:boolean}|null} right
 * @property {'crash'|'bot'|'cable'|'boss'|null} fix   what tapping Fix would do right now
 * @property {number} botHp           zaps needed to clear the bots latched onto this AP
 * @property {{name:string, hp:number, maxHp:number, here:boolean}|false} boss   boss attacking?
 * @property {number} cableTaps       progress on a cut cable next to this router
 * @property {number} cableNeeded
 * @property {string} [event]         text of a chaos event affecting this router
 * @property {Array<{id:string, kind:string, label:string, demand:number, surging:boolean,
 *   isNew:boolean, reconnecting:boolean, mine:boolean}>} devices   devices on this AP, hungriest first
 * @property {number} health          team network health 0..100
 * @property {number|null} timeLeft   seconds left in the level (null on the boss level: no timer)
 */
