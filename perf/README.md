# Performance tests (k6)

Targets and their rationale are in [PERFORMANCE_REQUIREMENTS.md](PERFORMANCE_REQUIREMENTS.md). They are this
project's own NFRs, not WCIRB's.

```
npm start                       # or: docker compose up -d app
k6 run perf/smoke.js            # 30 s, gate for every CI run
k6 run perf/load.js             # ~5.5 min
k6 run perf/stress.js           # up to ~7 min, -e MAX_RPS=3000 to push further
k6 run -e BASE_URL=https://your-host perf/smoke.js
```

Every run prints the usual k6 summary and writes the full summary JSON to `perf/results/`, both as
`<scenario>-<timestamp>.json` and as `<scenario>-latest.json` (the directory is gitignored). The scripts
import `textSummary` from jslib.k6.io, so k6 needs internet access at start-up.

## Scenarios

| Script | Shape | Question it answers |
|---|---|---|
| `smoke.js` | 1 VU, 30 s, every endpoint: health, plan, class lookup, unknown class (expects 404), all five valid payloads, a random invalid payload (expects 422), UI page, `/metrics` | Do the scripts, the deployment and the error contract work at all? Run before any bigger test and in CI. |
| `load.js` | `ramping-vus`: 0 → 50 VUs over 2 min, hold 50 for 3 min, ramp down 30 s. 0.5–1.5 s think time | Does the service meet the NFRs at design load (about 50 req/s)? |
| `stress.js` | `ramping-arrival-rate`: steps at 5/10/20/35/50/75/100% of `MAX_RPS` (default 1600 req/s), 15 s ramp + 45 s plateau per step | Where is the knee, the rate at which p95 leaves 200 ms and latency climbs steeply? |

**Payload mix** (load and stress), defined in `lib.js`:

| Payload | Share | What it exercises |
|---|---|---|
| `lossFree` | 25% | Reference risk (class 0005, $1M payroll, mod 0.77), no claims |
| `oneClaim` | 25% | One $20k claim; the 25-point cap applies |
| `fiveClaims` | 20% | Two classes, five claims of different sizes (one at or below $250, one above the threshold) |
| `multiClass` | 15% | Four classes including a per-capita class (7707) |
| `subrogation` | 10% | A subrogation claim (net/gross ratio path) plus an ordinary claim |
| `invalid` | 5% | One of: unknown class, negative payroll, empty payroll, duplicate claim ids, net > gross. Each expects **422 with the right error code and no `mod`** |

## What the thresholds mean

| Threshold | Meaning |
|---|---|
| `http_req_failed: rate<0.01` | Under 1% of requests fail. A **422 isn't counted as a failure**: `http.setResponseCallback(http.expectedStatuses({min:200,max:399}, 422))` marks it as an expected response, and the smoke test's deliberate 404 probe gets its own per-request callback. A 5xx, a timeout, a connection reset or an unexpected 4xx still counts. |
| `http_req_duration{name:calculate}: p(95)<200, p(99)<500` | Latency of `POST /api/xmod/calculate` only. Every request is tagged `name`, so cheap GETs can't dilute the number. |
| `http_req_duration{name:calculate,expected_error:true\|false}` (load) | The same p95 target, split by valid ratings versus expected rejections, so a slow validation path can't hide behind fast ones. |
| `checks: rate>0.99` | Over 99% of the functional assertions hold under load: status, error code, a numeric `mod`, and no `mod` on an error. |
| stress `p(95)<200` | Not a gate. It shows which step broke the SLO. The stress run aborts only if p95 > 2 s or failures > 10% (after a 30 s grace period). |

k6 exits non-zero when a threshold fails, and that's what fails the `perf-smoke` CI job.

## How to read the results

1. **Thresholds block first** (✓/✗ at the start of a line). One ✗ means the run failed its NFRs.
2. **`http_req_duration{name:calculate}`**: compare p(95) and p(99) with 200/500 ms. A large p99/p95 gap points to
   queueing or GC pauses rather than a slow calculation.
3. **`checks`**: a failure here is a *correctness* problem under load, which is worse than a slow one.
4. **`http_req_failed`**: if it isn't zero, look at the status distribution (in Grafana, the 4xx vs 5xx panel).
   A 429 means the target's rate limit is too low for the test (see the main README).
5. **Stress only:** find the step where p95 crosses 200 ms, or where `dropped_iterations` appears (k6 could not
   start iterations on schedule because every VU was waiting on the server). That arrival rate is the knee.
   Compare it with the 50 req/s design load: the ratio is the headroom.
6. **Machine matters.** k6 and the server share the CPU when run on one laptop, so absolute numbers are
   pessimistic. Compare runs on the same machine, or watch trends in Grafana
   (`docker compose --profile perf run --rm k6`).

In `perf/results/<scenario>-latest.json`, the same numbers are under
`metrics["http_req_duration{name:calculate}"].values["p(95)"]` (milliseconds) and `metrics.checks.values.rate`.

## Results from the last local run

Run on 2026-10-02 on one Windows 11 desktop (Intel i5-14400F, 16 logical CPUs, 32 GB), with k6 2.2.0 and the
server (`npm start`, Node 24) on the same machine. These numbers show the method; they aren't a capacity statement.

| Scenario | Requests | Rate | calculate p95 | calculate p99 / max | Failed | Checks | Thresholds |
|---|---:|---:|---:|---:|---:|---:|---|
| smoke | 375 | 12/s | 1.39 ms | max 11.6 ms | 0% | 555/555 | all passed |
| load (50 VUs) | 15,348 | 46.5/s | 2.01 ms | max 5.3 ms | 0% | 28,758/28,758 | all passed |
| stress (to 1,600/s) | 271,442 | 646/s average | 1.69 ms | max 245 ms | 0% | 556,546/556,546 | all passed |

Stress per step (45 s plateaus, computed from `k6 run --out csv=...`):

| Target req/s | Achieved | p95 | p99 | Dropped iterations |
|---:|---:|---:|---:|---:|
| 80 | 80 | 1.8 ms | 2.1 ms | 0 |
| 160 | 160 | 1.6 ms | 1.9 ms | 0 |
| 320 | 320 | 1.3 ms | 1.6 ms | 0 |
| 560 | 560 | 0.8 ms | 1.2 ms | 0 |
| 800 | 800 | 0.8 ms | 2.2 ms | 0 |
| 1,200 | 1,193 | 4.3 ms | **26.7 ms** | **332** |
| 1,600 | 1,600 | 2.0 ms | 16.7 ms | 18 |

**Reading:** the p95 < 200 ms SLO held at every step, so the SLO knee is above 1,600 req/s on this machine. Raise
`MAX_RPS` to look for it. The first sign of saturation is at about 1,200 req/s: p99 jumps more than tenfold and
k6 starts dropping iterations. Because k6 shares the CPU with the server, part of that is the load generator
itself. Even so, that is 24× the 50 req/s design load. On Windows, k6 timings have coarse resolution, which is why
some sub-millisecond medians read as 0.
