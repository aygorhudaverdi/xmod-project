import { test, expect } from "@playwright/test";
import { ApiClient } from "../../pages/ApiClient";
import { REF, risk } from "../../pages/builders";
import { expectClientError } from "../support";

const REF_VALUES = { expectedLosses: 20200, primaryThreshold: 8500, mod: 0.77 };
const REF_PAYROLL = [{ classCode: "0005", payroll: 1_000_000 }];

test.describe("calculate API: smoke", () => {
  test("AG-SMOKE-1: response schema of a successful calculation", async ({ request }) => {
    const r = await new ApiClient(request).calculate(REF);
    const b = r.json;
    // PLAN AG-SMOKE-1 (HAND-CALC REF): exactly the 21 documented RatingResult keys
    expect(Object.keys(b).sort()).toEqual([
      "actualExcess", "actualLosses", "actualPrimary", "capApplied", "claims", "claimsWithPrimary", "classes", "eligibilityReason",
      "eligible", "expectedExcess", "expectedLosses", "expectedPrimary", "lossFreeMod", "lossFreeModUnrounded", "maximumLossValue",
      "mod", "modBeforeCap", "modUnrounded", "planEffective", "policy", "primaryThreshold",
    ]);
    // PLAN AG-SMOKE-1: values and types from the REF arithmetic (Ep 4,565.20 pinned in API-X US-01)
    expect(b).toMatchObject({
      planEffective: "2025-09-01", expectedLosses: 20200, primaryThreshold: 8500, expectedPrimary: 4565.2, expectedExcess: 15634.8,
      actualPrimary: 0, actualLosses: 0, actualExcess: 0, maximumLossValue: 175000, mod: 0.77, lossFreeMod: 0.77,
      modUnrounded: "0.774", modBeforeCap: "0.774", lossFreeModUnrounded: "0.774",
      capApplied: false, eligible: true, claimsWithPrimary: 0, claims: [],
      // PLAN AG-SMOKE-1 (ASSUMPTION RatingPolicy #1/#2)
      policy: { modDecimals: 2, roundExpectedForBand: true },
    });
    expect(typeof b.eligibilityReason).toBe("string");
    expect(b.classes).toHaveLength(1);
    expect(b.classes[0]).toMatchObject({ perUnitBasis: false, elr: "2.02" });
    // PLAN AG-SMOKE-1 (CONTRACT): content type and rate-limit headers
    expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(r.headers["ratelimit"]).toBeTruthy();
    expect(r.headers["ratelimit-policy"]).toBeTruthy();
  });

  // BLOCKED part: none of the REF-equality branches; the "claims":null branch is plan-allowed to be 4xx (Q19).
  test("AG-SMOKE-2: optional collections omitted behave as empty @edge", async ({ request }) => {
    const api = new ApiClient(request);
    await test.step("claims absent", async () => {
      // PLAN AG-SMOKE-2 (HAND-CALC REF): equals the REF result
      expect((await api.calculate({ payroll: REF_PAYROLL })).json).toMatchObject(REF_VALUES);
    });
    await test.step("claims null", async () => {
      const r = await api.calculate({ payroll: REF_PAYROLL, claims: null });
      // PLAN AG-SMOKE-2 (Q19): REF result, or rejected 4xx; never 5xx
      if (r.status === 200) expect(r.json).toMatchObject(REF_VALUES);
      else expectClientError(r);
    });
    await test.step("contractMedical null", async () => {
      // PLAN AG-SMOKE-2 (HAND-CALC REF): equals the REF result
      expect((await api.calculate(risk([], { contractMedical: null }))).json).toMatchObject(REF_VALUES);
    });
  });
});
