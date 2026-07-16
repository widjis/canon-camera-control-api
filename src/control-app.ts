import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { readOpenApiDocument, renderSwaggerUiPage } from "./api-docs.js";
import type { AppConfig } from "./config.js";
import { HttpEdgeClient, type EdgeClient } from "./control-client.js";
import { ControlStore } from "./control-stores.js";
import type {
  AuditLogRecord,
  CaptureOrchestrationRequest,
  DeviceRegistrationRequest,
  MediaSyncPolicy
} from "./control-types.js";
import { AppError, toErrorResponse } from "./errors.js";
import { SqliteStore } from "./stores.js";
import type { ErrorPayload } from "./types.js";

interface ControlAppDependencies {
  edgeClient?: EdgeClient;
  store?: ControlStore;
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

function readCorrelationId(request: FastifyRequest): string | null {
  const header = request.headers["x-correlation-id"];
  return typeof header === "string" && header.length > 0 ? header : null;
}

function readActor(request: FastifyRequest): Pick<AuditLogRecord, "actorType" | "actorId"> {
  const actorId = request.headers["x-actor-id"];
  return {
    actorType: "controlApiClient",
    actorId: typeof actorId === "string" && actorId.length > 0 ? actorId : "anonymous"
  };
}

function asRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(400, {
      code: "INVALID_REQUEST",
      message: "Request body must be an object."
    });
  }
  return body as Record<string, unknown>;
}

function validateMediaSyncPolicy(value: unknown): MediaSyncPolicy {
  const input = asRecord(value);
  if ((input.syncMode !== "disabled" && input.syncMode !== "metadataOnly") || (input.retentionMode !== "edgeManaged" && input.retentionMode !== "controlManaged")) {
    throw new AppError(400, {
      code: "INVALID_REQUEST",
      message: "mediaSyncPolicy must include syncMode (disabled|metadataOnly) and retentionMode (edgeManaged|controlManaged)."
    });
  }

  return {
    syncMode: input.syncMode,
    retentionMode: input.retentionMode
  } as MediaSyncPolicy;
}

function validateDeviceRegistration(body: unknown): DeviceRegistrationRequest {
  const input = asRecord(body);
  if (typeof input.deviceId !== "string" || input.deviceId.trim().length === 0) {
    throw new AppError(400, {
      code: "INVALID_REQUEST",
      message: "deviceId is required."
    });
  }
  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    throw new AppError(400, {
      code: "INVALID_REQUEST",
      message: "name is required."
    });
  }
  if (typeof input.edgeBaseUrl !== "string" || input.edgeBaseUrl.trim().length === 0) {
    throw new AppError(400, {
      code: "INVALID_REQUEST",
      message: "edgeBaseUrl is required."
    });
  }

  return {
    deviceId: input.deviceId.trim(),
    name: input.name.trim(),
    edgeBaseUrl: input.edgeBaseUrl.trim(),
    edgeBearerToken: typeof input.edgeBearerToken === "string" ? input.edgeBearerToken : input.edgeBearerToken === null ? null : undefined,
    mediaSyncPolicy: input.mediaSyncPolicy ? validateMediaSyncPolicy(input.mediaSyncPolicy) : undefined,
    metadata: typeof input.metadata === "object" && input.metadata !== null && !Array.isArray(input.metadata) ? (input.metadata as Record<string, unknown>) : undefined
  };
}

function validateCaptureRequest(body: unknown): CaptureOrchestrationRequest {
  const input = asRecord(body);
  if ((input.captureTarget !== "internalRam" && input.captureTarget !== "memoryCard") || typeof input.downloadToEdge !== "boolean" || typeof input.keepOnCamera !== "boolean") {
    throw new AppError(400, {
      code: "INVALID_REQUEST",
      message: "captureTarget, downloadToEdge, and keepOnCamera are required."
    });
  }

  return {
    captureTarget: input.captureTarget,
    downloadToEdge: input.downloadToEdge,
    keepOnCamera: input.keepOnCamera,
    filenameTemplate: typeof input.filenameTemplate === "string" ? input.filenameTemplate : undefined
  } as CaptureOrchestrationRequest;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function createControlApp(config: AppConfig, overrides: ControlAppDependencies = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  const sqlite = new SqliteStore({
    ...config,
    databasePath: config.controlDatabasePath,
    dataDir: config.controlDataDir,
    mediaDir: config.mediaDir
  });
  const store = overrides.store ?? new ControlStore(sqlite);
  const edgeClient = overrides.edgeClient ?? new HttpEdgeClient({ pollTimeoutMs: config.controlJobPollTimeoutMs });

  app.addHook("onRequest", async (request) => {
    if (isPublicDocumentationRoute(request.raw.url)) {
      return;
    }

    if (!config.controlRequireBearerAuth) {
      return;
    }

    const token = readBearerToken(request);
    if (!token || token !== config.controlBearerToken) {
      throw new AppError(401, {
        code: "UNAUTHORIZED",
        message: "A valid control bearer token is required."
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

  app.get("/v1/control/health", async () => ({
    status: "ok",
    service: "control",
    version: config.agentVersion,
    now: new Date().toISOString()
  }));

  app.get("/v1/control/devices", async () => ({
    items: store.listDevices()
  }));

  app.post("/v1/control/devices", async (request, reply) => {
    const device = store.registerDevice(validateDeviceRegistration(request.body));
    const actor = readActor(request);
    store.recordAudit({
      ...actor,
      deviceId: device.deviceId,
      action: "registerDevice",
      outcome: "succeeded",
      correlationId: readCorrelationId(request),
      details: {
        edgeBaseUrl: device.edgeBaseUrl,
        mediaSyncPolicy: device.mediaSyncPolicy
      }
    });
    reply.status(201);
    return device;
  });

  app.get("/v1/control/devices/:deviceId", async (request) => {
    const params = request.params as { deviceId: string };
    return store.requireDevice(params.deviceId);
  });

  app.post("/v1/control/devices/:deviceId/probe", async (request, reply) => {
    const params = request.params as { deviceId: string };
    const device = store.requireDevice(params.deviceId);
    const actor = readActor(request);
    const job = store.createJob("probeDevice", device.deviceId);

    void (async () => {
      store.startJob(job.jobId);
      try {
        const secret = store.getDeviceSecret(device.deviceId);
        const result = await edgeClient.probeDevice(device, secret);
        const now = new Date().toISOString();
        store.markDeviceStatus(device.deviceId, "online", now);
        store.recordAudit({
          ...actor,
          deviceId: device.deviceId,
          action: "probeDevice",
          outcome: "succeeded",
          correlationId: readCorrelationId(request),
          details: {
            health: result.health,
            device: result.device
          }
        });
        store.succeedJob(job.jobId, {
          status: "online",
          probedAt: now,
          edge: result
        });
      } catch (error) {
        const normalized = toErrorResponse(error);
        store.markDeviceStatus(device.deviceId, normalized.statusCode >= 500 ? "offline" : "error", null);
        store.recordAudit({
          ...actor,
          deviceId: device.deviceId,
          action: "probeDevice",
          outcome: "failed",
          correlationId: readCorrelationId(request),
          details: {
            error: normalized.payload
          }
        });
        store.failJob(job.jobId, normalized.payload);
      }
    })();

    reply.status(202);
    return {
      jobId: job.jobId,
      status: job.status,
      type: job.type,
      deviceId: job.deviceId
    };
  });

  app.get("/v1/control/devices/:deviceId/media-sync-policy", async (request) => {
    const params = request.params as { deviceId: string };
    return store.requireDevice(params.deviceId).mediaSyncPolicy;
  });

  app.patch("/v1/control/devices/:deviceId/media-sync-policy", async (request) => {
    const params = request.params as { deviceId: string };
    const body = asRecord(request.body);
    if (!body.mediaSyncPolicy) {
      throw new AppError(400, {
        code: "INVALID_REQUEST",
        message: "mediaSyncPolicy is required."
      });
    }
    return store.updateMediaSyncPolicy(params.deviceId, validateMediaSyncPolicy(body.mediaSyncPolicy));
  });

  app.post("/v1/control/devices/:deviceId/captures", async (request, reply) => {
    const params = request.params as { deviceId: string };
    const device = store.requireDevice(params.deviceId);
    const payload = validateCaptureRequest(request.body);
    const actor = readActor(request);
    const correlationId = readCorrelationId(request);
    const job = store.createJob("orchestrateCapture", device.deviceId);

    store.recordAudit({
      ...actor,
      deviceId: device.deviceId,
      action: "orchestrateCapture",
      outcome: "accepted",
      correlationId,
      details: payload as unknown as Record<string, unknown>
    });

    void (async () => {
      store.startJob(job.jobId);
      const secret = store.getDeviceSecret(device.deviceId);
      let sessionId: string | null = null;
      let sessionToken: string | null = null;

      try {
        const session = await edgeClient.createSession(device, secret);
        sessionId = session.sessionId;
        sessionToken = session.leaseToken;

        const accepted = await edgeClient.triggerCapture(device, secret, sessionToken, payload);
        const startedAt = Date.now();

        while (true) {
          const edgeJob = await edgeClient.getJob(device, secret, accepted.jobId);
          if (edgeJob.status === "succeeded") {
            let importedMedia = null;
            const policy = store.requireDevice(device.deviceId).mediaSyncPolicy;
            if (policy.syncMode === "metadataOnly" && edgeJob.result?.asset?.assetId) {
              const asset = await edgeClient.getMedia(device, secret, edgeJob.result.asset.assetId);
              importedMedia = store.saveImportedMedia({
                deviceId: device.deviceId,
                edgeAssetId: asset.assetId,
                filename: asset.filename,
                mimeType: asset.mimeType,
                sizeBytes: asset.sizeBytes,
                localPath: asset.localPath,
                cameraPath: asset.cameraPath,
                sha256: asset.sha256,
                capturedAt: asset.createdAt,
                syncMode: policy.syncMode
              });
            }

            const result = {
              edgeJobId: accepted.jobId,
              edgeResult: edgeJob.result,
              importedMedia
            };
            store.recordAudit({
              ...actor,
              deviceId: device.deviceId,
              action: "orchestrateCapture",
              outcome: "succeeded",
              correlationId,
              details: result as Record<string, unknown>
            });
            store.succeedJob(job.jobId, result);
            break;
          }

          if (edgeJob.status === "failed" || edgeJob.status === "cancelled") {
            throw new AppError(409, edgeJob.error ?? {
              code: "EDGE_JOB_FAILED",
              message: "The remote edge capture job failed."
            });
          }

          if (Date.now() - startedAt > config.controlJobPollTimeoutMs) {
            throw new AppError(504, {
              code: "EDGE_JOB_TIMEOUT",
              message: "Timed out waiting for the edge capture job to finish."
            });
          }

          await sleep(config.controlJobPollIntervalMs);
        }
      } catch (error) {
        const normalized = toErrorResponse(error);
        store.recordAudit({
          ...actor,
          deviceId: device.deviceId,
          action: "orchestrateCapture",
          outcome: "failed",
          correlationId,
          details: {
            error: normalized.payload
          }
        });
        store.failJob(job.jobId, normalized.payload);
      } finally {
        if (sessionId && sessionToken) {
          try {
            await edgeClient.releaseSession(device, secret, sessionId, sessionToken);
          } catch {
            // Release failures should not hide the capture outcome.
          }
        }
      }
    })();

    reply.status(202);
    return {
      jobId: job.jobId,
      status: job.status,
      type: job.type,
      deviceId: job.deviceId
    };
  });

  app.get("/v1/control/jobs/:jobId", async (request) => {
    const params = request.params as { jobId: string };
    const job = store.getJob(params.jobId);
    if (!job) {
      throw new AppError(404, {
        code: "JOB_NOT_FOUND",
        message: "The requested control job was not found."
      });
    }
    return job;
  });

  app.get("/v1/control/audit-logs", async (request) => {
    const query = request.query as { deviceId?: string; limit?: string };
    return {
      items: store.listAuditLogs({
        deviceId: query.deviceId,
        limit: query.limit ? Number(query.limit) : undefined
      })
    };
  });

  app.get("/v1/control/media-assets", async (request) => {
    const query = request.query as { deviceId?: string };
    return {
      items: store.listImportedMedia(query.deviceId)
    };
  });

  app.get("/", async (_request, reply) => {
    reply.redirect("/v1/control/health");
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
