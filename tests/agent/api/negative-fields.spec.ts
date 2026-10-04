import { test, expect } from "@playwright/test";
import { ApiClient, type Reply } from "../../pages/ApiClient";
import { claim, payrollLine, risk, withClaim } from "../../pages/builders";
import { claimOf, expectClientError, expectError } from "../support";

const REF_VALUES = { expectedLosses: 20200, primaryThreshold: 8500, mod: 0.77 };
// Base case of AG-NEG-15 (HAND-CALC in the plan): AL 20,000, AP = PT 8,500 - 250 = 8,250, cap applies, mod 1.02.
const expectBaseCase = (r: Reply) => {
  expect(r.status).toBe(200);
  expect(claimOf(r)).toMatchObject({ actualLosses: 20000, actualPrimary: 8250 });
  expect(r.json.mod).toBe(1.02);
};

test.describe("calculate API: field types and values", () => {
  test("AG-NEG-7: payroll of the wrong type or format @negative", async ({ request }) => {
    const api = new ApiClient(request);
    const values: unknown[] = ["1000000", "1,000,000", "$1000000", "1e6", "Infinity", "NaN", null, true, [1000000], {}, -0.01];
    for (const v of values) {
      await test.step(`payroll ${JSON.stringify(v)}`, async () => {
        const r = await api.calculate(risk([], {}, [payrollLine("0005", v)]));
        // PLAN AG-NEG-7 steps 1-6, 9: 422 BAD_PAYROLL "Invalid payroll for 0005"
        expectError(r, 422, "BAD_PAYROLL");
        expect(r.json.error.message).toBe("Invalid payroll for 0005");
      });
    }
    await test.step("payroll 1e999", async () => {
      // PLAN AG-NEG-7 step 7: raw 1e999 parses to Infinity -> 422 BAD_PAYROLL
      expectError(await api.calculateRaw('{"payroll":[{"classCode":"0005","payroll":1e999}],"claims":[]}'), 422, "BAD_PAYROLL");
    });
    await test.step("payroll NaN", async () => {
      // PLAN AG-NEG-7 step 8: raw NaN is not JSON -> 400 MALFORMED_JSON
      expectError(await api.calculateRaw('{"payroll":[{"classCode":"0005","payroll":NaN}],"claims":[]}'), 400, "MALFORMED_JSON");
    });
  });

  test("AG-NEG-8: payroll that sums to zero, including negative zero @negative", async ({ request }) => {
    const api = new ApiClient(request);
    await test.step("-0", async () => {
      // PLAN AG-NEG-8 step 1: 422 ZERO_EXPECTED
      expectError(await api.calculateRaw('{"payroll":[{"classCode":"0005","payroll":-0}],"claims":[]}'), 422, "ZERO_EXPECTED");
    });
    await test.step("two zero lines", async () => {
      const r = await api.calculate(risk([], {}, [payrollLine("0005", 0), payrollLine("3634", 0)]));
      // PLAN AG-NEG-8 step 2: 422 ZERO_EXPECTED "Expected losses are zero; risk cannot be rated"
      expectError(r, 422, "ZERO_EXPECTED");
      expect(r.json.error.message).toBe("Expected losses are zero; risk cannot be rated");
    });
  });

  test("AG-NEG-9: loss amounts of the wrong type or missing @negative", async ({ request }) => {
    const api = new ApiClient(request);
    const bodies: [string, unknown][] = [
      ['indemnity "100"', withClaim("100")],
      ["indemnity absent", risk([{ id: "a", medical: 0 }])],
      ["indemnity null", withClaim(null)],
      ["indemnity true", withClaim(true)],
      ["indemnity [5]", withClaim([5])],
      ["indemnity -0.01", withClaim(-0.01)],
      ["medical null", withClaim(100, { medical: null })],
    ];
    for (const [name, body] of bodies) {
      await test.step(name, async () => {
        const r = await api.calculate(body);
        // PLAN AG-NEG-9 (CONTRACT US-06): 422 BAD_LOSS "Invalid loss amount on claim a"
        expectError(r, 422, "BAD_LOSS");
        expect(r.json.error.message).toBe("Invalid loss amount on claim a");
      });
    }
    await test.step("indemnity 1e999", async () => {
      const raw = '{"payroll":[{"classCode":"0005","payroll":1000000}],"claims":[{"id":"a","indemnity":1e999,"medical":0}]}';
      // PLAN AG-NEG-9: raw 1e999 -> 422 BAD_LOSS
      expectError(await api.calculateRaw(raw), 422, "BAD_LOSS");
    });
  });

  test("AG-NEG-10: class code variants are not normalised @negative", async ({ request }) => {
    const api = new ApiClient(request);
    const codes: unknown[] = ["005", "00005", " 0005", "0005 ", "5", 5, 5.0, "", null, undefined, "abcd"];
    for (const code of codes) {
      await test.step(`classCode ${JSON.stringify(code) ?? "absent"}`, async () => {
        // PLAN AG-NEG-10: only the exact key "0005" is a class; everything else 422 UNKNOWN_CLASS
        expectError(await api.calculate(risk([], {}, [{ classCode: code, payroll: 1_000_000 }])), 422, "UNKNOWN_CLASS");
      });
    }
  });

  test("AG-NEG-11: class codes named like Object.prototype members @negative @security", async ({ request }) => {
    const api = new ApiClient(request);
    for (const code of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      await test.step(`payroll classCode ${code}`, async () => {
        const r = await api.calculateRaw(`{"payroll":[{"classCode":"${code}","payroll":1000000}],"claims":[]}`);
        // PLAN AG-NEG-11 step 1 (CD-1): 422 UNKNOWN_CLASS naming the code, never 500
        expectError(r, 422, "UNKNOWN_CLASS");
        expect(r.json.error.message).toContain(code);
      });
    }
    await test.step("contractMedical constructor", async () => {
      // PLAN AG-NEG-11 step 2 (CD-1): 422 UNKNOWN_CLASS
      expectError(await api.calculate(risk([], { contractMedical: [{ classCode: "constructor", incurred: 1 }] })), 422, "UNKNOWN_CLASS");
    });
    for (const code of ["constructor", "__proto__"]) {
      await test.step(`GET /api/classes/${code}`, async () => {
        // PLAN AG-NEG-11 step 3 (CD-1): 404 UNKNOWN_CLASS
        expectError(await api.get(`/api/classes/${code}`), 404, "UNKNOWN_CLASS");
      });
    }
  });

  test("AG-NEG-12: claim id variants @negative", async ({ request }) => {
    const api = new ApiClient(request);
    const ids: [string, unknown][] = [["empty", ""], ["spaces", "   "], ["101 chars", "x".repeat(101)], ["null", null], ["7", 7], ["array", ["a"]], ["true", true]];
    for (const [name, id] of ids) {
      await test.step(`id ${name}`, async () => {
        // PLAN AG-NEG-12 (CONTRACT US-06, DEF-006): 422 BAD_CLAIM_ID
        expectError(await api.calculate(risk([claim({ id })])), 422, "BAD_CLAIM_ID");
      });
    }
    await test.step("id absent", async () => {
      // PLAN AG-NEG-12: 422 BAD_CLAIM_ID
      expectError(await api.calculate(risk([{ indemnity: 1, medical: 0 }])), 422, "BAD_CLAIM_ID");
    });
  });

  test("AG-NEG-13: unknown treatment value @negative", async ({ request }) => {
    const api = new ApiClient(request);
    const cases: [string, Record<string, unknown>][] = [
      ["bogus, no net", { treatment: "bogus" }],
      ["bogus, net 500", { treatment: "bogus", netIncurred: 500 }],
      ["Subrogation (wrong case)", { treatment: "Subrogation", netIncurred: 500 }],
    ];
    for (const [name, over] of cases) {
      await test.step(name, async () => {
        const r = await api.calculate(withClaim(1000, over));
        // PLAN AG-NEG-13 steps 1-3 (CD-4): 422 with a specific code, not BAD_NET
        expect(r.status).toBe(422);
        expect(r.json.error.code).not.toBe("BAD_NET");
      });
    }
    for (const treatment of [null, ""]) {
      await test.step(`treatment ${JSON.stringify(treatment)}`, async () => {
        const r = await api.calculate(withClaim(1000, { treatment }));
        // PLAN AG-NEG-13 step 4: treated as absent (200, AP 750 = 1,000 - 250) or rejected 422
        if (r.status === 200) expect(claimOf(r).actualPrimary).toBe(750);
        else { expect(r.status).toBe(422); expectClientError(r); }
      });
    }
  });

  test("AG-NEG-14: netIncurred on a claim whose treatment is none or absent @negative", async ({ request }) => {
    const api = new ApiClient(request);
    const cases: [string, Record<string, unknown>][] = [
      ["net 999, no treatment", { netIncurred: 999 }],
      ["treatment none, net 999", { treatment: "none", netIncurred: 999 }],
      ["net -5, no treatment", { netIncurred: -5 }],
    ];
    for (const [name, over] of cases) {
      await test.step(name, async () => {
        const r = await api.calculate(withClaim(100, over));
        // PLAN AG-NEG-14: (a) 422, or (b) 200 with the net ignored: AL 100, AP 0 (100 <= 250 floor)
        if (r.status === 200) expect(claimOf(r)).toMatchObject({ actualLosses: 100, actualPrimary: 0 });
        else expectClientError(r);
      });
    }
  });

  test("AG-NEG-15: boolean flags sent as strings or numbers @negative", async ({ request }) => {
    const api = new ApiClient(request);
    const claimFlags: [string, Record<string, unknown>][] = [
      ['nonCompensable "false"', { nonCompensable: "false" }], ['death "false"', { death: "false" }],
      ["elAndWc 0", { elAndWc: 0 }], ['elAndWc "no"', { elAndWc: "no" }],
      ['multiPerson "false"', { multiPerson: "false", accidentId: "A" }],
    ];
    const bodies: [string, unknown][] = [
      ...claimFlags.map(([n, o]) => [n, withClaim(20_000, o)] as [string, unknown]),
      ['excludedUnauditedPayroll "false"', withClaim(20_000, {}, { excludedUnauditedPayroll: "false" })],
      ['priorYearExperienceRated "false"', withClaim(20_000, {}, { priorYearExperienceRated: "false" })],
    ];
    for (const [name, body] of bodies) {
      await test.step(name, async () => {
        const r = await api.calculate(body);
        // PLAN AG-NEG-15 steps 1-5: 422 type error, or at minimum the result equals the base case (a string must not change the rule)
        if (r.status === 422) expectClientError(r);
        else expectBaseCase(r);
      });
    }
    await test.step("nonCompensable null", async () => {
      // PLAN AG-NEG-15 step 6: null is absent, result equals the base case
      expectBaseCase(await api.calculate(withClaim(20_000, { nonCompensable: null })));
    });
  });

  test("AG-NEG-16: contractMedical shapes @negative", async ({ request }) => {
    const api = new ApiClient(request);
    await test.step("null behaves as absent", async () => {
      // PLAN AG-NEG-16: null is accepted, REF result E 20,200, mod 0.77
      const r = await api.calculate(risk([], { contractMedical: null }));
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject(REF_VALUES);
    });
    const shapes: [string, unknown, string | null][] = [
      ['"abc"', "abc", null], ["{}", {}, null], ["[null]", [null], null],
      ["incurred absent", [{ classCode: "0005" }], "BAD_LOSS"],
      ['incurred "5"', [{ classCode: "0005", incurred: "5" }], "BAD_LOSS"],
      ["unknown class 9999", [{ classCode: "9999", incurred: 1 }], "UNKNOWN_CLASS"],
      ["incurred -1", [{ classCode: "0005", incurred: -1 }], "BAD_LOSS"],
    ];
    for (const [name, cm, code] of shapes) {
      await test.step(name, async () => {
        const r = await api.calculate(risk([], { contractMedical: cm }));
        // PLAN AG-NEG-16: 4xx JSON error; specific code where the plan names one (container-type code is open, Q3)
        expectClientError(r);
        if (code) expect(r.json.error.code).toBe(code);
      });
    }
  });

  test("AG-NEG-17: multiPerson and accidentId combinations @negative", async ({ request }) => {
    const api = new ApiClient(request);
    const bad: [string, Record<string, unknown>][] = [
      ["multiPerson without accidentId", { multiPerson: true }],
      ["empty accidentId", { multiPerson: true, accidentId: "" }],
      ["numeric accidentId", { multiPerson: true, accidentId: 7 }],
      ["array accidentId", { multiPerson: true, accidentId: ["A"] }],
    ];
    for (const [name, over] of bad) {
      await test.step(name, async () => {
        const r = await api.calculate(withClaim(20_000, over));
        // PLAN AG-NEG-17 steps 1-2: 422 BAD_ACCIDENT; step 3 (CD-6): accidentId must be text, 422
        expect(r.status).toBe(422);
        if (!("accidentId" in over) || over.accidentId === "") expectError(r, 422, "BAD_ACCIDENT");
      });
    }
    await test.step("accidentId without multiPerson", async () => {
      const r = await api.calculate(withClaim(20_000, { accidentId: "A1" }));
      // PLAN AG-NEG-17 step 4 (HAND-CALC): ordinary claim, id "a", AL 20,000, AP 8,500 - 250 = 8,250
      expect(r.status).toBe(200);
      expect(claimOf(r)).toMatchObject({ id: "a", actualLosses: 20000, actualPrimary: 8250 });
    });
  });
});
