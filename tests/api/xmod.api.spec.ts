import { test, expect } from "@playwright/test";
import pkg from "../../package.json" with { type: "json" };

const risk = (claims: unknown[] = [], extra = {}) => ({
  payroll: [{ classCode: "0005", payroll: 1_000_000 }], claims, ...extra,
});
const calc = (request: any, data: unknown) => request.post("/api/xmod/calculate", { data });

test.describe("health, plan and reference data", () => {
  test("GET /api/health reports status and the package version", async ({ request }) => {
    const r = await request.get("/api/health");
    expect(r.ok()).toBeTruthy();
    expect(await r.json()).toEqual({ status: "ok", version: pkg.version });
  });
  test("GET /api/plan exposes the plan constants", async ({ request }) => {
    const p = await (await request.get("/api/plan")).json();
    expect(p).toMatchObject({ effective: "2025-09-01", maximum_loss_value: 175000, average_death_value: 175000, eligibility_threshold: 10800 });
    expect(p.thresholds).toHaveLength(92);
  });
  test("GET /api/classes/0005 returns ELR 2.02", async ({ request }) => {
    expect(await (await request.get("/api/classes/0005")).json()).toEqual({ classCode: "0005", elr: "2.02", perUnitBasis: false });
  });
  test("per-capita class is flagged", async ({ request }) => {
    expect((await (await request.get("/api/classes/7707")).json()).perUnitBasis).toBe(true);
  });
  test("unknown class → 404 with error body", async ({ request }) => {
    const r = await request.get("/api/classes/9999");
    expect(r.status()).toBe(404);
    expect((await r.json()).error.code).toBe("UNKNOWN_CLASS");
  });
});

test.describe("US-01/US-07 calculate", () => {
  test("US-01 loss-free reference risk", async ({ request }) => {
    const r = await calc(request, risk());
    expect(r.status()).toBe(200);
    const b = await r.json();
    expect(b).toMatchObject({ expectedLosses: 20200, primaryThreshold: 8500, expectedPrimary: 4565.2, expectedExcess: 15634.8, mod: 0.77, eligible: true });
  });
  test("US-07 response carries a per-claim breakdown with the rule applied", async ({ request }) => {
    const b = await (await calc(request, risk([{ id: "a", indemnity: 1000, medical: 0 }, { id: "b", indemnity: 1000, medical: 0 }]))).json();
    expect(b.claims).toHaveLength(2);
    expect(b.claims[0]).toMatchObject({ id: "a", actualLosses: 1000, actualPrimary: 750 });
    expect(b.claims[0].rule).toContain("VI.2");
    expect(b.mod).toBe(0.85);
  });
});

test.describe("US-03/US-04 rules end to end", () => {
  test("US-04 single large claim is capped", async ({ request }) => {
    const b = await (await calc(request, risk([{ id: "a", indemnity: 20_000, medical: 0 }]))).json();
    expect(b).toMatchObject({ capApplied: true, mod: 1.02, claimsWithPrimary: 1 });
  });
  test("US-04 cap is off when unaudited payroll was excluded", async ({ request }) => {
    const b = await (await calc(request, risk([{ id: "a", indemnity: 20_000, medical: 0 }], { excludedUnauditedPayroll: true }))).json();
    expect(b).toMatchObject({ capApplied: false, mod: 1.18 });
  });
  test("US-03 subrogation vs joint coverage differ by $125", async ({ request }) => {
    const mk = (treatment: string) => risk([{ id: "x", indemnity: 10_000, medical: 0, treatment, netIncurred: 5_000 }]);
    const s = await (await calc(request, mk("subrogation"))).json();
    const j = await (await calc(request, mk("joint"))).json();
    expect(j.claims[0].actualPrimary - s.claims[0].actualPrimary).toBe(125);
  });
  test("US-03 multi-person accident is one capped line", async ({ request }) => {
    const claims = ["a", "b", "c"].map((id) => ({ id, indemnity: 20_000, medical: 0, multiPerson: true, accidentId: "A1" }));
    const b = await (await calc(request, risk(claims))).json();
    expect(b.claims).toHaveLength(1);
    expect(b.claims[0].actualPrimary).toBe(16_500);
  });
  test("US-03 COVID Cat.12 claim is excluded", async ({ request }) => {
    const b = await (await calc(request, risk([{ id: "c", indemnity: 50_000, medical: 0, catastropheNumber: 12, accidentDate: "2021-06-01" }]))).json();
    expect(b.actualPrimary).toBe(0);
    expect(b.mod).toBe(b.lossFreeMod);
  });
});

test.describe("US-05 eligibility", () => {
  const small = (payroll: number, extra = {}) => ({ payroll: [{ classCode: "3634", payroll }], claims: [], ...extra });
  test("at exactly $10,800 expected losses → eligible", async ({ request }) => {
    expect((await (await calc(request, small(900_000))).json()).eligible).toBe(true);
  });
  test("just below → not eligible", async ({ request }) => {
    expect((await (await calc(request, small(899_999))).json()).eligible).toBe(false);
  });
});

test.describe("US-06 validation and error contract", () => {
  const cases: [string, unknown, number, string][] = [
    ["unknown class", { payroll: [{ classCode: "9999", payroll: 1 }], claims: [] }, 422, "UNKNOWN_CLASS"],
    ["negative payroll", { payroll: [{ classCode: "0005", payroll: -1 }], claims: [] }, 422, "BAD_PAYROLL"],
    ["no payroll", { payroll: [], claims: [] }, 422, "NO_PAYROLL"],
    ["zero expected", { payroll: [{ classCode: "0005", payroll: 0 }], claims: [] }, 422, "ZERO_EXPECTED"],
    ["negative loss", risk([{ id: "a", indemnity: -1, medical: 0 }]), 422, "BAD_LOSS"],
    ["duplicate claim ids", risk([{ id: "a", indemnity: 1, medical: 0 }, { id: "a", indemnity: 1, medical: 0 }]), 422, "DUPLICATE_CLAIM"],
    ["net exceeds gross", risk([{ id: "a", indemnity: 100, medical: 0, treatment: "joint", netIncurred: 200 }]), 422, "BAD_NET"],
    ["subrogation without net", risk([{ id: "a", indemnity: 100, medical: 0, treatment: "subrogation" }]), 422, "BAD_NET"],
  ];
  for (const [name, body, status, code] of cases) {
    test(`US-06 ${name} → ${status} ${code}`, async ({ request }) => {
      const r = await calc(request, body);
      expect(r.status()).toBe(status);
      const b = await r.json();
      expect(b.error.code).toBe(code);
      expect(b.mod).toBeUndefined(); // never return a result alongside an error
    });
  }
  test("malformed JSON → 400 MALFORMED_JSON in the standard error shape", async ({ request }) => {
    const r = await request.post("/api/xmod/calculate", { headers: { "content-type": "application/json" }, data: "{not json" });
    expect(r.status()).toBe(400);
    expect(r.headers()["content-type"]).toContain("application/json");
    expect((await r.json()).error.code).toBe("MALFORMED_JSON");
  });
  test("oversized body → 413", async ({ request }) => {
    const r = await request.post("/api/xmod/calculate", { data: { payroll: [], claims: [], pad: "x".repeat(300_000) } });
    expect(r.status()).toBe(413);
  });
  test("payroll as a string does not 500", async ({ request }) => {
    const r = await calc(request, { payroll: [{ classCode: "0005", payroll: "abc" }], claims: [] });
    expect(r.status()).toBeLessThan(500);
  });
});

test.describe("observability", () => {
  test("/metrics exposes xmod counters after a calculation", async ({ request }) => {
    await calc(request, risk());
    const text = await (await request.get("/metrics")).text();
    expect(text).toContain("xmod_calculations_total");
    expect(text).toContain("xmod_http_request_duration_seconds_bucket");
  });
  test("latency histogram has bucket edges at the 200 ms and 500 ms targets", async ({ request }) => {
    const text = await (await request.get("/metrics")).text();
    expect(text).toMatch(/xmod_http_request_duration_seconds_bucket\{le="0\.2",/);
    expect(text).toMatch(/xmod_http_request_duration_seconds_bucket\{le="0\.5",/);
  });
  test("unknown URLs share one 'unmatched' route label (bounded metric cardinality, DEF-003)", async ({ request }) => {
    const probe = `/no-such-page-${Date.now()}`;
    expect((await request.get(probe)).status()).toBe(404);
    const text = await (await request.get("/metrics")).text();
    expect(text).not.toContain(probe);
    expect(text).toMatch(/route="unmatched",status="404"/);
  });
  test("body-parser errors are labelled with their endpoint, not as static files", async ({ request }) => {
    await request.post("/api/xmod/calculate", { headers: { "content-type": "application/json" }, data: "{oops" });
    const text = await (await request.get("/metrics")).text();
    expect(text).toMatch(/method="POST",route="\/api\/xmod\/calculate",status="400"/);
  });
});
