import fs from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { readOpenApiDocument, renderSwaggerUiPage } from "./api-docs.js";
import type { AppConfig } from "./config.js";
import { AppError, toErrorResponse } from "./errors.js";
import { GPhoto2Service } from "./gphoto2.js";
import { JobStore, MediaStore, ProfileStore, SessionStore, SqliteStore } from "./stores.js";
import type { CameraProfile, CreateSessionRequest, ErrorPayload } from "./types.js";

interface AppDependencies {
  gphoto2?: GPhoto2Service;
  sessions?: SessionStore;
  jobs?: JobStore;
  media?: MediaStore;
  profiles?: ProfileStore;
}

function isPublicDocumentationRoute(url: string | undefined): boolean {
  if (!url) {
    return false;
  }

  const pathname = url.split("?", 1)[0];
  return pathname === "/docs" || pathname === "/openapi.yaml";
}

function readBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) {
    return null;
  }
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function readSessionToken(request: FastifyRequest): string {
  const header = request.headers["x-session-token"];
  if (typeof header !== "string" || header.length === 0) {
    throw new AppError(401, {
      code: "INVALID_SESSION",
      message: "A valid X-Session-Token is required."
    });
  }
  return header;
}

function readIdempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers["idempotency-key"];
  return typeof header === "string" && header.length > 0 ? header : undefined;
}

function validateCreateSessionBody(body: unknown): CreateSessionRequest {
  if (!body || typeof body !== "object") {
    throw new AppError(400, {
      code: "INVALID_REQUEST",
      message: "Request body must be an object."
    });
  }

  const input = body as Record<string, unknown>;
  const ownerType = input.ownerType;
  const ownerId = input.ownerId;
  const leaseSeconds = input.leaseSeconds;

  if (!["controlServer", "operator", "automation"].includes(String(ownerType))) {
    throw new AppError(400, {
      code: "INVALID_REQUEST",
      message: "ownerType must be one of: controlServer, operator, automation."
    });
  }
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    throw new AppError(400, {
      code: "INVALID_REQUEST",
      message: "ownerId is required."
    });
  }
  if (typeof leaseSeconds !== "number" || leaseSeconds < 15 || leaseSeconds > 3600) {
    throw new AppError(400, {
      code: "INVALID_REQUEST",
      message: "leaseSeconds must be between 15 and 3600."
    });
  }

  return {
    ownerType: ownerType as CreateSessionRequest["ownerType"],
    ownerId,
    leaseSeconds,
    metadata: typeof input.metadata === "object" && input.metadata !== null ? (input.metadata as Record<string, unknown>) : undefined
  };
}

function asRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") {
    throw new AppError(400, {
      code: "INVALID_REQUEST",
      message: "Request body must be an object."
    });
  }
  return body as Record<string, unknown>;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

// Same collision policy as the browser's own resolveUniqueName (capture.tsx):
// never silently overwrite an existing file at the target path -- append
// " (2)", " (3)", ... until a free name is found. This device is the only
// party with real visibility into what's already on the network share, so
// the browser can't do this check itself the way it does for a locally
// picked folder.
async function resolveUniqueExportPath(targetPath: string): Promise<string> {
  if (!(await pathExists(targetPath))) {
    return targetPath;
  }
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  for (let i = 2; i < 1000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }
  return path.join(dir, `${base} ${Date.now()}${ext}`);
}

async function runJob(
  jobs: JobStore,
  jobId: string,
  operation: () => Promise<unknown>
): Promise<void> {
  jobs.start(jobId);
  try {
    const result = await operation();
    jobs.succeed(jobId, result);
  } catch (error) {
    const normalized = toErrorResponse(error);
    jobs.fail(jobId, normalized.payload);
  }
}

function validateProfileSettings(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, {
      code: "INVALID_REQUEST",
      message: "settings must be an object."
    });
  }

  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  if (entries.length === 0) {
    throw new AppError(400, {
      code: "INVALID_REQUEST",
      message: "settings must contain at least one config key."
    });
  }

  for (const [key, item] of entries) {
    if (!["string", "number", "boolean"].includes(typeof item)) {
      throw new AppError(400, {
        code: "INVALID_REQUEST",
        message: `Profile setting '${key}' must be a string, number, or boolean.`
      });
    }
  }

  return record as Record<string, string | number | boolean>;
}

function validateCreateProfileBody(body: unknown): { name: string; description?: string | null; settings: Record<string, string | number | boolean> } {
  const input = asRecord(body);
  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    throw new AppError(400, {
      code: "INVALID_REQUEST",
      message: "name is required."
    });
  }

  return {
    name: input.name.trim(),
    description: typeof input.description === "string" ? input.description : input.description === null ? null : undefined,
    settings: validateProfileSettings(input.settings)
  };
}

function validateUpdateProfileBody(body: unknown): { name?: string; description?: string | null; settings?: Record<string, string | number | boolean> } {
  const input = asRecord(body);
  const patch: { name?: string; description?: string | null; settings?: Record<string, string | number | boolean> } = {};

  if ("name" in input) {
    if (typeof input.name !== "string" || input.name.trim().length === 0) {
      throw new AppError(400, {
        code: "INVALID_REQUEST",
        message: "name must be a non-empty string."
      });
    }
    patch.name = input.name.trim();
  }

  if ("description" in input) {
    if (typeof input.description !== "string" && input.description !== null) {
      throw new AppError(400, {
        code: "INVALID_REQUEST",
        message: "description must be a string or null."
      });
    }
    patch.description = input.description;
  }

  if ("settings" in input) {
    patch.settings = validateProfileSettings(input.settings);
  }

  if (Object.keys(patch).length === 0) {
    throw new AppError(400, {
      code: "INVALID_REQUEST",
      message: "At least one profile field must be provided."
    });
  }

  return patch;
}

async function applyProfileSettings(gphoto2: GPhoto2Service, profile: CameraProfile): Promise<{ profile: CameraProfile; appliedKeys: string[] }> {
  const appliedKeys: string[] = [];
  for (const [key, value] of Object.entries(profile.settings)) {
    await gphoto2.updateCameraConfig(key, value);
    appliedKeys.push(key);
  }

  return {
    profile,
    appliedKeys
  };
}

export function createApp(config: AppConfig, overrides: AppDependencies = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  const sqlite = new SqliteStore(config);
  const gphoto2 = overrides.gphoto2 ?? new GPhoto2Service(config);
  const sessions = overrides.sessions ?? new SessionStore(sqlite);
  const jobs = overrides.jobs ?? new JobStore(sqlite);
  const media = overrides.media ?? new MediaStore(sqlite);
  const profiles = overrides.profiles ?? new ProfileStore(sqlite);

  app.addHook("onRequest", async (request) => {
    if (isPublicDocumentationRoute(request.raw.url)) {
      return;
    }

    if (!config.requireBearerAuth) {
      return;
    }

    const token = readBearerToken(request);
    if (!token || token !== config.bearerToken) {
      throw new AppError(401, {
        code: "UNAUTHORIZED",
        message: "A valid bearer token is required."
      });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const { statusCode, payload } = toErrorResponse(error);
    request.log.error({ err: error, statusCode, code: payload.code }, payload.message);
    reply.status(statusCode).send(payload);
  });

  app.get("/openapi.yaml", async (_request, reply) => {
    const document = await readOpenApiDocument();
    reply.type("application/yaml; charset=utf-8").send(document);
  });

  app.get("/docs", async (_request, reply) => {
    reply
      .type("text/html; charset=utf-8")
      .send(renderSwaggerUiPage({
        title: "Canon Camera Platform API Docs",
        specUrl: "/openapi.yaml"
      }));
  });

  app.get("/v1/health", async () => gphoto2.getHealth());

  app.get("/v1/device", async () => gphoto2.getDeviceState());

  app.get("/v1/profiles", async () => ({
    items: profiles.list()
  }));

  app.post("/v1/profiles", async (request, reply) => {
    const profile = profiles.create(validateCreateProfileBody(request.body));
    reply.status(201);
    return profile;
  });

  app.get("/v1/profiles/:profileId", async (request) => {
    const params = request.params as { profileId: string };
    const profile = profiles.get(params.profileId);
    if (!profile) {
      throw new AppError(404, {
        code: "PROFILE_NOT_FOUND",
        message: "The requested profile was not found."
      });
    }
    return profile;
  });

  app.patch("/v1/profiles/:profileId", async (request) => {
    const params = request.params as { profileId: string };
    return profiles.update(params.profileId, validateUpdateProfileBody(request.body));
  });

  app.delete("/v1/profiles/:profileId", async (request, reply) => {
    const params = request.params as { profileId: string };
    profiles.delete(params.profileId);
    reply.status(204).send();
  });

  app.post("/v1/profiles/:profileId/apply", async (request, reply) => {
    sessions.requireActiveToken(readSessionToken(request));
    const params = request.params as { profileId: string };
    const profile = profiles.get(params.profileId);
    if (!profile) {
      throw new AppError(404, {
        code: "PROFILE_NOT_FOUND",
        message: "The requested profile was not found."
      });
    }

    const job = jobs.create("applyProfile", readIdempotencyKey(request));
    void runJob(jobs, job.jobId, async () => {
      const result = await applyProfileSettings(gphoto2, profile);
      profiles.markApplied(profile.profileId);
      return {
        ...result,
        profile: profiles.get(profile.profileId) ?? profile
      };
    });
    reply.status(202);
    return {
      jobId: job.jobId,
      status: job.status,
      type: job.type
    };
  });

  app.post("/v1/sessions", async (request, reply) => {
    const session = sessions.create(validateCreateSessionBody(request.body));
    reply.status(201);
    return session;
  });

  app.get("/v1/sessions/:sessionId", async (request) => {
    const params = request.params as { sessionId: string };
    const session = sessions.get(params.sessionId);
    if (!session) {
      throw new AppError(404, {
        code: "SESSION_NOT_FOUND",
        message: "The requested session was not found."
      });
    }
    return session;
  });

  app.post("/v1/sessions/:sessionId/renew", async (request) => {
    const params = request.params as { sessionId: string };
    const body = (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;
    const raw = typeof body.leaseSeconds === "number" ? body.leaseSeconds : 120;
    const leaseSeconds = Math.min(3600, Math.max(15, raw));
    return sessions.renew(params.sessionId, readSessionToken(request), leaseSeconds);
  });

  app.delete("/v1/sessions/:sessionId", async (request, reply) => {
    const params = request.params as { sessionId: string };
    sessions.release(params.sessionId, readSessionToken(request));
    reply.status(204).send();
  });

  app.get("/v1/camera/status", async () => gphoto2.getCameraStatus());

  app.get("/v1/camera/configs", async () => ({
    items: await gphoto2.listCameraConfigs()
  }));

  app.patch("/v1/camera/configs/:key", async (request) => {
    sessions.requireActiveToken(readSessionToken(request));
    const params = request.params as { key: string };
    const body = asRecord(request.body);
    if (!("value" in body)) {
      throw new AppError(400, {
        code: "INVALID_REQUEST",
        message: "Request body must include 'value'."
      });
    }

    const value = body.value;
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new AppError(400, {
        code: "INVALID_REQUEST",
        message: "Config value must be a string, number, or boolean."
      });
    }

    return gphoto2.updateCameraConfig(params.key, value as string | number | boolean);
  });

  app.get("/v1/camera/preview", async (request, reply) => {
    sessions.requireActiveToken(readSessionToken(request));
    const preview = await gphoto2.capturePreview();
    reply.type("image/jpeg").send(preview);
  });

  app.post("/v1/camera/focus/autofocus", async (request, reply) => {
    sessions.requireActiveToken(readSessionToken(request));
    const job = jobs.create("autofocus", readIdempotencyKey(request));
    void runJob(jobs, job.jobId, async () => {
      await gphoto2.triggerAutofocus();
      return { ok: true };
    });
    reply.status(202);
    return {
      jobId: job.jobId,
      status: job.status,
      type: job.type
    };
  });

  app.post("/v1/camera/focus/steps", async (request, reply) => {
    sessions.requireActiveToken(readSessionToken(request));
    const body = asRecord(request.body);
    const direction = body.direction;
    const steps = body.steps;

    if ((direction !== "near" && direction !== "far") || typeof steps !== "number") {
      throw new AppError(400, {
        code: "INVALID_REQUEST",
        message: "direction must be 'near' or 'far', and steps must be a number."
      });
    }

    const job = jobs.create("focusStep", readIdempotencyKey(request));
    void runJob(jobs, job.jobId, async () => {
      await gphoto2.stepFocus(direction, steps);
      return { ok: true };
    });
    reply.status(202);
    return {
      jobId: job.jobId,
      status: job.status,
      type: job.type
    };
  });

  app.post("/v1/captures", async (request, reply) => {
    sessions.requireActiveToken(readSessionToken(request));
    const body = asRecord(request.body);
    const captureTarget = body.captureTarget;
    const downloadToEdge = body.downloadToEdge;
    const keepOnCamera = body.keepOnCamera;

    if ((captureTarget !== "internalRam" && captureTarget !== "memoryCard") || typeof downloadToEdge !== "boolean" || typeof keepOnCamera !== "boolean") {
      throw new AppError(400, {
        code: "INVALID_REQUEST",
        message: "captureTarget, downloadToEdge, and keepOnCamera are required."
      });
    }

    const filenameTemplate = typeof body.filenameTemplate === "string" ? body.filenameTemplate : undefined;
    const job = jobs.create("captureStill", readIdempotencyKey(request));
    void runJob(jobs, job.jobId, async () => {
      const result = await gphoto2.captureStill({
        captureTarget,
        downloadToEdge,
        keepOnCamera,
        filenameTemplate
      });

      if (result.asset) {
        media.save(result.asset);
      }

      return result;
    });
    reply.status(202);
    return {
      jobId: job.jobId,
      status: job.status,
      type: job.type
    };
  });

  app.get("/v1/storage/volumes", async () => ({
    items: await gphoto2.listStorageVolumes()
  }));

  app.get("/v1/storage/files", async (request) => {
    const query = request.query as { volumeId?: string; folderPath?: string };
    if (!query.volumeId || !query.folderPath) {
      throw new AppError(400, {
        code: "INVALID_REQUEST",
        message: "volumeId and folderPath are required query parameters."
      });
    }

    return {
      items: await gphoto2.listStorageFiles(query.folderPath)
    };
  });

  app.post("/v1/storage/files/download", async (request, reply) => {
    sessions.requireActiveToken(readSessionToken(request));
    const body = asRecord(request.body);
    const cameraPath = body.cameraPath;
    const keepOnCamera = body.keepOnCamera;
    const filenameTemplate = typeof body.filenameTemplate === "string" ? body.filenameTemplate : undefined;

    if (typeof cameraPath !== "string" || cameraPath.length === 0) {
      throw new AppError(400, {
        code: "INVALID_REQUEST",
        message: "cameraPath is required."
      });
    }

    const job = jobs.create("downloadFile", readIdempotencyKey(request));
    void runJob(jobs, job.jobId, async () => {
      const asset = await gphoto2.downloadStorageFile(cameraPath, keepOnCamera !== false, filenameTemplate);
      media.save(asset);
      return { asset };
    });
    reply.status(202);
    return {
      jobId: job.jobId,
      status: job.status,
      type: job.type
    };
  });

  app.post("/v1/storage/files/delete", async (request, reply) => {
    sessions.requireActiveToken(readSessionToken(request));
    const body = asRecord(request.body);
    const cameraPath = body.cameraPath;

    if (typeof cameraPath !== "string" || cameraPath.length === 0) {
      throw new AppError(400, {
        code: "INVALID_REQUEST",
        message: "cameraPath is required."
      });
    }

    const job = jobs.create("deleteFile", readIdempotencyKey(request));
    void runJob(jobs, job.jobId, async () => {
      await gphoto2.deleteStorageFile(cameraPath);
      return { deleted: true };
    });
    reply.status(202);
    return {
      jobId: job.jobId,
      status: job.status,
      type: job.type
    };
  });

  app.get("/v1/jobs/:jobId", async (request) => {
    const params = request.params as { jobId: string };
    const job = jobs.get(params.jobId);
    if (!job) {
      throw new AppError(404, {
        code: "JOB_NOT_FOUND",
        message: "The requested job was not found."
      });
    }
    return job;
  });

  app.get("/v1/media/:assetId", async (request) => {
    const params = request.params as { assetId: string };
    const asset = media.get(params.assetId);
    if (!asset) {
      throw new AppError(404, {
        code: "MEDIA_NOT_FOUND",
        message: "The requested media asset was not found."
      });
    }
    return asset;
  });

  app.get("/v1/media/:assetId/content", async (request, reply) => {
    const params = request.params as { assetId: string };
    const asset = media.get(params.assetId);
    if (!asset) {
      throw new AppError(404, {
        code: "MEDIA_NOT_FOUND",
        message: "The requested media asset was not found."
      });
    }

    let content: Buffer;
    try {
      content = await fs.readFile(asset.localPath);
    } catch {
      throw new AppError(404, {
        code: "MEDIA_FILE_MISSING",
        message: "The media asset record exists but its file is no longer available on disk."
      });
    }

    reply.type(asset.mimeType);
    reply.header("Content-Disposition", `inline; filename="${encodeURIComponent(asset.filename)}"`);
    return content;
  });

  // Copies an already-downloaded asset to a caller-supplied targetRoot (a
  // plant network share, typically). This runs as a plain Node fs write on
  // this device -- no browser permission prompt is possible or needed, which
  // is the whole point: the browser's File System Access API can only ever
  // write after a user clicks through a picker, every single time a new
  // handle is needed, by design (W3C security requirement, not something any
  // app can route around client-side). Doing the write here instead is what
  // makes a fully hands-off save to a fixed path actually possible.
  //
  // targetRoot itself is not configured on this device -- the caller (the app
  // server, never the browser directly) owns that setting and sends it with
  // every request, so changing the destination folder never requires
  // touching or redeploying this edge device.
  app.post("/v1/media/:assetId/export", async (request) => {
    sessions.requireActiveToken(readSessionToken(request));

    const params = request.params as { assetId: string };
    const asset = media.get(params.assetId);
    if (!asset) {
      throw new AppError(404, {
        code: "MEDIA_NOT_FOUND",
        message: "The requested media asset was not found."
      });
    }

    const body = asRecord(request.body);
    const targetRoot = body.targetRoot;
    if (typeof targetRoot !== "string" || targetRoot.length === 0) {
      throw new AppError(400, {
        code: "INVALID_REQUEST",
        message: "targetRoot is required."
      });
    }
    const relativePath = body.relativePath;
    if (typeof relativePath !== "string" || relativePath.length === 0) {
      throw new AppError(400, {
        code: "INVALID_REQUEST",
        message: "relativePath is required."
      });
    }

    // relativePath is caller-supplied (the browser sends its Year/Month/Day/
    // filename), and it's about to be joined onto a real filesystem root --
    // reject anything that could escape targetRoot before it's used.
    const normalized = path.normalize(relativePath);
    if (path.isAbsolute(normalized) || normalized.split(/[\\/]+/).includes("..")) {
      throw new AppError(400, {
        code: "INVALID_REQUEST",
        message: "relativePath must be a relative path with no '..' segments."
      });
    }
    const resolvedRoot = path.resolve(targetRoot);
    const resolvedTarget = path.resolve(resolvedRoot, normalized);
    if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
      throw new AppError(400, {
        code: "INVALID_REQUEST",
        message: "relativePath resolves outside targetRoot."
      });
    }

    let finalTarget: string;
    try {
      await fs.mkdir(path.dirname(resolvedTarget), { recursive: true });
      finalTarget = await resolveUniqueExportPath(resolvedTarget);
      await fs.copyFile(asset.localPath, finalTarget);
    } catch (error) {
      throw new AppError(502, {
        code: "NETWORK_SAVE_FAILED",
        message: error instanceof Error ? error.message : "Failed to write to the network save root."
      });
    }

    return { assetId: asset.assetId, savedTo: finalTarget, filename: path.basename(finalTarget) };
  });

  app.get("/", async (_request, reply) => {
    reply.redirect("/v1/health");
  });

  app.setNotFoundHandler((request, reply) => {
    const payload: ErrorPayload = {
      code: "NOT_FOUND",
      message: `Route ${request.method} ${request.url} was not found.`
    };
    reply.status(404).send(payload);
  });

  return app;
}
