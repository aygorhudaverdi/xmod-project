# X-Mod Lab

A test-practice web app around an experience-modification (X-Mod) engine, built from the
California Experience Rating Plan effective **Sept 1, 2025**. Not an official WCIRB tool.

```
npm install
npm start                                   # http://localhost:3000
npm run test:unit                           # 67 engine tests (vitest + fast-check)
CHROMIUM_PATH=/path/to/chrome npx playwright test   # API + UI tests (omit CHROMIUM_PATH if `npx playwright install` works)
```

Layout: `src/engine` (pure engine) · `src/server` (Express API, `/metrics`) · `web` (UI) ·
`tests/{unit,api,ui}` · `data` (tables parsed from the Plan PDF by `tools/extract_tables.py`).

## Assumptions the Plan text does not settle (all in `RatingPolicy`, covered by tests)
1. Published mod = 2-decimal factor, round-half-up (rounding rule not found in the pages read).
2. Expected losses are rounded to whole dollars before the Table II band lookup.
3. A multi-person accident counts as one entry; the 25-point cap counts claims with primary > 0 individually.
4. Plan values are the 2025 ones (eligibility $10,800). The Sept 2026 Plan ($11,700, 3-decimal ELRs) is not loaded.

## Not implemented yet
Experience period / effective-date rules, combinability and ownership change, corrections and
closed-claim revision, appeals workflow. Planned: performance tests (k6), Prometheus + Grafana tab, CI pipeline.
