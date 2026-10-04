/**
 * Test data builders. Values are loosely typed on purpose: negative tests need to send wrong types.
 * REF (plan fixture): class 0005, payroll 1,000,000, no claims.
 */
export type Json = Record<string, unknown>;

export const payrollLine = (classCode: unknown = "0005", payroll: unknown = 1_000_000): Json => ({ classCode, payroll });

export const claim = (over: Json = {}): Json => ({ id: "a", indemnity: 0, medical: 0, ...over });

/** A risk with the REF payroll unless `payroll` is given; `extra` adds top-level fields. */
export const risk = (claims: unknown = [], extra: Json = {}, payroll: unknown = [payrollLine()]): Json => ({ payroll, claims, ...extra });

/** REF risk with one claim of the given indemnity (medical 0) and optional claim fields. */
export const withClaim = (indemnity: unknown, over: Json = {}, extra: Json = {}): Json =>
  risk([claim({ indemnity, ...over })], extra);

export const REF = risk();

/** Raw JSON text of REF with an extra top-level fragment, e.g. `"__proto__":{"x":1}`. */
export const refRawWith = (fragment: string) =>
  `{"payroll":[{"classCode":"0005","payroll":1000000}],"claims":[],${fragment}}`;
