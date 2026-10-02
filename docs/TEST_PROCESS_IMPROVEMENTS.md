# Test process improvements (retrospective)

A short, honest list: what the tests missed at first, and what changed so the same kind of miss is caught next
time. Defect IDs refer to [DEFECTS.md](DEFECTS.md).

## What the tests missed first, and how it was tightened

| # | What was missed | Why the tests didn't catch it | What changed |
|---|---|---|---|
| 1 | Malformed JSON got an HTML stack trace (DEF-001) | Error-contract tests only sent bodies that parse. The "invalid input" cases were all valid JSON with bad values. | Negative tests now cover each layer a request passes through: transport (413), parsing (400), routing (404, undecodable URL), validation (422), throttling (429). Each asserts the **content type** and that there is **no stack trace or HTML**, not just the status code. |
| 2 | The suite could not start on Windows (DEF-002) | It had only run on Linux, and the config used POSIX shell syntax. | Config uses `webServer.env`; the README documents Windows. **Next:** add `windows-latest` to the e2e matrix. |
| 3 | Unbounded metric labels; parse errors missing from metrics (DEF-003, DEF-004) | `/metrics` was tested only for "contains the metric name". Observability had no behavioral tests. | API tests assert metric *behavior*: bounded `route` values, parse errors recorded on their endpoint, SLO bucket edges present. Writing the DEF-003 test exposed DEF-004 the same day. |
| 4 | Stack trace on undecodable URLs (DEF-005) | The DEF-001 fix was point-specific (body-parser errors only), and its test was point-specific too. | Fix the *class* of defect, not the instance: a catch-all JSON error handler, and a test that sends something matching no known error type. |
| 5 | Claim id type not validated (DEF-006) | All fixtures were well-typed; property tests generate valid shapes only. | Validation tests include wrong JSON *types* (number, object, empty, oversized), not just wrong values. |
| 6 | Unlabeled inputs and dark-mode contrast (DEF-007) | UI tests used `data-testid` locators, which pass whether or not a control has an accessible name, and nothing ran in dark mode. | axe runs on every tab and state in **both color schemes** with zero violations allowed. Keyboard behavior has its own test. |
| 7 | Traceability overstated coverage (DEF-008) | The report generator itself had no tests. | Report and tool code get unit tests like product code. The generated matrix is reviewed, and CI checks it is up to date. |
| 8 | A type error in new code (`stats.ts`) went unnoticed | There was no `tsconfig.json` and no type-check; `tsx` and Vite strip types without checking them. | `tsconfig.json` (strict) plus `npm run typecheck` in the CI `checks` job. |

## Process changes

- **Story IDs in test titles are enforced.** `npm run trace -- --check` fails CI if any story in `web/stories.js` has
  no test, or if `docs/TRACEABILITY.md` is stale. Adding a story without a test, or a test without a story tag
  where one is due, shows up in review as a diff in the matrix.
- **Every defect closes with a named regression test** that failed before the fix. DEF-003 and DEF-004 were
  re-run against the original commit to confirm the reproduction, not just inferred from code.
- **Non-functional checks run in the same pipeline as functional ones:** perf smoke with thresholds, axe,
  security headers and the CSP, and `npm audit`. They are written down as targets
  (`perf/PERFORMANCE_REQUIREMENTS.md`), and the same numbers drive the production alerts.
- **Flakiness is checked before merging new UI tests:** new or changed specs run with `--repeat-each=5` (or 10 for
  timing-sensitive ones). Time-based UI behavior (5 s auto-refresh) uses Playwright's fake clock instead of real
  waits.
- **Tests with shared state get their own fixture.** The rate-limit test builds a separate in-process app with a
  limit of 3, instead of lowering the shared server's limit and starving parallel tests.

## Next steps (not done yet)

1. e2e on `windows-latest` as well as Ubuntu (follow-up to DEF-002).
2. OWASP ZAP baseline scan and CodeQL in CI (security beyond headers and unit-level checks).
3. Mutation testing (Stryker) on `src/engine` to measure whether the 60+ engine tests would notice a changed
   operator or constant.
4. Contract snapshot of the API (OpenAPI document plus schema validation in the API tests).
5. Publish defect trend and test-count history to the Pages site, not only the latest report.
