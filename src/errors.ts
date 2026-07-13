import type { ErrorPayload } from "./types.js";

export class AppError extends Error {
  readonly statusCode: number;
  readonly payload: ErrorPayload;

  constructor(statusCode: number, payload: ErrorPayload) {
    super(payload.message);
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

export function toErrorResponse(error: unknown): { statusCode: number; payload: ErrorPayload } {
  if (error instanceof AppError) {
    return { statusCode: error.statusCode, payload: error.payload };
  }

  const message = error instanceof Error ? error.message : "Unexpected error";
  return {
    statusCode: 500,
    payload: {
      code: "INTERNAL_ERROR",
      message
    }
  };
}
