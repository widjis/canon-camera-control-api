import type { ErrorPayload, JobStatus, MediaAsset } from "./types.js";

export type DeviceConnectionStatus = "unknown" | "online" | "offline" | "error";
export type MediaSyncMode = "disabled" | "metadataOnly";
export type MediaRetentionMode = "edgeManaged" | "controlManaged";

export interface MediaSyncPolicy {
  syncMode: MediaSyncMode;
  retentionMode: MediaRetentionMode;
}

export interface RegisteredEdgeDevice {
  deviceId: string;
  name: string;
  edgeBaseUrl: string;
  authMode: "serviceBearer";
  edgeBearerTokenMasked: string | null;
  status: DeviceConnectionStatus;
  lastSeenAt: string | null;
  registeredAt: string;
  updatedAt: string;
  mediaSyncPolicy: MediaSyncPolicy;
  metadata?: Record<string, unknown>;
}

export interface ControlJobRecord {
  jobId: string;
  type: "probeDevice" | "orchestrateCapture";
  status: JobStatus;
  deviceId: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: unknown | null;
  error: ErrorPayload | null;
}

export interface AuditLogRecord {
  auditId: string;
  actorType: "controlApiClient" | "system";
  actorId: string;
  deviceId: string | null;
  action: string;
  outcome: "accepted" | "succeeded" | "failed";
  correlationId: string | null;
  createdAt: string;
  details: Record<string, unknown>;
}

export interface ControlMediaAsset {
  importedId: string;
  deviceId: string;
  edgeAssetId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  localPath: string;
  cameraPath: string | null;
  sha256: string | null;
  capturedAt: string;
  importedAt: string;
  syncMode: MediaSyncMode;
}

export interface DeviceRegistrationRequest {
  deviceId: string;
  name: string;
  edgeBaseUrl: string;
  edgeBearerToken?: string | null;
  mediaSyncPolicy?: MediaSyncPolicy;
  metadata?: Record<string, unknown>;
}

export interface CaptureOrchestrationRequest {
  captureTarget: "internalRam" | "memoryCard";
  downloadToEdge: boolean;
  keepOnCamera: boolean;
  filenameTemplate?: string;
}

export interface EdgeSessionResponse {
  sessionId: string;
  leaseToken: string;
}

export interface EdgeAcceptedJobResponse {
  jobId: string;
  status: JobStatus;
  type: string;
}

export interface EdgeJobResponse {
  jobId: string;
  status: JobStatus;
  result: {
    cameraPath?: string | null;
    asset?: MediaAsset | null;
  } | null;
  error: ErrorPayload | null;
}
