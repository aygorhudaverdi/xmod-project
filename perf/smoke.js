// Smoke: 1 VU for 30s across every endpoint. Proves the scripts and the deployment work; not a load test.
//   k6 run perf/smoke.js                       (BASE_URL defaults to http://localhost:3000)
// Needs the target started with RATE_LIMIT_MAX raised (e.g. 1000000): smoke sends ~330 calculations/min.
import { group, sleep } from "k6";
import { calculate, get, CORE_THRESHOLDS, summaryWriter, PAYLOADS } from "./lib.js";

export const options = {
  vus: 1,
  duration: "30s",
  thresholds: CORE_THRESHOLDS,
};

let i = 0;
export default function () {
  group("reference data", () => {
    get("/api/health", "health");
    get("/api/plan", "plan");
    get("/api/classes?q=00", "classes");
    get("/api/classes/0005", "class");
    get("/api/classes/9999", "class-unknown", 404);
  });
  group("calculate", () => {
    for (const kind of Object.keys(PAYLOADS)) calculate(kind);
    // Every other iteration also sends one random invalid payload (expects 422).
    if (i++ % 2 === 0) calculate("invalid");
  });
  group("ui and metrics", () => {
    get("/", "ui");
    get("/metrics", "metrics");
  });
  sleep(1);
}

export const handleSummary = summaryWriter("smoke");
