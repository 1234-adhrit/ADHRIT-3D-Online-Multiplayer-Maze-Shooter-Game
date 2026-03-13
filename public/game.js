(() => {
  "use strict";

  const canvas = document.getElementById("viewport");
  const ctx = canvas.getContext("2d");

  const createBtn = document.getElementById("createBtn");
  const joinBtn = document.getElementById("joinBtn");
  const playerNameInput = document.getElementById("playerName");
  const roomCodeInput = document.getElementById("roomCodeInput");
  const statusLine = document.getElementById("statusLine");
  const healthFill = document.getElementById("healthFill");
  const healthValue = document.getElementById("healthValue");
  const roomValue = document.getElementById("roomValue");
  const enemiesValue = document.getElementById("enemiesValue");
  const doorValue = document.getElementById("doorValue");
  const scoreList = document.getElementById("scoreList");
  const victoryOverlay = document.getElementById("victoryOverlay");
  const victoryTitle = document.getElementById("victoryTitle");
  const victoryText = document.getElementById("victoryText");

  const FOV = Math.PI / 3;
  const MOUSE_SENSITIVITY = 0.0029;
  const INPUT_TICK_MS = 33;
  const MAX_RAY_DISTANCE = 36;

  let ws = null;
  let mapData = null;
  let latestState = null;
  let roomCode = "";
  let localPlayerId = "";
  let joined = false;
  let localViewReady = false;
  let lastShotSeen = 0;
  let lastDamagedSeen = 0;
  let mouseDown = false;
  let pointerTurnDelta = 0;
  let touchX = null;
  let winnerShownId = "";

  let weaponKick = 0;
  let muzzleFlash = 0;
  let hurtFlash = 0;
  let lastFrameTime = performance.now();
  let depthBuffer = new Float32Array(1);

  const keys = Object.create(null);
  const localView = {
    x: 1.5,
    y: 1.5,
    angle: 0
  };

  const textures = {
    wall: createWallTexture(),
    door: createDoorTexture(),
    enemy: createEnemyTexture(),
    player: createPlayerTexture(),
    weapon: createWeaponTexture()
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
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

  function lerpAngle(a, b, t) {
    const delta = normalizeAngle(b - a);
    return normalizeAngle(a + delta * t);
  }

  function wsUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}`;
  }

  function setStatus(text, kind = "info") {
    statusLine.textContent = text;
    statusLine.classList.toggle("error", kind === "error");
  }

  function send(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function requestConnection(type) {
    const name = (playerNameInput.value || "Runner").trim() || "Runner";
    const code = (roomCodeInput.value || "").trim().toUpperCase();

    if (type === "join_room" && !code) {
      setStatus("Enter a room code first.", "error");
      return;
    }

    joined = false;
    mapData = null;
    latestState = null;
    localViewReady = false;
    winnerShownId = "";
    victoryOverlay.classList.remove("visible");

    if (ws) {
      ws.onclose = null;
      ws.close();
    }

    ws = new WebSocket(wsUrl());
    setStatus("Connecting to server...");

    ws.onopen = () => {
      if (type === "create_room") {
        send({ type, name });
      } else {
        send({ type, name, roomCode: code });
      }
    };

    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (_err) {
        return;
      }
      handleMessage(message);
    };

    ws.onclose = () => {
      if (joined) {
        setStatus("Disconnected from server.", "error");
      }
      joined = false;
      localViewReady = false;
    };

    ws.onerror = () => {
      setStatus("Network error. Please retry.", "error");
    };
  }

  function handleMessage(message) {
    if (!message || typeof message.type !== "string") {
      return;
    }

    if (message.type === "joined") {
      joined = true;
      roomCode = message.roomCode || "";
      localPlayerId = message.playerId || "";
      mapData = message.map || null;
      roomValue.textContent = roomCode || "----";
      setStatus(`Connected to room ${roomCode}.`);
      return;
    }

    if (message.type === "state") {
      latestState = message;
      if (message.you) {
        localPlayerId = message.you;
      }
      syncLocalPlayerState();
      updateHud();
      syncVictoryOverlay();
      return;
    }

    if (message.type === "error") {
      setStatus(message.message || "Server reported an error.", "error");
    }
  }

  function syncLocalPlayerState() {
    if (!latestState || !Array.isArray(latestState.players)) {
      return;
    }
    const me = latestState.players.find((player) => player.id === localPlayerId);
    if (!me) {
      return;
    }

    if (!localViewReady) {
      localView.x = me.x;
      localView.y = me.y;
      localView.angle = me.angle;
      localViewReady = true;
    }

    if (me.lastShotAt > lastShotSeen) {
      lastShotSeen = me.lastShotAt;
      weaponKick = 20;
      muzzleFlash = 0.09;
    }
    if (me.lastDamagedAt > lastDamagedSeen) {
      lastDamagedSeen = me.lastDamagedAt;
      hurtFlash = 0.22;
    }
  }

  function syncVictoryOverlay() {
    if (!latestState || !latestState.winnerId) {
      victoryOverlay.classList.remove("visible");
      winnerShownId = "";
      return;
    }

    const isMe = latestState.winnerId === localPlayerId;
    victoryTitle.textContent = isMe ? "Escape Complete" : "Runner Escaped";
    victoryText.textContent = isMe
      ? "You reached the exit. New round starts shortly."
      : `${latestState.winnerName || "A player"} reached the exit door.`;

    if (winnerShownId !== latestState.winnerId) {
      winnerShownId = latestState.winnerId;
    }
    victoryOverlay.classList.add("visible");
  }

  function updateHud() {
    if (!latestState) {
      return;
    }

    roomValue.textContent = latestState.roomCode || roomCode || "----";
    enemiesValue.textContent = String(latestState.enemiesRemaining ?? 0);
    doorValue.textContent = `${Math.round(((latestState.door && latestState.door.progress) || 0) * 100)}%`;

    const me = latestState.players.find((player) => player.id === localPlayerId);
    if (me) {
      const hpPercent = clamp((me.hp / Math.max(1, me.maxHp)) * 100, 0, 100);
      healthFill.style.width = `${hpPercent}%`;
      healthValue.textContent = me.alive ? `${Math.round(me.hp)} HP` : "Respawning";
    }

    scoreList.innerHTML = "";
    const sorted = [...latestState.players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    for (const player of sorted) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      const stat = document.createElement("span");
      name.textContent = player.name;
      stat.textContent = `${player.kills}K / ${player.deaths}D`;
      if (player.id === localPlayerId) {
        name.className = "me";
      }
      li.appendChild(name);
      li.appendChild(stat);
      scoreList.appendChild(li);
    }
  }

  function isDoorTile(tileX, tileY) {
    if (!latestState || !latestState.door) {
      return false;
    }
    return tileX === latestState.door.x && tileY === latestState.door.y;
  }

  function isWallTile(tileX, tileY) {
    if (!mapData) {
      return true;
    }
    if (tileX < 0 || tileY < 0 || tileX >= mapData.width || tileY >= mapData.height) {
      return true;
    }
    const row = mapData.rows[tileY];
    if (!row) {
      return true;
    }
    if (row.charAt(tileX) === "#") {
      return true;
    }
    if (isDoorTile(tileX, tileY)) {
      return ((latestState && latestState.door && latestState.door.progress) || 0) < 1;
    }
    return false;
  }

  function castRay(originX, originY, rayDirX, rayDirY) {
    let mapX = Math.floor(originX);
    let mapY = Math.floor(originY);

    const safeDirX = rayDirX === 0 ? 1e-9 : rayDirX;
    const safeDirY = rayDirY === 0 ? 1e-9 : rayDirY;
    const deltaDistX = Math.abs(1 / safeDirX);
    const deltaDistY = Math.abs(1 / safeDirY);

    let stepX = 0;
    let stepY = 0;
    let sideDistX = 0;
    let sideDistY = 0;

    if (rayDirX < 0) {
      stepX = -1;
      sideDistX = (originX - mapX) * deltaDistX;
    } else {
      stepX = 1;
      sideDistX = (mapX + 1 - originX) * deltaDistX;
    }

    if (rayDirY < 0) {
      stepY = -1;
      sideDistY = (originY - mapY) * deltaDistY;
    } else {
      stepY = 1;
      sideDistY = (mapY + 1 - originY) * deltaDistY;
    }

    let side = 0;
    let hit = false;
    let distance = MAX_RAY_DISTANCE;
    let wallX = 0;
    let hitType = "wall";
    let loops = 0;

    while (!hit && loops < 80) {
      loops += 1;
      if (sideDistX < sideDistY) {
        sideDistX += deltaDistX;
        mapX += stepX;
        side = 0;
      } else {
        sideDistY += deltaDistY;
        mapY += stepY;
        side = 1;
      }

      if (isWallTile(mapX, mapY)) {
        hit = true;
        hitType = isDoorTile(mapX, mapY) ? "door" : "wall";
      }
    }

    if (hit) {
      if (side === 0) {
        distance = (mapX - originX + (1 - stepX) * 0.5) / safeDirX;
        wallX = originY + distance * safeDirY;
      } else {
        distance = (mapY - originY + (1 - stepY) * 0.5) / safeDirY;
        wallX = originX + distance * safeDirX;
      }
      wallX -= Math.floor(wallX);
      if ((side === 0 && rayDirX > 0) || (side === 1 && rayDirY < 0)) {
        wallX = 1 - wallX;
      }
    }

    return {
      distance: clamp(Math.abs(distance), 0.0001, MAX_RAY_DISTANCE),
      texX: wallX,
      side,
      hitType
    };
  }

  function renderSkyAndFloor(width, height, time) {
    const sky = ctx.createLinearGradient(0, 0, 0, height * 0.52);
    sky.addColorStop(0, "#1e4f6a");
    sky.addColorStop(0.38, "#113445");
    sky.addColorStop(1, "#0b1d29");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height * 0.52);

    const glowRadius = 180 + Math.sin(time * 0.4) * 25;
    const glow = ctx.createRadialGradient(width * 0.68, height * 0.16, 10, width * 0.68, height * 0.16, glowRadius);
    glow.addColorStop(0, "rgba(255, 191, 112, 0.26)");
    glow.addColorStop(1, "rgba(255, 191, 112, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height * 0.6);

    const floor = ctx.createLinearGradient(0, height * 0.5, 0, height);
    floor.addColorStop(0, "#132734");
    floor.addColorStop(1, "#071018");
    ctx.fillStyle = floor;
    ctx.fillRect(0, height * 0.5, width, height * 0.5);
  }

  function renderWalls(width, height) {
    const stride = width > 1100 ? 2 : 1;
    const halfFov = FOV * 0.5;

    for (let x = 0; x < width; x += stride) {
      const camera = (x / width) * 2 - 1;
      const rayAngle = localView.angle + camera * halfFov;
      const rayDirX = Math.cos(rayAngle);
      const rayDirY = Math.sin(rayAngle);

      const hit = castRay(localView.x, localView.y, rayDirX, rayDirY);
      const correctedDistance = hit.distance * Math.cos(rayAngle - localView.angle);
      const lineHeight = Math.min(height * 1.8, height / Math.max(0.0001, correctedDistance));
      const drawY = Math.floor((height - lineHeight) * 0.5);
      const texture = hit.hitType === "door" ? textures.door : textures.wall;
      const sourceX = Math.floor(hit.texX * (texture.width - 1));
      const shade = clamp(correctedDistance / 10 + (hit.side ? 0.12 : 0.02), 0, 0.84);

      ctx.drawImage(texture, sourceX, 0, 1, texture.height, x, drawY, stride, lineHeight);
      ctx.fillStyle = `rgba(0,0,0,${shade})`;
      ctx.fillRect(x, drawY, stride, lineHeight);

      for (let i = 0; i < stride && x + i < depthBuffer.length; i += 1) {
        depthBuffer[x + i] = correctedDistance;
      }
    }
  }

  function renderEnemies(width, height) {
    if (!latestState || !Array.isArray(latestState.enemies)) {
      return;
    }
    const visibleEnemies = latestState.enemies
      .filter((enemy) => enemy.alive)
      .map((enemy) => {
        const dx = enemy.x - localView.x;
        const dy = enemy.y - localView.y;
        return {
          enemy,
          dist: Math.hypot(dx, dy),
          angle: normalizeAngle(Math.atan2(dy, dx) - localView.angle)
        };
      })
      .sort((a, b) => b.dist - a.dist);

    for (const item of visibleEnemies) {
      if (Math.abs(item.angle) > FOV * 0.72) {
        continue;
      }
      const screenX = (0.5 + item.angle / FOV) * width;
      const size = clamp(height / Math.max(0.2, item.dist), 24, height * 0.9);
      const drawX = screenX - size * 0.5;
      const drawY = height * 0.5 - size * 0.56;
      const centerColumn = clamp(Math.floor(screenX), 0, width - 1);
      const wallDepth = depthBuffer[centerColumn] || MAX_RAY_DISTANCE;

      if (wallDepth + 0.1 < item.dist) {
        continue;
      }

      ctx.globalAlpha = clamp(1 - item.dist / 15, 0.2, 1);
      ctx.drawImage(textures.enemy, drawX, drawY, size, size);

      if (item.enemy.hitFlash > 0) {
        ctx.fillStyle = `rgba(255, 86, 86, ${clamp(item.enemy.hitFlash, 0, 1) * 0.6})`;
        ctx.fillRect(drawX, drawY, size, size);
      }

      const hpRatio = clamp(item.enemy.hp / Math.max(1, item.enemy.maxHp), 0, 1);
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(drawX, drawY - 10, size, 5);
      ctx.fillStyle = "rgba(110, 240, 224, 0.95)";
      ctx.fillRect(drawX, drawY - 10, size * hpRatio, 5);
      ctx.globalAlpha = 1;
    }
  }

  function renderOtherPlayers(width, height) {
    if (!latestState || !Array.isArray(latestState.players)) {
      return;
    }

    const others = latestState.players
      .filter((player) => player.id !== localPlayerId && player.alive)
      .map((player) => {
        const dx = player.x - localView.x;
        const dy = player.y - localView.y;
        return {
          player,
          dist: Math.hypot(dx, dy),
          angle: normalizeAngle(Math.atan2(dy, dx) - localView.angle)
        };
      })
      .sort((a, b) => b.dist - a.dist);

    for (const item of others) {
      if (Math.abs(item.angle) > FOV * 0.75) {
        continue;
      }

      const screenX = (0.5 + item.angle / FOV) * width;
      const spriteHeight = clamp(height / Math.max(0.25, item.dist) * 1.25, 42, height * 0.95);
      const spriteWidth = spriteHeight * (textures.player.width / textures.player.height);
      const drawX = screenX - spriteWidth * 0.5;
      const drawY = height * 0.5 - spriteHeight * 0.72;

      const centerColumn = clamp(Math.floor(screenX), 0, width - 1);
      const wallDepth = depthBuffer[centerColumn] || MAX_RAY_DISTANCE;
      if (wallDepth + 0.08 < item.dist) {
        continue;
      }

      ctx.globalAlpha = clamp(1 - item.dist / 22, 0.26, 1);
      ctx.drawImage(textures.player, drawX, drawY, spriteWidth, spriteHeight);
      ctx.globalAlpha = 1;

      const hpRatio = clamp(item.player.hp / Math.max(1, item.player.maxHp), 0, 1);
      ctx.fillStyle = "rgba(0,0,0,0.52)";
      ctx.fillRect(drawX, drawY - 12, spriteWidth, 5);
      ctx.fillStyle = "rgba(110, 240, 224, 0.95)";
      ctx.fillRect(drawX, drawY - 12, spriteWidth * hpRatio, 5);
    }
  }

  function drawDownArrow(x, y, size, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y + size);
    ctx.lineTo(x - size, y - size * 0.6);
    ctx.lineTo(x + size, y - size * 0.6);
    ctx.closePath();
    ctx.fill();
  }

  function drawSideArrow(x, y, size, rightSide, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    if (rightSide) {
      ctx.moveTo(x + size, y);
      ctx.lineTo(x - size, y - size * 0.75);
      ctx.lineTo(x - size, y + size * 0.75);
    } else {
      ctx.moveTo(x - size, y);
      ctx.lineTo(x + size, y - size * 0.75);
      ctx.lineTo(x + size, y + size * 0.75);
    }
    ctx.closePath();
    ctx.fill();
  }

  function renderPlayerMarkers(width, height) {
    if (!latestState || !Array.isArray(latestState.players)) {
      return;
    }

    const others = latestState.players.filter((player) => player.id !== localPlayerId && player.alive);
    if (others.length === 0) {
      return;
    }

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "700 13px Rajdhani";

    const halfFov = FOV * 0.5;
    const edgeX = 24;
    const offscreenY = 56;

    for (const player of others) {
      const dx = player.x - localView.x;
      const dy = player.y - localView.y;
      const dist = Math.hypot(dx, dy);
      const angle = normalizeAngle(Math.atan2(dy, dx) - localView.angle);
      const label = `${player.name} ${dist.toFixed(1)}m`;
      const markerColor = "rgba(110, 240, 224, 0.96)";

      if (Math.abs(angle) <= halfFov) {
        const screenX = (0.5 + angle / FOV) * width;
        const pseudoSize = clamp(height / Math.max(0.25, dist), 20, height * 0.66);
        const topY = height * 0.5 - pseudoSize * 0.56;
        const markerY = clamp(topY - 22, 24, height - 34);

        drawDownArrow(screenX, markerY, 9, markerColor);
        ctx.fillStyle = "rgba(4, 12, 18, 0.74)";
        const textWidth = ctx.measureText(label).width + 12;
        ctx.fillRect(screenX - textWidth * 0.5, markerY - 26, textWidth, 16);
        ctx.fillStyle = "rgba(230, 250, 255, 0.96)";
        ctx.fillText(label, screenX, markerY - 18);
      } else {
        const rightSide = angle > 0;
        const markerX = rightSide ? width - edgeX : edgeX;
        drawSideArrow(markerX, offscreenY, 11, rightSide, markerColor);

        const textX = rightSide ? markerX - 44 : markerX + 44;
        ctx.textAlign = rightSide ? "right" : "left";
        ctx.fillStyle = "rgba(4, 12, 18, 0.78)";
        const textWidth = ctx.measureText(label).width + 10;
        const boxX = rightSide ? textX - textWidth : textX;
        ctx.fillRect(boxX, offscreenY - 8, textWidth, 16);
        ctx.fillStyle = "rgba(230, 250, 255, 0.96)";
        ctx.fillText(label, textX + (rightSide ? -5 : 5), offscreenY);
        ctx.textAlign = "center";
      }
    }

    ctx.restore();
  }

  function currentMoveFactor() {
    const forward = (keys.KeyW || keys.ArrowUp ? 1 : 0) + (keys.KeyS || keys.ArrowDown ? 1 : 0);
    const strafe = (keys.KeyA ? 1 : 0) + (keys.KeyD ? 1 : 0);
    return clamp(forward + strafe, 0, 1);
  }

  function renderWeapon(width, height, time) {
    const moveFactor = currentMoveFactor();
    const bobX = Math.cos(time * 10) * 4.2 * moveFactor;
    const bobY = Math.sin(time * 12) * 6.2 * moveFactor;
    const kickOffset = weaponKick;

    const scale = clamp(width / 980, 0.8, 1.3);
    const weaponWidth = textures.weapon.width * scale;
    const weaponHeight = textures.weapon.height * scale;
    const weaponX = width * 0.5 - weaponWidth * 0.5 + bobX;
    const weaponY = height - weaponHeight + bobY + kickOffset;

    ctx.drawImage(textures.weapon, weaponX, weaponY, weaponWidth, weaponHeight);

    if (muzzleFlash > 0) {
      const alpha = clamp(muzzleFlash / 0.09, 0, 1);
      const flashX = weaponX + weaponWidth * 0.8;
      const flashY = weaponY + weaponHeight * 0.38;
      const flash = ctx.createRadialGradient(flashX, flashY, 4, flashX, flashY, 72);
      flash.addColorStop(0, `rgba(255, 225, 160, ${0.8 * alpha})`);
      flash.addColorStop(1, "rgba(255, 225, 160, 0)");
      ctx.fillStyle = flash;
      ctx.fillRect(flashX - 80, flashY - 80, 160, 160);
    }
  }

  function renderCrosshair(width, height) {
    const cx = width * 0.5;
    const cy = height * 0.5;
    ctx.strokeStyle = "rgba(233, 247, 250, 0.86)";
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(cx - 8, cy);
    ctx.lineTo(cx - 2, cy);
    ctx.moveTo(cx + 2, cy);
    ctx.lineTo(cx + 8, cy);
    ctx.moveTo(cx, cy - 8);
    ctx.lineTo(cx, cy - 2);
    ctx.moveTo(cx, cy + 2);
    ctx.lineTo(cx, cy + 8);
    ctx.stroke();
  }

  function renderIdlePrompt(width, height) {
    ctx.fillStyle = "rgba(4, 10, 16, 0.58)";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "rgba(228, 242, 247, 0.9)";
    ctx.font = "600 24px Oxanium";
    ctx.textAlign = "center";
    ctx.fillText("Create or Join a Room to Start", width / 2, height / 2 - 14);
    ctx.font = "500 14px Rajdhani";
    ctx.fillStyle = "rgba(143, 169, 180, 0.95)";
    ctx.fillText("WASD move, mouse look, left click fire", width / 2, height / 2 + 14);
  }

  function resizeCanvasIfNeeded() {
    const width = Math.max(1, Math.floor(canvas.clientWidth));
    const height = Math.max(1, Math.floor(canvas.clientHeight));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      depthBuffer = new Float32Array(width);
    }
  }

  function updateLocalView(dt) {
    weaponKick = Math.max(0, weaponKick - 52 * dt);
    muzzleFlash = Math.max(0, muzzleFlash - dt);
    hurtFlash = Math.max(0, hurtFlash - dt);

    if (!latestState || !localViewReady) {
      return;
    }
    const me = latestState.players.find((player) => player.id === localPlayerId);
    if (!me) {
      return;
    }

    const smooth = clamp(dt * 12, 0, 1);
    localView.x = lerp(localView.x, me.x, smooth);
    localView.y = lerp(localView.y, me.y, smooth);
    localView.angle = lerpAngle(localView.angle, me.angle, smooth);
  }

  function renderFrame(nowMs) {
    resizeCanvasIfNeeded();
    const width = canvas.width;
    const height = canvas.height;
    const nowSec = nowMs * 0.001;
    const dt = Math.min(0.05, (nowMs - lastFrameTime) * 0.001);
    lastFrameTime = nowMs;

    updateLocalView(dt);
    renderSkyAndFloor(width, height, nowSec);

    if (joined && mapData && latestState && localViewReady) {
      renderWalls(width, height);
      renderOtherPlayers(width, height);
      renderEnemies(width, height);
      renderWeapon(width, height, nowSec);
      renderCrosshair(width, height);
      renderPlayerMarkers(width, height);
    } else {
      renderIdlePrompt(width, height);
    }

    if (hurtFlash > 0) {
      ctx.fillStyle = `rgba(255, 70, 70, ${hurtFlash * 0.35})`;
      ctx.fillRect(0, 0, width, height);
    }

    requestAnimationFrame(renderFrame);
  }

  function createWallTexture() {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const g = c.getContext("2d");
    g.fillStyle = "#7d8a91";
    g.fillRect(0, 0, 64, 64);

    g.fillStyle = "#67727a";
    for (let y = 0; y < 64; y += 16) {
      for (let x = 0; x < 64; x += 16) {
        if ((x + y) % 32 === 0) {
          g.fillRect(x, y, 16, 16);
        }
      }
    }

    g.strokeStyle = "rgba(40, 50, 58, 0.75)";
    g.lineWidth = 2;
    for (let y = 0; y <= 64; y += 16) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(64, y);
      g.stroke();
    }
    for (let x = 0; x <= 64; x += 16) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, 64);
      g.stroke();
    }

    return c;
  }

  function createDoorTexture() {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const g = c.getContext("2d");

    const grad = g.createLinearGradient(0, 0, 64, 64);
    grad.addColorStop(0, "#e7ac4c");
    grad.addColorStop(1, "#8f5b1f");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);

    g.strokeStyle = "rgba(42, 25, 7, 0.7)";
    g.lineWidth = 2;
    for (let i = 8; i <= 56; i += 8) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i, 64);
      g.stroke();
    }
    return c;
  }

  function createEnemyTexture() {
    const c = document.createElement("canvas");
    c.width = 96;
    c.height = 96;
    const g = c.getContext("2d");

    g.clearRect(0, 0, 96, 96);
    const body = g.createRadialGradient(48, 42, 8, 48, 42, 36);
    body.addColorStop(0, "#f6fffb");
    body.addColorStop(1, "#48907f");
    g.fillStyle = body;
    g.beginPath();
    g.ellipse(48, 45, 28, 34, 0, 0, Math.PI * 2);
    g.fill();

    g.fillStyle = "#0c1b20";
    g.beginPath();
    g.arc(38, 40, 5, 0, Math.PI * 2);
    g.arc(58, 40, 5, 0, Math.PI * 2);
    g.fill();

    g.strokeStyle = "#10252c";
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(32, 60);
    g.quadraticCurveTo(48, 70, 64, 60);
    g.stroke();

    return c;
  }

  function createPlayerTexture() {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 96;
    const g = c.getContext("2d");

    g.clearRect(0, 0, 64, 96);

    const px = 4;
    const fillPx = (x, y, w, h, color) => {
      g.fillStyle = color;
      g.fillRect(x * px, y * px, w * px, h * px);
    };

    fillPx(5, 1, 6, 6, "#d8a57d");
    fillPx(5, 1, 6, 2, "#6d4f38");
    fillPx(5, 7, 2, 1, "#c78f65");
    fillPx(9, 7, 2, 1, "#c78f65");

    fillPx(4, 7, 8, 6, "#2f7ec0");
    fillPx(3, 7, 1, 6, "#2f7ec0");
    fillPx(12, 7, 1, 6, "#2f7ec0");
    fillPx(4, 11, 8, 2, "#245f93");

    fillPx(4, 13, 4, 8, "#4e7ba8");
    fillPx(8, 13, 4, 8, "#4a739a");

    fillPx(3, 13, 1, 8, "#d8a57d");
    fillPx(12, 13, 1, 8, "#d8a57d");

    g.strokeStyle = "rgba(10,16,20,0.55)";
    g.lineWidth = 2;
    g.strokeRect(5 * px, 1 * px, 6 * px, 6 * px);
    g.strokeRect(4 * px, 7 * px, 8 * px, 6 * px);
    g.strokeRect(4 * px, 13 * px, 8 * px, 8 * px);

    return c;
  }

  function createWeaponTexture() {
    const c = document.createElement("canvas");
    c.width = 300;
    c.height = 170;
    const g = c.getContext("2d");

    const body = g.createLinearGradient(0, 0, 300, 0);
    body.addColorStop(0, "#2a3238");
    body.addColorStop(1, "#0f1317");
    g.fillStyle = body;
    g.beginPath();
    g.moveTo(28, 96);
    g.lineTo(208, 78);
    g.lineTo(274, 88);
    g.lineTo(262, 122);
    g.lineTo(112, 130);
    g.lineTo(36, 130);
    g.closePath();
    g.fill();

    g.fillStyle = "#1f2429";
    g.fillRect(144, 94, 56, 20);

    g.fillStyle = "#7bc1ff";
    g.fillRect(176, 84, 40, 7);

    g.fillStyle = "#ffb14d";
    g.fillRect(250, 93, 32, 11);

    g.fillStyle = "#171b20";
    g.beginPath();
    g.moveTo(96, 108);
    g.lineTo(120, 108);
    g.lineTo(126, 150);
    g.lineTo(102, 150);
    g.closePath();
    g.fill();

    return c;
  }

  createBtn.addEventListener("click", () => requestConnection("create_room"));
  joinBtn.addEventListener("click", () => requestConnection("join_room"));
  roomCodeInput.addEventListener("input", () => {
    roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });

  window.addEventListener("keydown", (event) => {
    keys[event.code] = true;
    if (event.code === "Space") {
      event.preventDefault();
    }
  });

  window.addEventListener("keyup", (event) => {
    keys[event.code] = false;
  });

  window.addEventListener("blur", () => {
    for (const key of Object.keys(keys)) {
      keys[key] = false;
    }
    mouseDown = false;
    pointerTurnDelta = 0;
  });

  canvas.addEventListener("click", () => {
    if (joined && document.pointerLockElement !== canvas && canvas.requestPointerLock) {
      canvas.requestPointerLock().catch(() => {});
    }
  });

  document.addEventListener("mousemove", (event) => {
    if (document.pointerLockElement === canvas) {
      pointerTurnDelta += event.movementX * MOUSE_SENSITIVITY;
    }
  });

  window.addEventListener("mousedown", (event) => {
    if (event.button === 0) {
      mouseDown = true;
    }
  });
  window.addEventListener("mouseup", (event) => {
    if (event.button === 0) {
      mouseDown = false;
    }
  });

  canvas.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length > 0) {
        touchX = event.touches[0].clientX;
      }
      mouseDown = true;
      event.preventDefault();
    },
    { passive: false }
  );

  canvas.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length > 0 && touchX !== null) {
        const nextX = event.touches[0].clientX;
        pointerTurnDelta += (nextX - touchX) * 0.004;
        touchX = nextX;
      }
      event.preventDefault();
    },
    { passive: false }
  );

  canvas.addEventListener(
    "touchend",
    (event) => {
      mouseDown = false;
      if (event.touches.length === 0) {
        touchX = null;
      }
      event.preventDefault();
    },
    { passive: false }
  );

  setInterval(() => {
    if (!joined || !ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const forward = (keys.KeyW || keys.ArrowUp ? 1 : 0) + (keys.KeyS || keys.ArrowDown ? -1 : 0);
    const strafe = (keys.KeyD ? 1 : 0) + (keys.KeyA ? -1 : 0);
    const turn = (keys.ArrowRight ? 1 : 0) + (keys.ArrowLeft ? -1 : 0);
    const fire = Boolean(mouseDown || keys.Space);

    send({
      type: "input",
      input: {
        forward,
        strafe,
        turn,
        turnDelta: clamp(pointerTurnDelta, -0.65, 0.65),
        fire
      }
    });
    pointerTurnDelta = 0;
  }, INPUT_TICK_MS);

  setStatus("Create a room or join an existing one.");
  requestAnimationFrame(renderFrame);
})();
