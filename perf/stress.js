// Stress: step the arrival rate up until the service bends, to find the knee.
//   k6 run perf/stress.js                    (override the ceiling with -e MAX_RPS=3000)
// Open model (arrival rate, not VUs): if the server slows down, requests still arrive on schedule
// and queueing becomes visible as latency and dropped_iterations rather than being hidden.
// Start the target with RATE_LIMIT_MAX=1000000 (see load.js).
import { calculate, pickPayload, summaryWriter } from "./lib.js";

const MAX_RPS = Number(__ENV.MAX_RPS || 1600);
const STEPS = [0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1].map((f) => Math.round(MAX_RPS * f));

export const options = {
  scenarios: {
    steps: {
      executor: "ramping-arrival-rate",
      startRate: STEPS[0],
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 500,
      // 15s ramp to each step, then a 45s plateau to measure it.
      stages: STEPS.flatMap((rps) => [{ duration: "15s", target: rps }, { duration: "45s", target: rps }]),
    },
  },
  thresholds: {
    // Stress is exploratory: these mark where SLOs break (the knee), they are not pass/fail gates.
    "http_req_duration{name:calculate}": [
      "p(95)<200",
      // Abort only when the service has clearly collapsed, to keep the run short.
      { threshold: "p(95)<2000", abortOnFail: true, delayAbortEval: "30s" },
    ],
    http_req_failed: [{ threshold: "rate<0.10", abortOnFail: true, delayAbortEval: "30s" }],
  },
};

export default function () {
  calculate(pickPayload());
}

export const handleSummary = summaryWriter("stress");
