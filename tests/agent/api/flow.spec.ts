import { test, expect } from "@playwright/test";
import { ApiClient } from "../../pages/ApiClient";
import { IsolatedApp } from "../../pages/IsolatedApp";
import { payrollLine, REF, risk } from "../../pages/builders";
import { expectClientError, expectError } from "../support";

const REF_VALUES = { expectedLosses: 20200, primaryThreshold: 8500, mod: 0.77 };

/** Request counts of the calculate route from the Prometheus text, keyed by HTTP status. */
function calculateStatusCounts(metrics: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of metrics.matchAll(/^xmod_http_request_duration_seconds_count\{([^}]*)\} (\d+)$/gm)) {
    if (!m[1].includes('route="/api/xmod/calculate"')) continue;
    const status = /status="(\d+)"/.exec(m[1])?.[1] ?? "?";
    out[status] = (out[status] ?? 0) + Number(m[2]);
  }
  return out;
}

test.describe("calculate API: state and flow on the shared server", () => {
  test("AG-FLOW-2: a failed request does not poison the next one @flow", async ({ request }) => {
    const api = new ApiClient(request);
    const before = await api.calculate(REF);
    await test.step("two failures", async () => {
      expect((await api.calculate(risk([], {}, [payrollLine("constructor")]))).status).toBeGreaterThanOrEqual(400);
      expect((await api.calculateRaw("{not json")).status).toBe(400);
    });
    for (const n of [1, 2, 3]) {
      await test.step(`REF again (${n})`, async () => {
        const r = await api.calculate(REF);
        // PLAN AG-FLOW-2 (HAND-CALC REF, stateless endpoint): identical to the response before the failures
        expect(r.status).toBe(200);
        expect(r.json).toMatchObject(REF_VALUES);
        expect(r.json.error).toBeUndefined();
        expect(r.text).toBe(before.text);
      });
    }
  });
});

test.describe("calculate API: counters on an isolated app", () => {
  let app: IsolatedApp;
  test.beforeAll(async () => { app = await IsolatedApp.start(); });
  test.afterAll(async () => { await app.stop(); });

  test("AG-FLOW-1: five identical parallel requests @flow", async () => {
    const before = (await app.api.calculationCounters()).ok;
    const replies = await Promise.all([1, 2, 3, 4, 5].map(() => app.api.calculate(REF)));
    for (const r of replies) {
      // PLAN AG-FLOW-1 (HAND-CALC REF): five 200s, byte-identical bodies
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject(REF_VALUES);
      expect(r.text).toBe(replies[0].text);
    }
    // PLAN AG-FLOW-1 (CONTRACT, src/server/app.ts): calculations.ok increased by exactly 5
    expect((await app.api.calculationCounters()).ok - before).toBe(5);
  });

  // BLOCKED part: that a malformed-JSON body leaves the calculation counters unchanged (Q17).
  test("AG-FLOW-3: outcome counters and request histogram classify each failure @flow", async () => {
    const api = app.api;
    const before = await api.calculationCounters();
    const histBefore = calculateStatusCounts(await api.metricsText());
    await test.step("valid, 422, 400 shape error", async () => {
      expect((await api.calculate(REF)).status).toBe(200);
      expect((await api.calculate(risk([], {}, [payrollLine("9999")]))).status).toBe(422);
      expect((await api.calculate(risk([null]))).status).toBe(400);
      const after = await api.calculationCounters();
      // PLAN AG-FLOW-3 (ASSUMPTION, src/server/app.ts): ok +1, validation_error +2
      expect(after.ok - before.ok).toBe(1);
      expect(after.validation_error - before.validation_error).toBe(2);
    });
    await test.step("malformed JSON", async () => {
      expect((await api.calculateRaw("{not json")).status).toBe(400);
    });
    await test.step("histogram records all four", async () => {
      // PLAN AG-FLOW-3 (DEF-004): route "/api/xmod/calculate" with statuses 200, 422, 400, 400
      await expect.poll(async () => {
        const c = calculateStatusCounts(await api.metricsText());
        return ["200", "422", "400"].map((s) => (c[s] ?? 0) - (histBefore[s] ?? 0));
      }).toEqual([1, 1, 2]);
    });
  });
});

test.describe("calculate API: rate limit on an isolated app", () => {
  let app: IsolatedApp;
  test.beforeAll(async () => { app = await IsolatedApp.start({ rateLimit: { limit: 3, windowMs: 60_000 } }); });
  test.afterAll(async () => { await app.stop(); });

  test("AG-FLOW-6: 429 contract; failed requests consume budget @flow", async () => {
    for (let i = 0; i < 3; i++) {
      // PLAN AG-FLOW-6 (ASSUMPTION): invalid requests count the same as valid ones
      expectError(await app.api.calculate(risk([], {}, [payrollLine("9999")])), 422, "UNKNOWN_CLASS");
    }
    const r = await app.api.calculate(REF);
    // PLAN AG-FLOW-6 (CONTRACT): 429, Retry-After 60, JSON, exact body, no mod
    expect(r.status).toBe(429);
    expect(r.headers["retry-after"]).toBe("60");
    expect(r.headers["content-type"]).toContain("application/json");
    expect(r.json).toEqual({ error: { code: "RATE_LIMITED", message: "Too many calculation requests; limit is 3 per 60s" } });
    expectClientError(r);
  });
});
