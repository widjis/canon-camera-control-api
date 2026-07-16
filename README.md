# Camera Control

Camera Control is a Canon camera automation platform built around an edge API that runs close to the camera and a control server that orchestrates it remotely.

## Source Of Truth
- Product and architecture docs live in `docs/`
- API contract lives in `docs/openapi.yaml`
- Agent workflow rules live in `AGENT.md`

## Current Status
- Canon EOS R50 has been verified locally with `gphoto2`
- The repository now includes both the TypeScript edge API and the first control server

## Development
1. Install dependencies:
   - `npm install`
2. Configure runtime environment:
   - copy values from `.env.example` into a local `.env`
3. Start the edge API:
   - `npm run dev:edge`
4. Start the control server:
   - `npm run dev:control`
5. Build for production:
   - `npm run build`
6. Run tests:
   - `npm test`
7. Or run both services with Docker:
   - local/dev (no camera passthrough): `docker compose up -d --build`
   - production Linux edge host (with camera passthrough): `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`
   - edge API: `http://localhost:30000`, control server: `http://localhost:40000`
   - see `docs/deployment-and-environment.md` for volumes, ports, health checks, and why USB passthrough is a separate override file

## Helper Scripts
- `scripts/test-gphoto2-camera.sh`: low-level `gphoto2` visibility and compatibility checks on the edge host
- `scripts/test_capture.py`: edge API capture helper that can:
  - create and release a camera session automatically
  - apply one or more camera config values with repeatable `--set key=value`
  - trigger still capture to `internalRam` or `memoryCard`
  - choose whether the image is downloaded to the edge and/or kept on the camera
  - optionally download the resulting image from the edge API to your local machine

Example:
- `python scripts/test_capture.py --edge-base-url http://10.60.20.196:3000 --set iso=100 --set aperture=6.3 --download-local-dir downloads`

## Runtime Split
- `src/index.ts` boots the edge API that owns camera USB access
- `src/control-index.ts` boots the control server that registers edge nodes, probes them, orchestrates captures, and records audit logs
- Runtime app config stays in environment variables or `.env`
- Saved camera presets/profiles stay in SQLite on the edge node
- Live camera config is queried from the camera when needed and is not treated as cached local truth

## Important Runtime Notes
- Canon EOS R50 should use `Photo Import/Remote Control`
- Wi-Fi/Bluetooth should be disabled for USB control
- On macOS, host processes such as `icdd`, `photolibraryd`, and `PTPCamera` may need to be stopped before `gphoto2` claims the camera
- For the first production path, prefer Linux for the edge node even though the control server remains cross-platform
