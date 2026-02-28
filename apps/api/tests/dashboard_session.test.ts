/**
 * Dashboard session: cookie parsing, CSRF validation, session cookie headers.
 */

import { describe, expect, it } from "vitest";
import {
  getDashboardSessionIdFromCookie,
  sessionCookieHeader,
  clearSessionCookieHeader,
  validateDashboardCsrf,
  DASHBOARD_SESSION_COOKIE,
  CSRF_HEADER,
  SESSION_TTL_SEC,
} from "../src/dashboardSession.js";

describe("getDashboardSessionIdFromCookie", () => {
  it("returns null when cookie header is missing", () => {
    const req = new Request("http://localhost", { headers: {} });
    expect(getDashboardSessionIdFromCookie(req)).toBeNull();
  });

  it("returns null when cookie does not contain session cookie", () => {
    const req = new Request("http://localhost", {
      headers: { cookie: "other=value; foo=bar" },
    });
    expect(getDashboardSessionIdFromCookie(req)).toBeNull();
  });

  it("returns session id when cookie is present", () => {
    const req = new Request("http://localhost", {
      headers: { cookie: `${DASHBOARD_SESSION_COOKIE}=session-id-abc; Path=/` },
    });
    expect(getDashboardSessionIdFromCookie(req)).toBe("session-id-abc");
  });

  it("parses cookie with multiple parts", () => {
    const req = new Request("http://localhost", {
      headers: { cookie: `a=1; ${DASHBOARD_SESSION_COOKIE}=sid-123; b=2` },
    });
    expect(getDashboardSessionIdFromCookie(req)).toBe("sid-123");
  });
});

describe("sessionCookieHeader", () => {
  it("includes session id, HttpOnly, Path, SameSite, Max-Age", () => {
    const h = sessionCookieHeader("sid", 900, true);
    expect(h).toContain(`${DASHBOARD_SESSION_COOKIE}=sid`);
    expect(h).toContain("HttpOnly");
    expect(h).toContain("Path=/");
    expect(h).toContain("SameSite=Lax");
    expect(h).toContain("Max-Age=900");
    expect(h).toContain("Secure");
  });

  it("omits Secure when secure is false", () => {
    const h = sessionCookieHeader("sid", 900, false);
    expect(h).not.toContain("Secure");
  });
});

describe("clearSessionCookieHeader", () => {
  it("returns Set-Cookie value that clears the session cookie", () => {
    const h = clearSessionCookieHeader(true);
    expect(h).toContain(`${DASHBOARD_SESSION_COOKIE}=;`);
    expect(h).toContain("Max-Age=0");
  });
});

describe("validateDashboardCsrf", () => {
  it("throws when session has no csrf_token", () => {
    const req = new Request("http://localhost", {
      method: "POST",
      headers: { [CSRF_HEADER]: "token" },
    });
    expect(() =>
      validateDashboardCsrf(req, { sessionId: "s", userId: "u", workspaceId: "w", csrfToken: null }, ["https://app.example.com"]),
    ).toThrow("CSRF_TOKEN_REQUIRED");
  });

  it("throws when x-csrf-token does not match session", () => {
    const req = new Request("http://localhost", {
      method: "POST",
      headers: { [CSRF_HEADER]: "wrong-token" },
    });
    expect(() =>
      validateDashboardCsrf(req, { sessionId: "s", userId: "u", workspaceId: "w", csrfToken: "correct-token" }, ["https://app.example.com"]),
    ).toThrow("CSRF_TOKEN_INVALID");
  });

  it("does not throw when token matches and origin is allowed", () => {
    const req = new Request("http://localhost", {
      method: "POST",
      headers: { [CSRF_HEADER]: "correct-token", origin: "https://app.example.com" },
    });
    expect(() =>
      validateDashboardCsrf(req, { sessionId: "s", userId: "u", workspaceId: "w", csrfToken: "correct-token" }, ["https://app.example.com"]),
    ).not.toThrow();
  });

  it("throws when origin is present but not in allowlist", () => {
    const req = new Request("http://localhost", {
      method: "POST",
      headers: { [CSRF_HEADER]: "correct-token", origin: "https://evil.com" },
    });
    expect(() =>
      validateDashboardCsrf(req, { sessionId: "s", userId: "u", workspaceId: "w", csrfToken: "correct-token" }, ["https://app.example.com"]),
    ).toThrow("ORIGIN_NOT_ALLOWED");
  });

  it("accepts wildcard origin allowlist", () => {
    const req = new Request("http://localhost", {
      method: "POST",
      headers: { [CSRF_HEADER]: "correct-token", origin: "https://any.com" },
    });
    expect(() =>
      validateDashboardCsrf(req, { sessionId: "s", userId: "u", workspaceId: "w", csrfToken: "correct-token" }, ["*"]),
    ).not.toThrow();
  });
});

describe("SESSION_TTL_SEC", () => {
  it("is 15 minutes in seconds", () => {
    expect(SESSION_TTL_SEC).toBe(15 * 60);
  });
});
