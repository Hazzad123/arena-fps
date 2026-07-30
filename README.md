# Arena

A browser multiplayer arena FPS for playing with coworkers. No accounts, no
downloads, no install — share a link, pick a name, go. Three-minute rounds,
six arena maps, up to eight players per arena room (45 in Battle Royale), plus
a single-player practice range.

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
| Use / pick up | `E` |
| Switch weapon | Mouse wheel or `1`–`8` |
| Drive rover | `W`/`S` throttle · `A`/`D` steer · mouse camera · `E` exit |
| Scoreboard | hold `Tab` |
| Full tactical map | `M` |
| Chat / team chat | `Enter` / `Shift` + `Enter` |
| Emotes | `Z` wave · `X` yes · `V` no |
| Reset practice targets | `T` |
| Pause menu | `Esc` (again to resume) |
| Quick-pick gun type | `1`–`6` while dead or paused |
| Back to lobby | `L` on the results screen |

**Modes.** Team Deathmatch (auto-balanced teams, friendly fire off),
Free-for-all, Gun Game (every kill promotes you up
pistol → SMG → shotgun → rifle → sniper → knife; win with a knife kill),
co-op Survival waves, and a 45-player Battle Royale with parachute drops, ground
loot, destructible rovers, named districts, a full skybox, an adaptive closing
zone and spectators.

**Lobby.** Players gather up to the selected mode's capacity, shown as open
slots — split by team in TDM — with everyone's ready state. It starts when
everybody has readied up, and the host (whoever arrived first) can force it or
change the mode and map. If someone wanders off, a 45-second clock starts once at
least two people are ready and the match goes without them, so a lobby can't
deadlock on one person. Nobody is dragged in against a unanimous vote they never
gave: the clock only runs when a quorum has actually said yes.

**Gun choice.** Pick any of 15 primaries, grouped into six types. Everyone also
carries the standard sidearm and knife. Pick one in the lobby, from the pause
menu, or on the death screen; the choice is remembered between sessions.
Changing it while you're alive takes effect on your next spawn rather than
immediately, so it can't be used as a free mid-fight re-arm. Gun Game and Battle
Royale ignore the choice by design.

**Pause menu.** `Esc` releases the mouse and opens it: resume, the complete
controls reference, settings, class, and leave. In the practice range it also
lists every weapon to click. It does
**not** pause the match — you're still standing there, and it says so.

**End of a round.** A results screen: who won, in their team's colour, the final
score, and a table ranked by score with placing, kills, deaths and K/D, the top
scorer marked MVP. It names the map you're about to play and counts down to it.

Rounds roll straight into the next one by default. Anyone can press `L` (or use
the pause menu) to go **back to the lobby** instead, which is where you'd change
class, mode or map, or wait for someone. One person asking is enough to hold the
room — it isn't a veto on playing, just a detour, and the lobby's normal start
rules take over once you're there. You can take your own request back, and you
can't cancel anyone else's.

**Name tags** are occluded by the map. The figures are real meshes and depth-test
themselves, but a name tag is a DOM element drawn over the whole scene, so
without a line-of-sight check every tag reads straight through walls — a free
wallhack. Teammates are occluded too: friendly fire is off, so knowing exactly
where a teammate is standing behind a wall is information nobody needs.

**Weapons.** Seventeen across eight number-key slots: a knife; three sidearms;
three SMGs; three shotguns; three rifles; three precision rifles; and a support
LMG. The practice range gives you all of them — keys `1`–`8`,
a rack down the side listing each one, and a clickable list in the pause menu.
Gun Game deliberately uses only the first six — eight rungs makes the mode outlast
a three-minute round.

Aiming down sights zooms and tightens spread; the sniper switches to a scope with
its own reticle rather than showing the gun. Reloads are animated (magazine out,
fresh one seated — the shotgun cycles its pump, the sniper works its bolt) and
pull you out of the aimed pose, so a reload never sits over your aim point.

**Maps.** Six competitive arenas rotate between rounds: Warehouse, Rooftops,
Alley, Courtyard, Foundry and Switchyard. Battle Royale uses the much larger
Crown Island, split into eleven named destinations.

**Rooms.** Four-character codes from an alphabet with no `0`/`O`/`1`/`I`, because
people read them out loud. Sharing `https://<host>/#ABCD` *is* the invite — the
code fills itself in. "Quick play" drops you into any room with space.

## Art assets

The game runs entirely on box primitives and still does if nothing below loads —
models and textures are fetched at runtime from `client/public`, and every caller
keeps its procedural version as the fallback. A 404 costs you the nice guns, not
the match.

| What | Where it's used | Source |
|---|---|---|
| 17 weapon models | first-person viewmodels; the character rig supplies 8 simplified held variants for remote players | Toon Shooter Game Kit (Quaternius) |
| `Character_Soldier` | remote players, with the kit's own animation clips | Toon Shooter Game Kit (Quaternius) |
| 16 environment props | crates and solid cover in the maps, plus wall dressing | Toon Shooter Game Kit (Quaternius) |
| 5 surface textures | floors and walls, tiled by world size | 50 Free Stylized Wall Textures |
| 11 terrain and material textures | grass, dirt, roads, water, roofs, masonry, metal and wood | Tiny Texture Packs 1 & 2 (Screaming Brain Studios) |

The Quaternius kit and both Screaming Brain Studios packs are **CC0** (public
domain) — their `License.txt` files say so explicitly. Shipped assets total
~6.2MB, none of it in the JS bundle.

> **The wall-texture pack shipped without a licence file.** Four of the five
> textures in `client/public/textures` derive from it. That's worth resolving
> before this goes anywhere public — either confirm the terms or swap those four
> for something with a licence attached. The models and the game code are
> unaffected.

Source packs live in `Assets/`, which is gitignored: only the small curated subset
under `client/public` is committed.

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

170 tests, no browser needed. They cover the parts where a bug is silent rather
than loud:

- **`shared/collision.js`** — swept AABB movement, ray/box and ray/cylinder
  casts, step-up, ceilings, corners, tunnelling through thin floors. A bug here
  doesn't throw, it just makes the game feel bad.
- **Hit validation** — exposed head/shoulder shots at Rooftops cover edges pass,
  while every reported zone still fails through full-height walls.
- **Map validity** — every spawn clear of geometry, standing on ground, teams far
  enough apart.
- **Map reachability** (`test/navigation.test.js`) — builds a walkable-surface
  graph using the real jump apex and horizontal jump distance, then proves every
  spawn can reach every other. This caught genuinely broken geometry: platforms
  placed above the 1.28m jump height, a staircase that ran underneath the
  balcony it led to, and catwalk stairs that stopped at the underside of their
  own deck.
- **Lobby, class, emote and round-end rules** (`test/lobby.test.js`) — capacity, host
  promotion, the start rules and every way they could deadlock, that a class
  change while alive waits for your next spawn, emotes are allow-listed and
  rate-limited, and a regroup request routes the room to the lobby without
  letting one player cancel another's. Ways a lobby fails to start are invisible
  until eight people are stood around waiting, which is the worst time to find out.

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

Useful flags: `--count`, `--mode tdm|ffa|gungame|waves|br`, `--code ABCD` to join a
specific room, `--duration <seconds>` to auto-report and exit, `--quiet`.

Bots ready up on arrival (so the lobby actually starts) and spread themselves
across the six classes, so a bot match exercises every class rather than eight
assault rifles.

To watch whole round cycles without waiting three minutes each, compress the
phase timers (server-side only):

```bash
ARENA_ROUND_MS=20000 ARENA_COUNTDOWN_MS=2000 ARENA_SCOREBOARD_MS=3000 ARENA_LOBBY_GRACE_MS=5000 npm run dev:server
```

## How it's built

No game engine, no physics engine, no asset pipeline. Three.js for rendering,
`ws` for transport, and about 12,000 lines of plain JavaScript.

```
shared/     imported by BOTH client and server, so they can't disagree
  collision.js   swept AABB + raycasts        <- the load-bearing file
  constants.js   every number that affects feel
  weapons.js     weapon stat table
  protocol.js    message types + snapshot encoding
  maps/          six arenas, Crown Island and the practice range
server/
  index.js       express + ws, room registry, matchmaking
  room.js        room state machine and 20Hz tick
  modes.js       tdm / ffa / gungame / survival / battle royale rules
  validate.js    movement and hit sanity checks
  bot.js         headless load tester (dev tool)
client/src/
  main.js        frame loop and screen state machine
  localPlayer.js movement, aim, firing
  net.js         snapshot buffering and interpolation
  remotePlayers.js, mapRenderer.js, weaponView.js, hud.js, practice.js, audio.js
```

**Collision is boxes.** Maps are arrays of axis-aligned boxes, which is what
lets us skip a physics engine entirely — collision is swept AABB against a box
list. Visual models and textures load separately and fall back to built-in
procedural shapes if an asset is unavailable.

**All sound is synthesised at runtime** with WebAudio — gunshots are a filtered
noise burst plus a low sine thump. No audio files, no licences.

**The viewmodel renders in its own scene** with its own 50° camera. A gun held
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
