const express = require("express");
const http = require("http");
const path = require("path");
const { randomUUID } = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const TICK_RATE = 30;
const PLAYER_MAX_HP = 100;
const PLAYER_SPEED = 2.7;
const PLAYER_TURN_SPEED = 2.8;
const PLAYER_RADIUS = 0.22;
const PLAYER_RESPAWN_MS = 3000;
const WEAPON_DAMAGE = 40;
const WEAPON_COOLDOWN_MS = 320;
const WEAPON_RANGE = 8;
const WEAPON_HIT_ARC = 0.095;
const ENEMY_MAX_HP = 100;
const ENEMY_SPEED = 1.15;
const ENEMY_RADIUS = 0.24;
const ENEMY_AGGRO_RANGE = 8;
const ENEMY_ATTACK_RANGE = 0.8;
const ENEMY_ATTACK_DAMAGE = 14;
const ENEMY_ATTACK_COOLDOWN_MS = 900;
const DOOR_OPEN_SPEED = 0.33;
const ROUND_RESET_MS = 9000;
const ROOM_IDLE_CLEANUP_MS = 20 * 60 * 1000;
const ROOM_MAX_PLAYERS = 8;

const BASE_MAP = [
  "###################",
  "#S....#.......E..D#",
  "#.##.#.#####.###..#",
  "#....#.....#...#..#",
  "###.#####.#.#.#.###",
  "#...#...#.#.#.#...#",
  "#.#.#.#.#.#.#.###.#",
  "#.#...#...#...#...#",
  "#.#####.#####.#.#.#",
  "#.....#.....#.#.#.#",
  "#.###.#####.#.#.#.#",
  "#...#.....#.#...#.#",
  "###.#####.#.#####.#",
  "#E........#......S#",
  "###################"
];

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }));

function parseMap() {
  const grid = [];
  const spawnPoints = [];
  const enemySpawns = [];
  let door = null;

  for (let y = 0; y < BASE_MAP.length; y += 1) {
    const row = BASE_MAP[y].split("");
    for (let x = 0; x < row.length; x += 1) {
      const tile = row[x];
      if (tile === "S") {
        spawnPoints.push({ x: x + 0.5, y: y + 0.5 });
        row[x] = ".";
      } else if (tile === "E") {
        enemySpawns.push({ x: x + 0.5, y: y + 0.5 });
        row[x] = ".";
      } else if (tile === "D") {
        door = { x, y, progress: 0 };
        row[x] = ".";
      }
    }
    grid.push(row);
  }

  if (!door) {
    throw new Error("Map is missing a door tile.");
  }
  if (spawnPoints.length === 0) {
    spawnPoints.push({ x: 1.5, y: 1.5 });
  }

  return {
    width: grid[0].length,
    height: grid.length,
    grid,
    spawnPoints,
    enemySpawns,
    door
  };
}

function randomCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function generateRoomCode() {
  let attempts = 0;
  while (attempts < 1000) {
    const code = randomCode();
    if (!rooms.has(code)) {
      return code;
    }
    attempts += 1;
  }
  throw new Error("Failed to generate room code.");
}

function normalizeAngle(angle) {
  let next = angle;
  while (next > Math.PI) {
    next -= Math.PI * 2;
  }
  while (next < -Math.PI) {
    next += Math.PI * 2;
  }
  return next;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distance(aX, aY, bX, bY) {
  return Math.hypot(aX - bX, aY - bY);
}

function sanitizeName(name) {
  if (typeof name !== "string") {
    return "Player";
  }
  const cleaned = name.trim().replace(/[^\w \-]/g, "").slice(0, 18);
  return cleaned || "Player";
}

function sendMessage(ws, payload) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function createRoom(code) {
  const map = parseMap();
  const room = {
    code,
    map,
    players: new Map(),
    enemies: new Map(),
    winnerId: null,
    winnerAt: 0,
    createdAt: Date.now(),
    lastActiveAt: Date.now()
  };

  map.enemySpawns.forEach((spawn) => {
    const enemy = {
      id: randomUUID(),
      x: spawn.x,
      y: spawn.y,
      hp: ENEMY_MAX_HP,
      alive: true,
      nextAttackAt: 0,
      hitFlashUntil: 0,
      wanderAngle: Math.random() * Math.PI * 2,
      wanderUntil: 0
    };
    room.enemies.set(enemy.id, enemy);
  });

  return room;
}

function pickSpawn(room) {
  const candidates = [...room.map.spawnPoints];
  if (candidates.length === 0) {
    return { x: 1.5, y: 1.5 };
  }
  for (let i = 0; i < 8; i += 1) {
    const choice = candidates[Math.floor(Math.random() * candidates.length)];
    const crowded = [...room.players.values()].some((player) => distance(choice.x, choice.y, player.x, player.y) < 1.1);
    if (!crowded) {
      return choice;
    }
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function mapPayload(room) {
  return {
    width: room.map.width,
    height: room.map.height,
    rows: room.map.grid.map((row) => row.join("")),
    door: { x: room.map.door.x, y: room.map.door.y }
  };
}

function addPlayer(room, ws, session, name) {
  const spawn = pickSpawn(room);
  const player = {
    id: session.id,
    ws,
    name: sanitizeName(name),
    x: spawn.x,
    y: spawn.y,
    angle: 0,
    hp: PLAYER_MAX_HP,
    alive: true,
    kills: 0,
    deaths: 0,
    lastShotAt: 0,
    lastDamagedAt: 0,
    respawnAt: 0,
    pendingTurn: 0,
    input: {
      forward: 0,
      strafe: 0,
      turn: 0,
      fire: false
    }
  };
  room.players.set(player.id, player);
  room.lastActiveAt = Date.now();

  session.roomCode = room.code;
  session.name = player.name;
  return player;
}

function removePlayer(session) {
  if (!session.roomCode) {
    return;
  }
  const room = rooms.get(session.roomCode);
  if (!room) {
    session.roomCode = null;
    return;
  }
  room.players.delete(session.id);
  room.lastActiveAt = Date.now();
  if (room.winnerId === session.id) {
    room.winnerId = null;
    room.winnerAt = 0;
  }
  if (room.players.size === 0) {
    rooms.delete(room.code);
  } else {
    broadcastState(room, Date.now());
  }
  session.roomCode = null;
}

function isTileBlocked(room, tileX, tileY) {
  if (tileX < 0 || tileY < 0 || tileX >= room.map.width || tileY >= room.map.height) {
    return true;
  }
  if (tileX === room.map.door.x && tileY === room.map.door.y && room.map.door.progress < 1) {
    return true;
  }
  return room.map.grid[tileY][tileX] === "#";
}

function isBlocked(room, x, y, radius) {
  const points = [
    [x, y],
    [x + radius, y],
    [x - radius, y],
    [x, y + radius],
    [x, y - radius],
    [x + radius, y + radius],
    [x - radius, y + radius],
    [x + radius, y - radius],
    [x - radius, y - radius]
  ];
  return points.some(([sx, sy]) => isTileBlocked(room, Math.floor(sx), Math.floor(sy)));
}

function tryMove(entity, room, stepX, stepY, radius) {
  const nextX = entity.x + stepX;
  if (!isBlocked(room, nextX, entity.y, radius)) {
    entity.x = nextX;
  }

  const nextY = entity.y + stepY;
  if (!isBlocked(room, entity.x, nextY, radius)) {
    entity.y = nextY;
  }
}

function hasLineOfSight(room, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.01) {
    return true;
  }
  const steps = Math.ceil(dist / 0.05);
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const sx = x1 + dx * t;
    const sy = y1 + dy * t;
    if (isTileBlocked(room, Math.floor(sx), Math.floor(sy))) {
      return false;
    }
  }
  return true;
}

function fireWeapon(room, player, now) {
  if (!player.alive || room.winnerId) {
    return;
  }
  let closestEnemy = null;
  let closestDistance = Infinity;
  for (const enemy of room.enemies.values()) {
    if (!enemy.alive) {
      continue;
    }
    const dx = enemy.x - player.x;
    const dy = enemy.y - player.y;
    const dist = Math.hypot(dx, dy);
    if (dist > WEAPON_RANGE) {
      continue;
    }
    const targetAngle = Math.atan2(dy, dx);
    const delta = normalizeAngle(targetAngle - player.angle);
    if (Math.abs(delta) > WEAPON_HIT_ARC) {
      continue;
    }
    if (!hasLineOfSight(room, player.x, player.y, enemy.x, enemy.y)) {
      continue;
    }
    if (dist < closestDistance) {
      closestDistance = dist;
      closestEnemy = enemy;
    }
  }

  if (!closestEnemy) {
    return;
  }

  closestEnemy.hp = Math.max(0, closestEnemy.hp - WEAPON_DAMAGE);
  closestEnemy.hitFlashUntil = now + 180;
  if (closestEnemy.hp <= 0) {
    closestEnemy.alive = false;
    player.kills += 1;
  }
}

function updatePlayers(room, dt, now) {
  for (const player of room.players.values()) {
    if (!player.alive) {
      if (now >= player.respawnAt) {
        const spawn = pickSpawn(room);
        player.x = spawn.x;
        player.y = spawn.y;
        player.angle = 0;
        player.hp = PLAYER_MAX_HP;
        player.alive = true;
      }
      continue;
    }

    player.angle = normalizeAngle(player.angle + player.pendingTurn + player.input.turn * PLAYER_TURN_SPEED * dt);
    player.pendingTurn = 0;

    const forward = clamp(player.input.forward, -1, 1);
    const strafe = clamp(player.input.strafe, -1, 1);
    let moveX = Math.cos(player.angle) * forward + Math.cos(player.angle + Math.PI * 0.5) * strafe;
    let moveY = Math.sin(player.angle) * forward + Math.sin(player.angle + Math.PI * 0.5) * strafe;
    const length = Math.hypot(moveX, moveY);
    if (length > 1) {
      moveX /= length;
      moveY /= length;
    }
    tryMove(player, room, moveX * PLAYER_SPEED * dt, moveY * PLAYER_SPEED * dt, PLAYER_RADIUS);

    if (player.input.fire && now - player.lastShotAt >= WEAPON_COOLDOWN_MS) {
      player.lastShotAt = now;
      fireWeapon(room, player, now);
    }
  }
}

function getClosestAlivePlayer(room, x, y) {
  let best = null;
  let bestDist = Infinity;
  for (const player of room.players.values()) {
    if (!player.alive) {
      continue;
    }
    const dist = distance(player.x, player.y, x, y);
    if (dist < bestDist) {
      best = player;
      bestDist = dist;
    }
  }
  return { player: best, dist: bestDist };
}

function updateEnemies(room, dt, now) {
  for (const enemy of room.enemies.values()) {
    if (!enemy.alive) {
      continue;
    }

    const { player: target, dist } = getClosestAlivePlayer(room, enemy.x, enemy.y);
    if (!target || room.winnerId) {
      if (now >= enemy.wanderUntil) {
        enemy.wanderAngle = Math.random() * Math.PI * 2;
        enemy.wanderUntil = now + 1400 + Math.random() * 900;
      }
      tryMove(
        enemy,
        room,
        Math.cos(enemy.wanderAngle) * ENEMY_SPEED * 0.45 * dt,
        Math.sin(enemy.wanderAngle) * ENEMY_SPEED * 0.45 * dt,
        ENEMY_RADIUS
      );
      continue;
    }

    const canSeeTarget = dist <= ENEMY_AGGRO_RANGE && hasLineOfSight(room, enemy.x, enemy.y, target.x, target.y);
    if (canSeeTarget) {
      const toX = (target.x - enemy.x) / Math.max(dist, 0.0001);
      const toY = (target.y - enemy.y) / Math.max(dist, 0.0001);
      if (dist > ENEMY_ATTACK_RANGE) {
        tryMove(enemy, room, toX * ENEMY_SPEED * dt, toY * ENEMY_SPEED * dt, ENEMY_RADIUS);
      } else if (now >= enemy.nextAttackAt) {
        enemy.nextAttackAt = now + ENEMY_ATTACK_COOLDOWN_MS;
        target.hp = Math.max(0, target.hp - ENEMY_ATTACK_DAMAGE);
        target.lastDamagedAt = now;
        if (target.hp <= 0) {
          target.alive = false;
          target.deaths += 1;
          target.respawnAt = now + PLAYER_RESPAWN_MS;
        }
      }
    } else {
      if (now >= enemy.wanderUntil) {
        enemy.wanderAngle = Math.random() * Math.PI * 2;
        enemy.wanderUntil = now + 1000 + Math.random() * 1500;
      }
      tryMove(
        enemy,
        room,
        Math.cos(enemy.wanderAngle) * ENEMY_SPEED * 0.35 * dt,
        Math.sin(enemy.wanderAngle) * ENEMY_SPEED * 0.35 * dt,
        ENEMY_RADIUS
      );
    }
  }
}

function aliveEnemies(room) {
  let count = 0;
  for (const enemy of room.enemies.values()) {
    if (enemy.alive) {
      count += 1;
    }
  }
  return count;
}

function resetRound(room) {
  const nextMap = parseMap();
  room.map = nextMap;
  room.enemies.clear();
  nextMap.enemySpawns.forEach((spawn) => {
    const id = randomUUID();
    room.enemies.set(id, {
      id,
      x: spawn.x,
      y: spawn.y,
      hp: ENEMY_MAX_HP,
      alive: true,
      nextAttackAt: 0,
      hitFlashUntil: 0,
      wanderAngle: Math.random() * Math.PI * 2,
      wanderUntil: 0
    });
  });
  room.winnerId = null;
  room.winnerAt = 0;

  for (const player of room.players.values()) {
    const spawn = pickSpawn(room);
    player.x = spawn.x;
    player.y = spawn.y;
    player.angle = 0;
    player.hp = PLAYER_MAX_HP;
    player.alive = true;
    player.respawnAt = 0;
    player.pendingTurn = 0;
  }
}

function updateDoorAndWin(room, dt, now) {
  const remaining = aliveEnemies(room);
  if (remaining === 0 && !room.winnerId) {
    room.map.door.progress = clamp(room.map.door.progress + DOOR_OPEN_SPEED * dt, 0, 1);
  } else if (remaining > 0) {
    room.map.door.progress = 0;
  }

  if (!room.winnerId && room.map.door.progress >= 1) {
    for (const player of room.players.values()) {
      if (!player.alive) {
        continue;
      }
      const toDoor = distance(player.x, player.y, room.map.door.x + 0.5, room.map.door.y + 0.5);
      if (toDoor <= 0.65) {
        room.winnerId = player.id;
        room.winnerAt = now;
        break;
      }
    }
  }

  if (room.winnerId && now - room.winnerAt > ROUND_RESET_MS) {
    resetRound(room);
  }
}

function stepRoom(room, dt, now) {
  updatePlayers(room, dt, now);
  updateEnemies(room, dt, now);
  updateDoorAndWin(room, dt, now);
}

function broadcastState(room, now) {
  const players = [...room.players.values()].map((player) => ({
    id: player.id,
    name: player.name,
    x: player.x,
    y: player.y,
    angle: player.angle,
    hp: player.hp,
    maxHp: PLAYER_MAX_HP,
    alive: player.alive,
    kills: player.kills,
    deaths: player.deaths,
    lastShotAt: player.lastShotAt,
    lastDamagedAt: player.lastDamagedAt
  }));

  const enemies = [...room.enemies.values()].map((enemy) => ({
    id: enemy.id,
    x: enemy.x,
    y: enemy.y,
    hp: enemy.hp,
    maxHp: ENEMY_MAX_HP,
    alive: enemy.alive,
    hitFlash: enemy.hitFlashUntil > now ? (enemy.hitFlashUntil - now) / 180 : 0
  }));

  const winner = room.winnerId ? room.players.get(room.winnerId) : null;
  const basePayload = {
    type: "state",
    roomCode: room.code,
    door: {
      x: room.map.door.x,
      y: room.map.door.y,
      progress: room.map.door.progress,
      open: room.map.door.progress >= 1
    },
    enemiesRemaining: aliveEnemies(room),
    winnerId: room.winnerId,
    winnerName: winner ? winner.name : "",
    players,
    enemies,
    serverTime: now
  };

  for (const player of room.players.values()) {
    sendMessage(player.ws, { ...basePayload, you: player.id });
  }
}

function handleCreateRoom(ws, session, message) {
  removePlayer(session);
  const code = generateRoomCode();
  const room = createRoom(code);
  rooms.set(code, room);
  const player = addPlayer(room, ws, session, message.name);

  sendMessage(ws, {
    type: "joined",
    roomCode: code,
    playerId: player.id,
    map: mapPayload(room)
  });
  broadcastState(room, Date.now());
}

function handleJoinRoom(ws, session, message) {
  const code = String(message.roomCode || "").trim().toUpperCase();
  if (!code) {
    sendMessage(ws, { type: "error", message: "Enter a room code first." });
    return;
  }

  const room = rooms.get(code);
  if (!room) {
    sendMessage(ws, { type: "error", message: "Room not found. Check the code." });
    return;
  }
  if (room.players.size >= ROOM_MAX_PLAYERS) {
    sendMessage(ws, { type: "error", message: "Room is full." });
    return;
  }

  removePlayer(session);
  const player = addPlayer(room, ws, session, message.name);
  sendMessage(ws, {
    type: "joined",
    roomCode: code,
    playerId: player.id,
    map: mapPayload(room)
  });
  broadcastState(room, Date.now());
}

function handleInput(session, message) {
  if (!session.roomCode) {
    return;
  }
  const room = rooms.get(session.roomCode);
  if (!room) {
    session.roomCode = null;
    return;
  }
  const player = room.players.get(session.id);
  if (!player) {
    return;
  }
  const input = message.input || {};
  player.input.forward = clamp(Number(input.forward) || 0, -1, 1);
  player.input.strafe = clamp(Number(input.strafe) || 0, -1, 1);
  player.input.turn = clamp(Number(input.turn) || 0, -1, 1);
  player.input.fire = Boolean(input.fire);
  player.pendingTurn += clamp(Number(input.turnDelta) || 0, -0.6, 0.6);
  room.lastActiveAt = Date.now();
}

wss.on("connection", (ws) => {
  const session = {
    id: randomUUID(),
    roomCode: null,
    name: "Player"
  };

  sendMessage(ws, { type: "hello", id: session.id });

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch (_err) {
      sendMessage(ws, { type: "error", message: "Invalid message format." });
      return;
    }

    if (!message || typeof message.type !== "string") {
      return;
    }

    if (message.type === "create_room") {
      handleCreateRoom(ws, session, message);
    } else if (message.type === "join_room") {
      handleJoinRoom(ws, session, message);
    } else if (message.type === "input") {
      handleInput(session, message);
    } else if (message.type === "leave_room") {
      removePlayer(session);
    }
  });

  ws.on("close", () => {
    removePlayer(session);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    stepRoom(room, 1 / TICK_RATE, now);
    broadcastState(room, now);
  }
}, Math.floor(1000 / TICK_RATE));

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.players.size === 0 && now - room.lastActiveAt > ROOM_IDLE_CLEANUP_MS) {
      rooms.delete(room.code);
    }
  }
}, 60_000);

server.listen(PORT, () => {
  console.log(`Maze Arena server running at http://localhost:${PORT}`);
});
