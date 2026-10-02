/**
 * X-Mod engine — California Workers' Compensation Experience Rating Plan,
 * effective September 1, 2025 (tables parsed from the Plan PDF into /data).
 *
 *   Mod = (Ap + Ee) / E
 *
 * All money math uses decimal.js; floats never touch a dollar amount.
 *
 * Interpretation choices the Plan text does not pin down are isolated in
 * `RatingPolicy` so they are explicit, visible in output, and testable:
 *   - rounding of the published mod
 *   - rounding of Expected Losses before the Table II band lookup
 */
import Decimal from "decimal.js";
import table1 from "../../data/table1_elr_dratios.json" with { type: "json" };
import constants from "../../data/plan_constants.json" with { type: "json" };
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

// ------------------------------------------------------------------ types
export type Treatment = "none" | "subrogation" | "fraud" | "compromise" | "joint";

export interface PayrollLine {
  classCode: string;
  /** Audited payroll in dollars (or per-capita units for per-unit classes). */
  payroll: number;
}

export interface ClaimInput {
  id: string;
  indemnity: number;
  medical: number;
  death?: boolean;
  /** Subrogation / partially fraudulent / compromised death / joint coverage. */
  treatment?: Treatment;
  /** Net incurred loss, required when treatment != "none". */
  netIncurred?: number;
  nonCompensable?: boolean;
  /** Claim involves both Employers' Liability and Workers' Comp. */
  elAndWc?: boolean;
  /** COVID-19 exclusion: Catastrophe No. 12 and accident date in window. */
  catastropheNumber?: number;
  accidentDate?: string; // ISO yyyy-mm-dd
  /** Injuries to two or more persons in one accident share an accidentId. */
  accidentId?: string;
  multiPerson?: boolean;
}

export interface ContractMedicalLine {
  classCode: string;
  incurred: number;
}

export interface RatingInput {
  payroll: PayrollLine[];
  claims: ClaimInput[];
  contractMedical?: ContractMedicalLine[];
  /** Risk was experience rated the prior year (low-E qualification path). */
  priorYearExperienceRated?: boolean;
  /** Mod computed excluding unaudited payroll (Sec III R3(g)) → 25-pt cap off. */
  excludedUnauditedPayroll?: boolean;
}

/**
 * Interpretation choices the Plan text does not settle. The two parameters below are switchable; two more
 * assumptions are fixed behavior, documented here so all four live in one place (README, TEST_STRATEGY §6):
 *   - 25-point cap (VI.6): counts claims with Actual Primary > 0 individually; a multi-person accident is
 *     grouped into one capped entry first, so it counts once.
 *   - Plan values: Sept 1, 2025 Plan only (eligibility $10,800, 2-decimal ELRs). The Sept 2026 Plan
 *     ($11,700, 3-decimal ELRs) is not loaded.
 */
export interface RatingPolicy {
  /** Decimal places of the published mod factor (0.87 → 2). */
  modDecimals: number;
  /** Round E to whole dollars before the Table II band lookup. */
  roundExpectedForBand: boolean;
}

export const DEFAULT_POLICY: RatingPolicy = { modDecimals: 2, roundExpectedForBand: true };

export class ValidationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export interface ClaimResult {
  id: string;
  actualLosses: number;
  actualPrimary: number;
  rule: string;
}

export interface RatingResult {
  planEffective: string;
  expectedLosses: number;
  primaryThreshold: number;
  expectedPrimary: number;
  expectedExcess: number;
  actualPrimary: number;
  maximumLossValue: number;
  modUnrounded: string;
  lossFreeModUnrounded: string;
  /** Published mod as a factor, e.g. 0.87 */
  mod: number;
  lossFreeMod: number;
  capApplied: boolean;
  claimsWithPrimary: number;
  eligible: boolean;
  eligibilityReason: string;
  classes: { classCode: string; payroll: number; elr: string; expectedLosses: number; dRatio: string; expectedPrimary: number }[];
  claims: ClaimResult[];
  policy: RatingPolicy;
}

// ------------------------------------------------------------ plan tables
interface ClassRow { elr: string; per_unit_basis: boolean; d_ratios: string[] }
const T1 = table1 as unknown as { thresholds: number[]; classes: Record<string, ClassRow> };
const PLAN = constants as { effective: string; eligibility_threshold: number; maximum_loss_value: number; average_death_value: number };

interface Band { min: number; max: number | null; threshold: number }
function loadBands(): Band[] {
  const csv = readFileSync(fileURLToPath(new URL("../../data/table2_primary_thresholds.csv", import.meta.url)), "utf8");
  return csv.trim().split("\n").slice(1).map((l) => {
    const [a, b, c] = l.split(",");
    return { min: Number(a), max: b === "" ? null : Number(b), threshold: Number(c) };
  });
}
const BANDS = loadBands();

export const planInfo = () => ({ ...PLAN, thresholds: T1.thresholds });
export const classCodes = () => Object.keys(T1.classes);
export const classInfo = (code: string) => {
  const c = T1.classes[code];
  return c ? { classCode: code, elr: c.elr, perUnitBasis: c.per_unit_basis } : undefined;
};

export function primaryThresholdFor(expectedLosses: Decimal, policy = DEFAULT_POLICY): number {
  const e = policy.roundExpectedForBand ? expectedLosses.toDecimalPlaces(0) : expectedLosses.floor();
  for (const b of BANDS) {
    if (e.lte(b.max ?? Infinity)) return b.threshold;
  }
  throw new Error("unreachable: last band is open-ended");
}

const D = (n: number | string) => new Decimal(String(n));
const dRatio = (cls: string, pt: number): Decimal => {
  const i = T1.thresholds.indexOf(pt);
  return D(T1.classes[cls].d_ratios[i]);
};
const min = (a: Decimal, b: Decimal) => (a.lt(b) ? a : b);
const max0 = (a: Decimal) => (a.isNegative() ? D(0) : a);
const FLOOR = D(250);

// ------------------------------------------------------------ validation
function validate(input: RatingInput) {
  if (!input.payroll?.length) throw new ValidationError("NO_PAYROLL", "At least one payroll line is required");
  for (const p of input.payroll) {
    if (!T1.classes[p.classCode]) throw new ValidationError("UNKNOWN_CLASS", `Unknown class code ${p.classCode}`);
    if (!Number.isFinite(p.payroll) || p.payroll < 0) throw new ValidationError("BAD_PAYROLL", `Invalid payroll for ${p.classCode}`);
  }
  for (const c of input.contractMedical ?? []) {
    if (!T1.classes[c.classCode]) throw new ValidationError("UNKNOWN_CLASS", `Unknown class code ${c.classCode}`);
    if (!Number.isFinite(c.incurred) || c.incurred < 0) throw new ValidationError("BAD_LOSS", "Invalid contract medical amount");
  }
  const ids = new Set<string>();
  for (const c of input.claims ?? []) {
    // DEF-006: ids are echoed back in the breakdown, so they must be plain text of bounded length.
    if (typeof c.id !== "string" || c.id.trim() === "" || c.id.length > 100)
      throw new ValidationError("BAD_CLAIM_ID", "Each claim needs an id: non-empty text of at most 100 characters");
    if (ids.has(c.id)) throw new ValidationError("DUPLICATE_CLAIM", `Duplicate claim id ${c.id}`);
    ids.add(c.id);
    for (const v of [c.indemnity, c.medical]) {
      if (!Number.isFinite(v) || v < 0) throw new ValidationError("BAD_LOSS", `Invalid loss amount on claim ${c.id}`);
    }
    const t = c.treatment ?? "none";
    if (t !== "none") {
      const gross = c.indemnity + c.medical;
      if (c.netIncurred === undefined || !Number.isFinite(c.netIncurred) || c.netIncurred < 0 || c.netIncurred > gross)
        throw new ValidationError("BAD_NET", `Claim ${c.id}: netIncurred must be between 0 and gross incurred`);
      if (gross === 0) throw new ValidationError("BAD_NET", `Claim ${c.id}: gross incurred is zero, ratio undefined`);
    }
    if (c.multiPerson && !c.accidentId) throw new ValidationError("BAD_ACCIDENT", `Claim ${c.id}: multiPerson requires accidentId`);
  }
}

const isCovidExcluded = (c: ClaimInput) =>
  c.catastropheNumber === 12 && !!c.accidentDate && c.accidentDate >= "2019-12-01" && c.accidentDate <= "2024-08-31";

// ------------------------------------------------- per-claim valuation
/** Sec VI R2: Actual Losses and Actual Primary for one claim at threshold PT. */
export function valueClaim(c: ClaimInput, pt: number): ClaimResult {
  const MLV = D(PLAN.maximum_loss_value);
  const ADV = D(PLAN.average_death_value);
  const PT = D(pt);
  const gross = D(c.indemnity).plus(c.medical);
  const t = c.treatment ?? "none";
  const out = (al: Decimal, ap: Decimal, rule: string): ClaimResult => ({
    id: c.id, actualLosses: al.toDecimalPlaces(2).toNumber(), actualPrimary: ap.toDecimalPlaces(2).toNumber(), rule,
  });

  if (c.nonCompensable) return out(D(0), D(0), "VI.2.c non-compensable: excluded");
  if (isCovidExcluded(c)) return out(D(0), D(0), "VI.2.j COVID-19 (Cat. 12): excluded");

  if (c.death) {
    if (t === "none") return out(ADV, PT.minus(FLOOR), "VI.2.f death");
    const ratio = D(c.netIncurred!).div(gross);
    if (t === "joint")
      return out(ADV.times(ratio), max0(min(ADV, PT).minus(FLOOR).times(ratio)), "VI.2.h death, joint coverage");
    return out(ADV.times(ratio), max0(min(ADV, PT).times(ratio).minus(FLOOR)), "VI.2.g death, compromise/subrogation/fraud");
  }

  if (t === "subrogation" || t === "fraud" || t === "compromise") {
    const ratio = D(c.netIncurred!).div(gross);
    return out(min(gross, MLV).times(ratio), max0(min(gross, PT).times(ratio).minus(FLOOR)), "VI.2.d subrogation/fraud");
  }
  if (t === "joint") {
    const ratio = D(c.netIncurred!).div(gross);
    return out(min(gross, MLV).times(ratio), max0(min(gross, PT).minus(FLOOR).times(ratio)), "VI.2.e joint coverage");
  }
  if (c.elAndWc) {
    return out(min(gross, MLV), max0(min(gross, PT).minus(FLOOR)), "VI.2.i EL + WC");
  }
  // ordinary claim: cap, then primary formula
  const al = min(gross, MLV);
  if (al.lte(FLOOR)) return out(al, D(0), "VI.2 ordinary: AL <= $250");
  if (al.lte(PT)) return out(al, al.minus(FLOOR), "VI.2 ordinary: AL within threshold");
  return out(al, PT.minus(FLOOR), "VI.2 ordinary: AL above threshold");
}

// ------------------------------------------------------------- main rating
export function calculateMod(input: RatingInput, policy: RatingPolicy = DEFAULT_POLICY): RatingResult {
  validate(input);

  // Expected losses (VI.5). Per-capita/per-unit classes are not divided by 100.
  const lines = input.payroll.map((p) => {
    const row = T1.classes[p.classCode];
    const raw = D(p.payroll).times(row.elr);
    const e = row.per_unit_basis ? raw : raw.div(100);
    return { p, row, e };
  });
  const E = lines.reduce((s, l) => s.plus(l.e), D(0));
  if (E.isZero()) throw new ValidationError("ZERO_EXPECTED", "Expected losses are zero; risk cannot be rated");

  const PT = primaryThresholdFor(E, policy);

  // Expected primary (VI.3) and excess (VI.4)
  const classes = lines.map((l) => {
    const dr = dRatio(l.p.classCode, PT);
    return { ...l, dr, ep: l.e.times(dr) };
  });
  const Ep = classes.reduce((s, c) => s.plus(c.ep), D(0));
  const Ee = E.minus(Ep);

  // Actual primary (VI.2). Multi-person accidents are grouped and capped.
  const results: ClaimResult[] = [];
  const grouped = new Map<string, ClaimInput[]>();
  for (const c of input.claims ?? []) {
    if (c.multiPerson && c.accidentId) {
      const g = grouped.get(c.accidentId) ?? [];
      g.push(c);
      grouped.set(c.accidentId, g);
    } else {
      results.push(valueClaim(c, PT));
    }
  }
  for (const [accidentId, group] of grouped) {
    const vals = group.map((c) => valueClaim(c, PT));
    const sumAL = vals.reduce((s, v) => s.plus(v.actualLosses), D(0));
    const sumAP = vals.reduce((s, v) => s.plus(v.actualPrimary), D(0));
    const cappedAL = min(sumAL, D(PLAN.maximum_loss_value).times(2));
    const cappedAP = min(sumAP, D(PT).times(2).minus(500));
    // Report the accident as a single line so totals are not double counted.
    results.push({
      id: `accident:${accidentId} (${group.map((g) => g.id).join(", ")})`,
      actualLosses: cappedAL.toNumber(),
      actualPrimary: cappedAP.toNumber(),
      rule: "VI.2.a multi-person accident",
    });
  }

  let Ap = results.reduce((s, r) => s.plus(r.actualPrimary), D(0));
  // Contract medical (VI.2.b): AL by class × D-ratio, no MLV cap.
  for (const cm of input.contractMedical ?? []) {
    const ap = D(cm.incurred).times(dRatio(cm.classCode, PT));
    Ap = Ap.plus(ap);
    results.push({
      id: `contract-medical:${cm.classCode}`,
      actualLosses: cm.incurred,
      actualPrimary: ap.toDecimalPlaces(2).toNumber(),
      rule: "VI.2.b contract medical",
    });
  }

  const modRaw = Ap.plus(Ee).div(E);
  const lossFreeRaw = Ee.div(E);

  // 25-point cap (VI.6): only when exactly one claim has Ap > 0.
  const claimsWithPrimary = results.filter((r) => r.actualPrimary > 0).length;
  const capEligible = claimsWithPrimary === 1 && !input.excludedUnauditedPayroll;
  const capValue = lossFreeRaw.plus("0.25");
  const capApplied = capEligible && modRaw.gt(capValue);
  const finalRaw = capApplied ? capValue : modRaw;

  const round = (x: Decimal) => x.toDecimalPlaces(policy.modDecimals, Decimal.ROUND_HALF_UP);
  const mod = round(finalRaw);

  // Eligibility (Sec III)
  const threshold = D(PLAN.eligibility_threshold);
  let eligible: boolean;
  let reason: string;
  if (E.gte(threshold)) {
    eligible = true;
    reason = `Expected losses ${E.toFixed(2)} >= ${threshold}`;
  } else if (input.priorYearExperienceRated && !input.excludedUnauditedPayroll && mod.gt(1)) {
    eligible = true;
    reason = "Below threshold but experience rated prior year and mod > 1.00";
  } else {
    eligible = false;
    reason = input.priorYearExperienceRated
      ? "Below threshold; prior-year rated but mod is not above 1.00"
      : `Expected losses ${E.toFixed(2)} < ${threshold} and not rated prior year`;
  }

  return {
    planEffective: PLAN.effective,
    expectedLosses: E.toDecimalPlaces(2).toNumber(),
    primaryThreshold: PT,
    expectedPrimary: Ep.toDecimalPlaces(2).toNumber(),
    expectedExcess: Ee.toDecimalPlaces(2).toNumber(),
    actualPrimary: Ap.toDecimalPlaces(2).toNumber(),
    maximumLossValue: PLAN.maximum_loss_value,
    modUnrounded: finalRaw.toSignificantDigits(12).toString(),
    lossFreeModUnrounded: lossFreeRaw.toSignificantDigits(12).toString(),
    mod: mod.toNumber(),
    lossFreeMod: round(lossFreeRaw).toNumber(),
    capApplied,
    claimsWithPrimary,
    eligible,
    eligibilityReason: reason,
    classes: classes.map((c) => ({
      classCode: c.p.classCode, payroll: c.p.payroll, elr: c.row.elr,
      expectedLosses: c.e.toDecimalPlaces(2).toNumber(), dRatio: c.dr.toString(),
      expectedPrimary: c.ep.toDecimalPlaces(2).toNumber(),
    })),
    claims: results,
    policy,
  };
}
