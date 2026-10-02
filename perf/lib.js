// Shared payloads, request helpers and summary export for the k6 scenarios.
import http from "k6/http";
import { check } from "k6";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";

export const BASE_URL = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const JSON_HEADERS = { "Content-Type": "application/json" };

// 422 is the API's documented answer to a bad rating input, so it is not an HTTP failure.
// Anything else outside 2xx/3xx still counts towards http_req_failed.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 422));

// ------------------------------------------------------------------ payloads
const claim = (id, indemnity, medical = 0, extra = {}) => ({ id, indemnity, medical, ...extra });

export const PAYLOADS = {
  // E = 20,200 -> mod 0.77 (the reference risk used across the test suites)
  lossFree: { payroll: [{ classCode: "0005", payroll: 1_000_000 }], claims: [] },
  oneClaim: { payroll: [{ classCode: "0005", payroll: 1_000_000 }], claims: [claim("C1", 20_000)] },
  fiveClaims: {
    payroll: [{ classCode: "8810", payroll: 4_000_000 }, { classCode: "5403", payroll: 900_000 }],
    claims: [claim("C1", 1_200, 300), claim("C2", 8_000, 2_500), claim("C3", 45_000, 30_000), claim("C4", 240), claim("C5", 0, 3_100)],
  },
  multiClass: {
    payroll: [
      { classCode: "0005", payroll: 600_000 }, { classCode: "3634", payroll: 450_000 },
      { classCode: "8810", payroll: 1_250_000 }, { classCode: "7707", payroll: 40 },
    ],
    claims: [claim("C1", 3_000, 1_000)],
  },
  subrogation: {
    payroll: [{ classCode: "5403", payroll: 1_500_000 }],
    claims: [claim("S1", 60_000, 15_000, { treatment: "subrogation", netIncurred: 30_000 }), claim("C2", 2_000)],
  },
};

// Deliberately invalid: each must come back 422 with the standard error shape.
export const INVALID = [
  { body: { payroll: [{ classCode: "9999", payroll: 1_000 }], claims: [] }, code: "UNKNOWN_CLASS" },
  { body: { payroll: [{ classCode: "0005", payroll: -5 }], claims: [] }, code: "BAD_PAYROLL" },
  { body: { payroll: [], claims: [] }, code: "NO_PAYROLL" },
  { body: { ...PAYLOADS.lossFree, claims: [claim("A", 1), claim("A", 2)] }, code: "DUPLICATE_CLAIM" },
  { body: { ...PAYLOADS.lossFree, claims: [claim("N", 100, 0, { treatment: "joint", netIncurred: 500 })] }, code: "BAD_NET" },
];

// Weighted mix used by load/stress: ~5% invalid by design.
const MIX = [
  ["lossFree", 25], ["oneClaim", 25], ["fiveClaims", 20], ["multiClass", 15], ["subrogation", 10], ["invalid", 5],
];
const TOTAL = MIX.reduce((s, [, w]) => s + w, 0);
export function pickPayload() {
  let r = Math.random() * TOTAL;
  for (const [name, w] of MIX) {
    if ((r -= w) < 0) return name;
  }
  return MIX[0][0];
}

// ------------------------------------------------------------------ requests
export function calculate(kind) {
  if (kind === "invalid") {
    const bad = INVALID[Math.floor(Math.random() * INVALID.length)];
    const res = http.post(`${BASE_URL}/api/xmod/calculate`, JSON.stringify(bad.body), {
      headers: JSON_HEADERS, tags: { name: "calculate", payload: "invalid", expected_error: "true" },
    });
    check(res, {
      "invalid payload -> 422": (r) => r.status === 422,
      "invalid payload -> expected error code": (r) => jsonPath(r, "error.code") === bad.code,
      "invalid payload -> no mod in body": (r) => jsonPath(r, "mod") === undefined,
    }, { payload: "invalid" });
    return res;
  }
  const res = http.post(`${BASE_URL}/api/xmod/calculate`, JSON.stringify(PAYLOADS[kind]), {
    headers: JSON_HEADERS, tags: { name: "calculate", payload: kind, expected_error: "false" },
  });
  check(res, {
    "calculate -> 200": (r) => r.status === 200,
    "calculate -> mod is a positive number": (r) => typeof jsonPath(r, "mod") === "number" && jsonPath(r, "mod") > 0,
  }, { payload: kind });
  return res;
}

export function get(path, name, expectStatus = 200) {
  const params = { tags: { name, expected_error: String(expectStatus >= 400) } };
  // A deliberate 404 probe is a passing request, not an HTTP failure.
  if (expectStatus >= 400) params.responseCallback = http.expectedStatuses(expectStatus);
  const res = http.get(`${BASE_URL}${path}`, params);
  check(res, { [`${name} -> ${expectStatus}`]: (r) => r.status === expectStatus });
  return res;
}

function jsonPath(res, path) {
  try {
    return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), res.json());
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ thresholds and summary
export const CORE_THRESHOLDS = {
  // Failures = transport errors and unexpected statuses. Expected 422s are excluded by the response callback.
  http_req_failed: ["rate<0.01"],
  "http_req_duration{name:calculate}": ["p(95)<200", "p(99)<500"],
  checks: ["rate>0.99"],
};

/** Print the normal text summary and write the full summary JSON to perf/results/. */
export function summaryWriter(scenario) {
  return (data) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const json = JSON.stringify(data, null, 2);
    return {
      stdout: textSummary(data, { indent: " ", enableColors: true }),
      [`perf/results/${scenario}-${stamp}.json`]: json,
      [`perf/results/${scenario}-latest.json`]: json,
    };
  };
}
