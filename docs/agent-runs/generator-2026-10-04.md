# Generator run: calculate API (2026-10-04)

Branch: agent/2026-10-04-calculate-api. Plan: specs/plan-calculate-api.md. Open questions Q1-Q20 were unanswered at run time.

Result of `npx playwright test --project=agent` (exit code 1): 48 tests, 42 passed, 6 failed, 0 skipped.
Existing suites: `--project=api --project=ui` 144 passed (exit 0); `npm run test:unit` 129 passed (exit 0); `npm run typecheck` exit 0.

## Failing new tests (do not edit; for the healer)

All six are the candidate defects the human said to expect. Each fails at the first failing step of its loop, so later
steps of the same test did not run yet (they will run once the earlier step passes, or the healer may switch the loop to
`expect.soft` to see all failing steps without changing any expected value).

| Scenario | Failing step and error | Trace (test-results/...) | Classification |
|---|---|---|---|
| AG-NEG-11 (CD-1) | classCode `__proto__`: expected status 422 UNKNOWN_CLASS, received 500 | api-negative-fields-calcul-b06da-e-members-negative-security-agent/trace.zip | APP-DEFECT |
| AG-NEG-13 (CD-4) | `treatment:"bogus"` no net: code is BAD_NET, plan says it must not be | api-negative-fields-calcul-e9285-wn-treatment-value-negative-agent/trace.zip | APP-DEFECT |
| AG-NEG-15 (CD-2) | `nonCompensable:"false"`: AL 0 / AP 0, expected 422 or base case AL 20,000 / AP 8,250 | api-negative-fields-calcul-e087f-strings-or-numbers-negative-agent/trace.zip | APP-DEFECT |
| AG-NEG-17 (CD-6) | numeric `accidentId` 7: expected 422, received 200 | api-negative-fields-calcul-bf22a-entId-combinations-negative-agent/trace.zip | APP-DEFECT |
| AG-EDGE-11 (CD-3) | accidentDate `"2020-02-30"`: expected 422, received 200 | api-edge-calculate-API-edg-2ea95-s-an-ISO-date-edge-negative-agent/trace.zip | APP-DEFECT |
| AG-SEC-3 (CD-6) | 100 KB class code: response 100,074 bytes, expected < 500 | api-security-calculate-API-166d8-ho-unbounded-input-security-agent/trace.zip | APP-DEFECT |

Note on AG-NEG-17: steps 1-2 (BAD_ACCIDENT) passed; the failure is step 3 (numeric accidentId); step 4 did not run.

## BLOCKED (not implemented)

| Scenario / step | Reason |
|---|---|
| AG-NEG-4 step 1 (`payroll:"abc"`) | Exact code depends on Q3; observed UNKNOWN_CLASS "undefined" is CD-5, which is not on the expected-failing list. Steps 2-4 implemented. |
| AG-EDGE-4 step 3 (UI unit hint) | Product question Q11; also a UI step. Steps 1-2 implemented. |
| AG-EDGE-7 (case/space ids) | Q13: plan has no concrete expected value ("decision is documented"). Whole scenario blocked. |
| AG-EDGE-8 steps 1-2 | Q14. Step 3 implemented. |
| AG-EDGE-9 steps 1-2 | Q14 (rule precedence). Step 3 implemented. |
| AG-EDGE-10 step 4 (string catastropheNumber) | Q7. Steps 1-3 implemented. |
| AG-FLOW-3 malformed-JSON counter part | Q17. ok +1 / validation_error +2 and the histogram are implemented. |
| AG-FLOW-4 | Q18, expected value is undetermined. Whole scenario blocked. |
| AG-FLOW-5 | Q18. Whole scenario blocked. |

Scenarios implemented with a plan-stated either/or expectation (both branches have concrete values, so they pass under
either answer): AG-NEG-3, 6 (step 3), 13 (step 4), 14, 15 (steps 1-5), AG-EDGE-2, 3, 5 (step 2), AG-SMOKE-2 (claims null).
They stay valid whichever way the human answers Q2, Q4, Q7, Q8, Q9, Q10, Q11, Q19; when answered, tighten them.

## Notes for review

- AG-FLOW-1 and AG-FLOW-3 use an isolated in-process app (own counters): the shared server's counters move with other
  parallel tests, so exact deltas are only reliable there. AG-SEC-6 and AG-FLOW-6 use isolated apps with limit 3.
- AG-SEC-5 replays at most 40 requests (asserted in the test), only ones whose plan expectation is a rejection. AG-EDGE-11 requests are left out because
  CD-3 makes them 200 and that would double count the defect; the CD-1 500 requests are included because the plan allows
  500 bodies in the fixed INTERNAL shape. The stack-trace check uses the frame pattern `at <name> (` rather than the
  words "at "+identifier, because legitimate messages contain "at most".
- AG-SEC-3 bound: "a few hundred bytes" is asserted as response < 500 bytes.
- AG-NEG-13 step 1-3: "specific code naming the bad treatment" is asserted as 422 and code != BAD_NET (the exact name is Q7).
- Tag @smoke is not used because the plan gives no tag for smoke scenarios.
