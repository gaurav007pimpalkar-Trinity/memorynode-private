# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-02-28

### Fixed

- **Proper API error parsing** — The SDK now correctly parses the API error response shape `{ error: { code, message } }`. Previously, thrown errors always had `code: "HTTP_ERROR"` and `message: response.statusText`; the actual API `code` and `message` are now preserved.

### Added

- **MemoryNodeApiError class** — A dedicated error class (extends `Error`) with `code`, `message`, and `status`. All API and client errors are thrown as `MemoryNodeApiError` so consumers can use `instanceof MemoryNodeApiError` and access `e.code` / `e.status`.
- **Fail-fast on missing API key** — When neither `apiKey` (constructor) nor `adminToken` (per call) is provided for a protected endpoint, the client throws `MemoryNodeApiError` with code `MISSING_API_KEY` before sending the request. `GET /healthz` remains allowed without credentials.
- **Re-exported ApiError** — The `ApiError` type is re-exported from the SDK so consumers can type errors without importing from `@memorynodeai/shared`.
- **Additional tests** — Tests for API error parsing (`{ error: { code, message } }`), `MISSING_API_KEY` fail-fast, and `health()` without API key.

### Changed

- Error handling: thrown value is now `MemoryNodeApiError` instead of a plain `Error` with assigned properties.

[0.1.2]: https://github.com/gaurav007pimpalkar-Trinity/memorynode/compare/sdk@0.1.1...sdk@0.1.2
