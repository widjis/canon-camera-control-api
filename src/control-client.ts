import { AppError } from "./errors.js";
import type {
  EdgeAcceptedJobResponse,
  EdgeJobResponse,
  EdgeSessionResponse,
  RegisteredEdgeDevice
} from "./control-types.js";
import type { MediaAsset } from "./types.js";

export interface EdgeClient {
  probeDevice(device: RegisteredEdgeDevice, secret: { edgeBaseUrl: string; edgeBearerToken: string | null }): Promise<{ health: unknown; device: unknown }>;
  createSession(device: RegisteredEdgeDevice, secret: { edgeBaseUrl: string; edgeBearerToken: string | null }): Promise<EdgeSessionResponse>;
  triggerCapture(
    device: RegisteredEdgeDevice,
    secret: { edgeBaseUrl: string; edgeBearerToken: string | null },
    sessionToken: string,
    payload: {
      captureTarget: "internalRam" | "memoryCard";
      downloadToEdge: boolean;
      keepOnCamera: boolean;
      filenameTemplate?: string;
    }
  ): Promise<EdgeAcceptedJobResponse>;
  getJob(
    device: RegisteredEdgeDevice,
    secret: { edgeBaseUrl: string; edgeBearerToken: string | null },
    jobId: string
  ): Promise<EdgeJobResponse>;
  getMedia(
    device: RegisteredEdgeDevice,
    secret: { edgeBaseUrl: string; edgeBearerToken: string | null },
    assetId: string
  ): Promise<MediaAsset>;
  releaseSession(
    device: RegisteredEdgeDevice,
    secret: { edgeBaseUrl: string; edgeBearerToken: string | null },
    sessionId: string,
    sessionToken: string
  ): Promise<void>;
}

function buildHeaders(edgeBearerToken: string | null, extras: Record<string, string> = {}): HeadersInit {
  const headers: Record<string, string> = {
    ...extras
  };
  if (edgeBearerToken) {
    headers.authorization = `Bearer ${edgeBearerToken}`;
  }
  return headers;
}

async function readJsonOrError(response: Response): Promise<unknown> {
  if (response.ok) {
    if (response.status === 204) {
      return null;
    }
    return response.json();
  }

  let payload: { code?: string; message?: string; details?: Record<string, unknown> } | undefined;
  try {
    payload = (await response.json()) as { code?: string; message?: string; details?: Record<string, unknown> };
  } catch {
    payload = undefined;
  }

  throw new AppError(response.status, {
    code: payload?.code ?? "EDGE_REQUEST_FAILED",
    message: payload?.message ?? `Edge request failed with status ${response.status}.`,
    details: {
      ...payload?.details,
      status: response.status
    }
  });
}

export class HttpEdgeClient implements EdgeClient {
  constructor(
    private readonly options: {
      pollTimeoutMs: number;
    }
  ) {}

  async probeDevice(device: RegisteredEdgeDevice, secret: { edgeBaseUrl: string; edgeBearerToken: string | null }): Promise<{ health: unknown; device: unknown }> {
    const [health, deviceState] = await Promise.all([
      this.requestJson(secret, "/v1/health"),
      this.requestJson(secret, "/v1/device")
    ]);

    return {
      health,
      device: deviceState
    };
  }

  async createSession(device: RegisteredEdgeDevice, secret: { edgeBaseUrl: string; edgeBearerToken: string | null }): Promise<EdgeSessionResponse> {
    return (await this.requestJson(secret, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        ownerType: "controlServer",
        ownerId: device.deviceId,
        leaseSeconds: 120
      }),
      headers: buildHeaders(secret.edgeBearerToken, {
        "content-type": "application/json"
      })
    })) as EdgeSessionResponse;
  }

  async triggerCapture(
    _device: RegisteredEdgeDevice,
    secret: { edgeBaseUrl: string; edgeBearerToken: string | null },
    sessionToken: string,
    payload: {
      captureTarget: "internalRam" | "memoryCard";
      downloadToEdge: boolean;
      keepOnCamera: boolean;
      filenameTemplate?: string;
    }
  ): Promise<EdgeAcceptedJobResponse> {
    return (await this.requestJson(secret, "/v1/captures", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: buildHeaders(secret.edgeBearerToken, {
        "content-type": "application/json",
        "x-session-token": sessionToken
      })
    })) as EdgeAcceptedJobResponse;
  }

  async getJob(
    _device: RegisteredEdgeDevice,
    secret: { edgeBaseUrl: string; edgeBearerToken: string | null },
    jobId: string
  ): Promise<EdgeJobResponse> {
    return (await this.requestJson(secret, `/v1/jobs/${jobId}`)) as EdgeJobResponse;
  }

  async getMedia(
    _device: RegisteredEdgeDevice,
    secret: { edgeBaseUrl: string; edgeBearerToken: string | null },
    assetId: string
  ): Promise<MediaAsset> {
    return (await this.requestJson(secret, `/v1/media/${assetId}`)) as MediaAsset;
  }

  async releaseSession(
    _device: RegisteredEdgeDevice,
    secret: { edgeBaseUrl: string; edgeBearerToken: string | null },
    sessionId: string,
    sessionToken: string
  ): Promise<void> {
    await this.requestJson(secret, `/v1/sessions/${sessionId}`, {
      method: "DELETE",
      headers: buildHeaders(secret.edgeBearerToken, {
        "x-session-token": sessionToken
      })
    });
  }

  private async requestJson(
    secret: { edgeBaseUrl: string; edgeBearerToken: string | null },
    pathname: string,
    init?: RequestInit
  ): Promise<unknown> {
    const response = await fetch(new URL(pathname, ensureTrailingSlash(secret.edgeBaseUrl)).toString(), {
      ...init,
      headers: init?.headers ?? buildHeaders(secret.edgeBearerToken),
      signal: AbortSignal.timeout(this.options.pollTimeoutMs)
    });
    return readJsonOrError(response);
  }
}

function ensureTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}
