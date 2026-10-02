/**
 * Experience period and rating effective date: California Workers' Compensation Experience Rating Plan,
 * effective September 1, 2025.
 *
 *   Sec III R2  experience period: 3 years, from 4y9m to 1y9m before the rating effective date
 *   Sec III R3  experience to be used: policies incepting in the period, completed periods only;
 *               not (a) a policy already used in mods applied for more than 2y6m, not (g) unaudited payroll
 *   Sec V R1    rating effective date: 12 months after the preceding policy's effective date, except
 *               (a) WCIRB-established date governs, (b) a lapse of more than one year resets it to the new
 *               policy's effective date, (c) policies of 3 months or less, or incepting and expiring between
 *               rating effective dates, do not establish a new date
 *
 * Interpretations the Plan text does not settle are listed in PERIOD_ASSUMPTIONS and referenced by id
 * (A1..A6) in the code and the tests. Not implemented: Sec III R3(b)-(f) exclusions (foreign projects,
 * private residence employees, other jurisdictions or lines, insolvent insurers), Sec III R7 (lapse in
 * coverage of more than two years), Sec V R2-R4 application to single/multiple/leasing policies.
 *
 * Dates are ISO calendar dates (yyyy-mm-dd) and are handled as plain y/m/d integers: no time zones.
 */
import { ValidationError, type ClaimInput, type PayrollLine, type RatingInput } from "./xmod.js";

export const PERIOD_ASSUMPTIONS = [
  { id: "A1", text: "The experience period is half-open: a policy incepting on the start date is in, one incepting on the end date (1y9m before the rating date) is out. This is the only reading under which an annually renewed policy is used in exactly three ratings, matching the three-year period." },
  { id: "A2", text: "Month arithmetic keeps the day of month and clamps it to the last day of a shorter month (e.g. 2026-11-30 minus 4y9m = 2022-02-28; Feb 29 plus 12 months = Feb 28)." },
  { id: "A3", text: "Sec III R3(a) excludes a policy used in mods that applied for MORE THAN 2 years 6 months, i.e. more than 30 months as supplied in monthsUsedInPriorMods. Exactly 30 months is still used. (The project brief said '2y6m or more'; the Plan text says 'more than'.)" },
  { id: "A4", text: "A risk with no prior policy gets its first rating effective date at the inception of its first policy. The Plan defines the date relative to a preceding policy and does not state the first-policy case." },
  { id: "A5", text: "The rating effective date from Sec V R1 recurs annually (a mod is effective for 12 months and re-determined annually, Sec V R1 and R2(b)). The anniversary in force for a new policy is the latest one on or before its effective date." },
  { id: "A6", text: "A policy's term for the '3 months or less' test and its end date for the lapse test use the cancellation date when the policy was cancelled, otherwise the expiration date. 'Three months or less' means end <= effective + 3 months." },
] as const;

// ------------------------------------------------------------------ dates
interface Ymd { y: number; m: number; d: number }
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function parse(date: unknown, field = "date"): Ymd {
  const m = typeof date === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!m) throw new ValidationError("BAD_DATE", `${field} must be an ISO date (yyyy-mm-dd)`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) throw new ValidationError("BAD_DATE", `${field} is not a real calendar date`);
  return { y, m: mo, d };
}
const fmt = ({ y, m, d }: Ymd) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Calendar month arithmetic with end-of-month clamping (A2). */
export function addMonths(date: string, months: number): string {
  const { y, m, d } = parse(date);
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return fmt({ y: ny, m: nm, d: Math.min(d, daysIn(ny, nm)) });
}
// ISO yyyy-mm-dd strings compare correctly as strings once validated.

// ------------------------------------------------------------------ Sec III R2
/** Sec III R2. Half-open [start, end) (A1). */
export function experiencePeriod(ratingEffectiveDate: string) {
  parse(ratingEffectiveDate, "ratingEffectiveDate");
  return { start: addMonths(ratingEffectiveDate, -57), end: addMonths(ratingEffectiveDate, -21) };
}

// ------------------------------------------------------------------ Sec III R3
export interface PolicyPayrollLine extends PayrollLine { audited: boolean }

export interface PolicyExperience {
  id: string;
  effective: string;
  expiration: string;
  /** Default true. Sec III R3: "Only completed policy periods shall be used." */
  completed?: boolean;
  /** Months for which modifications that used this policy's experience have already applied (Sec III R3(a), A3). */
  monthsUsedInPriorMods?: number;
  payroll: PolicyPayrollLine[];
  claims: ClaimInput[];
}

export interface PolicyDecision { id: string; effective: string; included: boolean; reasons: string[] }

export interface ExperienceSelection {
  ratingEffectiveDate: string;
  experiencePeriod: { start: string; end: string };
  policies: PolicyDecision[];
  excludedUnauditedPayroll: { policyId: string; classCode: string; payroll: number }[];
  /** Ready to POST to /api/xmod/calculate (or pass to calculateMod). */
  ratingInput: RatingInput;
  assumptions: typeof PERIOD_ASSUMPTIONS;
}

function validatePolicies(policies: unknown): asserts policies is PolicyExperience[] {
  if (!Array.isArray(policies)) throw new ValidationError("BAD_POLICIES", "policies must be an array");
  const ids = new Set<string>();
  for (const p of policies as PolicyExperience[]) {
    if (typeof p?.id !== "string" || !p.id.trim() || p.id.length > 100)
      throw new ValidationError("BAD_POLICY_ID", "Each policy needs an id: non-empty text of at most 100 characters");
    if (ids.has(p.id)) throw new ValidationError("DUPLICATE_POLICY", `Duplicate policy id ${p.id}`);
    ids.add(p.id);
    parse(p.effective, `policy ${p.id} effective`);
    parse(p.expiration, `policy ${p.id} expiration`);
    if (p.expiration <= p.effective) throw new ValidationError("BAD_POLICY_TERM", `Policy ${p.id}: expiration must be after effective`);
    if (p.monthsUsedInPriorMods !== undefined && (!Number.isFinite(p.monthsUsedInPriorMods) || p.monthsUsedInPriorMods < 0))
      throw new ValidationError("BAD_POLICY", `Policy ${p.id}: monthsUsedInPriorMods must be a non-negative number`);
    if (!Array.isArray(p.payroll) || !Array.isArray(p.claims ?? []))
      throw new ValidationError("BAD_POLICY", `Policy ${p.id}: payroll and claims must be arrays`);
    for (const l of p.payroll) {
      if (!Number.isFinite(l?.payroll) || l.payroll < 0) throw new ValidationError("BAD_PAYROLL", `Policy ${p.id}: invalid payroll for ${l?.classCode}`);
      if (typeof l.audited !== "boolean") throw new ValidationError("BAD_PAYROLL", `Policy ${p.id}: payroll line ${l.classCode} needs audited: true|false`);
    }
  }
}

export function selectExperience(input: { ratingEffectiveDate: string; policies: PolicyExperience[] }): ExperienceSelection {
  const period = experiencePeriod(input?.ratingEffectiveDate);
  validatePolicies(input.policies);

  const decisions: PolicyDecision[] = [];
  const excluded: ExperienceSelection["excludedUnauditedPayroll"] = [];
  const byClass = new Map<string, number>(); // insertion order = first appearance, for a stable output
  const claims: ClaimInput[] = [];

  for (const p of [...input.policies].sort((a, b) => a.effective.localeCompare(b.effective))) {
    const reasons: string[] = [];
    if (p.effective < period.start || p.effective >= period.end)
      reasons.push(`III.2: incepts ${p.effective}, outside the experience period ${period.start} to before ${period.end}`);
    if (p.completed === false) reasons.push("III.3: only completed policy periods are used");
    if ((p.monthsUsedInPriorMods ?? 0) > 30)
      reasons.push(`III.3.a: already used in modifications applied for ${p.monthsUsedInPriorMods} months (more than 2 years 6 months)`);

    const included = reasons.length === 0;
    if (included) {
      reasons.push("III.3: incepts within the experience period");
      for (const l of p.payroll) {
        if (!l.audited) {
          excluded.push({ policyId: p.id, classCode: l.classCode, payroll: l.payroll });
          continue;
        }
        // Payroll is whole dollars (or per-capita units); summing JS numbers is exact for these magnitudes.
        byClass.set(l.classCode, (byClass.get(l.classCode) ?? 0) + l.payroll);
      }
      claims.push(...(p.claims ?? []));
      if (p.payroll.some((l) => !l.audited)) reasons.push("III.3.g: unaudited payroll excluded");
    }
    decisions.push({ id: p.id, effective: p.effective, included, reasons });
  }

  return {
    ratingEffectiveDate: input.ratingEffectiveDate,
    experiencePeriod: period,
    policies: decisions,
    excludedUnauditedPayroll: excluded,
    ratingInput: {
      payroll: [...byClass].map(([classCode, payroll]) => ({ classCode, payroll })),
      claims,
      excludedUnauditedPayroll: excluded.length > 0,
    },
    assumptions: PERIOD_ASSUMPTIONS,
  };
}

// ------------------------------------------------------------------ Sec V R1
export interface PolicyTerm { id: string; effective: string; expiration: string; cancelled?: string }

export interface RatingDateResult {
  /** The rating effective date the applicable rule establishes. */
  date: string;
  rule: "V.1" | "V.1.a" | "V.1.b" | "A4";
  basedOnPolicy?: string;
  /** A5: the annual anniversary of `date` in force when the new policy incepts. */
  anniversaryForNewPolicy: string;
  /** False when the new policy itself cannot establish a rating date (V.1.c). */
  newPolicyEstablishesDate: boolean;
  skipped: { id: string; rule: "V.1.c"; reason: string }[];
  notes: string[];
}

const endOf = (p: PolicyTerm) => p.cancelled ?? p.expiration; // A6
const isShort = (p: PolicyTerm) => endOf(p) <= addMonths(p.effective, 3); // A6

function validateTerm(p: PolicyTerm, label: string) {
  if (typeof p?.id !== "string" || !p.id.trim()) throw new ValidationError("BAD_POLICY_ID", `${label} needs an id`);
  parse(p.effective, `${p.id} effective`);
  parse(p.expiration, `${p.id} expiration`);
  if (p.cancelled !== undefined) parse(p.cancelled, `${p.id} cancelled`);
  if (p.expiration <= p.effective) throw new ValidationError("BAD_POLICY_TERM", `Policy ${p.id}: expiration must be after effective`);
  if (p.cancelled !== undefined && (p.cancelled < p.effective || p.cancelled > p.expiration))
    throw new ValidationError("BAD_POLICY_TERM", `Policy ${p.id}: cancellation must fall within the policy term`);
}

function anniversaryOnOrBefore(date: string, target: string): string {
  if (target <= date) return date;
  let k = 0;
  while (addMonths(date, 12 * (k + 1)) <= target) k++;
  return addMonths(date, 12 * k);
}

export function ratingEffectiveDate(input: {
  priorPolicies: PolicyTerm[];
  newPolicy: PolicyTerm;
  wcirbEstablished?: string;
  /** Rating dates already on record, enabling the "incepts and expires between rating effective dates" test (V.1.c). */
  knownRatingEffectiveDates?: string[];
}): RatingDateResult {
  if (!Array.isArray(input?.priorPolicies)) throw new ValidationError("BAD_POLICIES", "priorPolicies must be an array");
  validateTerm(input.newPolicy, "newPolicy");
  input.priorPolicies.forEach((p, i) => validateTerm(p, `priorPolicies[${i}]`));
  const known = [...(input.knownRatingEffectiveDates ?? [])];
  known.forEach((d) => parse(d, "knownRatingEffectiveDates"));
  known.sort();

  const notes: string[] = [];
  const newPolicyEstablishesDate = !isShort(input.newPolicy);
  if (!newPolicyEstablishesDate)
    notes.push(`V.1.c: new policy ${input.newPolicy.id} is effective for 3 months or less and does not establish a new rating effective date`);
  if (!known.length) notes.push("V.1.c 'incepts and expires between rating effective dates' not applied: no knownRatingEffectiveDates supplied");

  const done = (r: Omit<RatingDateResult, "anniversaryForNewPolicy" | "newPolicyEstablishesDate" | "notes">): RatingDateResult => ({
    ...r, anniversaryForNewPolicy: anniversaryOnOrBefore(r.date, input.newPolicy.effective), newPolicyEstablishesDate, notes,
  });

  if (input.wcirbEstablished !== undefined) {
    parse(input.wcirbEstablished, "wcirbEstablished");
    return done({ date: input.wcirbEstablished, rule: "V.1.a", skipped: [] });
  }

  const prior = [...input.priorPolicies]
    .filter((p) => p.effective < input.newPolicy.effective)
    .sort((a, b) => a.effective.localeCompare(b.effective));

  // V.1.b: any policy issued counts as coverage, short ones included.
  const lastEnd = prior.map(endOf).sort().at(-1);
  if (lastEnd && input.newPolicy.effective > addMonths(lastEnd, 12)) {
    notes.push(`V.1.b: no policy for more than one year after ${lastEnd}`);
    return done({ date: input.newPolicy.effective, rule: "V.1.b", skipped: [] });
  }

  const skipped: RatingDateResult["skipped"] = [];
  const usable = prior.filter((p) => {
    if (isShort(p)) {
      skipped.push({ id: p.id, rule: "V.1.c", reason: "effective for 3 months or less" });
      return false;
    }
    const between = known.some((d, i) => i + 1 < known.length && p.effective > d && endOf(p) < known[i + 1]);
    if (between) {
      skipped.push({ id: p.id, rule: "V.1.c", reason: "incepts and expires between rating effective dates" });
      return false;
    }
    return true;
  });

  const preceding = usable.at(-1);
  if (!preceding) return done({ date: input.newPolicy.effective, rule: "A4", skipped });
  return done({ date: addMonths(preceding.effective, 12), rule: "V.1", basedOnPolicy: preceding.id, skipped });
}
