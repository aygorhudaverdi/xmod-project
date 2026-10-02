# X-Mod Lab

[![CI](https://github.com/aygorhudaverdi/xmod-project/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/aygorhudaverdi/xmod-project/actions/workflows/ci.yml)
[![Playwright report](https://img.shields.io/badge/Playwright-latest%20report-2ead33?logo=playwright)](https://aygorhudaverdi.github.io/xmod-project/)

A test-practice web app around an experience-modification (X-Mod) engine, built from the
California Workers' Compensation Experience Rating Plan effective **Sept 1, 2025**.
**Not an official WCIRB tool.** The numbers are for test practice and must not be used to rate a real risk.

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

If `npx playwright install` is not possible (locked-down sandbox), point `CHROMIUM_PATH` at an existing
Chromium binary instead.

Layout: `src/engine` (pure engine) · `src/server` (Express API, `/metrics`) · `web` (UI) ·
`tests/{unit,api,ui}` · `data` (tables parsed from the Plan PDF by `tools/extract_tables.py`).

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
| `unit` (Node 20 and 22) | `npm ci`, `npm run test:unit` | `npm run test:unit` |
| `e2e` | `npx playwright install --with-deps chromium`, `npx playwright test`; uploads `playwright-report/` and `test-results/` as artifacts even when tests fail | `npx playwright test` |
| `audit` | `npm audit --audit-level=high`; findings show up as a warning annotation and in the job summary, but don't fail the build | `npm audit --audit-level=high` |
| `deploy-report` | On `main` only: publishes the Playwright HTML report to GitHub Pages, including failing runs | n/a |

The Pages job needs a one-time repository setting: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
After that, the latest report is at <https://aygorhudaverdi.github.io/xmod-project/>.

## Performance (k6)

```
npm start
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

## Assumptions the Plan text does not settle (all in `RatingPolicy`, covered by tests)
1. Published mod = 2-decimal factor, round-half-up (rounding rule not found in the pages read).
2. Expected losses are rounded to whole dollars before the Table II band lookup.
3. A multi-person accident counts as one entry; the 25-point cap counts claims with primary > 0 individually.
4. Plan values are the 2025 ones (eligibility $10,800). The Sept 2026 Plan ($11,700, 3-decimal ELRs) is not loaded.

## Not implemented yet
Experience period / effective-date rules, combinability and ownership change, corrections and
closed-claim revision, appeals workflow. Planned: performance tests (k6), Prometheus + Grafana tab.
