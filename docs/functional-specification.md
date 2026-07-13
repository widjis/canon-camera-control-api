# Functional Specification

## Product Overview
The product is a two-tier camera automation platform:
- **Edge Camera API** on a mini PC connected to a Canon camera
- **Control Server** that manages devices, users, automation workflows, and remote operations

The edge API is the source of truth for live camera control. The control server is the source of truth for orchestration, access policy, and history.

## Primary Actors
- **Operator**: manually controls a camera through an application or admin panel
- **Automation Service**: triggers captures or configuration changes programmatically
- **Control Server**: trusted backend that calls the edge API
- **Edge Runtime**: local service that owns USB access to the camera

## Core Functional Areas

### 1. Device and Camera Discovery
- Report edge device identity, runtime version, health, and connected camera state
- Report camera metadata: manufacturer, model, serial number, firmware, battery, storage, and capability set
- Expose connection state transitions: disconnected, detecting, ready, busy, error

### 2. Capability Discovery
- Return machine-readable supported actions such as:
  - still capture
  - preview capture
  - movie recording
  - autofocus
  - manual focus steps
  - config read/write
  - storage listing
  - file download/delete
- Return supported configuration keys and current values

### 3. Camera Session and Locking
- Allow the control server to claim exclusive control over a camera session
- Support heartbeat or lease renewal for long workflows
- Reject conflicting writes when another session owns the camera

### 4. Status and Configuration
- Read camera status and normalized settings
- Set supported configuration values by stable API keys
- Treat live camera configuration as camera-owned state and read it from the camera when needed
- Preserve raw adapter key mappings internally for troubleshooting

### 4A. Runtime Configuration And Saved Profiles
- Store runtime application configuration outside the codebase using environment variables
- Store reusable camera presets/profiles locally on the edge device
- Allow profiles to represent desired camera settings without claiming to be the live current state
- Apply profiles by writing the desired settings to the camera through the adapter layer

### 5. Still Capture
- Trigger capture to internal RAM or memory card
- Optionally download the resulting file to the edge host
- Optionally keep or delete the file on the camera after download
- Return job metadata, downloaded asset metadata, and camera file metadata

### 6. Preview and Live View
- Return a current preview frame as an image
- Support live-view activation if the camera model exposes it
- Expose preview unavailability as a capability/state issue instead of a generic error

### 7. Focus and Shutter Actions
- Trigger autofocus
- Move focus by relative steps when supported
- Trigger remote shutter release
- Surface unsupported focus modes cleanly

### 8. Media Management
- List camera storage volumes, folders, and files
- Download individual files from the camera
- Delete files only on explicit request
- Track downloaded files in a local media catalog on the edge device

### 9. Jobs and Events
- Track long-running operations with state transitions:
  - queued
  - running
  - succeeded
  - failed
  - cancelled
- Expose job status and recent events for debugging and orchestration

### 10. Control-Plane Device Registry
- Register edge devices with a trusted base URL and service credential
- Expose current device connectivity state from control-plane probes
- Keep sensitive edge credentials server-side and return only masked metadata

### 11. Control-Plane Orchestration And Audit
- Allow the control server to probe an edge node before work
- Allow the control server to lease the edge session, trigger capture, poll the edge job, and release the session
- Record audit entries for accepted, succeeded, and failed orchestration actions
- Persist control-plane job state separately from edge job state

### 12. Media Sync Policy
- Store a per-device media sync policy in the control plane
- Start with metadata-only import from edge media assets into the control catalog
- Keep binary upload/object storage as a later phase rather than pretending it already exists

## Non-Functional Requirements
- Single-writer access to the camera
- Stable API independent of adapter internals
- Structured logging and correlation IDs
- Graceful handling of camera disconnect/reconnect
- Timeout and retry policies for transient USB errors
- Minimal local persistence using SQLite or equivalent

## Initial Assumptions
- One physical camera per edge node
- Canon EOS R50 is the first verified target
- Edge nodes are on trusted infrastructure and are not directly public
- The control server authenticates to edge nodes using service credentials and transport security
- Runtime application configuration is provided through `.env` or environment variables
- Saved camera profiles/presets are stored locally and are separate from live camera state
