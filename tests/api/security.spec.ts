import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../../src/server/app";

const risk = { payroll: [{ classCode: "0005", payroll: 1_000_000 }], claims: [] };

test.describe("US-06 security: headers", () => {
  for (const path of ["/", "/api/health"]) {
    test(`US-06 security headers are present on ${path}`, async ({ request }) => {
      const h = (await request.get(path)).headers();
      const csp = h["content-security-policy"];
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).not.toContain("unsafe-eval");
      expect(h["x-content-type-options"]).toBe("nosniff");
      expect(h["x-frame-options"]).toBe("SAMEORIGIN");
      expect(h["referrer-policy"]).toBe("no-referrer");
      expect(h["strict-transport-security"]).toContain("max-age=");
      expect(h["cross-origin-opener-policy"]).toBe("same-origin");
      expect(h["x-powered-by"]).toBeUndefined();
    });
  }
});

test.describe("US-06 security: error contract never leaks internals", () => {
  const jsonError = async (r: Awaited<ReturnType<APIRequestContext["get"]>>, status: number, code: string) => {
    expect(r.status()).toBe(status);
    expect(r.headers()["content-type"]).toContain("application/json");
    const text = await r.text();
    expect(text).not.toMatch(/node_modules|\bat \w|<html|<pre>/i); // no stack trace, no HTML page
    expect(JSON.parse(text).error.code).toBe(code);
  };

  test("US-06 unknown GET /api/* route -> JSON 404 NOT_FOUND", async ({ request }) => {
    await jsonError(await request.get("/api/does-not-exist"), 404, "NOT_FOUND");
  });
  test("US-06 wrong method on a real route -> JSON 404 NOT_FOUND", async ({ request }) => {
    await jsonError(await request.get("/api/xmod/calculate"), 404, "NOT_FOUND");
    await jsonError(await request.delete("/api/plan"), 404, "NOT_FOUND");
  });
  test("US-06 undecodable URL parameter -> JSON 400, no stack trace (DEF-005)", async ({ request }) => {
    await jsonError(await request.get("/api/classes/%ZZ"), 400, "BAD_REQUEST");
  });
  test("US-06 oversized body -> 413 PAYLOAD_TOO_LARGE in the standard error shape", async ({ request }) => {
    const r = await request.post("/api/xmod/calculate", { data: { ...risk, pad: "x".repeat(300_000) } });
    await jsonError(r, 413, "PAYLOAD_TOO_LARGE");
  });
  test("US-06 non-JSON content type is not parsed and is rejected without a 500", async ({ request }) => {
    const r = await request.post("/api/xmod/calculate", { headers: { "content-type": "text/plain" }, data: JSON.stringify(risk) });
    expect(r.status()).toBeGreaterThanOrEqual(400);
    expect(r.status()).toBeLessThan(500);
    expect((await r.json()).error.code).toBeTruthy();
  });
  test("US-06 a non-string claim id is rejected (DEF-006)", async ({ request }) => {
    const r = await request.post("/api/xmod/calculate", { data: { ...risk, claims: [{ id: { $gt: "" }, indemnity: 1, medical: 0 }] } });
    expect(r.status()).toBe(422);
    expect((await r.json()).error.code).toBe("BAD_CLAIM_ID");
  });
  test("US-06 injection-style strings are returned as data, never interpreted", async ({ request }) => {
    const id = `<script>alert(1)</script>'; DROP TABLE claims;--`;
    const b = await (await request.post("/api/xmod/calculate", { data: { ...risk, claims: [{ id, indemnity: 1000, medical: 0 }] } })).json();
    expect(b.claims[0].id).toBe(id);
  });
});

test.describe("US-06 security: rate limiting", () => {
  // The shared test server runs with a very high limit; this suite builds its own app with a limit of 3.
  let server: Server;
  let api: APIRequestContext;
  test.beforeAll(async () => {
    server = createApp({ rateLimit: { limit: 3, windowMs: 60_000 } }).listen(0);
    await new Promise((r) => server.once("listening", r));
    api = await pwRequest.newContext({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  });
  test.afterAll(async () => {
    await api?.dispose();
    await new Promise((r) => server.close(r));
  });

  test("US-06 calculate returns 429 RATE_LIMITED after the limit, in the standard error shape", async () => {
    for (let i = 0; i < 3; i++) {
      const ok = await api.post("/api/xmod/calculate", { data: risk });
      expect(ok.status()).toBe(200);
      expect(ok.headers()["ratelimit-policy"]).toContain("3");
    }
    const r = await api.post("/api/xmod/calculate", { data: risk });
    expect(r.status()).toBe(429);
    expect(r.headers()["retry-after"]).toBe("60");
    expect(r.headers()["content-type"]).toContain("application/json");
    expect(await r.json()).toEqual({ error: { code: "RATE_LIMITED", message: expect.stringContaining("3 per 60s") } });
    // Read-only endpoints are not limited.
    expect((await api.get("/api/plan")).status()).toBe(200);
  });
});
