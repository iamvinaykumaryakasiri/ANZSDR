# Console frontend (Phase 8)

The console lives in `web/`: React, Vite, TypeScript and Tailwind with its own `package.json` and build. It holds
no business logic. Everything it shows arrives over `/api/console/*`, whose shape is `src/stream/contract.ts`.
The design plan, written before any component, is `web/DESIGN.md`.

## Run it

```bash
cd web && npm install
npm run build              # tsc --noEmit, then vite build -> web/dist
npm run contract:check     # fails if web/src/contract.ts drifts from src/stream/contract.ts
npm run dev                # vite on :5173, /api proxied to http://localhost:8080 (src/web/start.ts, PORT)
```

Open the console and enter `ADMIN_TOKEN` at the gate. It is kept in `sessionStorage` for that tab only and sent
as `Authorization: Bearer ...`. The stream is read with `fetch` rather than `EventSource` because `EventSource`
cannot send that header.

Override the proxy target with `VITE_API_TARGET`.

## Serving it from Fastify later

`web/dist` is a static bundle with absolute `/assets/...` URLs and hash routing (`#/calls`), so the server only
needs to serve `web/dist/index.html` at `/` and `web/dist/assets/*` beside the `/api` routes. Nothing in `src/web/`
was changed for this.

## Dev-only fixture server

`web/dev/fixture-server.mjs` is a plain `node:http` stand-in for the backend with invented data and a looping
live call. It is not imported by anything under `web/src` and is not in the bundle.

```bash
npm run fixture            # :8081, token "demo"   (FIXTURE_STATE=live FIXTURE_LOOP=0 freezes a call mid-air)
npm run dev:fixture        # vite proxying /api to :8081
npm run screenshots        # needs a build; writes web/screenshots/*.png via the machine's Chromium
```

## Gaps the backend could close

- Industry and seniority segmenting of the hang-up curve uses `industry` and `seniority` on `CallLogEntry`
  (now in the contract) and offers those segments only when present.
- Funnel-stage filtering is inferred on the client from call length and outcome (`web/src/lib/callFilter.ts`).
  Server-supplied `callIds` per funnel stage would replace it exactly.
- The Accounts screen is a roll-up of the call log, queue, gatekeeper blocks and meeting desk; the feed has no
  attempts-remaining or per-account learnings.
- The Playbook screen shows each version's change note; the feed carries no diff.
