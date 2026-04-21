import type { ApiError } from "@memorynodeai/shared";

/** Thrown when the API returns an error or when the client is misconfigured (e.g. missing API key). */
export class MemoryNodeApiError extends Error implements ApiError {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "MemoryNodeApiError";
    this.code = code;
    this.status = status;
    Object.setPrototypeOf(this, MemoryNodeApiError.prototype);
  }
}
