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
}

export function getConfig(): AppConfig {
  const rootDir = process.cwd();
  const bearerToken = process.env.API_BEARER_TOKEN ?? null;

  return {
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 3000),
    deviceId: process.env.DEVICE_ID ?? `${os.hostname()}-edge-camera`,
    agentVersion: process.env.npm_package_version ?? "0.1.0",
    dataDir: process.env.DATA_DIR ?? path.join(rootDir, "data"),
    databasePath: process.env.DATABASE_PATH ?? path.join(process.env.DATA_DIR ?? path.join(rootDir, "data"), "edge.sqlite"),
    mediaDir: process.env.MEDIA_DIR ?? path.join(process.env.DATA_DIR ?? path.join(rootDir, "data"), "media"),
    requireBearerAuth: Boolean(bearerToken),
    bearerToken,
    prepareDarwinProcesses: process.env.PREPARE_DARWIN_PROCESSES !== "0"
  };
}
