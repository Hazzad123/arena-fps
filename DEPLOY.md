# Hosting Arena on Render

The repo already contains everything Render needs: a `Dockerfile` and a
`render.yaml` blueprint. You don't have to configure the service by hand.

## 1. Push to GitHub

The repo is initialised and committed locally but has **not** been pushed
anywhere. Create the remote and push:

```bash
gh repo create arena-fps --private --source=. --remote=origin --push
```

Use `--public` instead of `--private` if you don't mind it being public. Render
works with private repos either way.

## 2. Create the service on Render

1. Go to **dashboard.render.com** and sign in with GitHub.
2. **New → Blueprint.**
3. Pick the `arena-fps` repo. Render finds `render.yaml` and shows one web
   service called `arena`.
4. Click **Apply**.

First build takes roughly 2–4 minutes (it's installing dependencies and running
the Vite build inside Docker). You'll get a URL like
`https://arena-xxxx.onrender.com`.

## 3. Share it

That URL is the invite. A room code goes on the end:

```
https://arena-xxxx.onrender.com/#7KQP
```

Anyone who opens that gets the code pre-filled and just presses Join. Or they hit
the bare URL and press **Quick play**.

Check it's alive any time:

```bash
curl https://arena-xxxx.onrender.com/api/health
```

---

## Things that will bite you if you don't know them

**It's on the free plan, and the cold start is the only real downside.** Render
spins a free service down after 15 minutes with no traffic, and the next request
takes ~50 seconds to wake it.

That matters less than it sounds. The spin-down only happens when nobody is
playing, and players generate traffic, so it won't drop a live match out from
under you. The cost is that the first person to open the link after a quiet spell
waits about a minute. In practice: open the link yourself a minute before you tell
everyone, and nobody notices.

If the wait does annoy you, two options:

- **Keep it warm for free.** Point a free uptime pinger (uptimerobot.com,
  cron-job.org) at `https://your-app.onrender.com/api/health` every 10 minutes.
  That counts as traffic, so it never sleeps. Free web services get 750
  instance-hours a month, which is just about a full month of uptime for one
  service — so this fits, but it is the entire allowance.
- **Pay the $7.** Render's Starter plan doesn't sleep. Worth being clear about
  what that does and doesn't buy: it removes the cold start, it does **not** make
  matches survive a restart or redeploy. Rooms live in process memory either way.

**Never scale past one instance.** The free plan is single-instance, so this is
only a concern if you upgrade — at which point add `numInstances: 1` to
`render.yaml`. Rooms live in the server process's memory, so a second instance is
a second invisible set of rooms: someone would share a code the other instance has
never heard of. Genuinely scaling this needs room state moved into Redis first.

**A redeploy ends live matches.** Same reason. Push during lunch, not mid-game.

**Region.** `render.yaml` uses `frankfurt`, the closest Render region to the UK.
Change it to `oregon`, `ohio`, `virginia` or `singapore` if your team sits
elsewhere — ping is the one performance factor you control, and a shooter feels
it more than most.

**WebSockets** work on Render with no configuration. Nothing to enable.

**`autoDeploy: true`** means every push to the default branch redeploys. Turn it
off in the Render dashboard if you'd rather deploy deliberately.

---

## If the build fails

Check the build log in the Render dashboard first. The two likely causes:

- **`npm ci` fails** — `package-lock.json` is out of sync with `package.json`.
  Run `npm install` locally, commit the lockfile, push.
- **Health check failing, service restarts in a loop** — the server isn't
  listening on Render's injected `PORT`. It reads `process.env.PORT` and should be
  fine, but confirm nothing has pinned `PORT` in the Render dashboard's env vars.

To reproduce the exact production setup locally without Docker:

```bash
npm run build && NODE_ENV=production PORT=3000 node server/index.js
```

Then open http://localhost:3000 — this is the same code path Render runs, with
the Node server serving the built client itself rather than Vite.
