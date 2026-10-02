/**
 * Worksheet breakdown fields (expectedExcess per class, actualExcess per claim, actualLosses/actualExcess totals).
 * Display-only additions: they must reconcile exactly and must not change any mod.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import Decimal from "decimal.js";
import { calculateMod, classCodes, type RatingInput } from "../../src/engine/xmod";

const sum = (xs: number[]) => xs.reduce((s, x) => s.plus(x), new Decimal(0)).toNumber();

describe("US-07 worksheet breakdown fields", () => {
  const r = calculateMod({
    payroll: [{ classCode: "0005", payroll: 1_000_000 }, { classCode: "3634", payroll: 500_000 }],
    claims: [{ id: "a", indemnity: 4_000, medical: 0 }, { id: "b", indemnity: 300_000, medical: 0 }],
    contractMedical: [{ classCode: "0005", incurred: 10_000 }],
  });

  it("US-07 each class line: Expected Primary + Expected Excess = Expected Losses", () => {
    for (const c of r.classes) expect(new Decimal(c.expectedPrimary).plus(c.expectedExcess).toNumber()).toBe(c.expectedLosses);
    expect(r.classes[0]).toMatchObject({ expectedLosses: 20_200, dRatio: "0.245", expectedPrimary: 4_949, expectedExcess: 15_251 }); // PT 9,500
  });

  it("US-07 each claim line: Actual Primary + Actual Excess = Actual Losses (MLV-capped claim included)", () => {
    for (const c of r.claims) expect(new Decimal(c.actualPrimary).plus(c.actualExcess).toNumber()).toBe(c.actualLosses);
    expect(r.claims.find((c) => c.id === "b")).toMatchObject({ actualLosses: 175_000, actualPrimary: 9_250, actualExcess: 165_750 });
  });

  it("US-07 totals: actual losses = sum of lines; actual excess = actual losses - actual primary", () => {
    expect(r.actualLosses).toBe(sum(r.claims.map((c) => c.actualLosses)));
    expect(new Decimal(r.actualPrimary).plus(r.actualExcess).toNumber()).toBe(r.actualLosses);
  });

  it("US-07 property: lines reconcile and totals match line sums within rounding, for random risks", () => {
    const codes = classCodes().filter((c) => !["7707", "7722", "8278", "8631"].includes(c));
    const arb = fc.record({
      payroll: fc.array(fc.record({ classCode: fc.constantFrom(...codes), payroll: fc.integer({ min: 1_000, max: 5_000_000 }) }), { minLength: 1, maxLength: 4 }),
      claims: fc.array(fc.integer({ min: 0, max: 400_000 }), { maxLength: 6 }).map((xs) => xs.map((x, i) => ({ id: `c${i}`, indemnity: x, medical: 0 }))),
    });
    fc.assert(fc.property(arb, (input: RatingInput) => {
      const x = calculateMod(input);
      for (const c of x.classes) if (new Decimal(c.expectedPrimary).plus(c.expectedExcess).toNumber() !== c.expectedLosses) return false;
      for (const c of x.claims) if (new Decimal(c.actualPrimary).plus(c.actualExcess).toNumber() !== c.actualLosses) return false;
      // Totals come from unrounded values; per-line rounding can move a total by at most half a cent per line.
      const tol = 0.005 * x.classes.length + 1e-9;
      return Math.abs(sum(x.classes.map((c) => c.expectedLosses)) - x.expectedLosses) <= tol
        && Math.abs(sum(x.classes.map((c) => c.expectedPrimary)) - x.expectedPrimary) <= tol
        && x.actualLosses === sum(x.claims.map((c) => c.actualLosses));
    }), { numRuns: 300 });
  });
});
