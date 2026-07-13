import crypto from "node:crypto";
import { AppError } from "./errors.js";
import type { SqliteStore } from "./stores.js";
import type {
  AuditLogRecord,
  ControlJobRecord,
  ControlMediaAsset,
  DeviceRegistrationRequest,
  MediaSyncPolicy,
  RegisteredEdgeDevice
} from "./control-types.js";
import type { ErrorPayload, JobStatus } from "./types.js";

type DeviceRow = {
  device_id: string;
  name: string;
  edge_base_url: string;
  edge_bearer_token: string | null;
  auth_mode: "serviceBearer";
  status: RegisteredEdgeDevice["status"];
  last_seen_at: string | null;
  registered_at: string;
  updated_at: string;
  media_sync_policy_json: string;
  metadata_json: string | null;
};

type ControlJobRow = {
  job_id: string;
  type: ControlJobRecord["type"];
  status: JobStatus;
  device_id: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  result_json: string | null;
  error_json: string | null;
};

type AuditRow = {
  audit_id: string;
  actor_type: AuditLogRecord["actorType"];
  actor_id: string;
  device_id: string | null;
  action: string;
  outcome: AuditLogRecord["outcome"];
  correlation_id: string | null;
  created_at: string;
  details_json: string;
};

type MediaRow = {
  imported_id: string;
  device_id: string;
  edge_asset_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  local_path: string;
  camera_path: string | null;
  sha256: string | null;
  captured_at: string;
  imported_at: string;
  sync_mode: ControlMediaAsset["syncMode"];
};

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function maskToken(token: string | null): string | null {
  if (!token) {
    return null;
  }
  if (token.length <= 6) {
    return "*".repeat(token.length);
  }
  return `${token.slice(0, 3)}***${token.slice(-3)}`;
}

export class ControlStore {
  constructor(private readonly sqlite: SqliteStore) {
    this.sqlite.db.exec(`
      CREATE TABLE IF NOT EXISTS control_devices (
        device_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        edge_base_url TEXT NOT NULL,
        edge_bearer_token TEXT NULL,
        auth_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        last_seen_at TEXT NULL,
        registered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        media_sync_policy_json TEXT NOT NULL,
        metadata_json TEXT NULL
      );

      CREATE TABLE IF NOT EXISTS control_jobs (
        job_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        device_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT NULL,
        finished_at TEXT NULL,
        result_json TEXT NULL,
        error_json TEXT NULL,
        FOREIGN KEY(device_id) REFERENCES control_devices(device_id)
      );

      CREATE TABLE IF NOT EXISTS control_audit_logs (
        audit_id TEXT PRIMARY KEY,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        device_id TEXT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        correlation_id TEXT NULL,
        created_at TEXT NOT NULL,
        details_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS control_media_assets (
        imported_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        edge_asset_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        local_path TEXT NOT NULL,
        camera_path TEXT NULL,
        sha256 TEXT NULL,
        captured_at TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        sync_mode TEXT NOT NULL,
        UNIQUE(device_id, edge_asset_id),
        FOREIGN KEY(device_id) REFERENCES control_devices(device_id)
      );
    `);
  }

  registerDevice(input: DeviceRegistrationRequest): RegisteredEdgeDevice {
    const now = new Date().toISOString();
    const policy = input.mediaSyncPolicy ?? {
      syncMode: "metadataOnly",
      retentionMode: "edgeManaged"
    };

    this.sqlite.db
      .prepare(`
        INSERT INTO control_devices (
          device_id, name, edge_base_url, edge_bearer_token, auth_mode, status, last_seen_at,
          registered_at, updated_at, media_sync_policy_json, metadata_json
        )
        VALUES (?, ?, ?, ?, 'serviceBearer', 'unknown', NULL, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          name = excluded.name,
          edge_base_url = excluded.edge_base_url,
          edge_bearer_token = excluded.edge_bearer_token,
          updated_at = excluded.updated_at,
          media_sync_policy_json = excluded.media_sync_policy_json,
          metadata_json = excluded.metadata_json
      `)
      .run(
        input.deviceId,
        input.name,
        input.edgeBaseUrl,
        input.edgeBearerToken ?? null,
        now,
        now,
        stringifyJson(policy),
        stringifyJson(input.metadata ?? null)
      );

    return this.requireDevice(input.deviceId);
  }

  listDevices(): RegisteredEdgeDevice[] {
    const rows = this.sqlite.db.prepare("SELECT * FROM control_devices ORDER BY registered_at ASC").all() as DeviceRow[];
    return rows.map((row) => this.mapDevice(row));
  }

  getDevice(deviceId: string): RegisteredEdgeDevice | null {
    const row = this.sqlite.db.prepare("SELECT * FROM control_devices WHERE device_id = ?").get(deviceId) as DeviceRow | undefined;
    return row ? this.mapDevice(row) : null;
  }

  requireDevice(deviceId: string): RegisteredEdgeDevice {
    const device = this.getDevice(deviceId);
    if (!device) {
      throw new AppError(404, {
        code: "DEVICE_NOT_FOUND",
        message: "The requested edge device was not found."
      });
    }
    return device;
  }

  getDeviceSecret(deviceId: string): { edgeBaseUrl: string; edgeBearerToken: string | null } {
    const row = this.sqlite.db.prepare("SELECT edge_base_url, edge_bearer_token FROM control_devices WHERE device_id = ?").get(deviceId) as Pick<DeviceRow, "edge_base_url" | "edge_bearer_token"> | undefined;
    if (!row) {
      throw new AppError(404, {
        code: "DEVICE_NOT_FOUND",
        message: "The requested edge device was not found."
      });
    }
    return {
      edgeBaseUrl: row.edge_base_url,
      edgeBearerToken: row.edge_bearer_token
    };
  }

  markDeviceStatus(deviceId: string, status: RegisteredEdgeDevice["status"], lastSeenAt: string | null): void {
    const result = this.sqlite.db
      .prepare("UPDATE control_devices SET status = ?, last_seen_at = ?, updated_at = ? WHERE device_id = ?")
      .run(status, lastSeenAt, new Date().toISOString(), deviceId);
    if (result.changes === 0) {
      throw new AppError(404, {
        code: "DEVICE_NOT_FOUND",
        message: "The requested edge device was not found."
      });
    }
  }

  updateMediaSyncPolicy(deviceId: string, policy: MediaSyncPolicy): RegisteredEdgeDevice {
    const result = this.sqlite.db
      .prepare("UPDATE control_devices SET media_sync_policy_json = ?, updated_at = ? WHERE device_id = ?")
      .run(stringifyJson(policy), new Date().toISOString(), deviceId);
    if (result.changes === 0) {
      throw new AppError(404, {
        code: "DEVICE_NOT_FOUND",
        message: "The requested edge device was not found."
      });
    }
    return this.requireDevice(deviceId);
  }

  createJob(type: ControlJobRecord["type"], deviceId: string): ControlJobRecord {
    this.requireDevice(deviceId);
    const job: ControlJobRecord = {
      jobId: crypto.randomUUID(),
      type,
      status: "queued",
      deviceId,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null
    };

    this.sqlite.db
      .prepare(`
        INSERT INTO control_jobs (job_id, type, status, device_id, created_at, started_at, finished_at, result_json, error_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(job.jobId, job.type, job.status, job.deviceId, job.createdAt, null, null, null, null);

    return job;
  }

  startJob(jobId: string): void {
    this.sqlite.db.prepare("UPDATE control_jobs SET status = 'running', started_at = ? WHERE job_id = ?").run(new Date().toISOString(), jobId);
  }

  succeedJob(jobId: string, result: unknown): void {
    this.sqlite.db
      .prepare("UPDATE control_jobs SET status = 'succeeded', finished_at = ?, result_json = ?, error_json = NULL WHERE job_id = ?")
      .run(new Date().toISOString(), stringifyJson(result), jobId);
  }

  failJob(jobId: string, error: ErrorPayload): void {
    this.sqlite.db
      .prepare("UPDATE control_jobs SET status = 'failed', finished_at = ?, error_json = ? WHERE job_id = ?")
      .run(new Date().toISOString(), stringifyJson(error), jobId);
  }

  getJob(jobId: string): ControlJobRecord | null {
    const row = this.sqlite.db.prepare("SELECT * FROM control_jobs WHERE job_id = ?").get(jobId) as ControlJobRow | undefined;
    return row ? this.mapJob(row) : null;
  }

  recordAudit(input: Omit<AuditLogRecord, "auditId" | "createdAt">): AuditLogRecord {
    const record: AuditLogRecord = {
      auditId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...input
    };

    this.sqlite.db
      .prepare(`
        INSERT INTO control_audit_logs (
          audit_id, actor_type, actor_id, device_id, action, outcome, correlation_id, created_at, details_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.auditId,
        record.actorType,
        record.actorId,
        record.deviceId,
        record.action,
        record.outcome,
        record.correlationId,
        record.createdAt,
        stringifyJson(record.details)
      );

    return record;
  }

  listAuditLogs(filters: { deviceId?: string; limit?: number }): AuditLogRecord[] {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    if (filters.deviceId) {
      const rows = this.sqlite.db
        .prepare("SELECT * FROM control_audit_logs WHERE device_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(filters.deviceId, limit) as AuditRow[];
      return rows.map((row) => this.mapAudit(row));
    }

    const rows = this.sqlite.db
      .prepare("SELECT * FROM control_audit_logs ORDER BY created_at DESC LIMIT ?")
      .all(limit) as AuditRow[];
    return rows.map((row) => this.mapAudit(row));
  }

  saveImportedMedia(input: Omit<ControlMediaAsset, "importedId" | "importedAt">): ControlMediaAsset {
    const existing = this.sqlite.db
      .prepare("SELECT imported_id FROM control_media_assets WHERE device_id = ? AND edge_asset_id = ?")
      .get(input.deviceId, input.edgeAssetId) as { imported_id: string } | undefined;

    const record: ControlMediaAsset = {
      importedId: existing?.imported_id ?? crypto.randomUUID(),
      importedAt: new Date().toISOString(),
      ...input
    };

    this.sqlite.db
      .prepare(`
        INSERT INTO control_media_assets (
          imported_id, device_id, edge_asset_id, filename, mime_type, size_bytes, local_path, camera_path,
          sha256, captured_at, imported_at, sync_mode
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id, edge_asset_id) DO UPDATE SET
          filename = excluded.filename,
          mime_type = excluded.mime_type,
          size_bytes = excluded.size_bytes,
          local_path = excluded.local_path,
          camera_path = excluded.camera_path,
          sha256 = excluded.sha256,
          captured_at = excluded.captured_at,
          imported_at = excluded.imported_at,
          sync_mode = excluded.sync_mode
      `)
      .run(
        record.importedId,
        record.deviceId,
        record.edgeAssetId,
        record.filename,
        record.mimeType,
        record.sizeBytes,
        record.localPath,
        record.cameraPath,
        record.sha256,
        record.capturedAt,
        record.importedAt,
        record.syncMode
      );

    return record;
  }

  listImportedMedia(deviceId?: string): ControlMediaAsset[] {
    const rows = deviceId
      ? (this.sqlite.db
          .prepare("SELECT * FROM control_media_assets WHERE device_id = ? ORDER BY imported_at DESC")
          .all(deviceId) as MediaRow[])
      : (this.sqlite.db.prepare("SELECT * FROM control_media_assets ORDER BY imported_at DESC").all() as MediaRow[]);
    return rows.map((row) => this.mapMedia(row));
  }

  private mapDevice(row: DeviceRow): RegisteredEdgeDevice {
    return {
      deviceId: row.device_id,
      name: row.name,
      edgeBaseUrl: row.edge_base_url,
      authMode: row.auth_mode,
      edgeBearerTokenMasked: maskToken(row.edge_bearer_token),
      status: row.status,
      lastSeenAt: row.last_seen_at,
      registeredAt: row.registered_at,
      updatedAt: row.updated_at,
      mediaSyncPolicy: parseJson<MediaSyncPolicy>(row.media_sync_policy_json, {
        syncMode: "metadataOnly",
        retentionMode: "edgeManaged"
      }),
      metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined)
    };
  }

  private mapJob(row: ControlJobRow): ControlJobRecord {
    return {
      jobId: row.job_id,
      type: row.type,
      status: row.status,
      deviceId: row.device_id,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      result: parseJson(row.result_json, null),
      error: parseJson<ErrorPayload | null>(row.error_json, null)
    };
  }

  private mapAudit(row: AuditRow): AuditLogRecord {
    return {
      auditId: row.audit_id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      deviceId: row.device_id,
      action: row.action,
      outcome: row.outcome,
      correlationId: row.correlation_id,
      createdAt: row.created_at,
      details: parseJson<Record<string, unknown>>(row.details_json, {})
    };
  }

  private mapMedia(row: MediaRow): ControlMediaAsset {
    return {
      importedId: row.imported_id,
      deviceId: row.device_id,
      edgeAssetId: row.edge_asset_id,
      filename: row.filename,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      localPath: row.local_path,
      cameraPath: row.camera_path,
      sha256: row.sha256,
      capturedAt: row.captured_at,
      importedAt: row.imported_at,
      syncMode: row.sync_mode
    };
  }
}
