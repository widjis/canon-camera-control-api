import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { createControlApp } from "../src/control-app.js";
import { getConfig } from "../src/config.js";

async function createTestConfig() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "camera-control-control-test-"));
  return {
    ...getConfig(),
    controlRequireBearerAuth: false,
    controlDataDir: dir,
    controlDatabasePath: path.join(dir, "control.sqlite")
  };
}

async function createFakeEdgeServer() {
  const app = Fastify();
  const session = {
    sessionId: "session-1",
    leaseToken: "lease-1"
  };
  const job = {
    jobId: "edge-job-1",
    status: "queued",
    result: null as null | {
      cameraPath: string;
      asset: {
        assetId: string;
        filename: string;
        mimeType: string;
        sizeBytes: number;
        localPath: string;
        cameraPath: string;
        sha256: string | null;
        createdAt: string;
      };
    },
    error: null
  };

  app.get("/v1/health", async () => ({ status: "ok" }));
  app.get("/v1/device", async () => ({
    deviceId: "edge-1",
    connectionState: "ready",
    camera: { connected: true, manufacturer: "Canon", model: "EOS R50", serialNumber: null, firmwareVersion: null },
    capabilities: ["stillCapture", "previewCapture"]
  }));
  app.post("/v1/sessions", async () => session);
  app.delete("/v1/sessions/:sessionId", async (_request, reply) => {
    reply.status(204).send();
  });
  app.post("/v1/captures", async () => {
    job.status = "succeeded";
    job.result = {
      cameraPath: "/store_00020001/DCIM/100CANON/IMG_0001.JPG",
      asset: {
        assetId: "asset-1",
        filename: "IMG_0001.JPG",
        mimeType: "image/jpeg",
        sizeBytes: 12345,
        localPath: "/edge/media/IMG_0001.JPG",
        cameraPath: "/store_00020001/DCIM/100CANON/IMG_0001.JPG",
        sha256: null,
        createdAt: "2026-07-14T00:00:00.000Z"
      }
    };
    return {
      jobId: job.jobId,
      status: "queued",
      type: "captureStill"
    };
  });
  app.get("/v1/jobs/:jobId", async () => job);
  app.get("/v1/media/:assetId", async () => job.result?.asset);

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP address from fake edge server.");
  }

  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

test("control server registers devices, probes them, and orchestrates capture", async () => {
  const config = await createTestConfig();
  const edge = await createFakeEdgeServer();
  const app = createControlApp(config);

  const register = await app.inject({
    method: "POST",
    url: "/v1/control/devices",
    payload: {
      deviceId: "edge-1",
      name: "Canon R50 Desk Rig",
      edgeBaseUrl: edge.baseUrl,
      mediaSyncPolicy: {
        syncMode: "metadataOnly",
        retentionMode: "edgeManaged"
      }
    }
  });

  assert.equal(register.statusCode, 201);

  const probe = await app.inject({
    method: "POST",
    url: "/v1/control/devices/edge-1/probe"
  });
  assert.equal(probe.statusCode, 202);

  let probeJob = await app.inject({
    method: "GET",
    url: `/v1/control/jobs/${probe.json().jobId}`
  });

  for (let i = 0; i < 10 && probeJob.json().status !== "succeeded"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    probeJob = await app.inject({
      method: "GET",
      url: `/v1/control/jobs/${probe.json().jobId}`
    });
  }

  assert.equal(probeJob.statusCode, 200);
  assert.equal(probeJob.json().status, "succeeded");

  const capture = await app.inject({
    method: "POST",
    url: "/v1/control/devices/edge-1/captures",
    payload: {
      captureTarget: "memoryCard",
      downloadToEdge: true,
      keepOnCamera: true
    },
    headers: {
      "x-actor-id": "integration-test"
    }
  });

  assert.equal(capture.statusCode, 202);

  let captureJob = await app.inject({
    method: "GET",
    url: `/v1/control/jobs/${capture.json().jobId}`
  });

  for (let i = 0; i < 20 && captureJob.json().status !== "succeeded"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    captureJob = await app.inject({
      method: "GET",
      url: `/v1/control/jobs/${capture.json().jobId}`
    });
  }

  assert.equal(captureJob.statusCode, 200);
  assert.equal(captureJob.json().status, "succeeded");
  assert.equal(captureJob.json().result.importedMedia.edgeAssetId, "asset-1");

  const auditLogs = await app.inject({
    method: "GET",
    url: "/v1/control/audit-logs?deviceId=edge-1"
  });

  const mediaAssets = await app.inject({
    method: "GET",
    url: "/v1/control/media-assets?deviceId=edge-1"
  });

  assert.equal(auditLogs.statusCode, 200);
  assert.ok(auditLogs.json().items.length >= 3);
  assert.equal(mediaAssets.statusCode, 200);
  assert.equal(mediaAssets.json().items.length, 1);

  await app.close();
  await edge.app.close();
});

test("control documentation endpoints expose swagger ui and raw openapi without control bearer auth", async () => {
  const config = await createTestConfig();
  config.controlRequireBearerAuth = true;
  config.controlBearerToken = "control-secret";
  const app = createControlApp(config);

  const docs = await app.inject({
    method: "GET",
    url: "/docs"
  });

  const openapi = await app.inject({
    method: "GET",
    url: "/openapi.yaml"
  });

  const protectedHealth = await app.inject({
    method: "GET",
    url: "/v1/control/health"
  });

  assert.equal(docs.statusCode, 200);
  assert.match(docs.headers["content-type"] ?? "", /^text\/html/);
  assert.match(docs.body, /SwaggerUIBundle/);
  assert.match(docs.body, /\/openapi\.yaml/);

  assert.equal(openapi.statusCode, 200);
  assert.match(openapi.headers["content-type"] ?? "", /^application\/yaml/);
  assert.match(openapi.body, /^openapi:\s+3\.1\.0/m);

  assert.equal(protectedHealth.statusCode, 401);

  await app.close();
});
