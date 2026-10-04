import { test, expect } from "@playwright/test";
import { ApiClient } from "../../pages/ApiClient";
import { claim, payrollLine, risk, withClaim } from "../../pages/builders";
import { claimOf, expectClientError, expectError } from "../support";

const CLAIM_AT_MAX = '"id":"a","indemnity":1.7e308,"medical":1.7e308';
const refWithClaimRaw = (claimJson: string) => `{"payroll":[{"classCode":"0005","payroll":1000000}],"claims":[{${claimJson}}]}`;

test.describe("calculate API: edge cases", () => {
  test("AG-EDGE-1: floating-point sums stay exact in dollars @edge", async ({ request }) => {
    const r = await new ApiClient(request).calculate(risk([claim({ indemnity: 100.1, medical: 200.2 })]));
    // PLAN AG-EDGE-1 HAND-CALC: 100.1 + 200.2 = 300.3, AP = 300.3 - 250 = 50.3, excess 250 (not 300.29999999999995)
    expect(claimOf(r)).toMatchObject({ actualLosses: 300.3, actualPrimary: 50.3, actualExcess: 250 });
    // PLAN AG-EDGE-1 (RatingPolicy #1): (50.3 + 15,634.80) / 20,200 = 0.77654 -> 0.78
    expect(r.json.mod).toBe(0.78);
  });

  test("AG-EDGE-2: sub-cent loss amounts @edge", async ({ request }) => {
    const api = new ApiClient(request);
    for (const [indemnity, expected] of [[0.005, { actualLosses: 0.01 }], [250.004, { actualLosses: 250, actualPrimary: 0 }]] as const) {
      await test.step(`indemnity ${indemnity}`, async () => {
        const r = await api.calculate(withClaim(indemnity));
        // PLAN AG-EDGE-2 (ASSUMPTION half-up cents, Q9): 200 with these values, or a documented 422
        if (r.status === 200) expect(claimOf(r)).toMatchObject(expected);
        else expectClientError(r);
      });
    }
  });

  test("AG-EDGE-3: extreme magnitudes never 5xx and stay finite @edge", async ({ request }) => {
    const api = new ApiClient(request);
    const bodies: [string, string][] = [
      ["payroll 1e300", '{"payroll":[{"classCode":"0005","payroll":1e300}],"claims":[]}'],
      ["payroll 1e-320", '{"payroll":[{"classCode":"0005","payroll":1e-320}],"claims":[]}'],
      ["subrogation net 1e308", refWithClaimRaw(`${CLAIM_AT_MAX},"treatment":"subrogation","netIncurred":1e308`)],
    ];
    for (const [name, raw] of bodies) {
      await test.step(name, async () => {
        const r = await api.calculateRaw(raw);
        // PLAN AG-EDGE-3 (CONTRACT): never 5xx; a 200 holds only finite numbers (no null/Infinity), else a 422 with a code
        expect(r.status).toBeLessThan(500);
        if (r.status === 200) expect(r.text).not.toMatch(/:null|Infinity|NaN/);
        else expectClientError(r);
        // PLAN AG-EDGE-3 step 1 (HAND-CALC): top band "and over" -> PT 75,000
        if (name === "payroll 1e300" && r.status === 200) expect(r.json.primaryThreshold).toBe(75000);
      });
    }
    await test.step("claim 1.7e308 + 1.7e308, no treatment", async () => {
      const r = await api.calculateRaw(refWithClaimRaw(CLAIM_AT_MAX));
      // PLAN AG-EDGE-3 step 3 (HAND-CALC): AL capped at MLV 175,000, AP 8,250
      expect(r.status).toBe(200);
      expect(claimOf(r)).toMatchObject({ actualLosses: 175000, actualPrimary: 8250 });
    });
  });

  test("AG-EDGE-4: dollars entered for a per-capita class (API steps) @edge", async ({ request }) => {
    const api = new ApiClient(request);
    await test.step("100 persons", async () => {
      const r = await api.calculate(risk([], {}, [payrollLine("7707", 100)]));
      // PLAN AG-EDGE-4 step 1 (HAND-CALC, catalog E-02): 100 x 126.50 = 12,650, PT 6,500, per-unit basis
      expect(r.json).toMatchObject({ expectedLosses: 12650, primaryThreshold: 6500 });
      expect(r.json.classes[0].perUnitBasis).toBe(true);
    });
    await test.step("1,000,000 typed as dollars", async () => {
      const r = await api.calculate(risk([], {}, [payrollLine("7707", 1_000_000)]));
      // PLAN AG-EDGE-4 step 2 (HAND-CALC, catalog E-08): 1,000,000 x 126.50 = 126,500,000, top band PT 75,000
      expect(r.json).toMatchObject({ expectedLosses: 126_500_000, primaryThreshold: 75000 });
    });
  });

  test("AG-EDGE-5: head count in a dollar class, and fractional heads @edge", async ({ request }) => {
    const api = new ApiClient(request);
    await test.step("class 0005 payroll 100", async () => {
      const r = await api.calculate(risk([], {}, [payrollLine("0005", 100)]));
      // PLAN AG-EDGE-5 step 1 (HAND-CALC): 100 x 2.02 / 100 = 2.02, first band PT 4,500, not eligible (E < 10800)
      expect(r.json).toMatchObject({ expectedLosses: 2.02, primaryThreshold: 4500, eligible: false });
      expect(r.json.eligibilityReason).toContain("< 10800");
      expect(r.json.eligibilityReason).toContain("not rated prior year");
    });
    await test.step("class 7707 payroll 100.5", async () => {
      const r = await api.calculate(risk([], {}, [payrollLine("7707", 100.5)]));
      // PLAN AG-EDGE-5 step 2 (HAND-CALC): 100.5 x 126.50 = 12,713.25 accepted, or 422 if whole heads are required
      if (r.status === 200) expect(r.json.expectedLosses).toBe(12713.25);
      else expectClientError(r);
    });
  });

  test("AG-EDGE-6: duplicate payroll class lines are added @edge", async ({ request }) => {
    const r = await new ApiClient(request).calculate(risk([], {}, [payrollLine("0005", 500_000), payrollLine("0005", 500_000)]));
    // PLAN AG-EDGE-6 (HAND-CALC, catalog E-03): 2 x (500,000 x 2.02 / 100) = 20,200, two class entries
    expect(r.status).toBe(200);
    expect(r.json.expectedLosses).toBe(20200);
    expect(r.json.classes).toHaveLength(2);
  });

  // BLOCKED: steps 1-2 (Q14). Step 3 below.
  test("AG-EDGE-8: non-compensable with a treatment, step 3 only @edge", async ({ request }) => {
    const r = await new ApiClient(request).calculate(
      withClaim(20_000, { nonCompensable: true, treatment: "subrogation", netIncurred: 5000 }));
    // PLAN AG-EDGE-8 step 3 (Sec VI R2(c), HAND-CALC): excluded, AL 0, AP 0, mod = loss-free 0.77
    expect(r.status).toBe(200);
    expect(claimOf(r)).toMatchObject({ actualLosses: 0, actualPrimary: 0, rule: "VI.2.c non-compensable: excluded" });
    expect(r.json.mod).toBe(0.77);
  });

  // BLOCKED: steps 1-2 (precedence, Q14). Step 3 below.
  test("AG-EDGE-9: death with compromise and net 0, step 3 only @edge", async ({ request }) => {
    const r = await new ApiClient(request).calculate(
      withClaim(1000, { death: true, treatment: "compromise", netIncurred: 0 }));
    // PLAN AG-EDGE-9 step 3 (HAND-CALC): ratio 0 -> AL 0, AP 0, rule VI.2.g
    expect(claimOf(r)).toMatchObject({ actualLosses: 0, actualPrimary: 0 });
    expect(claimOf(r).rule).toContain("VI.2.g");
  });

  // BLOCKED: step 4, string catastropheNumber (Q7). Steps 1-3 below.
  test("AG-EDGE-10: multiPerson group of one, COVID fields without their pair (steps 1-3) @edge", async ({ request }) => {
    const api = new ApiClient(request);
    await test.step("group of one", async () => {
      const r = await api.calculate(withClaim(20_000, { multiPerson: true, accidentId: "A1" }));
      // PLAN AG-EDGE-10 step 1: line "accident:A1 (a)", AP 8,250 (below the 16,500 cap), mod 1.02
      expect(claimOf(r)).toMatchObject({ id: "accident:A1 (a)", actualPrimary: 8250 });
      expect(r.json.mod).toBe(1.02);
    });
    for (const [name, over] of [["catastrophe 12, no date", { catastropheNumber: 12 }], ["date, no catastrophe", { accidentDate: "2021-06-01" }]]) {
      await test.step(name as string, async () => {
        const r = await api.calculate(withClaim(20_000, over as Record<string, unknown>));
        // PLAN AG-EDGE-10 steps 2-3 (Sec VI R2(j)): exclusion needs both fields, so not excluded: AP 8,250
        expect(claimOf(r).actualPrimary).toBe(8250);
      });
    }
  });

  test("AG-EDGE-11: accidentDate is validated as an ISO date @edge @negative", async ({ request }) => {
    const api = new ApiClient(request);
    const bad: unknown[] = ["2020-02-30", "zzzz", "2020-6-1", 20200601, ""];
    for (const accidentDate of bad) {
      await test.step(`accidentDate ${JSON.stringify(accidentDate)}`, async () => {
        // PLAN AG-EDGE-11 (CONTRACT, CD-3): a value that is not a real ISO yyyy-mm-dd date is 422
        const r = await api.calculate(withClaim(50_000, { catastropheNumber: 12, accidentDate }));
        expect(r.status).toBe(422);
        expectClientError(r);
      });
    }
    await test.step("timestamp on the last window day", async () => {
      const r = await api.calculate(withClaim(50_000, { catastropheNumber: 12, accidentDate: "2024-08-31T12:00:00Z" }));
      // PLAN AG-EDGE-11 (CD-3): either rejected 422 or classified like "2024-08-31": excluded, AP 0, mod 0.77
      if (r.status === 200) {
        expect(claimOf(r).actualPrimary).toBe(0);
        expect(r.json.mod).toBe(0.77);
      } else expectError(r, 422, r.json.error.code);
    });
  });
});
