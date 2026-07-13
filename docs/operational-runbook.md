# Operational Runbook

## Edge Bring-Up
1. Connect the Canon camera over USB
2. Set camera USB mode to `Photo Import/Remote Control`
3. Disable Wi-Fi and Bluetooth on the camera if USB control is unstable
4. Start the edge API
5. Verify `GET /v1/health` and `GET /v1/device`

## Control Bring-Up
1. Start the control server
2. Register the edge node with its base URL and bearer token
3. Probe the edge node from the control API
4. Confirm device status changes to `online`

## Remote Capture Flow
1. Control server creates an edge session
2. Control server triggers edge `/v1/captures`
3. Control server polls the edge job until completion
4. Control server releases the edge session
5. Control server records audit entries and imports media metadata if policy allows

## Failure Notes
- `SESSION_CONFLICT`: another actor still owns the edge lease
- `CAMERA_DISCONNECTED`: camera USB state changed mid-operation
- `EDGE_JOB_TIMEOUT`: control server gave up waiting for the edge job to finish
- `CAPABILITY_NOT_SUPPORTED`: the camera body or current state does not expose that config/action

## Verification Checklist
- `npm run build`
- `npm test`
- edge device registration succeeds
- edge probe succeeds
- remote capture orchestration reaches `succeeded`
- audit log contains accepted and terminal events
