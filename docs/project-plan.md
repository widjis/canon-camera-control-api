# Camera Control Project Plan

## Goal
Build a production-ready camera automation platform for Canon cameras, starting with Canon EOS R50, where:
- an edge device (mini PC) connects to the camera over USB and exposes a stable HTTP API,
- a control server orchestrates one or more edge devices remotely,
- camera capabilities are abstracted behind a vendor-aware but product-stable contract.

## Problem Statement
Direct camera control through `gphoto2` is powerful but too low-level for fleet automation, remote orchestration, auditability, and product integration. We need an application layer that converts camera state, settings, capture, preview, and media workflows into a durable API.

## Primary Deliverables
- Edge Camera API running on a mini PC or similar host
- Control server for remote orchestration, access control, audit, and fleet management
- OpenAPI contract for the edge API
- Operational documentation for deployment, verification, and future implementation

## Scope For Initial Platform
- Single attached camera per edge device
- Canon EOS R50 as the first hardware target
- USB control via `gphoto2` / `libgphoto2`
- Still capture, preview, camera status, configuration read/write, storage browsing, file download, and action endpoints
- Local media cache and job tracking on the edge device
- Server-to-edge orchestration over a trusted network path, reverse proxy, or tunnel

## Out Of Scope For First Release
- Native Canon SDK integration
- Multi-camera concurrency on the same edge device
- High-frame-rate true video streaming
- Full offline workflow synchronization between edge and server
- Public internet exposure of the edge API without a gateway or tunnel

## Success Criteria
- The edge API can detect the camera, expose capabilities, and perform real still capture reliably
- The control server can invoke edge actions without requiring shell access
- Every backend contract is documented in `docs/openapi.yaml`
- The platform can grow to additional Canon models without breaking the public API
