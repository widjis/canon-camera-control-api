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
