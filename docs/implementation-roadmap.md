# Implementation Roadmap

## Phase 0 - Documentation And Contract Baseline
- **Objective**: establish the product scope, architecture, API contract, and planning baseline for the Canon Camera API platform.
- **Source documents**:
  - `docs/project-plan.md`
  - `docs/product-principles.md`
  - `docs/functional-specification.md`
  - `docs/technical-implementation-plan.md`
  - `docs/database-schema-specification.md`
  - `docs/openapi.yaml`
  - `docs/open-questions-and-challenges.md`
- **Checklist**:
  - [x] Define product scope and architecture split between edge device and control server
  - [x] Define API design approach for the edge Camera API
  - [x] Draft `docs/openapi.yaml` for the edge HTTP contract
  - [x] Record open questions and technical challenges
- **Output**:
  - documentation baseline under `docs/`
  - first OpenAPI contract for edge integration
- **Challenge / Verification**:
  - `docs/openapi.yaml` parsed successfully with Ruby YAML loader
  - required top-level docs were created and linked by the roadmap

## Phase 1 - Edge Runtime Skeleton
- **Objective**: implement a bootable edge service with health, device status, session locking, and job framework.
- **Source documents**:
  - `docs/functional-specification.md`
  - `docs/technical-implementation-plan.md`
  - `docs/openapi.yaml`
- **Checklist**:
  - [x] Create project structure for the edge service
  - [x] Implement health and device endpoints
  - [x] Implement session manager and single-writer lock
  - [x] Implement job storage and job status endpoint
- **Output**:
  - running TypeScript edge service skeleton using Fastify
  - `gphoto2` adapter-backed device, config, capture, storage, and preview endpoints
- **Challenge / Verification**:
  - `npm run build` passed
  - `npm test` passed with health, session-conflict, and session-required capture checks
  - runtime verification passed:
    - `GET /v1/health` returned `200`
    - `POST /v1/sessions` created a lease
    - second `POST /v1/sessions` returned `409 SESSION_CONFLICT`
    - `DELETE /v1/sessions/{id}` returned `204`
  - `docs/openapi.yaml` reviewed; no contract change was required during this implementation pass

## Phase 2 - Canon `gphoto2` Adapter
- **Objective**: implement the Canon adapter and normalize camera capabilities and settings.
- **Source documents**:
  - `docs/functional-specification.md`
  - `docs/technical-implementation-plan.md`
  - `docs/openapi.yaml`
- **Checklist**:
  - [ ] Implement camera discovery and capability mapping
  - [ ] Implement status and configuration read/write
  - [ ] Normalize adapter errors into API errors
  - [ ] Record verified Canon EOS R50 mappings
  - [ ] Keep live config camera-sourced and avoid treating local storage as the source of truth
- **Output**:
  - working adapter behind the edge API
- **Challenge / Verification**:
  - Canon EOS R50 is detected through the service
  - config read/write works for verified keys
  - `docs/openapi.yaml` reviewed and updated with any contract adjustments

## Phase 3 - Capture, Preview, And Media
- **Objective**: expose preview, still capture, and file workflows.
- **Source documents**:
  - `docs/functional-specification.md`
  - `docs/technical-implementation-plan.md`
  - `docs/openapi.yaml`
- **Checklist**:
  - [ ] Implement preview endpoint
  - [ ] Implement still capture job with download options
  - [ ] Implement storage listing and file download
  - [ ] Implement local media catalog
  - [ ] Add SQLite-backed camera profiles/presets separate from live camera state
- **Output**:
  - production-usable still capture path
- **Challenge / Verification**:
  - preview returns a valid image
  - capture creates a valid JPEG and stores metadata
  - `docs/openapi.yaml` reviewed and updated with any contract adjustments

## Phase 4 - Control Server Integration
- **Objective**: connect the edge Camera API to a central control plane.
- **Source documents**:
  - `docs/project-plan.md`
  - `docs/technical-implementation-plan.md`
  - `docs/openapi.yaml`
  - `docs/open-questions-and-challenges.md`
- **Checklist**:
  - [ ] Define control-plane auth and trust model
  - [ ] Implement device registration and connectivity strategy
  - [ ] Implement audit logging and orchestration flows
  - [ ] Define media upload/sync policy
  - [ ] Keep runtime application config environment-driven in production
- **Output**:
  - remotely orchestrated edge node
- **Challenge / Verification**:
  - control server can invoke a remote capture end-to-end
  - audit log captures the request trail
  - `docs/openapi.yaml` reviewed and updated with any contract adjustments
