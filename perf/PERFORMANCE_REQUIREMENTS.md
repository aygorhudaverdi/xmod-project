# Performance requirements (non-functional)

> **These are X-Mod Lab's own targets**, chosen for this practice project. They are not WCIRB requirements
> and don't describe any WCIRB system. They are written the way a team would agree NFRs with a product owner:
> measurable, tied to a user-facing reason, and each mapped to a k6 threshold.

## Context and assumptions

- **Users:** premium auditors and underwriters submitting one rating at a time from the UI, plus integrations
  calling `POST /api/xmod/calculate` directly.
- **Design load:** 50 concurrent users, each submitting every 0.5–1.5 s. That's about 50 req/s sustained, a deliberately
  pessimistic stand-in for a busy renewal season.
- **Environment for the numbers:** one Node process (one container, no clustering). Treat results from a laptop
  or a free Render instance as relative, not absolute (see `perf/README.md`).
- The calculation is CPU-bound and synchronous (decimal.js), so latency grows with claim count. The mix
  therefore includes 5-claim and multi-class payloads, not just the trivial case.

## Requirements

| ID | Requirement | Why it matters | k6 threshold (where) |
|---|---|---|---|
| NFR-P1 | 95% of calculate requests finish in **< 200 ms** at design load | A form submit that feels instant; leaves headroom for network latency in front of the service | `http_req_duration{name:calculate}: p(95)<200` (smoke, load) |
| NFR-P2 | 99% of calculate requests finish in **< 500 ms** at design load | Caps the tail that users notice as "it hung" | `http_req_duration{name:calculate}: p(99)<500` (smoke, load) |
| NFR-P3 | Fewer than **1%** of requests fail at design load | A failure is a 5xx, a timeout, a connection error or any unexpected status. A 422 for a bad input is the documented contract, not a failure | `http_req_failed: rate<0.01`, with 422 marked expected via `http.setResponseCallback` (all) |
| NFR-P4 | **> 99%** of functional checks pass under load | Fast but wrong is a failure: status, error code and "no mod alongside an error" are asserted on every response | `checks: rate>0.99` (smoke, load) |
| NFR-P5 | The rejection path (422) meets the same latency target as valid ratings | Validation errors must not hide an expensive path | `http_req_duration{name:calculate,expected_error:true}: p(95)<200` (load) |
| NFR-P6 | Know the capacity knee: the arrival rate at which NFR-P1 stops holding | Capacity planning and alert tuning; stress reports it rather than enforcing it | `stress.js` thresholds mark the breach; aborts only on collapse (p95 > 2 s or > 10% failures) |

## Related operational targets

These are enforced in production-style monitoring, not in k6 (see `observability/alerts.yml`):

- p95 latency > 200 ms for 5 minutes → alert (same number as NFR-P1, so test and production agree).
- 5xx rate > 1% for 5 minutes → alert (same number as NFR-P3).
