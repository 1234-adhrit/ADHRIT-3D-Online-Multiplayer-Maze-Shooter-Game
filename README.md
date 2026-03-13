# Maze Arena 3D (Multiplayer Web Prototype)

This project is a multiplayer 3D maze shooter built with HTML/CSS/JavaScript and a Node.js WebSocket server.

## Included Features

- Real-time multiplayer with room creation and join-by-code.
- Raycasting-based 3D maze rendering on canvas.
- PvE entities that chase and attack players.
- Weapon combat with hit detection and enemy health.
- Exit-door victory flow with round reset after a win.
- HUD with health, room code, door progress, and scoreboard.
- Responsive UI for desktop and mobile screens.

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Start the game server:

```bash
npm start
```

3. Open the game in your browser:

```text
http://localhost:3000
```

## Controls

- `WASD`: Move
- `Mouse`: Look around (click the canvas to lock pointer)
- `Arrow keys`: Optional look controls
- `Left click` or `Space`: Fire weapon

## Network / Deployment Notes

- Default port is `3000`. Set `PORT` in environment for hosting platforms.
- For public deployment, run behind HTTPS so WebSocket upgrades use `wss://`.
- Typical hosts: Render, Fly.io, Railway, VPS with Nginx reverse proxy.

## Architecture

- `server.js`: authoritative multiplayer simulation and WebSocket transport.
- `public/index.html`: game shell and HUD layout.
- `public/style.css`: UI styling and responsive layout.
- `public/game.js`: networking, controls, raycasting renderer, and animations.

## Play Online

- https://3d-online-multiplayer-maze-shooter-game.onrender.com/
