# Planner run: calculate API (2026-10-03)

- Output: specs/plan-calculate-api.md (51 scenarios: NEG 17, BND 9, EDGE 11, SEC 6, FLOW 6, SMOKE 2).
- Erratum in the plan: the sentence under "Coverage table" that says "38 scenarios" is wrong. The correct total is 51
  (the family table and the last sentence of that section are right). The edit tool was not available to fix it in place.
- Live probing: about 110 POSTs to /api/xmod/calculate in 5 batches over several minutes through browser fetch
  (RateLimit header showed the 120/min budget was never exhausted). The 429 path was not triggered.
- Candidate defects: CD-1 prototype-named class codes give 500 (and 200 on GET /api/classes/constructor); CD-2 string "false"
  flags are truthy; CD-3 accidentDate compared as a string; CD-4 unknown treatment accepted; CD-5 payroll string iterated;
  CD-6 unbounded echo of classCode / accidentId.
- Nothing outside specs/ and docs/agent-runs/ was written. No app code or test code changed.
