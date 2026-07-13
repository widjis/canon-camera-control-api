# Camera Control

Camera Control is a Canon camera automation platform built around an edge API that runs close to the camera and a control server that orchestrates it remotely.

## Source Of Truth
- Product and architecture docs live in `docs/`
- API contract lives in `docs/openapi.yaml`
- Agent workflow rules live in `AGENT.md`

## Current Status
- Canon EOS R50 has been verified locally with `gphoto2`
- The repository now includes the first TypeScript edge API skeleton

## Development
1. Install dependencies:
   - `npm install`
2. Start the edge API:
   - `npm run dev`
3. Build for production:
   - `npm run build`
4. Run tests:
   - `npm test`

## Important Runtime Notes
- Canon EOS R50 should use `Photo Import/Remote Control`
- Wi-Fi/Bluetooth should be disabled for USB control
- On macOS, host processes such as `icdd`, `photolibraryd`, and `PTPCamera` may need to be stopped before `gphoto2` claims the camera
