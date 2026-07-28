# Arena

A browser multiplayer arena FPS for playing with coworkers. No accounts, no
downloads, no install — share a link, pick a name, go. Three-minute rounds,
three maps, up to eight players per room, plus a single-player practice range.

**Desktop only.** It needs a mouse and a keyboard (pointer lock and mouse aim),
so phones and tablets are out.

---

## Running it locally

```bash
npm install
```

```bash
npm run dev
```

That starts the game server on `:3000` and the Vite dev server on `:5173`.
Open **http://localhost:5173**.

To let people on your network join without deploying, give them
`http://<your-lan-ip>:5173`.

## Playing

| | |
|---|---|
| Move | `W A S D` |
| Sprint | `Shift` (forward only) |
| Crouch | `Ctrl` or `C` (smoothly, ~150ms) |
| Jump | `Space` |
| Fire | Left mouse |
| Aim down sights | Right mouse |
| Reload | `R` |
| Switch weapon | `1`–`8` |
| Scoreboard | hold `Tab` |
| Reset practice targets | `T` |
| Release mouse / back out | `Esc` (twice to leave) |

**Modes.** Team Deathmatch (auto-balanced teams, friendly fire off),
Free-for-all, and Gun Game (every kill promotes you up
pistol → SMG → shotgun → rifle → sniper → knife; win with a knife kill).

**Weapons.** Eight: knife, sidearm, SMG, shotgun, assault rifle, sniper, support
LMG, and a marksman rifle. The practice range gives you all of them on keys
`1`–`8` and shows a rack listing each one. Gun Game deliberately uses only the
first six — eight rungs makes the mode outlast a three-minute round.

Aiming down sights zooms and tightens spread; the sniper switches to a scope with
its own reticle rather than showing the gun. Reloads are animated (magazine out,
fresh one seated — the shotgun cycles its pump, the sniper works its bolt) and
pull you out of the aimed pose, so a reload never sits over your aim point.

**Maps.** Warehouse (tight indoor lanes with catwalks), Rooftops (eight roofs
separated by lethal gaps, one central tower), Alley (small, short sightlines,
shotgun country). Maps rotate between rounds.

**Rooms.** Four-character codes from an alphabet with no `0`/`O`/`1`/`I`, because
people read them out loud. Sharing `https://<host>/#ABCD` *is* the invite — the
code fills itself in. "Quick play" drops you into any room with space.

## Deploying

**See [DEPLOY.md](DEPLOY.md) for the step-by-step.** Short version: push to
GitHub, then point Render at the repo — `render.yaml` and `Dockerfile` are already
here, so there's nothing to configure by hand.

```bash
gh repo create arena-fps --private --source=. --remote=origin --push
```

Then **dashboard.render.com → New → Blueprint → pick the repo → Apply.**

A `fly.toml` is included too if you'd rather use Fly.io (`fly launch --no-deploy`
then `fly deploy`); it deploys straight from this folder without needing GitHub,
but wants the `flyctl` CLI installed.

### What to know before you do

- **Rooms live in the server process's memory.** A restart or redeploy drops
  every in-progress match. That's the right trade at this scale, but it means
  you must run exactly **one** instance — two instances are two separate sets of
  rooms that can't see each other. `fly.toml` is set up accordingly.
- **Cost** is small: a `shared-cpu-1x` / 512MB machine is plenty. The server does
  almost nothing per player.
- Bandwidth measured with a full lobby is **~6.5 KB/s per client**.

## Tests

```bash
npm test
```

68 tests, no browser needed. They cover the parts where a bug is silent rather
than loud:

- **`shared/collision.js`** — swept AABB movement, ray/box and ray/cylinder
  casts, step-up, ceilings, corners, tunnelling through thin floors. A bug here
  doesn't throw, it just makes the game feel bad.
- **Map validity** — every spawn clear of geometry, standing on ground, teams far
  enough apart.
- **Map reachability** (`test/navigation.test.js`) — builds a walkable-surface
  graph using the real jump apex and horizontal jump distance, then proves every
  spawn can reach every other. This caught genuinely broken geometry: platforms
  placed above the 1.28m jump height, a staircase that ran underneath the
  balcony it led to, and catwalk stairs that stopped at the underside of their
  own deck.

### Filling a lobby without any people

```bash
node server/bot.js --count 7
```

Headless bots that connect over the real protocol and drive themselves with the
same shared movement code, so they exercise the actual server validation path.
Run one browser client alongside to play against them.

```bash
node server/bot.js --count 7 --mode gungame --duration 60
```

Useful flags: `--count`, `--mode tdm|ffa|gungame`, `--code ABCD` to join a
specific room, `--duration <seconds>` to auto-report and exit, `--quiet`.

To watch whole round cycles without waiting three minutes each, compress the
phase timers (server-side only):

```bash
ARENA_ROUND_MS=20000 ARENA_COUNTDOWN_MS=2000 ARENA_SCOREBOARD_MS=3000 npm run dev:server
```

## How it's built

No game engine, no physics engine, no asset pipeline. Three.js for rendering,
`ws` for transport, and about 4,000 lines of plain JavaScript.

```
shared/     imported by BOTH client and server, so they can't disagree
  collision.js   swept AABB + raycasts        <- the load-bearing file
  constants.js   every number that affects feel
  weapons.js     weapon stat table
  protocol.js    message types + snapshot encoding
  maps/          four maps, authored as arrays of boxes
server/
  index.js       express + ws, room registry, matchmaking
  room.js        room state machine and 20Hz tick
  modes.js       tdm / ffa / gungame rules
  validate.js    movement and hit sanity checks
  bot.js         headless load tester (dev tool)
client/src/
  main.js        frame loop and screen state machine
  localPlayer.js movement, aim, firing
  net.js         snapshot buffering and interpolation
  remotePlayers.js, mapRenderer.js, weaponView.js, hud.js, practice.js, audio.js
```

**Everything is boxes.** Maps are arrays of axis-aligned boxes, which is what
lets us skip a physics engine entirely — collision is swept AABB against a box
list, and the whole level renders as a single instanced draw call. Player models,
guns, and targets are all assembled from boxes in code. Nothing is downloaded.

**All sound is synthesised at runtime** with WebAudio — gunshots are a filtered
noise burst plus a low sine thump. No audio files, no licences.

**The viewmodel renders in its own scene** with its own 55° camera. A gun held
40cm from your face through a 110° world FOV looks like a canoe, and it would
clip through walls you stand against.

### Networking, and the one thing to know about it

WebSockets at 20Hz down / 30Hz up, JSON. WebRTC data channels would be the
better transport in principle (UDP, no head-of-line blocking) but need a
signalling layer and native bindings that complicate the container for no
benefit at this scale.

Remote players are rendered ~100ms in the past. That's deliberate: it guarantees
a snapshot on both sides of the moment being drawn, so movement interpolates
smoothly instead of snapping twenty times a second.

**The authority split:**

- **Movement is client-authoritative.** Clients simulate their own position; the
  server loosely validates speed and bounds and rebroadcasts.
- **Hits are client-reported, server-applied.** The shooter raycasts locally and
  reports who it hit; the server re-checks distance and line of sight against
  the map before applying damage.
- **The server owns everything consequential** — health, deaths, score, spawns,
  the round clock, gun-game progression, and falling out of the world.

This skips lag compensation entirely and makes shooting feel direct: what you
see is what you hit. **The trade-off is that it's trivially cheatable by anyone
willing to open devtools and craft a packet.** For playing with coworkers that's
the right call. If it ever stops being, the upgrade path is to move movement
simulation server-side and add input prediction plus reconciliation — which is
tractable precisely because the collision code already lives in `shared/`.

## Known limitations

- Desktop only; no touch controls.
- One server process, rooms in memory — a redeploy ends live matches.
- No anti-cheat, by design (see above).
- A dropped connection returns you to the menu rather than reconnecting into the
  match you were in.
- No persistent stats or ranking. Scores last one round.

## Tuning it

Everything that affects how it feels is in two files:
`shared/constants.js` (movement speeds, gravity, jump, round length, respawn,
health regen) and `shared/weapons.js` (damage, fire rate, spread, recoil, range
falloff). Both are heavily commented with the intent behind each number —
including the time-to-kill each weapon is aiming for.

Expect to change them after your first real game. Three people playing for ten
minutes will tell you more about movement speed and TTK than any amount of
solo testing.
