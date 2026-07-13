import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { AppError } from "./errors.js";
import type { CameraConfig, Capability, ConnectionState, DeviceState, MediaAsset, StorageFile, StorageVolume } from "./types.js";

const execFileAsync = promisify(execFile);

const CONFIG_MAPPINGS = {
  captureEnabled: "/main/settings/capture",
  captureTarget: "/main/settings/capturetarget",
  iso: "/main/imgsettings/iso",
  shutterSpeed: "/main/capturesettings/shutterspeed",
  aperture: "/main/capturesettings/aperture",
  whiteBalance: "/main/imgsettings/whitebalance",
  focusMode: "/main/capturesettings/focusmode",
  driveMode: "/main/capturesettings/drivemode"
} as const;

type ConfigKey = keyof typeof CONFIG_MAPPINGS;

interface ProbeResult {
  connected: boolean;
  model: string | null;
  port: string | null;
}

interface SummaryResult {
  manufacturer: string | null;
  model: string | null;
  firmwareVersion: string | null;
  serialNumber: string | null;
  batteryLevel: number | null;
}

function firstMatch(input: string, pattern: RegExp): string | null {
  const match = input.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function normalizeFolderPath(folderPath: string): string {
  if (!folderPath.startsWith("/")) {
    return `/${folderPath}`;
  }
  return folderPath;
}

export class GPhoto2Service {
  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await this.run(["--version"], { prepareHost: false });
      return true;
    } catch {
      return false;
    }
  }

  async getHealth(): Promise<{ status: "ok" | "degraded"; agentVersion: string; time: string }> {
    const available = await this.isAvailable();
    return {
      status: available ? "ok" : "degraded",
      agentVersion: this.config.agentVersion,
      time: new Date().toISOString()
    };
  }

  async getDeviceState(): Promise<DeviceState> {
    const available = await this.isAvailable();
    if (!available) {
      return {
        deviceId: this.config.deviceId,
        agentVersion: this.config.agentVersion,
        connectionState: "error",
        capabilities: [],
        camera: {
          connected: false,
          manufacturer: null,
          model: null,
          serialNumber: null,
          firmwareVersion: null
        }
      };
    }

    const probe = await this.probeCamera();
    if (!probe.connected) {
      return {
        deviceId: this.config.deviceId,
        agentVersion: this.config.agentVersion,
        connectionState: "disconnected",
        capabilities: [],
        camera: {
          connected: false,
          manufacturer: null,
          model: null,
          serialNumber: null,
          firmwareVersion: null
        }
      };
    }

    const summary = await this.getSummary();
    return {
      deviceId: this.config.deviceId,
      agentVersion: this.config.agentVersion,
      connectionState: "ready",
      capabilities: await this.getCapabilities(),
      camera: {
        connected: true,
        manufacturer: summary.manufacturer,
        model: summary.model ?? probe.model,
        serialNumber: summary.serialNumber,
        firmwareVersion: summary.firmwareVersion
      }
    };
  }

  async getCameraStatus(): Promise<{
    connectionState: ConnectionState;
    batteryLevel: number | null;
    lensName: string | null;
    availableShots: number | null;
    storage: StorageVolume[];
    settings: CameraConfig[];
  }> {
    const device = await this.getDeviceState();
    if (!device.camera.connected) {
      return {
        connectionState: device.connectionState,
        batteryLevel: null,
        lensName: null,
        availableShots: null,
        storage: [],
        settings: []
      };
    }

    const summaryText = await this.run(["--summary"]);
    const summary = this.parseSummary(summaryText);
    const lensName = firstMatch(summaryText, /^Lens Name\s+\([^)]+\):\s*(.+)$/m) ?? firstMatch(summaryText, /^Lens Name:\s*(.+)$/m);
    const availableShotsRaw = firstMatch(summaryText, /^Available Shots\s+\([^)]+\):\s*(\d+)/m) ?? firstMatch(summaryText, /^Available Shots:\s*(\d+)/m);

    return {
      connectionState: "ready",
      batteryLevel: summary.batteryLevel,
      lensName,
      availableShots: availableShotsRaw ? Number(availableShotsRaw) : null,
      storage: await this.listStorageVolumes(),
      settings: await this.listCameraConfigs()
    };
  }

  async listCameraConfigs(): Promise<CameraConfig[]> {
    const configs = await Promise.all(
      Object.entries(CONFIG_MAPPINGS).map(async ([key, rawPath]) => this.readConfig(key, rawPath))
    );
    return configs.filter((item): item is CameraConfig => item !== null);
  }

  async updateCameraConfig(key: string, value: string | number | boolean): Promise<CameraConfig> {
    const rawPath = CONFIG_MAPPINGS[key as ConfigKey];
    if (!rawPath) {
      throw new AppError(404, {
        code: "CONFIG_NOT_FOUND",
        message: `Camera config '${key}' is not supported by this service.`
      });
    }

    const current = await this.readConfig(key, rawPath);
    if (!current || !current.supported) {
      throw new AppError(404, {
        code: "CONFIG_NOT_FOUND",
        message: `Camera config '${key}' is not currently supported by the attached camera.`
      });
    }
    if (!current.writable) {
      throw new AppError(409, {
        code: "CONFIG_READ_ONLY",
        message: `Camera config '${key}' is read-only.`
      });
    }

    const encodedValue = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
    await this.run(["--set-config", `${rawPath}=${encodedValue}`]);

    const updated = await this.readConfig(key, rawPath);
    if (!updated) {
      throw new AppError(500, {
        code: "CONFIG_UPDATE_FAILED",
        message: `Camera config '${key}' was updated but could not be reloaded.`
      });
    }
    return updated;
  }

  async capturePreview(): Promise<Buffer> {
    const previewStem = path.join(this.config.mediaDir, `preview-${crypto.randomUUID()}.jpg`);
    const expectedThumb = path.join(path.dirname(previewStem), `thumb_${path.basename(previewStem)}`);

    await this.run(["--force-overwrite", "--capture-preview", "--filename", previewStem]);

    const actualPath = await this.findExistingPath([previewStem, expectedThumb]);
    if (!actualPath) {
      throw new AppError(500, {
        code: "PREVIEW_NOT_FOUND",
        message: "Preview capture completed, but no preview file was created."
      });
    }

    try {
      return await fs.readFile(actualPath);
    } finally {
      await fs.rm(actualPath, { force: true });
    }
  }

  async triggerAutofocus(): Promise<void> {
    await this.run(["--set-config", "/main/actions/autofocusdrive=1"]);
  }

  async stepFocus(direction: "near" | "far", steps: number): Promise<void> {
    const info = await this.readRawConfig("/main/actions/manualfocusdrive");
    const targetChoice = info.choices.find((choice) => {
      const normalized = String(choice).toLowerCase();
      return normalized.includes(direction) && normalized.includes(String(steps));
    });

    if (!targetChoice) {
      throw new AppError(409, {
        code: "CAPABILITY_NOT_SUPPORTED",
        message: `Manual focus step ${direction}:${steps} is not supported by the attached camera.`,
        details: { availableChoices: info.choices }
      });
    }

    await this.run(["--set-config", `/main/actions/manualfocusdrive=${targetChoice}`]);
  }

  async captureStill(options: {
    captureTarget: "internalRam" | "memoryCard";
    downloadToEdge: boolean;
    keepOnCamera: boolean;
    filenameTemplate?: string | undefined;
  }): Promise<{ cameraPath: string | null; asset: MediaAsset | null; storedOnCamera: boolean; storedLocally: boolean }> {
    const captureTargetValue = options.captureTarget === "memoryCard" ? "Memory card" : "Internal RAM";

    await this.run(["--set-config", `/main/settings/capturetarget=${captureTargetValue}`]);
    await this.run(["--set-config", "/main/settings/capture=1"]);

    if (!options.downloadToEdge) {
      const output = await this.run(["--capture-image"]);
      return {
        cameraPath: firstMatch(output, /New file is in location (.+)$/m),
        asset: null,
        storedOnCamera: true,
        storedLocally: false
      };
    }

    const targetPath = this.buildMediaPath(options.filenameTemplate, "capture");
    const keepFlag = options.keepOnCamera ? "--keep" : "--no-keep";
    const output = await this.run([
      keepFlag,
      "--force-overwrite",
      "--capture-image-and-download",
      "--filename",
      targetPath
    ]);

    const cameraPath = firstMatch(output, /New file is in location (.+)$/m);
    const actualLocalPath = firstMatch(output, /Saving file as (.+)$/m) ?? targetPath;
    const asset = await this.buildMediaAsset(actualLocalPath, cameraPath);

    return {
      cameraPath,
      asset,
      storedOnCamera: options.keepOnCamera,
      storedLocally: true
    };
  }

  async listStorageVolumes(): Promise<StorageVolume[]> {
    const output = await this.run(["--storage-info"]);
    const chunks = output.split(/\n(?=\[Storage \d+\])/).map((item) => item.trim()).filter(Boolean);
    return chunks.map((chunk, index) => {
      const description = firstMatch(chunk, /^description=(.+)$/m) ?? `Storage ${index}`;
      const access = firstMatch(chunk, /^access=\d+\s+(.+)$/m)?.toLowerCase().includes("read-write")
        ? "readWrite"
        : "readOnly";
      const fileSystemType = firstMatch(chunk, /^fstype=\d+\s+(.+)$/m) ?? "unknown";
      const totalCapacityKb = Number(firstMatch(chunk, /^totalcapacity=(\d+)\s+KB$/m) ?? "0");
      const freeKb = Number(firstMatch(chunk, /^free=(\d+)\s+KB$/m) ?? "0");

      return {
        id: firstMatch(chunk, /^basedir=\/([^/\n]+)$/m) ?? `storage-${index}`,
        description,
        access,
        fileSystemType,
        totalBytes: totalCapacityKb * 1024,
        freeBytes: freeKb * 1024
      } satisfies StorageVolume;
    });
  }

  async listStorageFiles(folderPath: string): Promise<StorageFile[]> {
    const normalizedFolderPath = normalizeFolderPath(folderPath);
    const output = await this.run(["--folder", normalizedFolderPath, "--list-files"]);
    const lines = output.split("\n");
    const items: StorageFile[] = [];

    for (const line of lines) {
      const match = line.match(/^#(\d+)\s+(.+?)\s{2,}.*?(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)\b/i);
      if (!match) {
        continue;
      }

      const index = Number(match[1]);
      const name = match[2].trim();
      const size = Number(match[3]);
      const unit = match[4].toUpperCase();
      const multiplier = unit === "GB" ? 1024 ** 3 : unit === "MB" ? 1024 ** 2 : unit === "KB" ? 1024 : 1;

      items.push({
        cameraPath: path.posix.join(normalizedFolderPath, name),
        name,
        sizeBytes: Math.round(size * multiplier),
        capturedAt: null,
        index
      });
    }

    return items;
  }

  async downloadStorageFile(cameraPath: string, keepOnCamera: boolean, filenameTemplate?: string | undefined): Promise<MediaAsset> {
    const { folder, file } = this.splitCameraPath(cameraPath);
    const items = await this.listStorageFiles(folder);
    const target = items.find((item) => item.name === file);
    if (!target) {
      throw new AppError(404, {
        code: "FILE_NOT_FOUND",
        message: `Camera file '${cameraPath}' was not found.`
      });
    }

    const localPath = this.buildMediaPath(filenameTemplate ?? file, "download");
    const keepFlag = keepOnCamera ? "--keep" : "--no-keep";
    await this.run([
      keepFlag,
      "--force-overwrite",
      "--folder",
      folder,
      "--get-file",
      String(target.index),
      "--filename",
      localPath
    ]);

    return this.buildMediaAsset(localPath, cameraPath);
  }

  async deleteStorageFile(cameraPath: string): Promise<void> {
    const { folder, file } = this.splitCameraPath(cameraPath);
    const items = await this.listStorageFiles(folder);
    const target = items.find((item) => item.name === file);
    if (!target) {
      throw new AppError(404, {
        code: "FILE_NOT_FOUND",
        message: `Camera file '${cameraPath}' was not found.`
      });
    }

    await this.run(["--folder", folder, "--delete-file", String(target.index)]);
  }

  private async getCapabilities(): Promise<Capability[]> {
    const configs = await Promise.all([
      this.readRawConfig("/main/actions/autofocusdrive"),
      this.readRawConfig("/main/actions/manualfocusdrive")
    ]);

    const capabilities: Capability[] = [
      "stillCapture",
      "previewCapture",
      "configRead",
      "configWrite",
      "storageList",
      "fileDownload",
      "fileDelete"
    ];

    if (configs[0].supported) {
      capabilities.push("autofocus");
    }
    if (configs[1].supported) {
      capabilities.push("manualFocusStep");
    }

    return capabilities;
  }

  private async probeCamera(): Promise<ProbeResult> {
    const output = await this.run(["--auto-detect"]);
    const lines = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("Model") && !line.startsWith("-"));

    const detectedLine = lines.find((line) => /usb:\d+,\d+/.test(line));
    if (!detectedLine) {
      return { connected: false, model: null, port: null };
    }

    const portMatch = detectedLine.match(/(usb:\d+,\d+)$/);
    const port = portMatch?.[1] ?? null;
    const model = detectedLine.replace(/\s+usb:\d+,\d+$/, "").trim();
    return {
      connected: true,
      model,
      port
    };
  }

  private async getSummary(): Promise<SummaryResult> {
    const output = await this.run(["--summary"]);
    return this.parseSummary(output);
  }

  private parseSummary(output: string): SummaryResult {
    const batteryText = firstMatch(output, /^Battery Level\s+\([^)]+\):.*?value:\s*(\d+)%/m) ?? firstMatch(output, /^Battery Level:.*?(\d+)%/m);

    return {
      manufacturer: firstMatch(output, /^Manufacturer:\s*(.+)$/m),
      model: firstMatch(output, /^Model:\s*(.+)$/m),
      firmwareVersion: firstMatch(output, /^  Version:\s*(.+)$/m),
      serialNumber: firstMatch(output, /^  Serial Number:\s*(.+)$/m),
      batteryLevel: batteryText ? Number(batteryText) : null
    };
  }

  private async readConfig(key: string, rawPath: string): Promise<CameraConfig | null> {
    const raw = await this.readRawConfig(rawPath);
    if (!raw.supported) {
      return null;
    }
    return {
      key,
      label: raw.label,
      type: raw.type,
      writable: !raw.readonly,
      supported: true,
      value: raw.value,
      choices: raw.choices,
      rawPath
    };
  }

  private async readRawConfig(rawPath: string): Promise<{
    supported: boolean;
    label: string;
    type: CameraConfig["type"];
    readonly: boolean;
    value: string | number | boolean | null;
    choices: Array<string | number | boolean>;
  }> {
    try {
      const output = await this.run(["--get-config", rawPath]);
      const typeRaw = firstMatch(output, /^Type:\s*(.+)$/m) ?? "TEXT";
      const type = this.normalizeConfigType(typeRaw);
      const readonly = firstMatch(output, /^Readonly:\s*(\d+)$/m) === "1";
      const currentRaw = firstMatch(output, /^Current:\s*(.*)$/m);
      const choices = Array.from(output.matchAll(/^Choice:\s*\d+\s+(.+)$/gm))
        .map((match) => this.coerceConfigValue(match[1].trim(), type))
        .filter((choice): choice is string | number | boolean => choice !== null);

      return {
        supported: true,
        label: firstMatch(output, /^Label:\s*(.+)$/m) ?? rawPath,
        type,
        readonly,
        value: this.coerceConfigValue(currentRaw, type),
        choices
      };
    } catch {
      return {
        supported: false,
        label: rawPath,
        type: "text",
        readonly: true,
        value: null,
        choices: []
      };
    }
  }

  private normalizeConfigType(typeRaw: string): CameraConfig["type"] {
    switch (typeRaw.toUpperCase()) {
      case "TOGGLE":
        return "toggle";
      case "RADIO":
      case "MENU":
        return "enum";
      case "RANGE":
        return "float";
      case "TEXT":
      default:
        return "text";
    }
  }

  private coerceConfigValue(value: string | null, type: CameraConfig["type"]): string | number | boolean | null {
    if (value === null || value.length === 0) {
      return null;
    }
    if (type === "toggle") {
      return value === "1" || value.toLowerCase() === "on";
    }
    if (type === "float" && !Number.isNaN(Number(value))) {
      return Number(value);
    }
    return value;
  }

  private buildMediaPath(template: string | undefined, prefix: string): string {
    const baseName = template && template.trim().length > 0 ? template : `${prefix}-${crypto.randomUUID()}.jpg`;
    return path.join(this.config.mediaDir, baseName);
  }

  private async buildMediaAsset(localPath: string, cameraPath: string | null): Promise<MediaAsset> {
    const stats = await fs.stat(localPath);
    const buffer = await fs.readFile(localPath);

    return {
      assetId: crypto.randomUUID(),
      filename: path.basename(localPath),
      mimeType: "image/jpeg",
      sizeBytes: stats.size,
      localPath,
      cameraPath,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      createdAt: new Date().toISOString()
    };
  }

  private async findExistingPath(pathsToCheck: string[]): Promise<string | null> {
    for (const candidate of pathsToCheck) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    return null;
  }

  private splitCameraPath(cameraPath: string): { folder: string; file: string } {
    const normalized = normalizeFolderPath(cameraPath);
    return {
      folder: path.posix.dirname(normalized),
      file: path.posix.basename(normalized)
    };
  }

  private async run(args: string[], options?: { prepareHost?: boolean }): Promise<string> {
    if ((options?.prepareHost ?? true) !== false) {
      await this.prepareHost();
    }

    try {
      const result = await execFileAsync("gphoto2", args, { maxBuffer: 10 * 1024 * 1024 });
      return result.stdout.trim();
    } catch (error) {
      const message =
        error instanceof Error && "stderr" in error && typeof error.stderr === "string"
          ? error.stderr.trim() || error.message
          : error instanceof Error
            ? error.message
            : "gphoto2 execution failed";

      throw new AppError(409, {
        code: "CAMERA_COMMAND_FAILED",
        message,
        details: {
          args
        }
      });
    }
  }

  private async prepareHost(): Promise<void> {
    await fs.mkdir(this.config.mediaDir, { recursive: true });

    if (process.platform !== "darwin" || !this.config.prepareDarwinProcesses) {
      return;
    }

    try {
      await execFileAsync("killall", ["icdd", "photolibraryd", "PTPCamera"]);
    } catch {
      // These processes may not be running. That is fine.
    }
  }
}
