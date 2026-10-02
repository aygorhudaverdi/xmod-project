import { describe, it, expect } from "vitest";
import fc from "fast-check";
import Decimal from "decimal.js";
import {
  calculateMod, primaryThresholdFor, valueClaim, ValidationError, classCodes, type ClaimInput, type RatingInput,
} from "../../src/engine/xmod";

// Reference risk: class 0005 (ELR 2.02), $1,000,000 payroll.
//   E = 20,200 -> Table II band 19,924-22,270 -> PT = 8,500
//   D-ratio(0005, 8,500) = 0.226 -> Ep = 4,565.20, Ee = 15,634.80
//   loss-free mod = 15,634.80 / 20,200 = 0.774
const base = (claims: ClaimInput[] = [], extra: Partial<RatingInput> = {}): RatingInput => ({
  payroll: [{ classCode: "0005", payroll: 1_000_000 }], claims, ...extra,
});
const claim = (id: string, amount: number, extra: Partial<ClaimInput> = {}): ClaimInput =>
  ({ id, indemnity: amount, medical: 0, ...extra });

describe("expected losses and primary threshold", () => {
  it("matches the hand-computed reference risk", () => {
    const r = calculateMod(base());
    expect(r.expectedLosses).toBe(20200);
    expect(r.primaryThreshold).toBe(8500);
    expect(r.expectedPrimary).toBe(4565.2);
    expect(r.expectedExcess).toBe(15634.8);
    expect(r.mod).toBe(0.77);
    expect(r.lossFreeMod).toBe(0.77);
  });

  it.each([
    [7248, 4500], [7249, 5000], [8671, 5000], [8672, 5500],
    [19923, 8000], [19924, 8500], [22270, 8500], [22271, 9000],
    [27391, 9500], [27392, 10000], [3293539, 74000], [3293540, 75000], [99_999_999, 75000],
  ])("Table II: E=%i -> PT %i", (e, pt) => {
    expect(primaryThresholdFor(new Decimal(e))).toBe(pt);
  });

  it("per-capita classes are not divided by 100", () => {
    const r = calculateMod({ payroll: [{ classCode: "7707", payroll: 100 }], claims: [] });
    expect(r.expectedLosses).toBe(12650); // 100 units x 126.50
  });

  it("sums multiple classes", () => {
    const r = calculateMod({ payroll: [{ classCode: "0005", payroll: 500_000 }, { classCode: "3634", payroll: 500_000 }], claims: [] });
    expect(r.expectedLosses).toBe(10100 + 6000);
  });
});

describe("ordinary claim valuation (VI.2)", () => {
  it.each([
    [0, 0], [250, 0], [251, 1], [1000, 750], [8500, 8250], [8501, 8250], [20000, 8250], [175000, 8250], [900000, 8250],
  ])("claim of $%i -> Ap %i at PT 8,500", (amt, ap) => {
    expect(valueClaim(claim("c", amt), 8500).actualPrimary).toBe(ap);
  });
  it("caps Actual Losses at the Maximum Loss Value", () => {
    expect(valueClaim(claim("c", 900_000), 8500).actualLosses).toBe(175_000);
  });
  it("sums indemnity and medical before capping", () => {
    const v = valueClaim({ id: "c", indemnity: 100_000, medical: 100_000 }, 8500);
    expect(v.actualLosses).toBe(175_000);
  });
});

describe("exception claims (VI.2.a-j)", () => {
  const net = (n: number, t: ClaimInput["treatment"], extra: Partial<ClaimInput> = {}): ClaimInput =>
    ({ id: "x", indemnity: 10_000, medical: 0, treatment: t, netIncurred: n, ...extra });

  it("subrogation: ratio applied to min(gross,PT), then $250 off", () => {
    const v = valueClaim(net(5000, "subrogation"), 8500);
    expect(v.actualPrimary).toBe(4000); // 8500*0.5 - 250
    expect(v.actualLosses).toBe(5000);
  });
  it("joint coverage: $250 comes off BEFORE the ratio (differs from subrogation)", () => {
    const v = valueClaim(net(5000, "joint"), 8500);
    expect(v.actualPrimary).toBe(4125); // (8500-250)*0.5
  });
  it("subrogation/joint results floor at zero", () => {
    expect(valueClaim({ id: "x", indemnity: 300, medical: 0, treatment: "subrogation", netIncurred: 100 }, 8500).actualPrimary).toBe(0);
    expect(valueClaim({ id: "x", indemnity: 200, medical: 0, treatment: "joint", netIncurred: 100 }, 8500).actualPrimary).toBe(0);
    // gross just over $250: joint takes $250 off first, so a sliver remains
    expect(valueClaim({ id: "x", indemnity: 300, medical: 0, treatment: "joint", netIncurred: 100 }, 8500).actualPrimary).toBe(16.67);
  });
  it("plain death: AL = ADV, Ap = PT - 250", () => {
    const v = valueClaim({ id: "d", indemnity: 5000, medical: 0, death: true }, 8500);
    expect(v.actualLosses).toBe(175_000);
    expect(v.actualPrimary).toBe(8250);
  });
  it("death with compromise: ratio on ADV, $250 after", () => {
    const v = valueClaim({ id: "d", indemnity: 100_000, medical: 0, death: true, treatment: "compromise", netIncurred: 40_000 }, 8500);
    expect(v.actualLosses).toBe(70_000);
    expect(v.actualPrimary).toBe(3150); // 8500*0.4 - 250
  });
  it("death with joint coverage: $250 before ratio", () => {
    const v = valueClaim({ id: "d", indemnity: 100_000, medical: 0, death: true, treatment: "joint", netIncurred: 40_000 }, 8500);
    expect(v.actualPrimary).toBe(3300); // (8500-250)*0.4
  });
  it("EL + WC claim", () => {
    expect(valueClaim({ id: "e", indemnity: 20_000, medical: 0, elAndWc: true }, 8500).actualPrimary).toBe(8250);
  });
  it("non-compensable claims contribute nothing", () => {
    const v = valueClaim(claim("n", 50_000, { nonCompensable: true }), 8500);
    expect([v.actualLosses, v.actualPrimary]).toEqual([0, 0]);
  });
  it.each([
    ["2019-11-30", false], ["2019-12-01", true], ["2024-08-31", true], ["2024-09-01", false],
  ])("COVID exclusion window: accident %s excluded=%s", (date, excluded) => {
    const v = valueClaim(claim("c", 20_000, { catastropheNumber: 12, accidentDate: date }), 8500);
    expect(v.actualPrimary === 0).toBe(excluded);
  });
  it("COVID exclusion needs Catastrophe No. 12", () => {
    expect(valueClaim(claim("c", 20_000, { catastropheNumber: 11, accidentDate: "2021-01-01" }), 8500).actualPrimary).toBe(8250);
  });

  it("multi-person accident: Ap capped at 2*PT - 500", () => {
    const ids = ["a", "b", "c"].map((id) => claim(id, 20_000, { multiPerson: true, accidentId: "A1" }));
    const r = calculateMod(base(ids));
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0].actualPrimary).toBe(16_500); // 2*8500 - 500, not 3*8250
    expect(r.claims[0].actualLosses).toBe(60_000);
  });
  it("multi-person accident: Actual Losses capped at 2*MLV", () => {
    const ids = ["a", "b", "c"].map((id) => claim(id, 175_000, { multiPerson: true, accidentId: "A1" }));
    expect(calculateMod(base(ids)).claims[0].actualLosses).toBe(350_000);
  });
  it("contract medical: Ap = AL x D-ratio, no MLV cap", () => {
    const r = calculateMod(base([], { contractMedical: [{ classCode: "0005", incurred: 500_000 }] }));
    expect(r.claims[0].actualLosses).toBe(500_000);
    expect(r.claims[0].actualPrimary).toBe(113_000); // 500000 * 0.226
  });
});

describe("modification, 25-point cap and eligibility", () => {
  it("two small claims, no cap", () => {
    const r = calculateMod(base([claim("a", 1000), claim("b", 1000)]));
    expect(r.actualPrimary).toBe(1500);
    expect(r.capApplied).toBe(false);
    expect(r.mod).toBe(0.85); // (1500+15634.8)/20200 = 0.8483
  });
  it("single large claim is capped at loss-free + 0.25", () => {
    const r = calculateMod(base([claim("a", 20_000)]));
    expect(Number(r.modUnrounded)).toBeCloseTo(1.024, 9); // uncapped would be 1.1824
    expect(r.capApplied).toBe(true);
    expect(r.mod).toBe(1.02);
  });
  it("cap does not bind when single claim stays under it", () => {
    const r = calculateMod(base([claim("a", 1000)]));
    expect(r.capApplied).toBe(false);
  });
  it("cap does not apply when unaudited payroll was excluded", () => {
    const r = calculateMod(base([claim("a", 20_000)], { excludedUnauditedPayroll: true }));
    expect(r.capApplied).toBe(false);
    expect(r.mod).toBe(1.18);
  });
  it("cap does not apply with two claims having primary", () => {
    const r = calculateMod(base([claim("a", 20_000), claim("b", 20_000)]));
    expect(r.capApplied).toBe(false);
  });
  it("claims of $250 or less count as zero-primary and do not trigger the 'two claims' rule", () => {
    const r = calculateMod(base([claim("a", 20_000), claim("b", 200)]));
    expect(r.claimsWithPrimary).toBe(1);
    expect(r.capApplied).toBe(true);
  });

  it("eligibility threshold boundary (E = 10,800 exactly)", () => {
    const at = calculateMod({ payroll: [{ classCode: "3634", payroll: 900_000 }], claims: [] });
    const below = calculateMod({ payroll: [{ classCode: "3634", payroll: 899_999 }], claims: [] });
    expect(at.expectedLosses).toBe(10800);
    expect(at.eligible).toBe(true);
    expect(below.eligible).toBe(false);
  });
  it("below threshold: prior-year-rated risk qualifies only if mod > 1.00", () => {
    const small = (claims: ClaimInput[]) => ({
      payroll: [{ classCode: "3634", payroll: 800_000 }], claims, priorYearExperienceRated: true,
    });
    expect(calculateMod(small([])).eligible).toBe(false); // mod < 1
    expect(calculateMod(small([claim("a", 5000), claim("b", 5000), claim("c", 5000)])).eligible).toBe(true);
  });
});

describe("input validation", () => {
  const bad = (i: RatingInput) => { try { calculateMod(i); return null; } catch (e) { return (e as ValidationError).code; } };
  it("rejects unknown class", () => expect(bad({ payroll: [{ classCode: "9999", payroll: 1 }], claims: [] })).toBe("UNKNOWN_CLASS"));
  it("rejects negative payroll", () => expect(bad({ payroll: [{ classCode: "0005", payroll: -1 }], claims: [] })).toBe("BAD_PAYROLL"));
  it("rejects empty payroll", () => expect(bad({ payroll: [], claims: [] })).toBe("NO_PAYROLL"));
  it("rejects zero expected losses", () => expect(bad({ payroll: [{ classCode: "0005", payroll: 0 }], claims: [] })).toBe("ZERO_EXPECTED"));
  it("rejects negative losses", () => expect(bad(base([claim("a", -5)]))).toBe("BAD_LOSS"));
  it("rejects duplicate claim ids", () => expect(bad(base([claim("a", 1), claim("a", 2)]))).toBe("DUPLICATE_CLAIM"));
  it("rejects net > gross", () => expect(bad(base([claim("a", 100, { treatment: "joint", netIncurred: 200 })]))).toBe("BAD_NET"));
  it.each([[""], ["   "], ["x".repeat(101)], [42], [{ x: 1 }], [undefined]])("rejects claim id %j (DEF-006)", (id) =>
    expect(bad(base([{ id, indemnity: 1, medical: 0 } as unknown as ClaimInput]))).toBe("BAD_CLAIM_ID"));
  it("accepts a 100-character claim id", () => expect(calculateMod(base([claim("x".repeat(100), 1)])).claims).toHaveLength(1));
  it("requires net for subrogation", () => expect(bad(base([claim("a", 100, { treatment: "subrogation" })]))).toBe("BAD_NET"));
});

describe("properties", () => {
  const codes = classCodes().filter((c) => !["7707", "7722", "8278", "8631"].includes(c));
  const payrollArb = fc.record({
    classCode: fc.constantFrom(...codes), payroll: fc.integer({ min: 100_000, max: 50_000_000 }),
  });
  const claimArb = fc.record({
    id: fc.uuid(), indemnity: fc.integer({ min: 0, max: 400_000 }), medical: fc.integer({ min: 0, max: 400_000 }),
  });
  const ratingArb = fc.record({
    payroll: fc.array(payrollArb, { minLength: 1, maxLength: 4 }),
    claims: fc.array(claimArb, { maxLength: 8 }),
  });
  const dedupe = (i: RatingInput): RatingInput => ({ ...i, payroll: [...new Map(i.payroll.map((p) => [p.classCode, p])).values()] });
  const opts = { numRuns: 300 };

  it("loss-free mod is a lower bound and mod = loss-free when there are no claims", () => {
    fc.assert(fc.property(ratingArb, (i) => {
      const r = calculateMod({ ...dedupe(i), claims: [] });
      expect(r.mod).toBe(r.lossFreeMod);
    }), opts);
  });
  it("adding a claim never lowers the mod", () => {
    fc.assert(fc.property(ratingArb, claimArb, (i, extra) => {
      const d = dedupe(i);
      const a = calculateMod(d), b = calculateMod({ ...d, claims: [...d.claims, extra] });
      expect(Number(b.modUnrounded)).toBeGreaterThanOrEqual(Number(a.modUnrounded) - 1e-9);
    }), opts);
  });
  it("mod is never below the loss-free mod", () => {
    fc.assert(fc.property(ratingArb, (i) => {
      const r = calculateMod(dedupe(i));
      expect(Number(r.modUnrounded)).toBeGreaterThanOrEqual(Number(r.lossFreeModUnrounded) - 1e-9);
    }), opts);
  });
  it("a risk with at most one primary-bearing claim never exceeds loss-free + 0.25", () => {
    fc.assert(fc.property(ratingArb, claimArb, (i, one) => {
      const r = calculateMod({ ...dedupe(i), claims: [one] });
      expect(Number(r.modUnrounded)).toBeLessThanOrEqual(Number(r.lossFreeModUnrounded) + 0.25 + 1e-9);
    }), opts);
  });
  it("every claim's Ap is within [0, PT-250] and Ap <= AL", () => {
    fc.assert(fc.property(ratingArb, (i) => {
      const r = calculateMod(dedupe(i));
      for (const c of r.claims) {
        expect(c.actualPrimary).toBeGreaterThanOrEqual(0);
        expect(c.actualPrimary).toBeLessThanOrEqual(r.primaryThreshold - 250);
        expect(c.actualPrimary).toBeLessThanOrEqual(c.actualLosses);
      }
    }), opts);
  });
  it("claim order does not change the mod", () => {
    fc.assert(fc.property(ratingArb, (i) => {
      const d = dedupe(i);
      expect(calculateMod({ ...d, claims: [...d.claims].reverse() }).modUnrounded).toBe(calculateMod(d).modUnrounded);
    }), opts);
  });
  it("non-compensable claims are ignored", () => {
    fc.assert(fc.property(ratingArb, claimArb, (i, extra) => {
      const d = dedupe(i);
      expect(calculateMod({ ...d, claims: [...d.claims, { ...extra, nonCompensable: true }] }).modUnrounded)
        .toBe(calculateMod(d).modUnrounded);
    }), opts);
  });
  it("Expected primary + expected excess = expected losses", () => {
    fc.assert(fc.property(ratingArb, (i) => {
      const r = calculateMod(dedupe(i));
      expect(Math.abs(r.expectedPrimary + r.expectedExcess - r.expectedLosses)).toBeLessThan(0.02);
    }), opts);
  });
});
