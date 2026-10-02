// Load: ramp to 50 VUs over 2 min, hold 3 min, ramp down. A realistic mix of rating requests, ~5% invalid.
//   k6 run perf/load.js
// POST /api/xmod/calculate is rate limited per client IP (default 120/min). Start the target with
// RATE_LIMIT_MAX=1000000 (docker compose and CI already do), or the 429s will fail this test.
import { sleep } from "k6";
import { calculate, get, pickPayload, CORE_THRESHOLDS, summaryWriter } from "./lib.js";

export const options = {
  scenarios: {
    raters: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m", target: 50 },
        { duration: "3m", target: 50 },
        { duration: "30s", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    ...CORE_THRESHOLDS,
    // Valid ratings and expected rejections are reported separately so a slow error path is visible.
    "http_req_duration{name:calculate,expected_error:false}": ["p(95)<200"],
    "http_req_duration{name:calculate,expected_error:true}": ["p(95)<200"],
  },
};

export default function () {
  calculate(pickPayload());
  // ~1 in 5 users also looks up a class code, as the UI's class picker does.
  if (Math.random() < 0.2) get("/api/classes?q=88", "classes");
  // Think time: a person filling the form, 0.5-1.5s between submissions.
  sleep(0.5 + Math.random());
}

export const handleSummary = summaryWriter("load");
