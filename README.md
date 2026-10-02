# RIFT RUNNERS: NEXUS

A polished real-time multiplayer browser arena for **2–8 players on separate devices**. No install and no player account required.

## The game in one sentence
Collect energy, decide how much risk to carry, bank it at the central Nexus, and use Pulse to knock valuable cargo out of nearby rivals before the 90-second clock expires.

## Rules players see inside the game
1. **Collect** cyan shards. You can carry up to 4. A gold Prism is worth 3 points.
2. **Bank** by touching the central Nexus. Bank all 4 cargo items at once for a **+2 Full Load bonus**.
3. **Pulse** with `Space` on desktop or the on-screen `PULSE` button on mobile. Nearby rivals can drop their most valuable cargo. Pulse recharges in 6 seconds.
4. **Powerups**: green Overdrive temporarily boosts speed; purple Shield blocks one Pulse while active.
5. **Win** by having the highest *banked* score after 90 seconds. Cargo still being carried at the buzzer scores nothing.

## Multiplayer / reliability features
- Socket.IO rooms with 6-character invite codes.
- QR code in the lobby so a second device can join instantly.
- Server-authoritative movement, pickups, collision, scoring, Pulse, powerups, timer and winner selection.
- Responsive keyboard and touch controls.
- Host migration if the host disconnects.
- 30-second reconnect grace after a dropped connection.
- Mid-round late joiners become spectators and automatically enter the next round.
- Room cleanup to avoid abandoned server state.
- Health endpoint at `/health`.
- Built-in automated smoke test using two independent Socket.IO clients.

## Gameplay depth / polish
- Risk-reward cargo system: each carried item slows the runner slightly.
- Full Load bonus rewards staying exposed longer.
- 3-point Prism Rifts create timed conflict hotspots.
- Overdrive and Shield pickups add tactical swings without making the rules hard to learn.
- Server-side circular obstacles create real pathing decisions.
- Live leaderboard, arena event feed, round highlights and stats.
- Canvas visuals, particle effects, synthesized sound effects, mobile controls and reduced-motion support.

## Run locally
```bash
npm install
npm test
npm start
```
Then open `http://localhost:3000`.

To test on two physical devices on the same Wi-Fi, open the computer's LAN IP (for example `http://192.168.1.20:3000`) on both devices.

## Automated smoke test
`npm test` boots a temporary server and verifies:
- health endpoint
- room creation
- a second independent client joining
- synchronized round start
- server-authoritative movement
- Pulse action
- QR invite generation

## Deploy to a public URL
The project includes both `render.yaml` and a `Dockerfile`.

### Render
1. Create a GitHub repository and upload the contents of this folder (not the outer zip folder).
2. In Render, create a new Web Service or Blueprint from that repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Health check: `/health`
6. After deployment, open the HTTPS URL on two different devices and run one complete round.

### Any Docker host
Build and run the included Dockerfile. The server listens on `process.env.PORT` and defaults to port 3000.

## Handshake submission assets included
- Project title: **Rift Runners: Nexus**
- `cover.png` — 1600×900 project cover
- `SUBMISSION.md` — polished project description and judge demo script
- Public URL — add your deployed URL before submitting

## Important final checks before submission
- Open the public URL in a private/incognito browser to ensure it is truly public.
- Join from two separate devices on different networks if possible.
- Confirm QR join, movement, Prism Rift, Pulse, banking and results all sync.
- Do not submit a localhost URL.
