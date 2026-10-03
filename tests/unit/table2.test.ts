import { describe, it, expect } from "vitest";
import fc from "fast-check";
import Decimal from "decimal.js";
import { lookupPrimaryThreshold, primaryThresholdFor, table2Bands } from "../../src/engine/xmod";

describe("US-10 Table II export and lookup", () => {
  it("US-10 table2Bands is a copy: changing it does not change the engine's data", () => {
    const bands = table2Bands();
    bands[0].threshold = 1;
    expect(table2Bands()[0].threshold).toBe(4_500);
    expect(primaryThresholdFor(new Decimal(100))).toBe(4_500);
  });

  it("US-10 property: the lookup's band always contains the rounded value and matches primaryThresholdFor", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 400_000_000 }), (cents) => {
      const e = new Decimal(cents).div(100);
      const l = lookupPrimaryThreshold(e);
      const inBand = l.roundedExpected >= l.band.min && (l.band.max === null || l.roundedExpected <= l.band.max);
      const band = table2Bands().find((b) => b.min === l.band.min)!;
      return inBand && l.threshold === primaryThresholdFor(e) && band.threshold === l.threshold;
    }), { numRuns: 2000 });
  });
});
