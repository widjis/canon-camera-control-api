# Deployment And Environment

## Services

### Edge API
- entrypoint: `src/index.ts`
- dev command: `npm run dev:edge`
- prod command: `npm run start:edge`
- default port: `3000`

### Control Server
- entrypoint: `src/control-index.ts`
- dev command: `npm run dev:control`
- prod command: `npm run start:control`
- default port: `4000`

## Environment Strategy
- Development: `.env`
- Production: injected environment variables

### Edge Variables
- `HOST`
- `PORT`
- `DEVICE_ID`
- `DATA_DIR`
- `DATABASE_PATH`
- `MEDIA_DIR`
- `API_BEARER_TOKEN`
- `PREPARE_DARWIN_PROCESSES`

### Control Variables
- `CONTROL_HOST`
- `CONTROL_PORT`
- `CONTROL_DATA_DIR`
- `CONTROL_DATABASE_PATH`
- `CONTROL_API_BEARER_TOKEN`
- `CONTROL_JOB_POLL_INTERVAL_MS`
- `CONTROL_JOB_POLL_TIMEOUT_MS`

## Recommended Topology
- Edge node: Linux mini PC with camera attached over USB and `gphoto2` installed
- Control server: private backend host on the same private network or reachable over VPN/tunnel
- Connectivity: control server calls edge API over a trusted address; do not depend on public inbound exposure

## Windows Note
- The control server is cross-platform and can be wrapped as a Windows service if needed
- The edge node remains Linux-first for `gphoto2` reliability

## Docker

- `Dockerfile` is a multi-stage build: `builder` compiles TypeScript with `npm run build`, `runtime` installs production dependencies and the `gphoto2` CLI (Debian `bookworm-slim` base) and runs `dist/*.js`
- `docker-compose.yml` defines both services from the same image, selecting the entrypoint via `command`:
  - `edge`: `node dist/index.js`, published on host port `30000`
  - `control`: `node dist/control-index.js`, published on host port `40000`
- Ports were intentionally moved to 5-digit values to avoid collisions with common 4-digit dev ports already in use on shared hosts
- `edge_data` and `control_data` named volumes persist SQLite databases and downloaded media across container restarts
- Both services define a `healthcheck` (Node's built-in `fetch` against their own health endpoint) so `docker compose ps` and any orchestrator can detect a stuck container instead of only a stopped one
- Bearer auth stays optional by default, matching `src/config.ts`: `API_BEARER_TOKEN` / `CONTROL_API_BEARER_TOKEN` are read via `${VAR:-}` substitution from a `.env` file next to `docker-compose.yml` (not hardcoded in the compose file), and auth is only enforced once a real value is set
- Usage: `docker compose up -d --build`, then `docker compose down` to stop

### Production (Linux edge host) — USB Passthrough

- `docker-compose.prod.yml` is an override that adds `/dev/bus/usb` device passthrough to the `edge` service; it is intentionally kept out of the base `docker-compose.yml` because Docker Desktop on Windows/macOS runs containers inside a VM and fails to start the container outright if that device path does not exist on the host
- Deploy to the real Linux edge node with both files layered: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`
- Verified on this development machine (Windows, Docker Desktop): the base compose file builds, starts, and reports both services `healthy` on ports `30000`/`40000`; adding the `devices` mapping directly (without the override split) fails Docker Desktop with `error gathering device information ... no such file or directory`, confirming the override approach is required for cross-platform development against a production-bound compose setup
- Real camera capture through the `edge` container itself has not yet been verified end-to-end on a native Linux Docker host — do that check before relying on the container in production
