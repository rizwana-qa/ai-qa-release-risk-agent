# Deployment

## What has to run

This is **not** a static site. `api/server.ts` is one long-lived Node process that
serves, from the same port:

- the dependency-free frontend (`web/`),
- the JSON assessment API (`/api/assess/custom`, …),
- the Server-Sent-Events progress stream,
- a per-assessment pipeline that **spawns `node src/pipelineCli.ts` child
  processes** and writes short-lived temp files under `.pipeline-run/`.

So it needs a real Node runtime with a writable filesystem and the ability to
spawn subprocesses — a container or a VM, not an edge/serverless function, and
not a static host. It also runs TypeScript directly (`node api/server.ts`), which
needs **Node ≥ 23.6**.

## Recommended platform: Render — Docker web service

| Why | |
| --- | --- |
| Runs a persistent container process — SSE, child processes and temp files all work | ✅ |
| Free tier, HTTPS + public URL out of the box, health checks, Git-push deploys (no CLI login) | ✅ |
| Built from the `Dockerfile`, so the runtime is pinned to Node 24 regardless of the platform default | ✅ |
| The same image runs unchanged on Railway, Fly.io or Google Cloud Run — no lock-in | ✅ |

`render.yaml` in the repo root is a ready blueprint. Railway (Nixpacks) also works
with no config: it reads `engines.node` and runs `npm start`.

## Deploy steps (Render)

1. Push this repository to GitHub.
2. Render dashboard → **New +** → **Blueprint** → pick the repo. Render reads
   `render.yaml` and creates the service.
3. First build + deploy takes a few minutes. Render gives you a URL like
   `https://ai-qa-release-risk-agent.onrender.com`.
4. Verify:
   ```bash
   node scripts/verify-deployment.mjs https://<your-app>.onrender.com
   ```

No secrets are required.

## Environment variables

| Variable | Required? | Notes |
| --- | --- | --- |
| `PORT` | injected by the platform | server reads `process.env.PORT` (falls back to 8080) |
| `HOST` | set by `render.yaml` / `Dockerfile` to `0.0.0.0` | must be `0.0.0.0` (or `::`) in a container so the platform router can reach it; defaults to loopback for local `npm run demo` |
| `NODE_ENV` | set to `production` | |
| `GEMINI_API_KEY` | **optional** | enables a live Gemini 3.6 Flash analysis for both the built-in `REQ-BEN-001` fixture and user-submitted custom assessments. If unset, or if a Gemini call fails to produce valid findings, the app falls back to the existing rules-based analysis. Set it in the Render dashboard — never commit it. |

## Commands

| Purpose | Command |
| --- | --- |
| Production start (what the container runs) | `node api/server.ts` (`npm start`) |
| Local dev | `npm run demo` → http://localhost:8080 |
| Build image locally | `docker build -t ai-qa-release-risk-agent .` |
| Run image locally | `docker run --rm -p 8080:8080 ai-qa-release-risk-agent` |
| Post-deploy verification | `node scripts/verify-deployment.mjs <url>` |
| Full test suite | `npm run check` · browser test: `npm run test:e2e` |

## Notes / later

- Render's **free** web service cold-starts (~50 s) after 15 min idle. Fine for a
  portfolio demo; upgrade the plan or use a keep-warm ping if that matters.
- Temp files under `.pipeline-run/` are per-request and deleted on completion; the
  container filesystem is ephemeral, which is exactly what this needs.
- No database, no auth, no persistence — every assessment is standalone.
