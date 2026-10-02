# Security and accessibility checks

Non-functional checks for X-Mod Lab, a practice project and **not an official WCIRB tool**. This page
records what is checked automatically, what was found, what changed, and what is still out of scope.

## 1. Security

### Controls in place

| Control | Where | Configuration |
|---|---|---|
| Security headers (helmet 8) | `src/server/app.ts` | CSP below, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, `Strict-Transport-Security`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`; `X-Powered-By` removed |
| Content-Security-Policy | same | `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`. **No `'unsafe-inline'` and no `'unsafe-eval'`.** `upgrade-insecure-requests` is deliberately left out because the app is also served over plain http (localhost, docker compose); Render serves it over https. |
| Rate limiting (express-rate-limit 8) | `POST /api/xmod/calculate` | 120 requests per 60 s per client IP by default (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`). Answers **429** in the standard shape `{ "error": { "code": "RATE_LIMITED", ... } }` with `Retry-After` and IETF draft-8 `RateLimit` / `RateLimit-Policy` headers. Read-only endpoints are not limited. Set `TRUST_PROXY=1` behind one proxy hop (done in `render.yaml`) so the limit applies per real client, not per proxy. |
| Body size limit | `express.json({ limit: "256kb" })` | 413 `PAYLOAD_TOO_LARGE` |
| JSON error contract everywhere | final error middleware + `/api` 404 handler | Every error is `{ "error": { "code", "message" } }`: 400 `MALFORMED_JSON`, 400 `BAD_REQUEST` (e.g. undecodable URL), 404 `NOT_FOUND` for unknown `/api/*`, 413, 422, 429, 500 `INTERNAL`. No HTML error page and no stack trace can reach a client. Unexpected errors are logged on the server only. |
| Input validation | `src/engine/xmod.ts` `validate()` | Class codes must exist; amounts finite and ≥ 0; net ≤ gross; claim ids unique, non-empty text ≤ 100 chars |
| Output encoding | `web/app.js` | All API-sourced text goes through `esc()` or `textContent`; no `eval` and no inline handlers. The CSP is a second line of defense. |
| Bounded metric labels | `routeLabel()` in `src/server/app.ts` | Prevents clients from creating unbounded Prometheus series (DEF-003) |
| Container | `Dockerfile` | Non-root `node` user, production dependencies only |
| Dependency audit | CI `audit` job | `npm audit --audit-level=high` on every run; visible as a warning, not blocking |

### Automated tests

| Test | File |
|---|---|
| Security headers and CSP present (no `unsafe-inline`/`unsafe-eval`, `X-Powered-By` absent) on `/` and `/api/health` | `tests/api/security.spec.ts` |
| 429 `RATE_LIMITED` after the limit, with `Retry-After` and `RateLimit-Policy`; other routes unaffected. Uses its own in-process app with a limit of 3, so the shared test server (limit raised) is not starved | `tests/api/security.spec.ts` |
| Oversized body → 413 in the standard shape; non-JSON content type → 4xx, not 500 | `tests/api/security.spec.ts` |
| Unknown `/api/*` route and wrong method → JSON 404; undecodable URL → JSON 400; responses contain no HTML, no stack frames and no `node_modules` paths | `tests/api/security.spec.ts` |
| Non-string claim id (`{ "$gt": "" }`, NoSQL-injection style) → 422 `BAD_CLAIM_ID`; SQL- and script-like ids are returned as plain data | `tests/api/security.spec.ts` |
| XSS: four injection payloads as claim ids render as literal text, no `img`/`script`/`svg` nodes, no script runs | `tests/ui/security.spec.ts` |
| XSS: an API error message carrying markup renders as text | `tests/ui/security.spec.ts` |
| XSS: test titles and error text in the dashboard's failed-test list render as text | `tests/ui/dashboard.spec.ts` |
| The whole UI (calculate, stories, dashboard) runs under the CSP with zero `securitypolicyviolation` events | `tests/ui/security.spec.ts` |
| An injected inline `<script>` is blocked by the CSP | `tests/ui/security.spec.ts` |
| `?grafana=javascript:...` is ignored (only http/https links) | `tests/ui/dashboard.spec.ts` |

### Findings

| ID | Finding | Severity | Status |
|---|---|---|---|
| DEF-001 | Malformed JSON returned Express's HTML error page with a stack trace | Major | Fixed before this work |
| DEF-003 | Unmatched URLs became Prometheus label values (unbounded cardinality, a memory and DoS vector for the metrics stack) | Major | Fixed |
| DEF-005 | Undecodable URL parameter (`/api/classes/%ZZ`) returned HTML with a full stack trace and absolute server paths; unknown `/api/*` returned HTML 404 | Major | Fixed |
| DEF-006 | Claim `id` accepted any JSON type (objects echoed back in the response) | Minor | Fixed |
| Hardening | No security headers, `X-Powered-By: Express` disclosed, inline `<style>` and `style=` attributes would have forced `style-src 'unsafe-inline'` | n/a | Fixed: helmet, CSS moved to `web/styles.css`, inline styles replaced with classes |
| Hardening | No rate limit on the CPU-bound calculate endpoint | n/a | Fixed |

Full defect records are in [DEFECTS.md](DEFECTS.md).

### Not covered (known gaps)

- No authentication or authorization: the app has no users. A real rating tool would need both, plus audit logging.
- No DAST/SAST scanner (e.g. OWASP ZAP baseline, CodeQL) in CI yet. This is the next step in `TEST_PROCESS_IMPROVEMENTS.md`.
- The rate limiter keeps counters in memory per process. Several replicas would need a shared store (e.g. Redis).
- `npm audit` covers known CVEs only, and it is non-blocking by design. Someone has to triage its warnings.
- HSTS is sent on http too, where browsers ignore it. It only takes effect over https.

## 2. Accessibility

### Checks

- `tests/ui/a11y.spec.ts` runs **axe-core** (`@axe-core/playwright`) with the WCAG 2.0/2.1 A and AA rule sets
  **plus axe best practices** on every tab and state: empty calculator, calculator with a result and claim
  breakdown, validation error, stories tab, and dashboard with live stats and a failed-test list. Every state is
  checked in both **light and dark** color schemes (the UI follows `prefers-color-scheme`).
- The gate is **zero violations of any impact**. It started at "no serious or critical". Once those were fixed,
  the single moderate finding was fixed too and the gate was tightened.
- Keyboard: `tests/ui/calculator.spec.ts` checks the WAI-ARIA tabs pattern (arrow keys, Home/End, wrap-around,
  roving `tabindex`) and Enter activation.

### Findings and fixes

| Rule (axe) | Impact | Where | Fix |
|---|---|---|---|
| `label`: form elements must have labels | critical | Payroll rows (class code, payroll) and claim rows (id, indemnity, medical) | The visible `<label>` text was not programmatically tied to its input. Each dynamic row now gets unique ids with `<label for>`. |
| `select-name`: select must have an accessible name | critical | Claim *Treatment* select | Same fix, `<label for>` on the select |
| `color-contrast` | serious | Dark mode: *Calculate X-Mod* button (white text on light blue, below 4.5:1) | New `--on-acc` token: white text in light mode, near-black in dark mode |
| `color-contrast` | serious | Dark mode: *Open Grafana* link (browser default link blue on a dark card) | Links use the theme accent `var(--acc)` |
| `region`: content must be in landmarks | moderate | `<nav role="tablist">`: the explicit role removed the `nav` landmark | `<nav aria-label="Sections">` now wraps a separate `role="tablist"` element |
| (manual) | n/a | Tabs only worked with Tab+Enter | Arrow keys, Home/End and roving `tabindex` per the WAI-ARIA Authoring Practices tabs pattern |

Logged together as DEF-007 in [DEFECTS.md](DEFECTS.md).

### Not covered (known gaps)

axe finds roughly a third to a half of WCAG issues. Still manual: screen-reader passes (NVDA, VoiceOver),
200% zoom and reflow at 320 px, focus order inside dynamically added rows, and whether `aria-live` result
announcements are useful rather than noisy.
