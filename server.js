'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 12000,
  pingInterval: 10000,
});

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
}));

const PORT = Number(process.env.PORT || 3000);
const GAME_MS = Number(process.env.GAME_MS || 90000);
const COUNTDOWN_MS = Number(process.env.COUNTDOWN_MS || 3200);
const TICK_MS = 1000 / 30;
const BROADCAST_EVERY = 2;
const MAX_PLAYERS = 8;
const ARENA = { width: 1280, height: 800 };
const CORE = { x: 640, y: 400, radius: 72 };
const PLAYER_RADIUS = 21;
const SHARD_RADIUS = 10;
const POWER_RADIUS = 13;
const MAX_CARGO = 4;
const NORMAL_SHARDS = 18;
const BASE_SPEED = 292;
const PULSE_RADIUS = 132;
const PULSE_COOLDOWN_MS = 6000;
const BOOST_MS = 6500;
const SHIELD_MS = 10000;
const RECONNECT_GRACE_MS = 30000;
const EMPTY_ROOM_TTL_MS = 120000;
const ROOM_MAX_AGE_MS = 4 * 60 * 60 * 1000;

const COLORS = ['#61e8ff', '#ff65dc', '#ffe274', '#77ff9a', '#a98bff', '#ff8b62', '#67f2ca', '#f4f7ff'];
const OBSTACLES = [
  { x: 430, y: 250, r: 54 },
  { x: 850, y: 250, r: 54 },
  { x: 430, y: 550, r: 54 },
  { x: 850, y: 550, r: 54 },
  { x: 640, y: 170, r: 38 },
  { x: 640, y: 630, r: 38 },
];
const RIFT_PORTALS = [
  { x: 160, y: 145 }, { x: 1120, y: 145 }, { x: 160, y: 655 }, { x: 1120, y: 655 },
];

const rooms = new Map();

const now = () => Date.now();
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rand = (min, max) => min + Math.random() * (max - min);

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

function uid(prefix = '') {
  return `${prefix}${crypto.randomBytes(6).toString('hex')}`;
}

function cleanName(value) {
  return String(value || 'Runner').trim().replace(/\s+/g, ' ').slice(0, 18) || 'Runner';
}

function cleanToken(value) {
  const token = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{12,100}$/.test(token) ? token : uid('p_');
}

function connectedPlayers(room) {
  return Array.from(room.players.values()).filter(p => p.connected);
}

function activePlayers(room) {
  return Array.from(room.players.values()).filter(p => p.connected && !p.spectator);
}

function ensureHost(room) {
  const current = room.players.get(room.hostToken);
  if (current?.connected) return;
  const next = connectedPlayers(room)[0];
  room.hostToken = next ? next.token : null;
}

function safePoint(x, y, padding = PLAYER_RADIUS) {
  x = clamp(x, padding, ARENA.width - padding);
  y = clamp(y, padding, ARENA.height - padding);
  for (const obstacle of OBSTACLES) {
    const dx = x - obstacle.x;
    const dy = y - obstacle.y;
    const d = Math.hypot(dx, dy);
    const min = obstacle.r + padding + 8;
    if (d < min) {
      const nx = d > 0 ? dx / d : 1;
      const ny = d > 0 ? dy / d : 0;
      x = obstacle.x + nx * min;
      y = obstacle.y + ny * min;
    }
  }
  return { x: clamp(x, padding, ARENA.width - padding), y: clamp(y, padding, ARENA.height - padding) };
}

function spawnPoint(index = 0) {
  const angle = (index / Math.max(1, MAX_PLAYERS)) * Math.PI * 2 - Math.PI / 2;
  const radius = 300;
  return safePoint(CORE.x + Math.cos(angle) * radius, CORE.y + Math.sin(angle) * radius);
}

function randomArenaPoint(avoidCore = 145) {
  for (let tries = 0; tries < 60; tries++) {
    const p = safePoint(rand(68, ARENA.width - 68), rand(68, ARENA.height - 68), SHARD_RADIUS);
    if (Math.hypot(p.x - CORE.x, p.y - CORE.y) < avoidCore) continue;
    if (OBSTACLES.some(o => Math.hypot(p.x - o.x, p.y - o.y) < o.r + 42)) continue;
    return p;
  }
  return { x: 90, y: 90 };
}

function makeShard(type = 'normal', position = null) {
  const p = position || randomArenaPoint();
  return {
    id: uid('s_'),
    x: p.x,
    y: p.y,
    type,
    value: type === 'prism' ? 3 : 1,
    expiresAt: type === 'prism' ? now() + 13000 : 0,
  };
}

function makePowerup(type) {
  const p = randomArenaPoint(170);
  return { id: uid('u_'), x: p.x, y: p.y, type, expiresAt: now() + 18000 };
}

function resolveObstacleCollision(player) {
  for (const obstacle of OBSTACLES) {
    const dx = player.x - obstacle.x;
    const dy = player.y - obstacle.y;
    const d = Math.hypot(dx, dy);
    const min = PLAYER_RADIUS + obstacle.r + 3;
    if (d < min) {
      const nx = d > 0.001 ? dx / d : 1;
      const ny = d > 0.001 ? dy / d : 0;
      player.x = obstacle.x + nx * min;
      player.y = obstacle.y + ny * min;
    }
  }
  player.x = clamp(player.x, PLAYER_RADIUS, ARENA.width - PLAYER_RADIUS);
  player.y = clamp(player.y, PLAYER_RADIUS, ARENA.height - PLAYER_RADIUS);
}

function publicRoom(room) {
  const t = now();
  const host = room.players.get(room.hostToken);
  return {
    code: room.code,
    state: room.state,
    round: room.round,
    hostId: host?.id || null,
    serverNow: t,
    startsAt: room.startsAt,
    endsAt: room.endsAt,
    remaining: ['countdown', 'playing'].includes(room.state) ? Math.max(0, room.endsAt - t) : 0,
    countdownRemaining: room.state === 'countdown' ? Math.max(0, room.startsAt - t) : 0,
    arena: ARENA,
    core: CORE,
    obstacles: OBSTACLES,
    riftPortals: RIFT_PORTALS,
    riftPortalIndex: room.riftPortalIndex,
    riftActiveUntil: room.riftActiveUntil,
    nextRiftAt: room.nextRiftAt,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      x: p.x,
      y: p.y,
      score: p.score,
      cargoCount: p.cargo.length,
      cargoValue: p.cargo.reduce((sum, item) => sum + item.value, 0),
      connected: p.connected,
      spectator: p.spectator,
      pulseReadyAt: p.pulseReadyAt,
      boostUntil: p.boostUntil,
      shieldUntil: p.shieldUntil,
      stats: p.stats,
    })),
    shards: room.shards.map(s => ({ id: s.id, x: s.x, y: s.y, type: s.type, value: s.value, expiresAt: s.expiresAt })),
    powerups: room.powerups.map(p => ({ ...p })),
    winnerIds: room.winnerIds,
  };
}

function emitRoom(room, event = 'room') {
  io.to(room.code).emit(event, publicRoom(room));
}

function feed(room, message, kind = 'info') {
  io.to(room.code).emit('feed', { id: uid('f_'), message, kind, at: now() });
}

function createRoom(socket, name, token) {
  let code;
  do code = roomCode(); while (rooms.has(code));
  const room = {
    code,
    createdAt: now(),
    lastActiveAt: now(),
    hostToken: token,
    state: 'lobby',
    round: 0,
    players: new Map(),
    shards: [],
    powerups: [],
    startsAt: 0,
    endsAt: 0,
    nextRiftAt: 0,
    nextPowerAt: 0,
    riftPortalIndex: -1,
    riftActiveUntil: 0,
    winnerIds: [],
    timer: null,
    tickCount: 0,
  };
  rooms.set(code, room);
  addOrReconnectPlayer(room, socket, name, token, false);
  return room;
}

function addOrReconnectPlayer(room, socket, name, token, joiningExisting = true) {
  let player = room.players.get(token);
  if (player) {
    player.socketId = socket.id;
    player.connected = true;
    player.name = cleanName(name || player.name);
    player.input = { up: false, down: false, left: false, right: false };
    clearTimeout(player.removeTimer);
    player.removeTimer = null;
  } else {
    if (room.players.size >= MAX_PLAYERS) throw new Error('This room already has 8 players.');
    const p = spawnPoint(room.players.size);
    const spectator = joiningExisting && ['countdown', 'playing'].includes(room.state);
    player = {
      id: uid('r_'),
      token,
      socketId: socket.id,
      name: cleanName(name),
      color: COLORS[room.players.size % COLORS.length],
      x: p.x,
      y: p.y,
      input: { up: false, down: false, left: false, right: false },
      score: 0,
      cargo: [],
      pulseReadyAt: 0,
      boostUntil: 0,
      shieldUntil: 0,
      connected: true,
      spectator,
      removeTimer: null,
      stats: { pickups: 0, deposits: 0, pulseHits: 0, prisms: 0, bonuses: 0, banked: 0, cargoLost: 0, shieldsBroken: 0, maxCargo: 0 },
    };
    room.players.set(token, player);
  }

  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerToken = token;
  room.lastActiveAt = now();
  ensureHost(room);
  return player;
}

function refillNormalShards(room) {
  const normalCount = room.shards.filter(s => s.type === 'normal').length;
  for (let i = normalCount; i < NORMAL_SHARDS; i++) room.shards.push(makeShard('normal'));
}

function prepareRound(room) {
  room.round += 1;
  room.shards = [];
  room.powerups = [];
  room.winnerIds = [];
  room.riftPortalIndex = -1;
  room.riftActiveUntil = 0;
  let spawnIndex = 0;
  for (const player of room.players.values()) {
    player.score = 0;
    player.cargo = [];
    player.pulseReadyAt = 0;
    player.boostUntil = 0;
    player.shieldUntil = 0;
    player.input = { up: false, down: false, left: false, right: false };
    player.stats = { pickups: 0, deposits: 0, pulseHits: 0, prisms: 0, bonuses: 0, banked: 0, cargoLost: 0, shieldsBroken: 0, maxCargo: 0 };
    player.spectator = !player.connected;
    if (player.connected) {
      const p = spawnPoint(spawnIndex++);
      player.x = p.x;
      player.y = p.y;
    }
  }
  refillNormalShards(room);
}

function startGame(room) {
  if (room.timer) clearInterval(room.timer);
  if (connectedPlayers(room).length < 2) throw new Error('At least 2 connected players are required.');
  prepareRound(room);
  room.state = 'countdown';
  room.startsAt = now() + COUNTDOWN_MS;
  room.endsAt = room.startsAt + GAME_MS;
  room.nextRiftAt = room.startsAt + 14000;
  room.nextPowerAt = room.startsAt + 8000;
  room.tickCount = 0;
  emitRoom(room, 'roundCountdown');
  room.timer = setInterval(() => tick(room), TICK_MS);
}

function endGame(room) {
  if (room.timer) clearInterval(room.timer);
  room.timer = null;
  room.state = 'ended';
  room.startsAt = 0;
  room.endsAt = 0;
  const candidates = Array.from(room.players.values()).filter(p => !p.spectator);
  const best = candidates.length ? Math.max(...candidates.map(p => p.score)) : 0;
  room.winnerIds = candidates.filter(p => p.score === best).map(p => p.id);
  emitRoom(room, 'roundEnded');
  if (room.winnerIds.length === 1) {
    const winner = candidates.find(p => p.id === room.winnerIds[0]);
    if (winner) feed(room, `${winner.name} wins Round ${room.round} with ${winner.score} points.`, 'win');
  } else if (room.winnerIds.length > 1) {
    feed(room, `Round ${room.round} ends in a ${room.winnerIds.length}-way tie.`, 'win');
  }
}

function dropCargoItem(room, player, item, angle = Math.random() * Math.PI * 2) {
  const radius = rand(46, 76);
  const p = safePoint(player.x + Math.cos(angle) * radius, player.y + Math.sin(angle) * radius, SHARD_RADIUS);
  room.shards.push({
    id: uid('d_'),
    x: p.x,
    y: p.y,
    type: item.type,
    value: item.value,
    expiresAt: item.type === 'prism' ? now() + 11000 : 0,
  });
}

function dropAllCargo(room, player) {
  let i = 0;
  while (player.cargo.length) {
    const item = player.cargo.pop();
    dropCargoItem(room, player, item, (Math.PI * 2 * i++) / 5 + Math.random() * 0.3);
  }
}

function movePlayer(player, dt, t) {
  const ix = (player.input.right ? 1 : 0) - (player.input.left ? 1 : 0);
  const iy = (player.input.down ? 1 : 0) - (player.input.up ? 1 : 0);
  const magnitude = Math.hypot(ix, iy);
  if (!magnitude) return;
  const loadPenalty = 1 - Math.min(MAX_CARGO, player.cargo.length) * 0.055;
  const boost = player.boostUntil > t ? 1.38 : 1;
  const speed = BASE_SPEED * loadPenalty * boost;
  player.x += (ix / magnitude) * speed * dt;
  player.y += (iy / magnitude) * speed * dt;
  resolveObstacleCollision(player);
}

function handleShardPickup(room, player) {
  if (player.cargo.length >= MAX_CARGO) return;
  for (let i = room.shards.length - 1; i >= 0; i--) {
    const shard = room.shards[i];
    if (dist(player, shard) <= PLAYER_RADIUS + SHARD_RADIUS + 5) {
      room.shards.splice(i, 1);
      player.cargo.push({ type: shard.type, value: shard.value });
      player.stats.pickups += 1;
      player.stats.maxCargo = Math.max(player.stats.maxCargo || 0, player.cargo.length);
      io.to(room.code).emit('eventFx', { type: shard.type === 'prism' ? 'prismPickup' : 'pickup', x: player.x, y: player.y, playerId: player.id });
      if (shard.type === 'prism') feed(room, `${player.name} grabbed a 3-point Prism.`, 'prism');
      return;
    }
  }
}

function handlePowerupPickup(room, player, t) {
  for (let i = room.powerups.length - 1; i >= 0; i--) {
    const power = room.powerups[i];
    if (dist(player, power) <= PLAYER_RADIUS + POWER_RADIUS + 5) {
      room.powerups.splice(i, 1);
      if (power.type === 'boost') player.boostUntil = t + BOOST_MS;
      if (power.type === 'shield') player.shieldUntil = t + SHIELD_MS;
      io.to(room.code).emit('eventFx', { type: 'powerup', power: power.type, x: player.x, y: player.y, playerId: player.id });
      feed(room, `${player.name} activated ${power.type === 'boost' ? 'Overdrive' : 'a Pulse Shield'}.`, 'power');
      return;
    }
  }
}

function handleDeposit(room, player) {
  if (!player.cargo.length) return;
  if (Math.hypot(player.x - CORE.x, player.y - CORE.y) > CORE.radius + PLAYER_RADIUS - 2) return;
  const base = player.cargo.reduce((sum, item) => sum + item.value, 0);
  const prismCount = player.cargo.filter(item => item.type === 'prism').length;
  const bonus = player.cargo.length === MAX_CARGO ? 2 : 0;
  const total = base + bonus;
  player.score += total;
  player.stats.deposits += 1;
  player.stats.prisms += prismCount;
  player.stats.banked = (player.stats.banked || 0) + total;
  if (bonus) player.stats.bonuses += 1;
  player.cargo = [];
  refillNormalShards(room);
  io.to(room.code).emit('eventFx', { type: 'deposit', x: CORE.x, y: CORE.y, playerId: player.id, amount: total, bonus, base, prismCount });
  if (total >= 5 || bonus) feed(room, `${player.name} banked ${total} points${bonus ? ' with a +2 full-load bonus' : ''}.`, 'score');
}

function openRift(room, t) {
  let index = Math.floor(Math.random() * RIFT_PORTALS.length);
  if (RIFT_PORTALS.length > 1 && index === room.riftPortalIndex) index = (index + 1) % RIFT_PORTALS.length;
  room.riftPortalIndex = index;
  room.riftActiveUntil = t + 7000;
  const portal = RIFT_PORTALS[index];
  room.shards.push(makeShard('prism', { x: portal.x, y: portal.y }));
  room.nextRiftAt = t + 23000;
  io.to(room.code).emit('eventFx', { type: 'rift', x: portal.x, y: portal.y, portalIndex: index });
  feed(room, 'PRISM RIFT OPEN — the gold Prism is worth 3 points!', 'prism');
}

function spawnPowerup(room, t) {
  const type = Math.random() < 0.5 ? 'boost' : 'shield';
  room.powerups.push(makePowerup(type));
  room.nextPowerAt = t + 14500;
}

function tick(room) {
  const t = now();
  room.lastActiveAt = t;

  if (room.state === 'countdown') {
    if (t >= room.startsAt) {
      room.state = 'playing';
      feed(room, `Round ${room.round} is live. Bank the most energy before time runs out.`, 'start');
      emitRoom(room, 'roundStarted');
    }
  }

  if (room.state === 'playing') {
    if (t >= room.endsAt) {
      endGame(room);
      return;
    }

    room.shards = room.shards.filter(s => !s.expiresAt || s.expiresAt > t);
    room.powerups = room.powerups.filter(p => p.expiresAt > t);

    if (t >= room.nextRiftAt) openRift(room, t);
    if (t >= room.nextPowerAt && room.powerups.length < 2) spawnPowerup(room, t);

    const dt = TICK_MS / 1000;
    for (const player of room.players.values()) {
      if (!player.connected || player.spectator) continue;
      movePlayer(player, dt, t);
      handleShardPickup(room, player);
      handlePowerupPickup(room, player, t);
      handleDeposit(room, player);
    }
  }

  room.tickCount += 1;
  if (room.tickCount % BROADCAST_EVERY === 0) emitRoom(room, 'state');
}

function getContext(socket) {
  const room = rooms.get(socket.data.roomCode);
  const player = room?.players.get(socket.data.playerToken);
  return { room, player };
}

function leaveCurrentRoom(socket, remove = true) {
  const { room, player } = getContext(socket);
  if (!room || !player) return;
  if (room.state === 'playing') dropAllCargo(room, player);
  if (remove) room.players.delete(player.token);
  else {
    player.connected = false;
    player.input = { up: false, down: false, left: false, right: false };
  }
  socket.leave(room.code);
  socket.data.roomCode = null;
  socket.data.playerToken = null;
  ensureHost(room);
  emitRoom(room, 'room');
}

io.on('connection', socket => {
  socket.on('createRoom', ({ name, playerToken } = {}, ack = () => {}) => {
    try {
      if (socket.data.roomCode) leaveCurrentRoom(socket, true);
      const token = cleanToken(playerToken);
      const room = createRoom(socket, name, token);
      const player = room.players.get(token);
      ack({ ok: true, room: publicRoom(room), playerId: player.id, playerToken: token });
      emitRoom(room, 'room');
    } catch (error) {
      ack({ ok: false, error: error.message || 'Could not create room.' });
    }
  });

  socket.on('joinRoom', ({ code, name, playerToken } = {}, ack = () => {}) => {
    try {
      const cleanCode = String(code || '').trim().toUpperCase().slice(0, 6);
      const room = rooms.get(cleanCode);
      if (!room) throw new Error('Room not found. Check the 6-character code.');
      const token = cleanToken(playerToken);
      if (socket.data.roomCode && socket.data.roomCode !== cleanCode) leaveCurrentRoom(socket, true);
      const player = addOrReconnectPlayer(room, socket, name, token, true);
      ack({ ok: true, room: publicRoom(room), playerId: player.id, playerToken: token, spectator: player.spectator });
      emitRoom(room, 'room');
      if (player.spectator) feed(room, `${player.name} joined as a spectator and will race next round.`, 'info');
      else feed(room, `${player.name} joined the room.`, 'join');
    } catch (error) {
      ack({ ok: false, error: error.message || 'Could not join room.' });
    }
  });

  socket.on('input', input => {
    const { room, player } = getContext(socket);
    if (!room || !player || !player.connected || player.spectator || !['countdown', 'playing'].includes(room.state)) return;
    const src = input || {};
    player.input = {
      up: !!src.up,
      down: !!src.down,
      left: !!src.left,
      right: !!src.right,
    };
  });

  socket.on('pulse', (_data, ack = () => {}) => {
    const { room, player } = getContext(socket);
    const t = now();
    if (!room || !player || room.state !== 'playing' || player.spectator || !player.connected) return ack({ ok: false });
    if (t < player.pulseReadyAt) return ack({ ok: false, cooldown: player.pulseReadyAt - t });
    player.pulseReadyAt = t + PULSE_COOLDOWN_MS;
    const targets = [];
    let meaningfulHits = 0;

    for (const rival of room.players.values()) {
      if (rival.id === player.id || !rival.connected || rival.spectator) continue;
      const d = dist(player, rival);
      if (d > PULSE_RADIUS) continue;
      let result = 'push';
      if (rival.shieldUntil > t) {
        rival.shieldUntil = 0;
        result = 'shield';
        meaningfulHits += 1;
        player.stats.shieldsBroken = (player.stats.shieldsBroken || 0) + 1;
        feed(room, `${player.name} shattered ${rival.name}'s Pulse Shield.`, 'hit');
      } else if (rival.cargo.length) {
        let bestIndex = 0;
        for (let i = 1; i < rival.cargo.length; i++) {
          if (rival.cargo[i].value > rival.cargo[bestIndex].value) bestIndex = i;
        }
        const [item] = rival.cargo.splice(bestIndex, 1);
        rival.stats.cargoLost = (rival.stats.cargoLost || 0) + item.value;
        dropCargoItem(room, rival, item);
        result = item.type === 'prism' ? 'prismDrop' : 'drop';
        meaningfulHits += 1;
        feed(room, `${player.name} knocked cargo loose from ${rival.name}.`, 'hit');
      }
      const dx = rival.x - player.x;
      const dy = rival.y - player.y;
      const mag = Math.hypot(dx, dy) || 1;
      rival.x += (dx / mag) * 36;
      rival.y += (dy / mag) * 36;
      resolveObstacleCollision(rival);
      targets.push({ id: rival.id, result });
    }

    player.stats.pulseHits += meaningfulHits;
    io.to(room.code).emit('eventFx', { type: 'pulse', x: player.x, y: player.y, playerId: player.id, targets });
    ack({ ok: true, hits: meaningfulHits });
  });

  socket.on('startGame', (_data, ack = () => {}) => {
    try {
      const { room, player } = getContext(socket);
      if (!room || !player) throw new Error('Room no longer exists.');
      if (room.hostToken !== player.token) throw new Error('Only the room host can start a round.');
      if (!['lobby', 'ended'].includes(room.state)) throw new Error('A round is already starting.');
      startGame(room);
      ack({ ok: true });
    } catch (error) {
      ack({ ok: false, error: error.message || 'Could not start round.' });
    }
  });

  socket.on('leaveRoom', (_data, ack = () => {}) => {
    leaveCurrentRoom(socket, true);
    ack({ ok: true });
  });

  socket.on('pingProbe', (sentAt, ack = () => {}) => ack({ sentAt, serverNow: now() }));

  socket.on('disconnect', () => {
    const { room, player } = getContext(socket);
    if (!room || !player) return;
    if (room.state === 'playing') dropAllCargo(room, player);
    player.connected = false;
    player.input = { up: false, down: false, left: false, right: false };
    ensureHost(room);
    emitRoom(room, 'room');
    player.removeTimer = setTimeout(() => {
      if (!player.connected && room.players.get(player.token) === player) {
        room.players.delete(player.token);
        ensureHost(room);
        emitRoom(room, 'room');
      }
    }, RECONNECT_GRACE_MS);
  });
});

app.get('/health', (_req, res) => {
  const players = Array.from(rooms.values()).reduce((sum, room) => sum + connectedPlayers(room).length, 0);
  res.json({ ok: true, rooms: rooms.size, players, version: '3.0.0' });
});

app.get('/api/qr', async (req, res) => {
  try {
    const text = String(req.query.text || '').slice(0, 500);
    if (!/^https?:\/\//i.test(text)) return res.status(400).send('Invalid URL');
    const png = await QRCode.toBuffer(text, {
      type: 'png', width: 260, margin: 1,
      color: { dark: '#0b1020', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    });
    res.type('png').set('Cache-Control', 'no-store').send(png);
  } catch (error) {
    res.status(500).send('QR generation failed');
  }
});

setInterval(() => {
  const t = now();
  for (const [code, room] of rooms) {
    const noPlayers = connectedPlayers(room).length === 0;
    if ((noPlayers && t - room.lastActiveAt > EMPTY_ROOM_TTL_MS) || t - room.createdAt > ROOM_MAX_AGE_MS) {
      if (room.timer) clearInterval(room.timer);
      rooms.delete(code);
    }
  }
}, 30000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rift Runners: Nexus listening on http://0.0.0.0:${PORT}`);
});
