# Product Principles

## 1. Capability-Driven API
The API must expose what the connected camera can actually do instead of assuming every model supports every feature. Unsupported actions should fail clearly with machine-readable capability errors.

## 2. Local Control, Remote Orchestration
Time-sensitive camera control happens on the edge device. Higher-level scheduling, policy, and fleet management belong on the control server.

## 3. Safe By Default
Operations that change camera state or storage must be explicit. Media deletion, destructive file handling, or mode switching must never happen implicitly.

## 4. Single-Owner Camera Session
The edge device must serialize camera access. Only one active operation pipeline controls the camera at a time to avoid `device busy` and inconsistent state.

## 5. Jobs For Long-Running Operations
Capture, bulk download, and record workflows must return a job handle when they cannot complete within a normal request window.

## 6. Auditability
Every remote action should be attributable to a requester, correlated with a job, and reconstructable from logs and metadata.

## 7. Hardware-Aware Abstraction
The public API should be stable even if the implementation later swaps from `gphoto2` to Canon SDK or another adapter. Hardware-specific details belong in the adapter layer and capability model.

## 8. Incremental Delivery
Still capture, preview, and settings management are first-class initial goals. Movie recording, advanced focus workflows, and multi-device fleet operations expand in later phases.
