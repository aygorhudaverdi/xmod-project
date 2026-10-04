import { expect } from "@playwright/test";
import type { Reply } from "../pages/ApiClient";

/** Error contract: JSON content type, exactly {error:{code,message}}, no stack trace, no result fields. */
export function expectErrorShape(r: Reply) {
  expect(r.headers["content-type"]).toContain("application/json");
  expect(Object.keys(r.json ?? {})).toEqual(["error"]);
  expect(Object.keys(r.json.error).sort()).toEqual(["code", "message"]);
  expect(typeof r.json.error.message).toBe("string");
  expect(r.text).not.toMatch(/node_modules|\n\s+at |<html|TypeError|C:\\|\.ts:/);
}

export function expectError(r: Reply, status: number, code: string) {
  expect(r.status).toBe(status);
  expectErrorShape(r);
  expect(r.json.error.code).toBe(code);
}

/** Any 4xx JSON error with a non-empty code. */
export function expectClientError(r: Reply) {
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(r.status).toBeLessThan(500);
  expectErrorShape(r);
  expect(r.json.error.code).toBeTruthy();
}

export const claimOf = (r: Reply, i = 0) => r.json.claims[i];
