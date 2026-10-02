# Test strategy: X-Mod Lab

X-Mod Lab is a practice application built from the California Workers' Compensation Experience Rating Plan
effective Sept 1, 2025. **It is not an official WCIRB tool.** This strategy is written as if the calculator
were a real product, because the techniques transfer.

## 1. Scope

**In scope**
- The experience-modification engine (`src/engine/xmod.ts`): expected losses, Table II primary threshold, D-ratios,
  claim valuation and its exception rules (Sec VI R2), the single-claim 25-point cap, eligibility, rounding.
- The HTTP API (`src/server/app.ts`): routes, validation, the error contract, rate limiting, security headers, metrics.
- The browser UI (`web/`): calculator, user-stories tab, quality dashboard.
- Experience-period selection and rating-effective-date rules (`src/engine/period.ts`, Sec III R2–R3, Sec V R1).
- Non-functional: performance (k6), security (headers, CSP, rate limit, XSS, payload limits, dependency audit),
  accessibility (axe, keyboard).
- The delivery pipeline: CI jobs, artifacts, the report on Pages, container image.

**Out of scope**
- Combinability, ownership changes, corrections, closed-claim revision, appeals; Sec III R3(b)–(f) and R7;
  Sec V R2–R4 (not implemented).
- The Sept 2026 Plan values (eligibility $11,700, 3-decimal ELRs); the tables are not loaded.
- The correctness of the source PDF itself. Tables are trusted once `tools/extract_tables.py` has parsed them,
  and spot-checked by hand-computed expectations in unit tests.
- **Known gap: grouping by policy.** The real worksheet groups payroll and claims by policy (and policy
  period). The engine has no policy concept in `/api/xmod/calculate`: the calculator's "Policy year" field is a
  display-only label that groups rows in the payroll summary and is never sent to the engine. Claims are not
  grouped. `POST /api/xmod/experience-period` (US-09) does work per policy, but the calculator does not use it yet.
- Browsers other than Chromium, mobile layouts beyond a basic responsive check, load beyond a single instance.

## 2. Test levels

| Level | Tooling | Location | What it is for | What it does *not* prove |
|---|---|---|---|---|
| Static | TypeScript strict (`npm run typecheck`) | `tsconfig.json` | Type errors in engine, server, tools and tests | Runtime input shapes (validated separately) |
| Unit (example-based) | vitest | `tests/unit/*.test.ts` | Exact hand-computed expectations for each Plan rule and each boundary (Table II band edges, $250 floor, MLV cap, $10,800 eligibility) | That the API or UI expose those results correctly |
| Property-based | fast-check in vitest | `tests/unit/xmod.test.ts` › `properties` | Invariants over thousands of generated risks: mod ≥ loss-free mod, adding a claim never lowers the mod, claim order is irrelevant, Ep + Ee = E, Ap within [0, PT−250] | Specific Plan numbers (a consistent but wrong formula can satisfy invariants) |
| Component / API | Playwright `request` | `tests/api/*.spec.ts` | The HTTP contract: status codes, the `{error:{code,message}}` shape, content types, health/version, metrics exposure, rate limit, security headers | Browser rendering |
| Integration (UI ↔ API) | Playwright + Chromium | `tests/ui/*.spec.ts` | User journeys per story: form → API → rendered breakdown, error display, tab behavior, dashboard refresh | Cross-browser behavior |
| Accessibility | `@axe-core/playwright` | `tests/ui/a11y.spec.ts` | Zero WCAG 2.1 A/AA and best-practice violations on every tab and state, light and dark; WAI-ARIA keyboard pattern for tabs | Full WCAG conformance (needs manual and screen-reader testing) |
| Security (functional) | Playwright | `tests/api/security.spec.ts`, `tests/ui/security.spec.ts` | Headers/CSP present, 429 after the limit, 413 on oversize, JSON 404 for unknown `/api/*`, injected strings rendered inertly | Penetration-level assurance; it isn't a pentest |
| Dependency security | `npm audit` (CI) | `.github/workflows/ci.yml` › `audit` | Known-vulnerable packages, visible on every run | Zero-days, logic flaws |
| Performance | k6 | `perf/` | NFR-P1..P6: latency percentiles, failure rate, check rate at design load; capacity knee | Production capacity (single local instance) |
| Regression | All of the above in CI | `.github/workflows/ci.yml` | Every push and PR re-runs unit, API, UI, a11y and perf smoke; each fixed defect has a named regression test (`docs/DEFECTS.md`) | |

Story IDs (`US-01`..`US-09`) appear in test titles. `npm run trace` builds `docs/TRACEABILITY.md` from them and
fails CI if any story has no test.

## 3. Test design techniques used

- **Boundary value analysis:** Table II band edges (E = 19,923 / 19,924), the $250 floor (250 / 251), threshold
  equality (claim = PT), eligibility at exactly $10,800 and one dollar below.
- **Equivalence partitioning:** the claim treatment types (none, subrogation, fraud, compromise, joint, death, EL+WC,
  non-compensable, COVID, multi-person, contract medical) each form one class with one representative test.
- **Decision tables:** 25-point cap = (exactly one claim with primary) AND (unaudited payroll not excluded) AND
  (raw mod > loss-free + 0.25). Eligibility = E ≥ threshold OR (prior-year rated AND not excluded AND mod > 1).
- **Property-based testing:** for invariants where enumerating examples would miss combinations.
- **Error guessing / negative testing:** malformed JSON, strings for numbers, oversized bodies, duplicate ids,
  script tags in claim ids.

## 4. Entry and exit criteria

**Entry (a change is ready to be tested)**
- Linked to a user story ID, or to a defect ID for fixes.
- Builds and starts locally (`npm start`, `/api/health` returns `ok`).
- For engine changes: the Plan section it implements is cited in a code comment.

**Exit (a change is ready to merge)**
- CI green: `checks` (strict type-check, traceability gate), `unit` (Node 20 and 22), `e2e` (API + UI + a11y +
  security), `perf-smoke`; `audit` reviewed if it warns.
- `npm run trace` reports every story covered.
- No open Critical or Major defects in `docs/DEFECTS.md` for the change.
- New rules carry unit tests with hand-computed expectations, plus at least one API or UI test per story.
- Any new interpretation of the Plan is added to the assumptions list below and to `RatingPolicy` if it is a
  parameter.

## 5. Risks and how the strategy addresses them

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| Plan text misread, so the formula is consistently wrong | Medium / High | Hand-computed reference risk shared by unit, API, UI and perf tests; rule cited per claim (`rule` field) so a reviewer can check against the Plan |
| Table extraction from the PDF is off by a row or column | Medium / High | Band-edge tests on Table II; spot D-ratios and ELRs asserted; extractor kept in `tools/` for re-runs |
| Floating-point drift in money | Low / High | decimal.js everywhere; the property `Ep + Ee = E` holds exactly |
| Ambiguous rule silently decided in code | Medium / Medium | Assumptions isolated in `RatingPolicy`, listed below, shown in the API output (`policy`) and the UI |
| Contract drift between API and UI | Medium / Medium | UI tests go through the real API, not mocks |
| Flaky UI tests | Medium / Low | `data-testid` locators only, web-first assertions (no sleeps), one retry on CI only, traces kept on failure |
| Performance regressions unnoticed | Low / Medium | perf smoke in CI; same thresholds as the production alerts |
| Vulnerable dependency | Medium / Medium | `npm audit` on every run (non-blocking but visible); helmet, CSP and rate limiting |

## 6. Assumptions (interpretations the Plan text does not settle)

1. **Mod rounding:** the published mod is a 2-decimal factor, rounded half-up (`RatingPolicy.modDecimals = 2`).
2. **Band lookup rounding:** expected losses are rounded to whole dollars before the Table II band lookup
   (`RatingPolicy.roundExpectedForBand = true`).
3. **25-point cap counting:** the cap applies when exactly one claim has primary losses > 0. Claims are counted
   individually, and a multi-person accident (one capped line in the breakdown) counts as one entry.
4. **Plan year:** only the Sept 1, 2025 Plan values are loaded (eligibility $10,800, 2-decimal ELRs). The Sept 2026
   Plan ($11,700, 3-decimal ELRs) is not.
5. **Experience period and rating effective date:** A1–A6 in [ENGINE_PERIOD_RULES.md](ENGINE_PERIOD_RULES.md): half-open
   period, month-end clamping, "more than 30 months" for prior use, first-policy rating date, annual anniversaries,
   cancellation dates for term and lapse. They are returned with every response and asserted in tests.

## 7. Environments and data

- **Local:** `npm start` on :3000; Playwright starts its own server on :3100.
- **CI:** GitHub-hosted Ubuntu runners; the server is started per job.
- **Container:** `docker compose up` adds Prometheus (:9090) and Grafana (:3001).
- **Test data:** synthetic risks only. The reference risk (class 0005, $1,000,000 payroll → E = 20,200, PT 8,500,
  mod 0.77) is the shared oracle across levels.

## 8. Reporting

- Playwright HTML report: CI artifact and GitHub Pages (main).
- Playwright JSON results: shown in the app's *Quality dashboard → Test results* panel.
- k6 summary JSON: `perf/results/`, CI artifact for smoke.
- Live service metrics: the in-app dashboard and Grafana.
- Defects: `docs/DEFECTS.md`; process changes: `docs/TEST_PROCESS_IMPROVEMENTS.md`.
