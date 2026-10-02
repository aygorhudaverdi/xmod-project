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

## Assumptions the Plan text does not settle (all in `RatingPolicy`, covered by tests)
1. Published mod = 2-decimal factor, round-half-up (rounding rule not found in the pages read).
2. Expected losses are rounded to whole dollars before the Table II band lookup.
3. A multi-person accident counts as one entry; the 25-point cap counts claims with primary > 0 individually.
4. Plan values are the 2025 ones (eligibility $10,800). The Sept 2026 Plan ($11,700, 3-decimal ELRs) is not loaded.

## Not implemented yet
Experience period / effective-date rules, combinability and ownership change, corrections and
closed-claim revision, appeals workflow. Planned: performance tests (k6), Prometheus + Grafana tab.
