# Defect log

Every defect found in X-Mod Lab is logged here, whether it came from a failing test, a test review, a
non-functional check or exploratory use. A defect is closed only when a regression test that failed
before the fix passes after it.

## Template

```
### DEF-NNN: <one-line title>
| Field | Value |
|---|---|
| Severity | Critical / Major / Minor / Trivial (impact on the user or on trust in the results) |
| Found by | Which test, review or activity surfaced it |
| Component | engine / API / UI / test infra / CI / observability |
| Status | Open / Fixed (commit) / Won't fix (reason) |

**Steps to reproduce:** numbered, minimal, copy-pasteable.
**Expected:** what the contract, story or Plan says should happen.
**Actual:** what happened, with evidence (status code, body, screenshot, log line).
**Root cause:** why the code did that, not just where.
**Fix:** what changed.
**Regression test:** file and exact test title, which fails without the fix.
```

Severity scale: **Critical** = wrong mod or data exposure. **Major** = broken contract, security weakness or
blocked workflow. **Minor** = degraded behavior with a workaround. **Trivial** = cosmetic.

---

### DEF-001: Malformed JSON returned Express's default HTML error page and stack trace
| Field | Value |
|---|---|
| Severity | Major (broken API contract; stack trace leaks internals) |
| Found by | Playwright API test review: the error-contract cases covered only bodies that parse |
| Component | API |
| Status | Fixed (in the initial commit `68938bf`) |

**Steps to reproduce:**
1. `curl -i -X POST localhost:3000/api/xmod/calculate -H 'content-type: application/json' -d '{not json'`

**Expected:** `400` with `content-type: application/json` and `{ "error": { "code": "MALFORMED_JSON", "message": ... } }`,
like every other API error.
**Actual:** `400` with an HTML page from Express's default error handler containing the `SyntaxError` stack trace
(file paths of the server).
**Root cause:** `express.json()` raises `entity.parse.failed` before any route runs, so the route's `try/catch`
never sees it. No error-handling middleware was registered, so Express used its default HTML handler.
**Fix:** a 4-argument error middleware in `src/server/app.ts` maps `entity.parse.failed` → 400 `MALFORMED_JSON` and
`entity.too.large` → 413 `PAYLOAD_TOO_LARGE`.
**Regression test:** `tests/api/xmod.api.spec.ts` › `malformed JSON → 400 MALFORMED_JSON in the standard error shape`
(also asserts the JSON content type).

---

### DEF-002: Playwright could not start the test server on Windows
| Field | Value |
|---|---|
| Severity | Major (the whole API/UI suite was blocked for anyone on Windows) |
| Found by | Baseline run before Task 1 (`npx playwright test` on Windows 11) |
| Component | test infra |
| Status | Fixed (`a652e41`) |

**Steps to reproduce:**
1. On Windows, `npm ci && npx playwright test`.

**Expected:** Playwright starts the app on port 3100 and runs 37 tests.
**Actual:** `'PORT' is not recognized as an internal or external command`, then `Process from config.webServer was not able to start. Exit code: 1`. No test ran.
**Root cause:** `webServer.command` was `PORT=3100 npx tsx ...`, a POSIX-shell-only way of setting an environment
variable. Playwright runs the command through `cmd.exe` on Windows. Nobody noticed because the suite had only run on Linux.
**Fix:** pass the port through `webServer.env` and keep the command shell-neutral.
**Regression test:** the whole Playwright suite starting on Windows; CI (Ubuntu) covers Linux. Retrospective item: also run e2e on a Windows runner (see TEST_PROCESS_IMPROVEMENTS.md).

### DEF-003: Unmatched URLs created a new Prometheus time series each
| Field | Value |
|---|---|
| Severity | Major (unbounded metric cardinality: memory growth in the app and in Prometheus, triggerable by any client) |
| Found by | Code review while building the Grafana dashboard (Task 4) |
| Component | observability |
| Status | Fixed (`e883e15`) |

**Steps to reproduce:**
1. `for i in $(seq 1 50); do curl -s localhost:3000/x$i > /dev/null; done`
2. `curl -s localhost:3000/metrics | grep -c 'route="/x'`

**Expected:** a bounded set of `route` label values (route patterns), whatever the URLs requested.
**Actual:** 50 distinct label values, `route="/x1"` … `route="/x50"` (re-run against `68938bf`); every new URL adds more.
**Root cause:** the label fell back to `req.path` when no route matched.
**Fix:** `routeLabel()` uses the matched route pattern, a fixed list of API paths, or one of two constants
(`unmatched` for 404, `static` for files).
**Regression test:** `tests/api/xmod.api.spec.ts` › `unknown URLs share one 'unmatched' route label (bounded metric cardinality, DEF-003)`.

### DEF-004: Malformed-JSON and oversized requests were missing from the metrics
| Field | Value |
|---|---|
| Severity | Major (error-rate panels and the 5xx alert under-reported; a flood of bad requests was invisible) |
| Found by | A new API test written for DEF-003's labelling failed: the 400 never appeared in `/metrics` at all |
| Component | observability |
| Status | Fixed (`e883e15`) |

**Steps to reproduce:**
1. `curl -s -XPOST localhost:3000/api/xmod/calculate -H 'content-type: application/json' -d '{oops'`
2. `curl -s localhost:3000/metrics | grep 'status="400"'`

**Expected:** one `xmod_http_request_duration_seconds_count{method="POST",route="/api/xmod/calculate",status="400"}` sample.
**Actual:** no series for the request (zero `status="400"` samples, re-run against `68938bf`).
**Root cause:** `express.json()` was registered *before* the timing middleware. When the parser throws, Express
skips every remaining normal middleware and goes straight to the error handler, so the timer never started.
**Fix:** register the timing middleware first, then the body parser.
**Regression test:** `tests/api/xmod.api.spec.ts` › `body-parser errors are labelled with their endpoint, not as static files`.

### DEF-005: Undecodable URL parameter returned an HTML stack trace with server paths
| Field | Value |
|---|---|
| Severity | Major (information disclosure: absolute file paths and dependency layout; broken API contract) |
| Found by | Exploratory negative testing during the security task (Task 6) |
| Component | API |
| Status | Fixed (`e9cc9c5`) |

**Steps to reproduce:**
1. `curl -i localhost:3000/api/classes/%ZZ`
2. `curl -i localhost:3000/api/nope`

**Expected:** JSON errors in the standard shape: 400 for the bad parameter, 404 for the unknown route.
**Actual:** (1) `400 text/html` with `URIError: Failed to decode param '%ZZ'` and a stack trace including
`C:\Users\...\node_modules\router\lib\layer.js`. (2) `404 text/html` "Cannot GET /api/nope".
**Root cause:** the DEF-001 fix handled body-parser errors only and passed everything else to Express's default
handler, which renders HTML with the stack outside production. Unknown routes fell through to Express's HTML 404.
**Fix:** a JSON 404 handler for `/api`, and a final error handler that maps any 4xx error to `BAD_REQUEST` and
anything else to `INTERNAL`, logging server-side only.
**Regression tests:** `tests/api/security.spec.ts` › `undecodable URL parameter -> JSON 400, no stack trace (DEF-005)`,
`unknown GET /api/* route -> JSON 404 NOT_FOUND`, `wrong method on a real route -> JSON 404 NOT_FOUND`.

### DEF-006: Claim id accepted any JSON type
| Field | Value |
|---|---|
| Severity | Minor (no wrong mod, but objects were echoed back in `claims[].id`; NoSQL-style `{ "$gt": "" }` payloads accepted) |
| Found by | Exploratory API testing during the security task |
| Component | engine validation |
| Status | Fixed (`e9cc9c5`) |

**Steps to reproduce:**
1. POST `{"payroll":[{"classCode":"0005","payroll":1000000}],"claims":[{"id":{"x":1},"indemnity":1,"medical":0}]}`

**Expected:** 422 with a specific error code (US-06: invalid input is rejected with a specific message).
**Actual:** 200, with `"id": {"x": 1}` in the breakdown.
**Root cause:** `validate()` checked uniqueness of `id` but not its type. TypeScript types are not enforced at runtime.
**Fix:** claim ids must be non-empty strings of at most 100 characters (`BAD_CLAIM_ID`). The UI input has `maxlength="100"`. No numeric behavior changed.
**Regression tests:** `tests/unit/xmod.test.ts` › `rejects claim id %j (DEF-006)` (6 cases),
`tests/api/security.spec.ts` › `a non-string claim id is rejected (DEF-006)`.

### DEF-007: Accessibility violations on the calculator and dashboard
| Field | Value |
|---|---|
| Severity | Major (critical axe findings: unlabeled form controls are unusable with a screen reader) |
| Found by | New axe-core tests (`tests/ui/a11y.spec.ts`) on their first run |
| Component | UI |
| Status | Fixed (`e9cc9c5`) |

**Steps to reproduce:** run `npx playwright test tests/ui/a11y.spec.ts` against the UI before the fix.

**Expected:** no WCAG 2.1 A/AA violations.
**Actual:** `label` (critical) on class code, payroll, claim id, indemnity and medical inputs; `select-name`
(critical) on Treatment; `color-contrast` (serious, dark mode only) on the primary button and the Grafana link;
`region` (moderate) because `role="tablist"` on `<nav>` removed the landmark. Separately, tabs had no arrow-key support.
**Root cause:** labels were visual siblings without `for`/`id`; the dark palette was never contrast-checked;
the ARIA role was put on the landmark element itself.
**Fix:** per-row unique ids with `<label for>`, an `--on-acc` color token, themed links, a separate tablist inside
`<nav>`, and the WAI-ARIA tabs keyboard pattern.
**Regression tests:** `tests/ui/a11y.spec.ts` (10 tests, light and dark, zero violations of any impact) and
`tests/ui/calculator.spec.ts` › `tabs follow the WAI-ARIA keyboard pattern: arrows, Home/End, roving tabindex`.

### DEF-008: Traceability scanner counted fake and shadowed tests as coverage
| Field | Value |
|---|---|
| Severity | Minor (overstated coverage in the traceability report; a story could look covered without being covered) |
| Found by | Reviewing the first generated matrix (Task 7): US-02 showed unit coverage that did not exist |
| Component | tooling (`tools/traceability.ts`) |
| Status | Fixed (this commit) |

**Steps to reproduce:** generate the matrix with the first scanner version. `tests/unit/traceability.test.ts` contains
`scan('test("US-01 loss-free risk", ...)')` as a *string fixture*, and `tests/unit/stats.test.ts` had a local helper named `test()`.
**Expected:** only real `test`/`it`/`describe` calls count.
**Actual:** the string fixture counted as a US-01 unit test, and five helper calls counted as US-08 tests titled "api"/"ui".
**Root cause:** the scanner regex matched text anywhere in the file, including strings and comments; a local
function shadowing `test` is indistinguishable by text alone.
**Fix:** the scanner's lexer marks string, template-text, comment and regex positions, and matches there are ignored.
The helper was renamed to `pwTest`.
**Regression test:** `tests/unit/traceability.test.ts` › `test-like text inside strings and comments is not a test (no false coverage)`.

### DEF-009: A contract-medical line counts as a "claim" for the 25-point cap (OPEN, needs a rules decision)
| Field | Value |
|---|---|
| Severity | Major if confirmed (wrong mod for risks with contract medical and at most one claim) |
| Found by | Computing expected results for the worksheet redesign's contract-medical test |
| Component | engine (`calculateMod`, cap counting) |
| Status | **Open.** Not changed, because the redesign task forbids any change to calculation results. Needs a decision from whoever owns the rating rules |

**Steps to reproduce:**
1. POST `{"payroll":[{"classCode":"0005","payroll":1000000}],"claims":[],"contractMedical":[{"classCode":"0005","incurred":500000}]}`

**Expected (by the Plan text):** Sec VI R6 limits the mod "for risks with only a single **claim** for which the Actual Primary
Losses is greater than zero". Contract medical is reported by classification (Sec VI R2(b)), not per claim, so with
no claims at all the single-claim limit arguably does not apply. The loss-free comparison is also unclear, because "if the risk had no claims"
says nothing about contract medical.
**Actual:** `capApplied: true`, `claimsWithPrimary: 1`, mod 1.02 (uncapped formula 6.37).
**Root cause:** `claimsWithPrimary` counts every line in the breakdown with Ap > 0, and contract-medical lines are in that list.
**Options:** (a) count only real claims (contract medical never triggers or blocks the cap); (b) keep the current
behavior and record it as assumption 5 in `RatingPolicy`. Either way, add a unit test that pins the decision.
**Regression test:** to be written once the rule is decided. `tests/ui/worksheet.spec.ts` currently pins only the
contract-medical line value (Ap 113,000), not the cap.

## Defect trend

| Found during | Defects | By severity | How found |
|---|---|---|---|
| Initial build | 1 | Major 1 | API test review |
| CI setup (Task 1) | 1 | Major 1 | Baseline run on a second OS |
| Observability (Task 4) | 2 | Major 2 | Code review, then a new test exposing a second bug |
| Security and a11y (Task 6) | 3 | Major 2, Minor 1 | Exploratory negative testing, first axe run |
| Test documentation (Task 7) | 1 | Minor 1 | Review of generated report |
| Worksheet redesign | 1 (open) | Major 1, if confirmed | Deriving expected values from the Plan text before writing tests |
| **Total** | **9** | **Critical 0, Major 7, Minor 2** | 8 closed, each with a regression test; 1 open pending a rules decision |

Most defects sat on **contract edges and error paths** (DEF-001, 004, 005, 006) or in **non-functional and
tooling layers** (002, 003, 007, 008). None came from the rating math, which example and property tests had already
pinned down. That pattern shaped the changes in [TEST_PROCESS_IMPROVEMENTS.md](TEST_PROCESS_IMPROVEMENTS.md).
