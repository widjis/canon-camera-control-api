import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";
import { AppError } from "./errors.js";
import type {
  CameraProfile,
  CreateSessionRequest,
  ErrorPayload,
  JobRecord,
  JobType,
  MediaAsset,
  SessionRecord
} from "./types.js";

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

type SessionRow = {
  session_id: string;
  lease_token: string;
  owner_type: SessionRecord["ownerType"];
  owner_id: string;
  status: SessionRecord["status"];
  created_at: string;
  expires_at: string;
};

type JobRow = {
  job_id: string;
  type: JobRecord["type"];
  status: JobRecord["status"];
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  result_json: string | null;
  error_json: string | null;
};

type MediaRow = {
  asset_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  local_path: string;
  camera_path: string | null;
  sha256: string | null;
  created_at: string;
};

type ProfileRow = {
  profile_id: string;
  name: string;
  description: string | null;
  settings_json: string;
  created_at: string;
  updated_at: string;
  last_applied_at: string | null;
};

export class SqliteStore {
  readonly db: DatabaseSync;

  constructor(config: AppConfig) {
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
    this.db = new DatabaseSync(config.databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS camera_sessions (
        session_id TEXT PRIMARY KEY,
        lease_token TEXT NOT NULL UNIQUE,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NULL UNIQUE,
        created_at TEXT NOT NULL,
        started_at TEXT NULL,
        finished_at TEXT NULL,
        result_json TEXT NULL,
        error_json TEXT NULL
      );

      CREATE TABLE IF NOT EXISTS media_assets (
        asset_id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        local_path TEXT NOT NULL,
        camera_path TEXT NULL,
        sha256 TEXT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS camera_profiles (
        profile_id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NULL,
        settings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_applied_at TEXT NULL
      );
    `);
  }
}

export class SessionStore {
  constructor(private readonly store: SqliteStore) {}

  private expireIfNeeded(): void {
    this.store.db
      .prepare("UPDATE camera_sessions SET status = 'expired' WHERE status = 'active' AND expires_at <= ?")
      .run(new Date().toISOString());
  }

  create(input: CreateSessionRequest): SessionRecord {
    this.expireIfNeeded();

    const active = this.store.db
      .prepare("SELECT * FROM camera_sessions WHERE status = 'active' ORDER BY created_at DESC LIMIT 1")
      .get() as SessionRow | undefined;

    if (active) {
      throw new AppError(409, {
        code: "SESSION_CONFLICT",
        message: "The camera is already leased by another session.",
        details: {
          sessionId: active.session_id,
          ownerType: active.owner_type,
          ownerId: active.owner_id,
          expiresAt: active.expires_at
        }
      });
    }

    const now = new Date();
    const record: SessionRecord = {
      sessionId: crypto.randomUUID(),
      leaseToken: crypto.randomUUID(),
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      status: "active",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.leaseSeconds * 1000).toISOString()
    };

    this.store.db
      .prepare(`
        INSERT INTO camera_sessions (session_id, lease_token, owner_type, owner_id, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.sessionId,
        record.leaseToken,
        record.ownerType,
        record.ownerId,
        record.status,
        record.createdAt,
        record.expiresAt
      );

    return record;
  }

  get(sessionId: string): SessionRecord | null {
    this.expireIfNeeded();
    const row = this.store.db.prepare("SELECT * FROM camera_sessions WHERE session_id = ?").get(sessionId) as SessionRow | undefined;
    return row ? this.mapSession(row) : null;
  }

  getByToken(token: string): SessionRecord | null {
    this.expireIfNeeded();
    const row = this.store.db.prepare("SELECT * FROM camera_sessions WHERE lease_token = ?").get(token) as SessionRow | undefined;
    if (!row || row.status !== "active") {
      return null;
    }
    return this.mapSession(row);
  }

  requireActiveToken(token: string): SessionRecord {
    const session = this.getByToken(token);
    if (!session) {
      throw new AppError(401, {
        code: "INVALID_SESSION",
        message: "A valid X-Session-Token is required."
      });
    }
    return session;
  }

  release(sessionId: string, token: string): void {
    const session = this.get(sessionId);
    if (!session) {
      throw new AppError(404, {
        code: "SESSION_NOT_FOUND",
        message: "The requested session was not found."
      });
    }
    if (session.leaseToken !== token) {
      throw new AppError(401, {
        code: "INVALID_SESSION",
        message: "A valid X-Session-Token is required."
      });
    }

    this.store.db.prepare("UPDATE camera_sessions SET status = 'released' WHERE session_id = ?").run(sessionId);
  }

  private mapSession(row: SessionRow): SessionRecord {
    return {
      sessionId: row.session_id,
      leaseToken: row.lease_token,
      ownerType: row.owner_type,
      ownerId: row.owner_id,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at
    };
  }
}

export class JobStore {
  constructor(private readonly store: SqliteStore) {}

  create(type: JobType, idempotencyKey?: string): JobRecord {
    if (idempotencyKey) {
      const existing = this.store.db
        .prepare("SELECT * FROM jobs WHERE idempotency_key = ? LIMIT 1")
        .get(idempotencyKey) as JobRow | undefined;
      if (existing) {
        return this.mapJob(existing);
      }
    }

    const job: JobRecord = {
      jobId: crypto.randomUUID(),
      type,
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null
    };

    this.store.db
      .prepare(`
        INSERT INTO jobs (job_id, type, status, idempotency_key, created_at, started_at, finished_at, result_json, error_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(job.jobId, job.type, job.status, idempotencyKey ?? null, job.createdAt, null, null, null, null);

    return job;
  }

  get(jobId: string): JobRecord | null {
    const row = this.store.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
    return row ? this.mapJob(row) : null;
  }

  start(jobId: string): void {
    this.store.db
      .prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE job_id = ?")
      .run(new Date().toISOString(), jobId);
  }

  succeed(jobId: string, result: unknown): void {
    this.store.db
      .prepare("UPDATE jobs SET status = 'succeeded', finished_at = ?, result_json = ?, error_json = NULL WHERE job_id = ?")
      .run(new Date().toISOString(), stringifyJson(result), jobId);
  }

  fail(jobId: string, error: ErrorPayload): void {
    this.store.db
      .prepare("UPDATE jobs SET status = 'failed', finished_at = ?, error_json = ? WHERE job_id = ?")
      .run(new Date().toISOString(), stringifyJson(error), jobId);
  }

  private mapJob(row: JobRow): JobRecord {
    return {
      jobId: row.job_id,
      type: row.type,
      status: row.status,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      result: parseJson(row.result_json, null),
      error: parseJson(row.error_json, null)
    };
  }
}

export class MediaStore {
  constructor(private readonly store: SqliteStore) {}

  save(asset: MediaAsset): MediaAsset {
    this.store.db
      .prepare(`
        INSERT INTO media_assets (asset_id, filename, mime_type, size_bytes, local_path, camera_path, sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(asset_id) DO UPDATE SET
          filename = excluded.filename,
          mime_type = excluded.mime_type,
          size_bytes = excluded.size_bytes,
          local_path = excluded.local_path,
          camera_path = excluded.camera_path,
          sha256 = excluded.sha256,
          created_at = excluded.created_at
      `)
      .run(
        asset.assetId,
        asset.filename,
        asset.mimeType,
        asset.sizeBytes,
        asset.localPath,
        asset.cameraPath,
        asset.sha256,
        asset.createdAt
      );

    return asset;
  }

  get(assetId: string): MediaAsset | null {
    const row = this.store.db.prepare("SELECT * FROM media_assets WHERE asset_id = ?").get(assetId) as MediaRow | undefined;
    return row ? this.mapMedia(row) : null;
  }

  private mapMedia(row: MediaRow): MediaAsset {
    return {
      assetId: row.asset_id,
      filename: row.filename,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      localPath: row.local_path,
      cameraPath: row.camera_path,
      sha256: row.sha256,
      createdAt: row.created_at
    };
  }
}

export class ProfileStore {
  constructor(private readonly store: SqliteStore) {}

  list(): CameraProfile[] {
    const rows = this.store.db
      .prepare("SELECT * FROM camera_profiles ORDER BY name ASC")
      .all() as ProfileRow[];
    return rows.map((row) => this.mapProfile(row));
  }

  get(profileId: string): CameraProfile | null {
    const row = this.store.db.prepare("SELECT * FROM camera_profiles WHERE profile_id = ?").get(profileId) as ProfileRow | undefined;
    return row ? this.mapProfile(row) : null;
  }

  create(input: { name: string; description?: string | null; settings: Record<string, string | number | boolean> }): CameraProfile {
    const now = new Date().toISOString();
    const profile: CameraProfile = {
      profileId: crypto.randomUUID(),
      name: input.name,
      description: input.description ?? null,
      settings: input.settings,
      createdAt: now,
      updatedAt: now,
      lastAppliedAt: null
    };

    try {
      this.store.db
        .prepare(`
          INSERT INTO camera_profiles (profile_id, name, description, settings_json, created_at, updated_at, last_applied_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          profile.profileId,
          profile.name,
          profile.description,
          stringifyJson(profile.settings),
          profile.createdAt,
          profile.updatedAt,
          profile.lastAppliedAt
        );
    } catch (error) {
      throw new AppError(409, {
        code: "PROFILE_CONFLICT",
        message: "A profile with that name already exists.",
        details: { cause: error instanceof Error ? error.message : String(error) }
      });
    }

    return profile;
  }

  update(profileId: string, input: { name?: string; description?: string | null; settings?: Record<string, string | number | boolean> }): CameraProfile {
    const current = this.get(profileId);
    if (!current) {
      throw new AppError(404, {
        code: "PROFILE_NOT_FOUND",
        message: "The requested profile was not found."
      });
    }

    const updated: CameraProfile = {
      ...current,
      name: input.name ?? current.name,
      description: input.description === undefined ? current.description : input.description,
      settings: input.settings ?? current.settings,
      updatedAt: new Date().toISOString()
    };

    try {
      this.store.db
        .prepare(`
          UPDATE camera_profiles
          SET name = ?, description = ?, settings_json = ?, updated_at = ?
          WHERE profile_id = ?
        `)
        .run(updated.name, updated.description, stringifyJson(updated.settings), updated.updatedAt, profileId);
    } catch (error) {
      throw new AppError(409, {
        code: "PROFILE_CONFLICT",
        message: "A profile with that name already exists.",
        details: { cause: error instanceof Error ? error.message : String(error) }
      });
    }

    return updated;
  }

  delete(profileId: string): void {
    const result = this.store.db.prepare("DELETE FROM camera_profiles WHERE profile_id = ?").run(profileId);
    if (result.changes === 0) {
      throw new AppError(404, {
        code: "PROFILE_NOT_FOUND",
        message: "The requested profile was not found."
      });
    }
  }

  markApplied(profileId: string): void {
    const profile = this.get(profileId);
    if (!profile) {
      return;
    }

    this.store.db
      .prepare("UPDATE camera_profiles SET last_applied_at = ?, updated_at = updated_at WHERE profile_id = ?")
      .run(new Date().toISOString(), profileId);
  }

  private mapProfile(row: ProfileRow): CameraProfile {
    return {
      profileId: row.profile_id,
      name: row.name,
      description: row.description,
      settings: parseJson<Record<string, string | number | boolean>>(row.settings_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastAppliedAt: row.last_applied_at
    };
  }
}
