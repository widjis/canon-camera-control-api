# Database Schema Specification

## Overview
This project needs persistence in two places:
- **Edge database** for operational state close to the camera
- **Control server database** for fleet and business-level orchestration

The repository now implements both an edge SQLite database and a first control-plane SQLite database.

## Edge Database (SQLite)

### `device_state`
- `device_id` TEXT PRIMARY KEY
- `registered_at` DATETIME NULL
- `last_boot_at` DATETIME NOT NULL
- `agent_version` TEXT NOT NULL
- `camera_connected` BOOLEAN NOT NULL
- `camera_model` TEXT NULL
- `camera_serial` TEXT NULL
- `camera_firmware` TEXT NULL
- `capabilities_json` TEXT NOT NULL

### `camera_sessions`
- `session_id` TEXT PRIMARY KEY
- `owner_type` TEXT NOT NULL
- `owner_id` TEXT NOT NULL
- `lease_token` TEXT NOT NULL UNIQUE
- `status` TEXT NOT NULL
- `created_at` DATETIME NOT NULL
- `expires_at` DATETIME NOT NULL
- `released_at` DATETIME NULL

### `jobs`
- `job_id` TEXT PRIMARY KEY
- `type` TEXT NOT NULL
- `status` TEXT NOT NULL
- `requested_by` TEXT NOT NULL
- `session_id` TEXT NULL
- `idempotency_key` TEXT NULL
- `request_json` TEXT NOT NULL
- `result_json` TEXT NULL
- `error_code` TEXT NULL
- `error_message` TEXT NULL
- `created_at` DATETIME NOT NULL
- `started_at` DATETIME NULL
- `finished_at` DATETIME NULL

### `job_events`
- `event_id` TEXT PRIMARY KEY
- `job_id` TEXT NOT NULL
- `level` TEXT NOT NULL
- `message` TEXT NOT NULL
- `metadata_json` TEXT NULL
- `created_at` DATETIME NOT NULL

### `media_assets`
- `asset_id` TEXT PRIMARY KEY
- `job_id` TEXT NULL
- `camera_path` TEXT NULL
- `local_path` TEXT NOT NULL
- `filename` TEXT NOT NULL
- `mime_type` TEXT NOT NULL
- `size_bytes` INTEGER NOT NULL
- `sha256` TEXT NULL
- `captured_at` DATETIME NULL
- `stored_on_camera` BOOLEAN NOT NULL
- `stored_locally` BOOLEAN NOT NULL
- `uploaded_to_server` BOOLEAN NOT NULL DEFAULT 0
- `created_at` DATETIME NOT NULL

### `camera_profiles`
- `profile_id` TEXT PRIMARY KEY
- `name` TEXT NOT NULL UNIQUE
- `description` TEXT NULL
- `settings_json` TEXT NOT NULL
- `created_at` DATETIME NOT NULL
- `updated_at` DATETIME NOT NULL
- `last_applied_at` DATETIME NULL

### `app_runtime_settings`
- `key` TEXT PRIMARY KEY
- `value` TEXT NOT NULL
- `updated_at` DATETIME NOT NULL

## Control Server Database (SQLite)

### `control_devices`
- `device_id` TEXT PRIMARY KEY
- `name` TEXT NOT NULL
- `edge_base_url` TEXT NOT NULL
- `edge_bearer_token` TEXT NULL
- `auth_mode` TEXT NOT NULL
- `status` TEXT NOT NULL
- `last_seen_at` DATETIME NULL
- `registered_at` DATETIME NOT NULL
- `updated_at` DATETIME NOT NULL
- `media_sync_policy_json` TEXT NOT NULL
- `metadata_json` TEXT NULL

### `control_jobs`
- `job_id` TEXT PRIMARY KEY
- `type` TEXT NOT NULL
- `device_id` TEXT NOT NULL
- `status` TEXT NOT NULL
- `created_at` DATETIME NOT NULL
- `started_at` DATETIME NULL
- `finished_at` DATETIME NULL
- `result_json` TEXT NULL
- `error_json` TEXT NULL

### `control_audit_logs`
- `audit_id` TEXT PRIMARY KEY
- `actor_type` TEXT NOT NULL
- `actor_id` TEXT NOT NULL
- `device_id` TEXT NULL
- `action` TEXT NOT NULL
- `outcome` TEXT NOT NULL
- `correlation_id` TEXT NULL
- `created_at` DATETIME NOT NULL
- `details_json` TEXT NOT NULL

### `control_media_assets`
- `imported_id` TEXT PRIMARY KEY
- `device_id` TEXT NOT NULL
- `edge_asset_id` TEXT NOT NULL
- `filename` TEXT NOT NULL
- `mime_type` TEXT NOT NULL
- `size_bytes` INTEGER NOT NULL
- `local_path` TEXT NOT NULL
- `camera_path` TEXT NULL
- `sha256` TEXT NULL
- `captured_at` DATETIME NOT NULL
- `imported_at` DATETIME NOT NULL
- `sync_mode` TEXT NOT NULL
- UNIQUE(`device_id`, `edge_asset_id`)

## Notes
- JSON columns can be implemented as TEXT in SQLite and JSONB in PostgreSQL later
- Foreign keys should be added where the target database engine and migration plan support them cleanly
- Status fields should use application-level enums aligned with `docs/openapi.yaml`
- For production, prefer environment variables for runtime app configuration; `app_runtime_settings` is optional and should only be used for non-secret dynamic settings if needed later
- Live camera state must not be persisted as the source of truth because it can change from the camera body outside the application
