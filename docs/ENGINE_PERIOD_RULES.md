# Experience period and rating effective date (US-09)

Source: California Workers' Compensation Experience Rating Plan, effective September 1, 2025. Section III,
Rules 2 and 3, and Section V, Rule 1. The Plan PDF is public on wcirb.com and is **not** committed to this repo.
Practice implementation only. **Not an official WCIRB tool.**

Code: [`src/engine/period.ts`](../src/engine/period.ts) · Tests: [`tests/unit/period.test.ts`](../tests/unit/period.test.ts),
[`tests/api/period.api.spec.ts`](../tests/api/period.api.spec.ts)

## Rules implemented

| Plan rule | Plan text (abridged) | Implementation |
|---|---|---|
| III.2 | "three (3) years, commencing four (4) years and nine (9) months prior and terminating one (1) year and nine (9) months prior to the date for which an experience modification is to be established" | `experiencePeriod(red)` → `[red − 57 months, red − 21 months)` |
| III.3 | experience of a policy "that incepts within the experience period shall be … used"; "Only completed policy periods shall be used" | `selectExperience()` includes a policy when its **effective** date is in the period and `completed !== false` |
| III.3(a) | not used: "Experience of a policy previously used in determining experience modifications that applied to the risk for more than two (2) years and six (6) months" | excluded when `monthsUsedInPriorMods > 30` |
| III.3(g) | not used: "Unaudited payroll" | payroll lines with `audited: false` are dropped, listed in `excludedUnauditedPayroll`, and `ratingInput.excludedUnauditedPayroll = true`, which switches off the 25-point cap (Sec VI) and drives the low-E eligibility path (Sec III R1) in `calculateMod` |
| V.1 | "The rating effective date is twelve (12) months after the effective date of the preceding policy" | `ratingEffectiveDate()` → preceding usable policy's effective + 12 months |
| V.1(a) | "Where the WCIRB has established a rating effective date … such date shall govern" | `wcirbEstablished` input wins |
| V.1(b) | lapsed, cancelled or expired, and "no policy has been issued … for a period in excess of one (1) year" → "the effective date of the new policy" | reset when the new policy's effective date is **after** last end + 12 months |
| V.1(c) | "A policy that is effective for three (3) months or less or that incepts and expires between rating effective dates shall not be used to establish a new rating effective date" | short policies are skipped as the preceding policy, and a short *new* policy returns `newPolicyEstablishesDate: false`. The "between" test runs when `knownRatingEffectiveDates` are supplied |

## Assumptions (where the Plan text does not settle the question)

Returned with every `/api/xmod/experience-period` response (`assumptions`) and asserted in the unit tests.

| ID | Assumption | Why |
|---|---|---|
| A1 | The period is **half-open**: inception on the start date is in, inception on the end date is out. | Only this reading uses an annually renewed policy in exactly three ratings. A property test checks that for every inception date from 2000 to 2030. |
| A2 | Month arithmetic keeps the day and **clamps to month end** (2026-11-30 − 57 months = 2022-02-28). | The Plan states durations in years and months only. |
| A3 | III.3(a) means **more than 30 months**, so exactly 30 is still used. | Plan wording "more than two (2) years and six (6) months". The project brief said "2y6m or more"; the Plan text wins, and the difference is flagged here. |
| A4 | A risk with **no prior policy** gets its first rating date at its first policy's inception. | V.1 is defined relative to a preceding policy only. |
| A5 | The rating date recurs **annually**; `anniversaryForNewPolicy` is the latest anniversary on or before the new policy's inception. | V.1 (mod effective 12 months) and V.2(b) ("determined annually"). Without this, skipping short policies can yield a date more than a year before the new policy. |
| A6 | Term length and lapse use the **cancellation date** when present; "3 months or less" means end ≤ effective + 3 months. | "Effective for" reads as actual coverage. "Lapsed, been cancelled" names cancellation as a lapse start. |

The brief also said a lapse "over 1 year resets". The Plan says "in excess of one (1) year", and the implementation
treats exactly one year as **not** resetting. A boundary test covers it.

## Not implemented

- III.3(b)–(f) exclusions (projects outside the US/Canada over 180 days, private residence employees, other
  jurisdictions, other lines, insolvent insurers). They need data the model doesn't carry.
- III.7: experience before a coverage lapse of more than two consecutive years is not considered.
- V.2–V.4: applying a mod to single, multiple and employee-leasing policies.
- Valuation timing (the latest unit statistical report due one month before the rating date).

## API

```
POST /api/xmod/experience-period
{ "ratingEffectiveDate": "2026-01-01",
  "policies": [ { "id": "P2023", "effective": "2023-01-01", "expiration": "2024-01-01",
                  "monthsUsedInPriorMods": 12, "completed": true,
                  "payroll": [ { "classCode": "0005", "payroll": 500000, "audited": true } ],
                  "claims":  [ { "id": "C1", "indemnity": 20000, "medical": 0 } ] } ] }
→ { experiencePeriod, policies: [{ id, included, reasons[] }], excludedUnauditedPayroll[],
    ratingInput (POST it to /api/xmod/calculate), assumptions[] }

POST /api/xmod/rating-effective-date
{ "priorPolicies": [ { "id": "P1", "effective": "2025-01-01", "expiration": "2026-01-01", "cancelled": "2025-06-01"? } ],
  "newPolicy": { "id": "P2", "effective": "2026-01-01", "expiration": "2027-01-01" },
  "wcirbEstablished"?: "2026-07-01", "knownRatingEffectiveDates"?: ["2025-01-01", "2026-01-01"] }
→ { date, rule: "V.1" | "V.1.a" | "V.1.b" | "A4", basedOnPolicy, anniversaryForNewPolicy,
    newPolicyEstablishesDate, skipped[], notes[] }
```

Errors use the standard `{ "error": { "code", "message" } }` shape: 422 `BAD_DATE`, `BAD_POLICY_TERM`,
`DUPLICATE_POLICY`, `BAD_POLICY_ID`, `BAD_PAYROLL`, `BAD_POLICY`, `BAD_POLICIES`; 400 for a body of the wrong
shape. Both endpoints share the calculate endpoint's rate limit.
