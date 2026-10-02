import { test, expect } from "@playwright/test";

const annual = (y: number, extra: Record<string, unknown> = {}) => ({
  id: `P${y}`, effective: `${y}-01-01`, expiration: `${y + 1}-01-01`,
  payroll: [{ classCode: "0005", payroll: 1_000_000 / 3, audited: true }], claims: [], ...extra,
});

test.describe("US-09 POST /api/xmod/experience-period", () => {
  test("US-09 selects the three policies incepting in the period and explains every decision", async ({ request }) => {
    const r = await request.post("/api/xmod/experience-period", {
      data: { ratingEffectiveDate: "2026-01-01", policies: [2021, 2022, 2023, 2024, 2025].map((y) => annual(y)) },
    });
    expect(r.status()).toBe(200);
    const b = await r.json();
    expect(b.experiencePeriod).toEqual({ start: "2021-04-01", end: "2024-04-01" });
    expect(b.policies.filter((p: { included: boolean }) => p.included).map((p: { id: string }) => p.id)).toEqual(["P2022", "P2023", "P2024"]);
    for (const p of b.policies) expect(p.reasons[0]).toMatch(/^III\.[23]/);
    expect(b.assumptions.map((a: { id: string }) => a.id)).toContain("A1");
  });

  test("US-09 integration: the returned ratingInput feeds /api/xmod/calculate unchanged", async ({ request }) => {
    const sel = await (await request.post("/api/xmod/experience-period", {
      data: {
        ratingEffectiveDate: "2026-01-01",
        policies: [
          annual(2022, { payroll: [{ classCode: "0005", payroll: 500_000, audited: true }], claims: [{ id: "C1", indemnity: 20_000, medical: 0 }] }),
          annual(2023, { payroll: [{ classCode: "0005", payroll: 500_000, audited: true }, { classCode: "3634", payroll: 90_000, audited: false }] }),
          annual(2019, { claims: [{ id: "too-old", indemnity: 90_000, medical: 0 }] }),
        ],
      },
    })).json();
    expect(sel.ratingInput).toEqual({
      payroll: [{ classCode: "0005", payroll: 1_000_000 }],
      claims: [{ id: "C1", indemnity: 20_000, medical: 0 }],
      excludedUnauditedPayroll: true,
    });
    const mod = await (await request.post("/api/xmod/calculate", { data: sel.ratingInput })).json();
    // Same risk as the reference single-claim case, but the 25-point cap is off because unaudited payroll was excluded.
    expect(mod).toMatchObject({ expectedLosses: 20_200, capApplied: false, mod: 1.18 });
  });

  test("US-09 invalid policy data -> 422 in the standard error shape", async ({ request }) => {
    const r = await request.post("/api/xmod/experience-period", {
      data: { ratingEffectiveDate: "2026-01-01", policies: [annual(2022), annual(2022)] },
    });
    expect(r.status()).toBe(422);
    expect((await r.json()).error.code).toBe("DUPLICATE_POLICY");
    const bad = await request.post("/api/xmod/experience-period", { data: { ratingEffectiveDate: "2026-02-30", policies: [] } });
    expect((await bad.json()).error.code).toBe("BAD_DATE");
  });

  test("US-09 a body of the wrong shape -> 4xx, never 500", async ({ request }) => {
    const r = await request.post("/api/xmod/experience-period", { data: { ratingEffectiveDate: "2026-01-01", policies: "nope" } });
    expect(r.status()).toBe(422);
    const r2 = await request.post("/api/xmod/experience-period", { data: [] });
    expect(r2.status()).toBeGreaterThanOrEqual(400);
    expect(r2.status()).toBeLessThan(500);
  });
});

test.describe("US-09 POST /api/xmod/rating-effective-date", () => {
  test("US-09 12 months after the preceding policy, with the rule cited", async ({ request }) => {
    const b = await (await request.post("/api/xmod/rating-effective-date", {
      data: { priorPolicies: [{ id: "P1", effective: "2025-07-01", expiration: "2026-07-01" }], newPolicy: { id: "P2", effective: "2026-07-01", expiration: "2027-07-01" } },
    })).json();
    expect(b).toMatchObject({ date: "2026-07-01", rule: "V.1", basedOnPolicy: "P1", newPolicyEstablishesDate: true });
  });

  test("US-09 lapse of more than a year resets the date (V.1.b)", async ({ request }) => {
    const b = await (await request.post("/api/xmod/rating-effective-date", {
      data: { priorPolicies: [{ id: "P1", effective: "2021-01-01", expiration: "2022-01-01" }], newPolicy: { id: "P2", effective: "2023-05-01", expiration: "2024-05-01" } },
    })).json();
    expect(b).toMatchObject({ date: "2023-05-01", rule: "V.1.b" });
  });

  test("US-09 short-term policy does not establish a date (V.1.c)", async ({ request }) => {
    const b = await (await request.post("/api/xmod/rating-effective-date", {
      data: { priorPolicies: [{ id: "P1", effective: "2025-01-01", expiration: "2026-01-01" }], newPolicy: { id: "S", effective: "2026-01-01", expiration: "2026-03-01" } },
    })).json();
    expect(b.newPolicyEstablishesDate).toBe(false);
  });

  test("US-09 cancellation outside the policy term -> 422 BAD_POLICY_TERM", async ({ request }) => {
    const r = await request.post("/api/xmod/rating-effective-date", {
      data: { priorPolicies: [], newPolicy: { id: "P", effective: "2026-01-01", expiration: "2027-01-01", cancelled: "2028-01-01" } },
    });
    expect(r.status()).toBe(422);
    expect((await r.json()).error.code).toBe("BAD_POLICY_TERM");
  });
});
