import { test, expect } from "@playwright/test";
import { ApiClient } from "../../pages/ApiClient";
import { claim, payrollLine, REF, risk, withClaim } from "../../pages/builders";
import { claimOf, expectError } from "../support";

const calcAt = (api: ApiClient, payroll: number) => api.calculate(risk([], {}, [payrollLine("0005", payroll)]));

test.describe("calculate API: boundaries", () => {
  test("AG-BND-1: Table II edge 7,248 / 7,249 through fractional E @boundary", async ({ request }) => {
    const api = new ApiClient(request);
    const cases = [[358836, 7248.49, 4500], [358837, 7248.51, 5000]];
    for (const [payroll, expectedLosses, primaryThreshold] of cases) {
      await test.step(`payroll ${payroll}`, async () => {
        const r = await calcAt(api, payroll);
        // PLAN AG-BND-1 HAND-CALC: E rounds half-up to 7,248 -> PT 4,500; to 7,249 -> PT 5,000
        expect(r.json).toMatchObject({ expectedLosses, primaryThreshold });
      });
    }
  });

  test("AG-BND-2: Table II edge 27,391 / 27,392 through fractional E @boundary", async ({ request }) => {
    const api = new ApiClient(request);
    const cases = [[1356014, 27391.48, 9500], [1356015, 27391.5, 10000]];
    for (const [payroll, expectedLosses, primaryThreshold] of cases) {
      await test.step(`payroll ${payroll}`, async () => {
        const r = await calcAt(api, payroll);
        // PLAN AG-BND-2 HAND-CALC: E rounds to 27,391 -> PT 9,500; to 27,392 -> PT 10,000
        expect(r.json).toMatchObject({ expectedLosses, primaryThreshold });
      });
    }
  });

  test("AG-BND-3: $250 floor at 0, 249, 250, 250.005, 251 @boundary", async ({ request }) => {
    const api = new ApiClient(request);
    const cases = [[0, 0, 0], [249, 249, 0], [250, 250, 0], [250.005, 250.01, 0.01], [251, 251, 1]];
    for (const [indemnity, actualLosses, actualPrimary] of cases) {
      await test.step(`indemnity ${indemnity}`, async () => {
        const r = await api.calculate(withClaim(indemnity));
        // PLAN AG-BND-3 (Sec VI R2 floor): AP = AL - 250 never below 0; 250.005 -> AL 250.01, AP 0.01 (half-up cents, Q9)
        expect(r.status).toBe(200);
        expect(claimOf(r)).toMatchObject({ actualLosses, actualPrimary });
      });
    }
  });

  test("AG-BND-4: Maximum Loss Value 174,999 / 175,000 / 175,001 @boundary", async ({ request }) => {
    const api = new ApiClient(request);
    const cases = [[174999, 0, 174999], [175000, 0, 175000], [175001, 0, 175000], [100000, 75001, 175000], [0, 175001, 175000]];
    for (const [indemnity, medical, actualLosses] of cases) {
      await test.step(`indemnity ${indemnity} medical ${medical}`, async () => {
        const r = await api.calculate(risk([claim({ indemnity, medical })]));
        // PLAN AG-BND-4 (Sec VI R2, MLV 175,000): AL capped at 175,000; AP = 8,500 - 250 = 8,250 in all five
        expect(claimOf(r)).toMatchObject({ actualLosses, actualPrimary: 8250 });
      });
    }
  });

  test("AG-BND-5: Actual Losses around the primary threshold @boundary", async ({ request }) => {
    const api = new ApiClient(request);
    for (const [indemnity, actualPrimary] of [[8499, 8249], [8500, 8250], [8501, 8250]]) {
      await test.step(`indemnity ${indemnity}`, async () => {
        const r = await api.calculate(withClaim(indemnity));
        // PLAN AG-BND-5 HAND-CALC: AP = min(AL, 8,500) - 250
        expect(claimOf(r).actualPrimary).toBe(actualPrimary);
      });
    }
  });

  test("AG-BND-6: COVID window dates are inclusive at both ends @boundary", async ({ request }) => {
    const api = new ApiClient(request);
    const cases: [string, boolean][] = [["2019-11-30", false], ["2019-12-01", true], ["2020-02-29", true], ["2024-08-31", true], ["2024-09-01", false]];
    for (const [accidentDate, excluded] of cases) {
      await test.step(accidentDate, async () => {
        const r = await api.calculate(withClaim(50_000, { catastropheNumber: 12, accidentDate }));
        // PLAN AG-BND-6 (Sec VI R2(j)): inside the window AP 0, mod 0.77; outside AP 8,250, mod 1.02
        expect(claimOf(r)).toMatchObject(excluded
          ? { actualPrimary: 0, rule: "VI.2.j COVID-19 (Cat. 12): excluded" }
          : { actualPrimary: 8250, rule: "VI.2 ordinary: AL above threshold" });
        expect(r.json.mod).toBe(excluded ? 0.77 : 1.02);
      });
    }
  });

  test("AG-BND-7: netIncurred bounds on a subrogation claim @boundary", async ({ request }) => {
    const api = new ApiClient(request);
    const sub = (netIncurred: number, indemnity = 10_000) => api.calculate(withClaim(indemnity, { treatment: "subrogation", netIncurred }));
    await test.step("net 0 and net = gross", async () => {
      // PLAN AG-BND-7 (Sec VI R2(d)): ratio 0 -> AL 0, AP 0; ratio 1 -> AL 10,000, AP 8,500 - 250 = 8,250
      expect(claimOf(await sub(0))).toMatchObject({ actualLosses: 0, actualPrimary: 0 });
      expect(claimOf(await sub(10_000))).toMatchObject({ actualLosses: 10000, actualPrimary: 8250 });
    });
    await test.step("net 9,999.99 is accepted", async () => {
      // PLAN AG-BND-7: 200 (value not asserted until an oracle exists)
      expect((await sub(9999.99)).status).toBe(200);
    });
    for (const net of [10000.01, -0.01]) {
      await test.step(`net ${net}`, async () => {
        // PLAN AG-BND-7 (CONTRACT US-06): 422 BAD_NET
        expectError(await sub(net), 422, "BAD_NET");
      });
    }
    await test.step("zero gross", async () => {
      const r = await sub(0, 0);
      // PLAN AG-BND-7: 422 BAD_NET "gross incurred is zero, ratio undefined"
      expectError(r, 422, "BAD_NET");
      expect(r.json.error.message).toContain("gross incurred is zero, ratio undefined");
    });
  });

  test("AG-BND-8: multi-person Actual Primary cap edge 16,500 vs 16,501 @boundary", async ({ request }) => {
    const api = new ApiClient(request);
    const grouped = (amounts: number[]) =>
      api.calculate(risk(amounts.map((indemnity, i) => claim({ id: "abc"[i], indemnity, multiPerson: true, accidentId: "A" }))));
    const cases: [number[], string, number, number][] = [
      [[20000, 8500], "accident:A (a, b)", 16500, 28500],
      [[20000, 8500, 251], "accident:A (a, b, c)", 16500, 28751],
    ];
    for (const [amounts, id, actualPrimary, actualLosses] of cases) {
      await test.step(id, async () => {
        const r = await grouped(amounts);
        // PLAN AG-BND-8 (Sec VI R2(a)): AP capped at 2 x 8,500 - 500 = 16,500 (uncapped 16,501 is capped); one line, cap applies, mod 1.02
        expect(r.json.claims).toHaveLength(1);
        expect(claimOf(r)).toMatchObject({ id, actualPrimary, actualLosses });
        expect(r.json).toMatchObject({ claimsWithPrimary: 1, capApplied: true, mod: 1.02 });
      });
    }
  });

  test("AG-BND-9: request body limit 262,144 vs 262,145 bytes @boundary", async ({ request }) => {
    const api = new ApiClient(request);
    const bodyOfSize = (bytes: number) => {
      const empty = JSON.stringify({ ...REF, pad: "" });
      return JSON.stringify({ ...REF, pad: "x".repeat(bytes - Buffer.byteLength(empty)) });
    };
    await test.step("262,144 bytes", async () => {
      const raw = bodyOfSize(262_144);
      expect(Buffer.byteLength(raw)).toBe(262_144);
      const r = await api.calculateRaw(raw);
      // PLAN AG-BND-9 (CONTRACT, 256kb = 262,144): body equal to the limit is accepted, REF values
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ expectedLosses: 20200, primaryThreshold: 8500, mod: 0.77 });
    });
    await test.step("262,145 bytes", async () => {
      const raw = bodyOfSize(262_145);
      expect(Buffer.byteLength(raw)).toBe(262_145);
      // PLAN AG-BND-9: one byte over -> 413 PAYLOAD_TOO_LARGE in the error shape
      expectError(await api.calculateRaw(raw), 413, "PAYLOAD_TOO_LARGE");
    });
  });
});
