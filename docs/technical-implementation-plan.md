# Technical Implementation Plan

## Active Phase
Phase 4: Control server integration

## Source Documents
- `docs/project-plan.md`
- `docs/product-principles.md`
- `docs/functional-specification.md`
- `docs/openapi.yaml`
- `docs/implementation-roadmap.md`
- `docs/open-questions-and-challenges.md`

## Architecture Summary

### Edge Device
Runs next to the camera on a mini PC, NUC, Raspberry Pi-class device, or similar Linux/macOS host.

Responsibilities:
- Own exclusive USB communication with the camera
- Translate API requests into adapter operations
- Normalize camera state and configuration
- Store job metadata and local media metadata
- Expose a stable HTTP API

### Control Server
Runs centrally and manages:
- device inventory
- authentication and authorization
- workflow scheduling
- audit trails
- automation policies
- remote operator access

The control server should call the edge API through a private network, VPN, reverse proxy, or tunnel initiated from the edge side. Do not expose the edge API directly to the public internet.

Control-plane implementation baseline now includes:
- device registration with per-edge bearer credentials stored server-side
- connectivity probe jobs against edge `/v1/health` and `/v1/device`
- orchestration jobs that lease the edge session, trigger capture, poll the edge job, and release the lease
- audit trail storage for accepted, succeeded, and failed control actions
- metadata-only media import from the edge into the control-plane catalog

## Edge Runtime Components

### 1. API Layer
- REST endpoints for health, capabilities, status, sessions, capture, preview, config, storage, files, and jobs
- Request validation and response normalization
- Correlation ID propagation

### 2. Camera Session Manager
- Enforces single active writer
- Owns a renewable lease token
- Queues or rejects conflicting requests
- Coordinates clean reconnect behavior

### 3. Operation Queue
- Serial execution for camera commands
- Supports synchronous fast paths and asynchronous job execution
- Records start time, end time, attempts, and failure reason

### 4. Canon Adapter
- Initial implementation: `gphoto2` / `libgphoto2`
- Maps public API keys to adapter commands and raw config paths
- Handles Canon-specific toggles such as capture enablement and storage target
- Normalizes adapter errors into stable API errors

### 5. Media Spool
- Stores downloaded assets on local disk
- Persists metadata in SQLite
- Supports retention policies and downstream upload to the control server later

### 6. State Store
- SQLite recommended for the edge node
- Stores device registration, leases, jobs, events, media metadata, and saved camera profiles

### 7. Runtime Configuration
- Runtime application configuration should come from environment variables, typically via a `.env` file in development and injected environment variables in production
- Examples include host, port, device ID, auth token, media directory, and adapter feature flags
- Runtime configuration is application-owned and should not be mixed with camera live state

## Canon Adapter Strategy

### Public API Keys
Expose stable keys such as:
- `captureEnabled`
- `captureTarget`
- `iso`
- `shutterSpeed`
- `aperture`
- `whiteBalance`
- `focusMode`
- `driveMode`
- `batteryLevel`

### Adapter Mapping
Maintain a mapping table from public keys to `gphoto2` config paths, for example:
- `captureEnabled` -> `/main/settings/capture`
- `captureTarget` -> `/main/settings/capturetarget`
- `iso` -> `/main/imgsettings/iso`
- `shutterSpeed` -> `/main/capturesettings/shutterspeed`
- `aperture` -> `/main/capturesettings/aperture`

Do not expose raw `gphoto2` paths as the primary public contract. Keep them available in debug metadata only.

## Config And Profile Strategy
- Live camera state remains camera-owned and should be queried from the camera when needed
- API reads for current settings should reflect the camera's current state, not a cached JSON snapshot
- Reusable camera presets/profiles should be stored locally on the edge device in SQLite
- Applying a profile means translating the stored desired values into adapter write operations against the camera
- Profiles and runtime application config serve different purposes and should be modeled separately

## API Style Decisions
- Use REST for request/response control flows
- Use job resources for long-running operations
- Use idempotency keys on mutating endpoints where retries are expected
- Use typed error payloads with a stable `code`
- Return discovered capabilities on the device resource instead of separate hardcoded assumptions

## Recommended Deployment Topology

### Edge Node
- `camera-agent` process
- local media directory
- SQLite database
- system service supervisor (`launchd` on macOS during development, `systemd` on Linux in production)

### Control Plane
- API server
- SQLite for the first implementation, with a later path to PostgreSQL
- object storage for uploaded media later; first implementation keeps metadata-only sync
- message queue for automation workflows later; first implementation uses background jobs in-process
- admin UI or client applications

## Recommended Technology Choices
- Edge service: Node.js + TypeScript or Go
- Local persistence: SQLite
- Central control server: Node.js + TypeScript
- Object storage: S3-compatible
- Reverse connectivity: Tailscale, WireGuard, or outbound tunnel
- Runtime app config: environment variables (`.env` for development)

## Failure Handling
- If camera disconnects during an operation, mark the job failed with `CAMERA_DISCONNECTED`
- If the adapter reports busy state, return `CAMERA_BUSY` or queue the job
- If a config is unsupported, return `CAPABILITY_NOT_SUPPORTED`
- If media download fails after capture, preserve camera file when possible and report partial result

## Security Model
- Signed bearer tokens between control server clients and the control API
- Service bearer tokens between control server and edge API
- Per-request correlation ID
- Audit fields: actor, source, session ID, job ID
- No shell access should be required for normal operations

## Phase 4 Decisions
- Keep runtime application config environment-driven in both services via `.env` in development and injected env vars in production
- Keep edge bearer credentials server-side and expose only masked values in control responses
- Default media sync policy to `metadataOnly` plus `edgeManaged` retention until binary upload is designed
- Treat orchestration as job-based even when edge operations themselves already create jobs, so the control plane has its own audit and retry boundary
