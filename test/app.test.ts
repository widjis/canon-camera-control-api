import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { getConfig } from "../src/config.js";
import type { GPhoto2Service } from "../src/gphoto2.js";

function createFakeGPhoto(): GPhoto2Service {
  const fake = {
    async getHealth() {
      return {
        status: "ok" as const,
        agentVersion: "test",
        time: new Date().toISOString()
      };
    },
    async getDeviceState() {
      return {
        deviceId: "test-device",
        agentVersion: "test",
        connectionState: "ready" as const,
        capabilities: ["stillCapture"],
        camera: {
          connected: true,
          manufacturer: "Canon",
          model: "Canon EOS R50",
          serialNumber: "123",
          firmwareVersion: "1.0"
        }
      };
    },
    async getCameraStatus() {
      return {
        connectionState: "ready" as const,
        batteryLevel: 100,
        lensName: null,
        availableShots: null,
        storage: [],
        settings: []
      };
    },
    async listCameraConfigs() {
      return [];
    },
    async updateCameraConfig() {
      return {
        key: "iso",
        label: "ISO",
        type: "enum" as const,
        writable: true,
        supported: true,
        value: "100",
        choices: ["100"],
        rawPath: "/main/imgsettings/iso"
      };
    },
    async capturePreview() {
      return Buffer.from("jpeg");
    },
    async triggerAutofocus() {},
    async stepFocus() {},
    async captureStill() {
      return {
        cameraPath: "/store/file.jpg",
        asset: null,
        storedOnCamera: true,
        storedLocally: false
      };
    },
    async listStorageVolumes() {
      return [];
    },
    async listStorageFiles() {
      return [];
    },
    async downloadStorageFile() {
      throw new Error("not implemented in fake");
    },
    async deleteStorageFile() {}
  };

  return fake as unknown as GPhoto2Service;
}

async function createTestConfig() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "camera-control-test-"));
  return {
    ...getConfig(),
    requireBearerAuth: false,
    dataDir: dir,
    databasePath: path.join(dir, "edge.sqlite"),
    mediaDir: path.join(dir, "media")
  };
}

test("health endpoint responds", async () => {
  const config = await createTestConfig();
  const app = createApp(
    config,
    { gphoto2: createFakeGPhoto() }
  );

  const response = await app.inject({
    method: "GET",
    url: "/v1/health"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, "ok");

  await app.close();
});

test("documentation endpoints expose swagger ui and raw openapi without bearer auth", async () => {
  const config = await createTestConfig();
  config.requireBearerAuth = true;
  config.bearerToken = "edge-secret";
  const app = createApp(config, { gphoto2: createFakeGPhoto() });

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
    url: "/v1/health"
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

test("session store prevents concurrent writers", async () => {
  const config = await createTestConfig();
  const app = createApp(
    config,
    { gphoto2: createFakeGPhoto() }
  );

  const first = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    payload: {
      ownerType: "controlServer",
      ownerId: "server-a",
      leaseSeconds: 300
    }
  });

  const second = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    payload: {
      ownerType: "controlServer",
      ownerId: "server-b",
      leaseSeconds: 300
    }
  });

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().code, "SESSION_CONFLICT");

  await app.close();
});

test("capture endpoint requires an active session token", async () => {
  const config = await createTestConfig();
  const app = createApp(
    config,
    { gphoto2: createFakeGPhoto() }
  );

  const response = await app.inject({
    method: "POST",
    url: "/v1/captures",
    payload: {
      captureTarget: "memoryCard",
      downloadToEdge: true,
      keepOnCamera: true
    }
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().code, "INVALID_SESSION");

  await app.close();
});

test("profiles are persisted and can be listed", async () => {
  const config = await createTestConfig();
  const app = createApp(config, { gphoto2: createFakeGPhoto() });

  const created = await app.inject({
    method: "POST",
    url: "/v1/profiles",
    payload: {
      name: "studio-default",
      description: "Default studio look",
      settings: {
        iso: "100",
        captureTarget: "memoryCard"
      }
    }
  });

  const listed = await app.inject({
    method: "GET",
    url: "/v1/profiles"
  });

  assert.equal(created.statusCode, 201);
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().items.length, 1);
  assert.equal(listed.json().items[0].name, "studio-default");

  await app.close();
});

test("profile apply creates a job when a session is active", async () => {
  const config = await createTestConfig();
  const app = createApp(config, { gphoto2: createFakeGPhoto() });

  const session = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    payload: {
      ownerType: "controlServer",
      ownerId: "server-a",
      leaseSeconds: 300
    }
  });

  const profile = await app.inject({
    method: "POST",
    url: "/v1/profiles",
    payload: {
      name: "apply-me",
      settings: {
        iso: "100"
      }
    }
  });

  const apply = await app.inject({
    method: "POST",
    url: `/v1/profiles/${profile.json().profileId}/apply`,
    headers: {
      "x-session-token": session.json().leaseToken
    }
  });

  assert.equal(apply.statusCode, 202);
  assert.equal(apply.json().type, "applyProfile");

  await app.close();
});
