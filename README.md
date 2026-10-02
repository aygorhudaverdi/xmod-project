# X-Mod Lab

[![CI](https://github.com/aygorhudaverdi/xmod-project/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/aygorhudaverdi/xmod-project/actions/workflows/ci.yml)
[![Playwright report](https://img.shields.io/badge/Playwright-latest%20report-2ead33?logo=playwright)](https://aygorhudaverdi.github.io/xmod-project/)

A test-practice web app around an experience-modification (X-Mod) engine, built from the
California Workers' Compensation Experience Rating Plan effective **Sept 1, 2025**.
**Not an official WCIRB tool.** The numbers are for test practice and must not be used to rate a real risk.

## What this demonstrates

Each duty from the Quality Engineer job description, and where this repo covers it:

| Duty | Where to look |
|---|---|
| **Build automated tests** (Playwright/Cypress/Selenium) | Playwright API and UI suites in [`tests/api`](tests/api) and [`tests/ui`](tests/ui): stable `data-testid` locators, web-first assertions, a fake clock for time-based UI, request mocking for UI states, an in-process app for isolated rate-limit tests. Engine unit and property tests in [`tests/unit`](tests/unit) (vitest + fast-check). |
| **Analyze user stories into functional, integration, component and regression tests** | Stories US-01..US-09 with acceptance criteria in [`web/stories.js`](web/stories.js) (also shown in the app); [docs/TRACEABILITY.md](docs/TRACEABILITY.md) maps each story to unit (component), API and UI (integration) tests; [docs/TEST_STRATEGY.md](docs/TEST_STRATEGY.md) covers levels and design techniques (boundary values, equivalence classes, decision tables, properties); every fixed defect has a named regression test. |
| **Collaborate on defects** | [docs/DEFECTS.md](docs/DEFECTS.md): template plus 8 real defects with reproduction steps, expected/actual, root cause, fix and regression test, and a severity trend. |
| **Validate non-functional requirements** (load, performance, security) | k6 smoke/load/stress in [`perf/`](perf) with NFRs in [PERFORMANCE_REQUIREMENTS.md](perf/PERFORMANCE_REQUIREMENTS.md) and recorded results; security headers, CSP, rate limiting, XSS and error-leak tests, and axe accessibility in [docs/SECURITY_AND_A11Y.md](docs/SECURITY_AND_A11Y.md). |
| **Help design CI/CD with tests integrated** | [`.github/workflows/ci.yml`](.github/workflows/ci.yml): type-check and traceability gate, unit on Node 20/22, Playwright with artifacts, dependency audit, k6 smoke, report published to Pages. [`Dockerfile`](Dockerfile), [`render.yaml`](render.yaml). |
| **Test reports, dashboards and defect trends** | Playwright HTML report on GitHub Pages; the in-app **Quality dashboard** (live service stats and latest test results); Grafana dashboard and Prometheus alerts in [`observability/`](observability); defect trend in [docs/DEFECTS.md](docs/DEFECTS.md#defect-trend); traceability summary in each CI run. |
| **Continuously improve the test process** | [docs/TEST_PROCESS_IMPROVEMENTS.md](docs/TEST_PROCESS_IMPROVEMENTS.md): what the tests missed first, how each gap was closed (layered negative tests, metric-behavior tests, a11y in both themes, typecheck, traceability gate), and next steps. |

## Run locally

Requires Node 20.19+ (CI runs 20 and 22).

```
npm ci
npm start                          # http://localhost:3000  (PORT env var overrides)
npm run test:unit                  # engine tests (vitest + fast-check)
npx playwright install chromium    # once per machine
npx playwright test                # API + UI tests; starts its own server on :3100
npx playwright show-report         # open the HTML report
```

Also: `npm run typecheck` (strict TypeScript) and `npm run trace` (regenerate the story → test matrix; add
`-- --check` to fail when a story has no tests, as CI does).

If `npx playwright install` is not possible (locked-down sandbox), point `CHROMIUM_PATH` at an existing
Chromium binary instead.

Layout: `src/engine` (pure engine) · `src/server` (Express API, `/metrics`) · `web` (UI) ·
`tests/{unit,api,ui}` · `data` (tables parsed from the Plan PDF by `tools/extract_tables.py`).

## Test documentation

| Document | What it covers |
|---|---|
| [docs/TEST_STRATEGY.md](docs/TEST_STRATEGY.md) | Scope, test levels and what each one proves, design techniques, entry/exit criteria, risks, assumptions |
| [docs/TRACEABILITY.md](docs/TRACEABILITY.md) | Story → acceptance criteria → tests, generated from test titles by `npm run trace` |
| [docs/DEFECTS.md](docs/DEFECTS.md) | Defect template, every defect found (steps, expected/actual, root cause, fix, regression test), and the trend |
| [docs/TEST_PROCESS_IMPROVEMENTS.md](docs/TEST_PROCESS_IMPROVEMENTS.md) | Retrospective: what the tests missed first and how the process was tightened |
| [docs/SECURITY_AND_A11Y.md](docs/SECURITY_AND_A11Y.md) | Security controls and tests, accessibility findings and fixes, known gaps |
| [perf/PERFORMANCE_REQUIREMENTS.md](perf/PERFORMANCE_REQUIREMENTS.md) | NFRs behind the k6 thresholds and the alert rules |
| [docs/ENGINE_PERIOD_RULES.md](docs/ENGINE_PERIOD_RULES.md) | Experience period and rating effective date: Plan citations, assumptions A1–A6, API examples |

## In-app quality dashboard

The **Quality dashboard** tab shows two panels:

- **Live service stats** from `GET /api/stats`, a JSON view of the app's own Prometheus registry: requests served,
  calculations by outcome, approximate p95, mod distribution and uptime. It refreshes every 5 s, shows a
  last-updated time and has a pause toggle. Its own polling (`/api/stats`, `/api/test-results`, `/metrics`) is
  left out of the counts.
- **Test results** from `GET /api/test-results`, a summary of `test-results/results.json` written by Playwright's JSON
  reporter: pass/fail/flaky/skipped per project and the failed tests with their first error line. Run
  `npx playwright test`, then `npm start`, to see it. Without a results file the panel shows an empty state.

The Grafana link defaults to `http://localhost:3001`. Override it on the server with `GRAFANA_URL`, or per browser
with `?grafana=https://your-grafana`, which is remembered.

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull request:

| Job | What it runs | Local equivalent |
|---|---|---|
| `checks` | strict type-check, traceability gate (`npm run trace -- --check`); matrix summary in the job summary | `npm run typecheck && npm run trace -- --check` |
| `unit` (Node 20 and 22) | `npm ci`, `npm run test:unit` | `npm run test:unit` |
| `e2e` | `npx playwright install --with-deps chromium`, `npx playwright test`; uploads `playwright-report/` and `test-results/` as artifacts even when tests fail | `npx playwright test` |
| `audit` | `npm audit --audit-level=high`; findings show up as a warning annotation and in the job summary, but don't fail the build | `npm audit --audit-level=high` |
| `perf-smoke` | starts the app (rate limit raised), runs `k6 run perf/smoke.js`; thresholds fail the job; uploads the k6 summary JSON | `RATE_LIMIT_MAX=1000000 npm start` then `k6 run perf/smoke.js` |
| `deploy-report` | On `main` only: publishes the Playwright HTML report to GitHub Pages, including failing runs | n/a |

The Pages job needs a one-time repository setting: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
After that, the latest report is at <https://aygorhudaverdi.github.io/xmod-project/>.

## Performance (k6)

```
RATE_LIMIT_MAX=1000000 npm start   # the default 120/min per IP would answer k6 with 429s
k6 run perf/smoke.js     # 30 s, 1 VU, all endpoints; runs in CI (perf-smoke job)
k6 run perf/load.js      # 0 → 50 VUs over 2 min, hold 3 min, realistic payload mix (~5% invalid → 422)
k6 run perf/stress.js    # stepped arrival rate to find the knee
```

Thresholds: `http_req_failed` < 1% (expected 422s excluded), calculate p95 < 200 ms and p99 < 500 ms, checks > 99%.
Summaries go to `perf/results/` (gitignored). See [perf/README.md](perf/README.md) for the scenarios, how to read
results, and the last local run, and [perf/PERFORMANCE_REQUIREMENTS.md](perf/PERFORMANCE_REQUIREMENTS.md) for the NFRs
(the project's own targets, not WCIRB's).

## Observability (Prometheus + Grafana)

```
docker compose up -d --build                         # app :3000, Prometheus :9090, Grafana :3001
docker compose --profile perf run --rm k6            # optional: run perf/load.js against the stack
K6_SCRIPT=smoke.js docker compose --profile perf run --rm k6   # or a shorter run
docker compose down -v
```

What to look at:

- **Grafana** <http://localhost:3001> opens straight onto *X-Mod Lab: service health* (anonymous, read-only).
  Panels: request rate by route; API latency p50/p95/p99 from histogram buckets (dashed line = 200 ms target);
  error rate split into 4xx (expected: validation, 404, 413, 429) and 5xx (should be zero); calculations by
  outcome; distribution of calculated mods; Node CPU, memory and event-loop lag; and k6 VUs and p95 while
  the `perf` profile runs (k6 pushes its metrics into Prometheus with remote write).
- **Prometheus** <http://localhost:9090>: *Status → Targets* should show `xmod` as UP, and *Alerts* lists the rules
  from [`observability/alerts.yml`](observability/alerts.yml): p95 > 200 ms for 5 min per API route, 5xx ratio > 1% for 5 min,
  and target down. The thresholds match the k6 NFRs, so what's tested before release is what's watched after.
- Grafana's admin password defaults to Grafana's own `admin` for this local-only stack. Set `GRAFANA_ADMIN_PASSWORD`
  in your shell to override it. No credentials are stored in the repo.

The app's metrics come from [`src/server/app.ts`](src/server/app.ts): `xmod_http_request_duration_seconds{method,route,status}`
(the `route` label is the matched route pattern, `unmatched` or `static`, so cardinality stays bounded),
`xmod_calculations_total{outcome}`, `xmod_mod_value`, plus prom-client's default process metrics.

## Security and accessibility

- helmet security headers with a strict CSP (`script-src 'self'; style-src 'self'`, no `unsafe-inline`).
- `POST /api/xmod/calculate` is rate limited per client IP: `RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS`, default
  120 per minute. Over the limit it returns 429 `RATE_LIMITED` in the standard error shape. Raise the limit for load
  tests: docker compose and CI already do. Behind a proxy, set `TRUST_PROXY=1`.
- Every error, including unknown `/api/*` routes and undecodable URLs, is JSON. No HTML error pages or stack traces
  are returned.
- axe-core checks every tab in light and dark mode (WCAG 2.1 AA plus best practices, zero violations allowed), and the
  tabs follow the WAI-ARIA keyboard pattern.

Details, findings and known gaps: [docs/SECURITY_AND_A11Y.md](docs/SECURITY_AND_A11Y.md).

## Deploy

The server runs the TypeScript sources through `tsx`, which is a runtime dependency. There is no build step, so
`npm start`, the Docker image and Render all run the same code.

**Docker** (multi-stage `node:20-slim`, runs as the unprivileged `node` user, `HEALTHCHECK` on `/api/health`):

```
docker build -t xmod-lab .
docker run --rm -p 3000:3000 xmod-lab              # http://localhost:3000
docker run --rm -e PORT=8080 -p 8080:8080 xmod-lab # any PORT works
```

**Render** (free web service): [`render.yaml`](render.yaml) is a Blueprint. In the Render dashboard choose
*New → Blueprint*, select this repository, and Render builds the Dockerfile and health-checks `/api/health`.
Free instances sleep when idle, so the first request after a pause is slow. Don't treat that as a performance result.

`GET /api/health` returns `{ "status": "ok", "version": "<package.json version>" }`, so you can see which build is live.

## Assumptions the Plan text does not settle (covered by tests)

1–2 are `RatingPolicy` parameters; 3–4 are fixed behavior documented on `RatingPolicy` in `src/engine/xmod.ts`; 5 lives in `src/engine/period.ts`.

1. Published mod = 2-decimal factor, round-half-up (rounding rule not found in the pages read).
2. Expected losses are rounded to whole dollars before the Table II band lookup.
3. A multi-person accident counts as one entry; the 25-point cap counts claims with primary > 0 individually.
4. Plan values are the 2025 ones (eligibility $10,800). The Sept 2026 Plan ($11,700, 3-decimal ELRs) is not loaded.
5. Experience period and rating-date interpretations A1–A6 are listed in [docs/ENGINE_PERIOD_RULES.md](docs/ENGINE_PERIOD_RULES.md).

## Experience period and rating effective date

`POST /api/xmod/experience-period` picks the policies and audited payroll that belong in a rating (Plan Sec III R2–R3),
explains each decision, and returns a `ratingInput` you can POST straight to `/api/xmod/calculate`.
`POST /api/xmod/rating-effective-date` applies Sec V R1. Plan citations, assumptions A1–A6 and examples are in
[docs/ENGINE_PERIOD_RULES.md](docs/ENGINE_PERIOD_RULES.md).

## Not implemented yet
Combinability and ownership change, corrections and closed-claim revision, appeals workflow, the remaining
Sec III R3 exclusions (b–f) and R7 coverage-lapse rule, and Sec V R2–R4 mod application.
