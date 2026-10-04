import { test, expect } from "@playwright/test";
import pkg from "../../../package.json" with { type: "json" };
import { ApiClient, type Reply } from "../../pages/ApiClient";
import { IsolatedApp } from "../../pages/IsolatedApp";
import { claim, payrollLine, REF, risk, withClaim } from "../../pages/builders";
import { claimOf, expectError, expectErrorShape } from "../support";

const REF_VALUES = { expectedLosses: 20200, primaryThreshold: 8500, mod: 0.77 };

test.describe("calculate API: security and robustness", () => {
  test("AG-SEC-1: prototype-pollution keys leave no trace @security", async ({ request }) => {
    const api = new ApiClient(request);
    await test.step("__proto__ at top level", async () => {
      const r = await api.calculateRaw(refWithProto());
      // PLAN AG-SEC-1 (HAND-CALC REF): 200, E 20,200, PT 8,500, mod 0.77
      expect(r.json).toMatchObject(REF_VALUES);
    });
    await test.step("constructor.prototype", async () => {
      const r = await api.calculate(risk([], { constructor: { prototype: { polluted: 1 } } }));
      // PLAN AG-SEC-1: 200 with REF values
      expect(r.json).toMatchObject(REF_VALUES);
    });
    await test.step("__proto__ inside a claim", async () => {
      const r = await api.calculateRaw('{"payroll":[{"classCode":"0005","payroll":1000000}],"claims":[{"id":"a","indemnity":1,"medical":0,"__proto__":{"nonCompensable":true,"death":true}}]}');
      // PLAN AG-SEC-1: AL 1, AP 0 (1 <= 250), ordinary rule, not excluded and not a death
      expect(claimOf(r)).toMatchObject({ actualLosses: 1, actualPrimary: 0, rule: "VI.2 ordinary: AL <= $250" });
    });
    await test.step("later clean requests are unaffected", async () => {
      // PLAN AG-SEC-1 (HAND-CALC): 20,000 > PT 8,500 so AP 8,250, not excluded, not death; REF mod 0.77
      expect(claimOf(await api.calculate(risk([claim({ id: "b", indemnity: 20_000 })])))).toMatchObject({ actualLosses: 20000, actualPrimary: 8250 });
      expect((await api.calculate(REF)).json).toMatchObject(REF_VALUES);
      // PLAN AG-SEC-1 step 5: health unchanged
      expect((await api.get("/api/health")).json).toEqual({ status: "ok", version: pkg.version });
    });
  });

  test("AG-SEC-2: markup, RTL, emoji and NUL in text fields round-trip as data @security", async ({ request }) => {
    const api = new ApiClient(request);
    const ids = ["‮abc\u0000😀", "<img src=x onerror=alert(1)>"];
    for (const id of ids) {
      await test.step(`claim id ${JSON.stringify(id)}`, async () => {
        const r = await api.calculate(risk([claim({ id, indemnity: 1 })]));
        // PLAN AG-SEC-2 (CONTRACT): 200, the id comes back unchanged, JSON + nosniff
        expect(r.status).toBe(200);
        expect(claimOf(r).id).toBe(id);
        expect(r.headers["content-type"]).toContain("application/json");
        expect(r.headers["x-content-type-options"]).toBe("nosniff");
      });
    }
    await test.step("id length 100 vs 101 (UTF-16 code units)", async () => {
      // PLAN AG-SEC-2 (ASSUMPTION Q15): 100 accepted, 101 is 422 BAD_CLAIM_ID
      expect((await api.calculate(risk([claim({ id: "é".repeat(100) })]))).status).toBe(200);
      expectError(await api.calculate(risk([claim({ id: "é".repeat(101) })])), 422, "BAD_CLAIM_ID");
    });
    await test.step("accidentId markup", async () => {
      const accidentId = "<svg onload=alert(1)>";
      const r = await api.calculate(risk([claim({ id: "a", indemnity: 20_000, multiPerson: true, accidentId }), claim({ id: "b", indemnity: 20_000, multiPerson: true, accidentId })]));
      // PLAN AG-SEC-2 step 4: returned as data in the grouped line id
      expect(claimOf(r).id).toBe(`accident:${accidentId} (a, b)`);
    });
  });

  test("AG-SEC-3: error messages do not echo unbounded input @security", async ({ request }) => {
    const r = await new ApiClient(request).calculate(risk([], {}, [payrollLine("<script>" + "x".repeat(100_000), 1_000_000)]));
    // PLAN AG-SEC-3 (CD-6, ASSUMPTION DEF-006 rationale): 422 UNKNOWN_CLASS, response no larger than a few hundred bytes
    expectError(r, 422, "UNKNOWN_CLASS");
    expect(r.bytes).toBeLessThan(500);
  });

  test("AG-SEC-4: security headers and JSON content type on error responses @security", async ({ request }) => {
    const api = new ApiClient(request);
    const replies: [string, () => Promise<Reply>][] = [
      ["422", () => api.calculate(risk([], {}, [payrollLine("9999")]))],
      ["400", () => api.calculateRaw("{not json")],
      ["404", () => api.get("/api/xmod/<script>alert(1)</script>")],
      ["413", () => api.calculate({ ...REF, pad: "x".repeat(300_000) })],
    ];
    for (const [status, send] of replies) {
      await test.step(`${status} response`, async () => {
        const r = await send();
        const h = r.headers;
        // PLAN AG-SEC-4 (CONTRACT, helmet before every route): JSON, nosniff, CSP, referrer policy, HSTS, no x-powered-by
        expect(r.status).toBe(Number(status));
        expect(h["content-type"]).toContain("application/json");
        expect(h["x-content-type-options"]).toBe("nosniff");
        expect(h["content-security-policy"]).toContain("default-src 'self'");
        expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
        expect(h["referrer-policy"]).toBe("no-referrer");
        expect(h["strict-transport-security"]).toBeTruthy();
        expect(h["x-powered-by"]).toBeUndefined();
        // PLAN AG-SEC-4: the 404 message shows the URL percent-encoded, not raw markup
        if (status === "404") {
          expect(r.json.error.message).toContain("%3Cscript%3E");
          expect(r.json.error.message).not.toContain("<script>");
        }
      });
    }
  });

  test("AG-SEC-5: no stack trace, path or result fields on any failure @security", async ({ request }) => {
    const api = new ApiClient(request);
    const raw = (s?: string) => () => api.calculateRaw(s);
    const calc = (b: unknown) => () => api.calculate(b);
    const failing: (() => Promise<Reply>)[] = [
      raw("null"), raw("5"), raw('"x"'), raw(), raw("[]"), raw("{}"), raw("{not json"),
      calc({ payroll: "abc", claims: [] }), calc({ payroll: {}, claims: [] }), calc({ claims: [] }),
      calc(risk([], {}, [null])), calc(risk([null])), calc(risk([5])), calc(risk({})), calc(risk("abc")),
      calc(risk([], {}, [payrollLine("0005", "1000000")])), calc(risk([], {}, [payrollLine("0005", -0.01)])),
      calc(risk([], {}, [payrollLine("0005", 0)])), calc(risk([], {}, [payrollLine("5")])),
      calc(risk([], {}, [payrollLine(null)])), calc(risk([], {}, [payrollLine("abcd")])),
      calc(withClaim("100")), calc(withClaim(null)), calc(withClaim(-0.01)),
      calc(risk([claim({ id: "" })])), calc(risk([claim({ id: "x".repeat(101) })])), calc(risk([claim({ id: 7 })])),
      calc(withClaim(1000, { treatment: "subrogation" })), calc(withClaim(20_000, { multiPerson: true })),
      calc(risk([], { contractMedical: "abc" })), calc(risk([], { contractMedical: [{ classCode: "9999", incurred: 1 }] })),
      calc(risk([], {}, [payrollLine("constructor")])), calc(risk([], {}, [payrollLine("__proto__")])),
      raw('{"payroll":[{"classCode":"0005","payroll":1e999}],"claims":[]}'),
      calc(risk([], {}, [payrollLine("<script>" + "x".repeat(50), 1)])),
    ];
    expect(failing.length).toBeLessThanOrEqual(40);
    for (const [i, send] of failing.entries()) {
      await test.step(`failing request ${i + 1}`, async () => {
        const r = await send();
        // PLAN AG-SEC-5 (CONTRACT): exactly {error:{code,message}}, code UPPER_SNAKE, no result keys, no internals; 500 body is the fixed INTERNAL text
        expect(r.status).toBeGreaterThanOrEqual(400);
        expectErrorShape(r);
        expect(r.json.error.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect(r.text).not.toMatch(/node_modules|\bat \S+ \(|\/home\/|stack|<html/);
        for (const key of ["mod", "result", "claims", "expectedLosses"]) expect(r.json).not.toHaveProperty(key);
        if (r.status === 500) expect(r.json).toEqual({ error: { code: "INTERNAL", message: "Unexpected error" } });
      });
    }
  });

  test.describe("rate limit with spoofed X-Forwarded-For", () => {
    let app: IsolatedApp;
    test.beforeAll(async () => { app = await IsolatedApp.start({ rateLimit: { limit: 3, windowMs: 60_000 } }); });
    test.afterAll(async () => { await app.stop(); });

    test("AG-SEC-6: X-Forwarded-For cannot evade the rate limit @security", async () => {
      for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) {
        expect((await app.api.calculate(REF, { "x-forwarded-for": ip })).status).toBe(200);
      }
      const r = await app.api.calculate(REF, { "x-forwarded-for": "4.4.4.4" });
      // PLAN AG-SEC-6 (CONTRACT, TRUST_PROXY unset): 4th request is 429 RATE_LIMITED, Retry-After 60
      expectError(r, 429, "RATE_LIMITED");
      expect(r.headers["retry-after"]).toBe("60");
    });
  });
});

function refWithProto() {
  return '{"payroll":[{"classCode":"0005","payroll":1000000}],"claims":[],"__proto__":{"polluted":1}}';
}
