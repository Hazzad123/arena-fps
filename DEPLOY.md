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

**The blueprint asks for the Starter plan ($7/month), on purpose.** Render's free
tier spins a service down after 15 minutes of inactivity and takes ~50 seconds to
wake up. For this game that means every in-progress match dies when it sleeps,
and the first coworker to open the link sits on a blank page for a minute. If
you'd rather try it free first, change `plan: starter` to `plan: free` in
`render.yaml` — just expect the cold starts.

**Never scale past one instance.** `numInstances: 1` is set deliberately. Rooms
live in the server process's memory, so a second instance is a second invisible
set of rooms — someone would share a code that the other instance has never heard
of. If you ever genuinely need to scale, room state has to move into Redis first.

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
