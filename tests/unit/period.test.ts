/**
 * Experience period selection (Plan Sec III R2, R3) and rating effective date (Sec V R1),
 * California Workers' Compensation Experience Rating Plan effective Sept 1, 2025.
 * Plan wording is quoted next to each group; interpretations are marked ASSUMPTION and listed in
 * src/engine/period.ts (PERIOD_ASSUMPTIONS).
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  addMonths, experiencePeriod, selectExperience, ratingEffectiveDate, PERIOD_ASSUMPTIONS, type PolicyExperience,
} from "../../src/engine/period";
import { calculateMod, ValidationError } from "../../src/engine/xmod";

const pol = (id: string, effective: string, expiration: string, extra: Partial<PolicyExperience> = {}): PolicyExperience => ({
  id, effective, expiration, payroll: [{ classCode: "0005", payroll: 400_000, audited: true }], claims: [], ...extra,
});
const code = (f: () => unknown) => { try { f(); return null; } catch (e) { return (e as ValidationError).code; } };

describe("US-09 calendar arithmetic", () => {
  it.each([
    ["2026-01-01", -57, "2021-04-01"],
    ["2026-01-01", -21, "2024-04-01"],
    ["2026-11-30", -57, "2022-02-28"], // ASSUMPTION A2: day clamps to the end of a shorter month
    ["2024-02-29", 12, "2025-02-28"],
    ["2025-01-31", 1, "2025-02-28"],
    ["2025-12-15", 1, "2026-01-15"],
  ])("addMonths(%s, %i) = %s", (d, n, out) => expect(addMonths(d, n)).toBe(out));

  it("rejects impossible or badly formatted dates", () => {
    expect(code(() => addMonths("2025-02-30", 1))).toBe("BAD_DATE");
    expect(code(() => addMonths("2025-2-01", 1))).toBe("BAD_DATE");
  });
});

// Sec III R2: "three (3) years, commencing four (4) years and nine (9) months prior and terminating
// one (1) year and nine (9) months prior to the date for which an experience modification is to be established."
describe("US-09 experience period (Sec III R2)", () => {
  it("is 3 years: from 4y9m to 1y9m before the rating effective date", () => {
    expect(experiencePeriod("2026-01-01")).toEqual({ start: "2021-04-01", end: "2024-04-01" });
  });

  it("an annually renewed risk has exactly 3 policies in its period", () => {
    const policies = ["2021", "2022", "2023", "2024", "2025"].map((y) => pol(`P${y}`, `${y}-01-01`, `${Number(y) + 1}-01-01`));
    const r = selectExperience({ ratingEffectiveDate: "2026-01-01", policies });
    expect(r.policies.filter((p) => p.included).map((p) => p.id)).toEqual(["P2022", "P2023", "P2024"]);
    expect(r.policies.find((p) => p.id === "P2021")!.reasons[0]).toContain("III.2");
    expect(r.policies.find((p) => p.id === "P2025")!.reasons[0]).toContain("III.2");
  });

  it("boundaries: inception on the start date is in, inception on the end date is out (ASSUMPTION A1: half-open)", () => {
    const r = selectExperience({
      ratingEffectiveDate: "2026-01-01",
      policies: [pol("start", "2021-04-01", "2022-04-01"), pol("last-day", "2024-03-31", "2025-03-31"), pol("end", "2024-04-01", "2025-04-01"), pol("before", "2021-03-31", "2022-03-31")],
    });
    const inc = Object.fromEntries(r.policies.map((p) => [p.id, p.included]));
    expect(inc).toEqual({ start: true, "last-day": true, end: false, before: false });
  });

  it("property: with annual renewals, every policy is in exactly 3 consecutive yearly ratings (why A1 is half-open)", () => {
    fc.assert(fc.property(fc.integer({ min: 2000, max: 2030 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }), (y, m, d) => {
      const eff = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      let count = 0;
      for (let k = -2; k <= 8; k++) {
        const red = addMonths(eff, 12 * k);
        const { start, end } = experiencePeriod(red);
        if (start <= eff && eff < end) count++;
      }
      return count === 3;
    }));
  });
});

// Sec III R3: "...that incepts within the experience period shall be reported and used... Only completed policy
// periods shall be used. The following experience shall not be used: a. Experience of a policy previously used in
// determining experience modifications that applied to the risk for more than two (2) years and six (6) months.
// ... g. Unaudited payroll."
describe("US-09 experience to be used (Sec III R3)", () => {
  const RED = "2026-01-01";

  it("R3(a): excludes a policy already used for MORE THAN 2 years 6 months; exactly 30 months stays", () => {
    const r = selectExperience({
      ratingEffectiveDate: RED,
      policies: [
        pol("used-30", "2022-01-01", "2023-01-01", { monthsUsedInPriorMods: 30 }),
        pol("used-31", "2023-01-01", "2024-01-01", { monthsUsedInPriorMods: 31 }),
      ],
    });
    expect(r.policies.find((p) => p.id === "used-30")!.included).toBe(true);
    const out = r.policies.find((p) => p.id === "used-31")!;
    expect(out.included).toBe(false);
    expect(out.reasons.join(" ")).toContain("III.3.a");
  });

  it("only completed policy periods are used", () => {
    const r = selectExperience({ ratingEffectiveDate: RED, policies: [pol("open", "2023-06-01", "2024-06-01", { completed: false })] });
    expect(r.policies[0]).toMatchObject({ included: false });
    expect(r.policies[0].reasons.join(" ")).toContain("completed");
  });

  it("R3(g): unaudited payroll lines are dropped and flagged, audited lines and the policy's claims are kept", () => {
    const r = selectExperience({
      ratingEffectiveDate: RED,
      policies: [pol("P", "2023-01-01", "2024-01-01", {
        payroll: [{ classCode: "0005", payroll: 500_000, audited: true }, { classCode: "3634", payroll: 200_000, audited: false }],
        claims: [{ id: "C1", indemnity: 5_000, medical: 0 }],
      })],
    });
    expect(r.ratingInput.payroll).toEqual([{ classCode: "0005", payroll: 500_000 }]);
    expect(r.ratingInput.claims.map((c) => c.id)).toEqual(["C1"]);
    expect(r.ratingInput.excludedUnauditedPayroll).toBe(true);
    expect(r.excludedUnauditedPayroll).toEqual([{ policyId: "P", classCode: "3634", payroll: 200_000 }]);
  });

  it("aggregates audited payroll by class across included policies, and only their claims", () => {
    const r = selectExperience({
      ratingEffectiveDate: RED,
      policies: [
        pol("A", "2022-01-01", "2023-01-01", { claims: [{ id: "a1", indemnity: 1_000, medical: 0 }] }),
        pol("B", "2023-01-01", "2024-01-01", { payroll: [{ classCode: "0005", payroll: 600_000, audited: true }, { classCode: "8810", payroll: 50_000, audited: true }] }),
        pol("old", "2019-01-01", "2020-01-01", { claims: [{ id: "x", indemnity: 99_000, medical: 0 }] }),
      ],
    });
    expect(r.ratingInput.payroll).toEqual([{ classCode: "0005", payroll: 1_000_000 }, { classCode: "8810", payroll: 50_000 }]);
    expect(r.ratingInput.claims.map((c) => c.id)).toEqual(["a1"]);
    expect(r.ratingInput.excludedUnauditedPayroll).toBe(false);
  });

  it("integration: the selected experience rates exactly like the hand-built reference risk", () => {
    const r = selectExperience({
      ratingEffectiveDate: RED,
      policies: [pol("A", "2022-01-01", "2023-01-01", { payroll: [{ classCode: "0005", payroll: 1_000_000, audited: true }] })],
    });
    expect(calculateMod(r.ratingInput).mod).toBe(0.77);
  });

  it("validation: ids unique, dates real, expiration after effective, payroll non-negative", () => {
    const run = (policies: PolicyExperience[]) => code(() => selectExperience({ ratingEffectiveDate: RED, policies }));
    expect(run([pol("A", "2022-01-01", "2023-01-01"), pol("A", "2023-01-01", "2024-01-01")])).toBe("DUPLICATE_POLICY");
    expect(run([pol("A", "2022-13-01", "2023-01-01")])).toBe("BAD_DATE");
    expect(run([pol("A", "2023-01-01", "2023-01-01")])).toBe("BAD_POLICY_TERM");
    expect(run([pol("A", "2022-01-01", "2023-01-01", { payroll: [{ classCode: "0005", payroll: -1, audited: true }] })])).toBe("BAD_PAYROLL");
    expect(code(() => selectExperience({ ratingEffectiveDate: "soon", policies: [] }))).toBe("BAD_DATE");
  });
});

// Sec V R1: "The rating effective date is twelve (12) months after the effective date of the preceding policy except
// as noted below: a. Where the WCIRB has established a rating effective date pursuant to Rule 2 or Rule 3 of this
// Section, such date shall govern. b. Where the preceding policy has lapsed, been cancelled or expired and no policy
// has been issued for the risk for a period in excess of one (1) year beyond such date of lapse, cancellation or
// expiration, the new rating effective date shall be the effective date of the new policy. c. A policy that is
// effective for three (3) months or less or that incepts and expires between rating effective dates shall not be
// used to establish a new rating effective date."
describe("US-09 rating effective date (Sec V R1)", () => {
  const term = (id: string, effective: string, expiration: string, cancelled?: string) => ({ id, effective, expiration, cancelled });

  it("is 12 months after the effective date of the preceding policy", () => {
    const r = ratingEffectiveDate({ priorPolicies: [term("P1", "2025-03-15", "2026-03-15")], newPolicy: term("P2", "2026-03-15", "2027-03-15") });
    expect(r).toMatchObject({ date: "2026-03-15", rule: "V.1", basedOnPolicy: "P1" });
  });

  it("a late renewal keeps the anniversary (gap of one year or less)", () => {
    const r = ratingEffectiveDate({ priorPolicies: [term("P1", "2025-01-01", "2026-01-01")], newPolicy: term("P2", "2026-04-01", "2027-04-01") });
    expect(r).toMatchObject({ date: "2026-01-01", rule: "V.1" });
  });

  it("R1(a): a WCIRB-established date governs", () => {
    const r = ratingEffectiveDate({ priorPolicies: [term("P1", "2025-01-01", "2026-01-01")], newPolicy: term("P2", "2026-01-01", "2027-01-01"), wcirbEstablished: "2026-07-01" });
    expect(r).toMatchObject({ date: "2026-07-01", rule: "V.1.a" });
  });

  it("R1(b): no policy for MORE THAN one year after expiration resets to the new policy's effective date", () => {
    const r = ratingEffectiveDate({ priorPolicies: [term("P1", "2022-01-01", "2023-01-01")], newPolicy: term("P2", "2024-01-02", "2025-01-02") });
    expect(r).toMatchObject({ date: "2024-01-02", rule: "V.1.b" });
  });

  it("R1(b) boundary: a gap of exactly one year does not reset", () => {
    const r = ratingEffectiveDate({ priorPolicies: [term("P1", "2022-01-01", "2023-01-01")], newPolicy: term("P2", "2024-01-01", "2025-01-01") });
    expect(r).toMatchObject({ date: "2023-01-01", rule: "V.1" });
  });

  it("R1(b): a cancellation date, not the scheduled expiration, starts the lapse clock", () => {
    const r = ratingEffectiveDate({ priorPolicies: [term("P1", "2022-01-01", "2023-01-01", "2022-03-01")], newPolicy: term("P2", "2023-06-01", "2024-06-01") });
    expect(r).toMatchObject({ date: "2023-06-01", rule: "V.1.b" });
  });

  it("R1(c): a prior policy of three months or less is skipped when finding the preceding policy", () => {
    const r = ratingEffectiveDate({
      priorPolicies: [term("annual", "2025-01-01", "2026-01-01"), term("short", "2026-01-01", "2026-04-01")],
      newPolicy: term("P3", "2026-04-01", "2027-04-01"),
    });
    expect(r).toMatchObject({ date: "2026-01-01", basedOnPolicy: "annual" });
    expect(r.skipped).toEqual([{ id: "short", rule: "V.1.c", reason: expect.stringContaining("3 months or less") }]);
  });

  it("R1(c): a new policy of three months or less does not establish a new date", () => {
    const r = ratingEffectiveDate({ priorPolicies: [term("P1", "2025-01-01", "2026-01-01")], newPolicy: term("short", "2026-01-01", "2026-04-01") });
    expect(r.newPolicyEstablishesDate).toBe(false);
    expect(r.notes.join(" ")).toContain("V.1.c");
  });

  it("R1(c): a policy that incepts and expires between known rating effective dates is skipped", () => {
    const r = ratingEffectiveDate({
      priorPolicies: [term("anchor", "2024-01-01", "2025-01-01"), term("mid", "2025-02-01", "2025-11-30")],
      newPolicy: term("P3", "2026-01-01", "2027-01-01"),
      knownRatingEffectiveDates: ["2025-01-01", "2026-01-01"],
    });
    expect(r.skipped.map((s) => s.id)).toEqual(["mid"]);
    expect(r).toMatchObject({ date: "2025-01-01", basedOnPolicy: "anchor" });
    // ASSUMPTION A5: the mod runs 12 months from its rating date and is re-determined annually (V.1, V.2.b),
    // so the anniversary in force when the new policy incepts is the latest one on or before that date.
    expect(r.anniversaryForNewPolicy).toBe("2026-01-01");
  });

  it("ASSUMPTION A5: anniversary equals the date when the new policy starts within its first year", () => {
    const r = ratingEffectiveDate({ priorPolicies: [term("P1", "2025-01-01", "2026-01-01")], newPolicy: term("P2", "2026-04-01", "2027-04-01") });
    expect(r.anniversaryForNewPolicy).toBe("2026-01-01");
  });

  it("ASSUMPTION A4: a risk's first policy sets the rating effective date at its own inception", () => {
    expect(ratingEffectiveDate({ priorPolicies: [], newPolicy: term("P1", "2026-02-01", "2027-02-01") })).toMatchObject({ date: "2026-02-01", rule: "A4" });
  });

  it("every assumption used is documented", () => {
    expect(PERIOD_ASSUMPTIONS.map((a) => a.id)).toEqual(["A1", "A2", "A3", "A4", "A5", "A6"]);
  });
});
