import os from "node:os";
import path from "node:path";

export interface AppConfig {
  host: string;
  port: number;
  deviceId: string;
  agentVersion: string;
  dataDir: string;
  databasePath: string;
  mediaDir: string;
  requireBearerAuth: boolean;
  bearerToken: string | null;
  prepareDarwinProcesses: boolean;
  controlHost: string;
  controlPort: number;
  controlDataDir: string;
  controlDatabasePath: string;
  controlRequireBearerAuth: boolean;
  controlBearerToken: string | null;
  controlJobPollIntervalMs: number;
  controlJobPollTimeoutMs: number;
}

export function getConfig(): AppConfig {
  const rootDir = process.cwd();
  const bearerToken = process.env.API_BEARER_TOKEN ?? null;
  const controlBearerToken = process.env.CONTROL_API_BEARER_TOKEN ?? null;
  const dataDir = process.env.DATA_DIR ?? path.join(rootDir, "data");
  const controlDataDir = process.env.CONTROL_DATA_DIR ?? path.join(rootDir, "control-data");

  return {
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 3000),
    deviceId: process.env.DEVICE_ID ?? `${os.hostname()}-edge-camera`,
    agentVersion: process.env.npm_package_version ?? "0.1.0",
    dataDir,
    databasePath: process.env.DATABASE_PATH ?? path.join(dataDir, "edge.sqlite"),
    mediaDir: process.env.MEDIA_DIR ?? path.join(dataDir, "media"),
    requireBearerAuth: Boolean(bearerToken),
    bearerToken,
    prepareDarwinProcesses: process.env.PREPARE_DARWIN_PROCESSES !== "0",
    controlHost: process.env.CONTROL_HOST ?? "0.0.0.0",
    controlPort: Number(process.env.CONTROL_PORT ?? 4000),
    controlDataDir,
    controlDatabasePath: process.env.CONTROL_DATABASE_PATH ?? path.join(controlDataDir, "control.sqlite"),
    controlRequireBearerAuth: Boolean(controlBearerToken),
    controlBearerToken,
    controlJobPollIntervalMs: Number(process.env.CONTROL_JOB_POLL_INTERVAL_MS ?? 500),
    controlJobPollTimeoutMs: Number(process.env.CONTROL_JOB_POLL_TIMEOUT_MS ?? 60000)
  };
}
