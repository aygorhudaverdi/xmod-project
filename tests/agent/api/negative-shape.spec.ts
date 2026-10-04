import { test, expect } from "@playwright/test";
import { ApiClient, CALCULATE } from "../../pages/ApiClient";
import { REF, risk } from "../../pages/builders";
import { expectClientError, expectError, expectErrorShape } from "../support";

test.describe("calculate API: request shape and content type", () => {
  test("AG-NEG-1: valid JSON that is not an object is rejected @negative", async ({ request }) => {
    const api = new ApiClient(request);
    for (const raw of ["null", "5", '"x"']) {
      await test.step(`body ${raw}`, async () => {
        const r = await api.calculateRaw(raw);
        // PLAN AG-NEG-1 (CONTRACT, Q1 assumption): 400 MALFORMED_JSON, error shape only, no mod key
        expectError(r, 400, "MALFORMED_JSON");
        expect(r.text).not.toContain('"mod"');
      });
    }
  });

  test("AG-NEG-2: empty, array and empty-object bodies are NO_PAYROLL @negative", async ({ request }) => {
    const api = new ApiClient(request);
    for (const raw of [undefined, "[]", "{}"]) {
      await test.step(`body ${raw ?? "(none)"}`, async () => {
        const r = await api.calculateRaw(raw);
        // PLAN AG-NEG-2 (CONTRACT US-06): 422 NO_PAYROLL "At least one payroll line is required"
        expectError(r, 422, "NO_PAYROLL");
        expect(r.json.error.message).toBe("At least one payroll line is required");
      });
    }
  });

  test("AG-NEG-3: missing or wrong content type is a 4xx JSON error @negative", async ({ request }) => {
    const api = new ApiClient(request);
    const ref = JSON.stringify(REF);
    await test.step("text/plain", async () => expectClientError(await api.calculateRaw(ref, "text/plain")));
    await test.step("form-urlencoded", async () =>
      expectClientError(await api.calculateRaw("payroll=1", "application/x-www-form-urlencoded")));
    await test.step("no content-type", async () => expectClientError(await api.calculateRaw(Buffer.from(ref), null)));
    await test.step("charset=utf-16", async () => {
      const r = await api.calculateRaw(ref, "application/json; charset=utf-16");
      // PLAN AG-NEG-3 step 4: 400 MALFORMED_JSON or 415, JSON error shape
      expectErrorShape(r);
      expect([400, 415]).toContain(r.status);
      if (r.status === 400) expect(r.json.error.code).toBe("MALFORMED_JSON");
    });
  });

  // BLOCKED step 1 (payroll as a string): its code depends on Q3 and it exposes CD-5. See run log.
  test("AG-NEG-4: payroll container of the wrong type or absent (steps 2-4) @negative", async ({ request }) => {
    const api = new ApiClient(request);
    for (const body of ['{"payroll":{},"claims":[]}', '{"payroll":5,"claims":[]}', '{"claims":[]}']) {
      await test.step(body, async () => {
        const r = await api.calculateRaw(body);
        // PLAN AG-NEG-4: steps 2-4 are 422 NO_PAYROLL and the message never contains "undefined"
        expectError(r, 422, "NO_PAYROLL");
        expect(r.json.error.message).not.toContain("undefined");
      });
    }
  });

  test("AG-NEG-5: array entries that are not objects @negative", async ({ request }) => {
    const api = new ApiClient(request);
    const cases: [string, unknown, number, string][] = [
      ["payroll [null]", risk([], {}, [null]), 400, "MALFORMED_REQUEST"],
      ["claims [null]", risk([null]), 400, "MALFORMED_REQUEST"],
      ["claims [5]", risk([5]), 422, "BAD_CLAIM_ID"],
      ["claims [[]]", risk([[]]), 422, "BAD_CLAIM_ID"],
      ["claims ['x']", risk(["x"]), 422, "BAD_CLAIM_ID"],
      ["claims {}", risk({}), 400, "MALFORMED_REQUEST"],
      ["claims 'abc'", risk("abc"), 422, "BAD_CLAIM_ID"],
    ];
    for (const [name, body, status, code] of cases) {
      await test.step(name, async () => {
        const r = await api.calculate(body);
        // PLAN AG-NEG-5: null entries and object claims 400 MALFORMED_REQUEST; number/array/string entries and string claims 422 BAD_CLAIM_ID
        expectError(r, status, code);
        expect(r.json.mod).toBeUndefined();
      });
    }
  });

  test("AG-NEG-6: wrong methods and path variants on the calculate route @negative", async ({ request }) => {
    const api = new ApiClient(request);
    for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
      await test.step(method, async () => {
        const r = await api.send(method, CALCULATE, { data: REF });
        // PLAN AG-NEG-6 steps 1-2: 404 with the JSON NOT_FOUND shape
        expectError(r, 404, "NOT_FOUND");
      });
    }
    await test.step("HEAD", async () => {
      // PLAN AG-NEG-6 step 2: 404 (a HEAD response has no body by HTTP rules)
      expect((await api.send("HEAD", CALCULATE)).status).toBe(404);
    });
    for (const path of [`${CALCULATE}/`, "/API/XMOD/CALCULATE", `${CALCULATE}?x=1`]) {
      await test.step(`POST ${path}`, async () => {
        const r = await api.send("POST", path, { data: REF });
        // PLAN AG-NEG-6 step 3: same as the plain route (200 with REF values) or a JSON 404; never 5xx
        if (r.status === 200) expect(r.json).toMatchObject({ expectedLosses: 20200, primaryThreshold: 8500, mod: 0.77 });
        else expectError(r, 404, "NOT_FOUND");
      });
    }
  });
});

