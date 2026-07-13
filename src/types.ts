export type HealthStatus = "ok" | "degraded";
export type ConnectionState = "disconnected" | "detecting" | "ready" | "busy" | "error";
export type SessionStatus = "active" | "released" | "expired";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type JobType = "autofocus" | "focusStep" | "captureStill" | "downloadFile" | "deleteFile" | "applyProfile";

export type Capability =
  | "stillCapture"
  | "previewCapture"
  | "movieRecording"
  | "autofocus"
  | "manualFocusStep"
  | "configRead"
  | "configWrite"
  | "storageList"
  | "fileDownload"
  | "fileDelete";

export interface CameraIdentity {
  connected: boolean;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  firmwareVersion: string | null;
}

export interface DeviceState {
  deviceId: string;
  agentVersion: string;
  connectionState: ConnectionState;
  capabilities: Capability[];
  camera: CameraIdentity;
}

export interface CreateSessionRequest {
  ownerType: "controlServer" | "operator" | "automation";
  ownerId: string;
  leaseSeconds: number;
  metadata?: Record<string, unknown>;
}

export interface SessionRecord {
  sessionId: string;
  leaseToken: string;
  ownerType: CreateSessionRequest["ownerType"];
  ownerId: string;
  status: SessionStatus;
  createdAt: string;
  expiresAt: string;
}

export interface JobRecord {
  jobId: string;
  type: JobType;
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: unknown | null;
  error: ErrorPayload | null;
}

export interface ErrorPayload {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface CameraConfig {
  key: string;
  label: string;
  type: "toggle" | "enum" | "text" | "integer" | "float";
  writable: boolean;
  supported: boolean;
  value: string | number | boolean | null;
  choices?: Array<string | number | boolean>;
  rawPath?: string | null;
}

export interface StorageVolume {
  id: string;
  description: string;
  access: "readOnly" | "readWrite";
  fileSystemType: string;
  totalBytes: number;
  freeBytes: number;
}

export interface StorageFile {
  cameraPath: string;
  name: string;
  sizeBytes: number;
  capturedAt: string | null;
  index: number;
}

export interface MediaAsset {
  assetId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  localPath: string;
  cameraPath: string | null;
  sha256: string | null;
  createdAt: string;
}

export interface CameraProfile {
  profileId: string;
  name: string;
  description: string | null;
  settings: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
  lastAppliedAt: string | null;
}
