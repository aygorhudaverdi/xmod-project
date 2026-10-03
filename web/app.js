import { STORIES } from "./stories.js";
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---- tabs
const tabs = [["calc", "panel-calc"], ["stories", "panel-stories"], ["dash", "panel-dash"], ["reference", "panel-reference"]];
function selectTab(k) {
  for (const [k2, p2] of tabs) {
    const t = $(`#tab-${k2}`);
    t.setAttribute("aria-selected", String(k2 === k));
    t.tabIndex = k2 === k ? 0 : -1; // roving tabindex: Tab moves into the panel, arrows move between tabs
    $(`#${p2}`).hidden = k2 !== k;
  }
  dashboard.setActive(k === "dash");
  if (k === "reference") reference.load();
}
for (const [k] of tabs) {
  $(`#tab-${k}`).addEventListener("click", () => selectTab(k));
  // WAI-ARIA tabs pattern: Left/Right wrap around, Home/End jump; selection follows focus.
  $(`#tab-${k}`).addEventListener("keydown", (e) => {
    const i = tabs.findIndex(([k2]) => k2 === k);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const [nk] = tabs[(next + tabs.length) % tabs.length];
    selectTab(nk);
    $(`#tab-${nk}`).focus();
  });
}

// ---- stories
$("#stories").innerHTML = STORIES.map((s) => `
  <div class="story" data-testid="story-${s.id}"><h3>${s.id} — ${esc(s.title)}</h3><p>${esc(s.story)}</p>
  <ul>${s.ac.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>`).join("");

// ---- class reference data: datalist, ELR hint and per-capita labelling
fetch("/api/classes").then((r) => r.json()).then((list) => {
  $("#class-list").innerHTML = list.map((c) => `<option value="${esc(c.classCode)}">`).join("");
}).catch(() => {});
const classCache = new Map();
function lookupClass(code) {
  if (!/^\d{4}$/.test(code)) return Promise.resolve(null);
  if (!classCache.has(code)) {
    classCache.set(code, fetch(`/api/classes/${code}`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return classCache.get(code);
}

// ---- worksheet vocabulary
const INJURY_TYPES = [
  ["death", "Death"],
  ["ptd", "Permanent Total Disability"],
  ["major-ppd", "Major Permanent Partial Disability"],
  ["minor-ppd", "Minor Permanent Partial Disability"],
  ["ttd", "Temporary Total or Temporary Partial Disability"],
  ["med-only", "Medical Only Claim"],
  ["contract-medical", "Contract Medical or Hospital Allowances"],
  ["s-claim", 'Compromised Death or "S" Claim'],
];
const injuryLabel = (v) => (INJURY_TYPES.find(([k]) => k === v) ?? [, v])[1];
const OPEN_CLOSED_HELP = "Informational only: open or closed status does not change the calculation.";
const ACTUAL_LOSSES_HELP = "Total claim value as of the last valuation date (medical + indemnity). The Plan limits it to the $175,000 Maximum Loss Value in the calculation.";
const ACTUAL_PRIMARY_HELP = "Portion of the claim up to the risk's Primary Threshold, less $250. Depends on total expected losses, so it needs payroll first.";

// ---- payroll rows
let seq = 0;
let uid = 0; // unique per row, so every <label for> points at exactly one control
function addPayroll({ year = "", code = "", payroll = "" } = {}) {
  const u = `p${++uid}`;
  const tr = document.createElement("tr");
  tr.className = "payroll-line"; tr.dataset.testid = "payroll-row";
  tr.innerHTML = `
    <td><label class="sr-only" for="${u}-yr">Policy year</label><input id="${u}-yr" data-field="policyYear" data-testid="policy-year" inputmode="numeric" maxlength="9" value="${esc(year)}"></td>
    <td><label class="sr-only" for="${u}-code">Class code</label><input id="${u}-code" list="class-list" data-field="classCode" data-testid="class-code" inputmode="numeric" maxlength="4" value="${esc(code)}"></td>
    <td><label class="sr-only" for="${u}-pay" data-testid="payroll-label">Payroll ($)</label><input id="${u}-pay" data-field="payroll" data-testid="payroll" inputmode="decimal" placeholder="dollars" value="${esc(payroll)}"></td>
    <td class="hint" data-testid="elr-hint" aria-live="polite"></td>
    <td><button class="btn x" type="button" aria-label="Remove class" data-testid="remove-payroll">✕</button></td>`;
  $(".x", tr).onclick = () => { tr.remove(); schedulePreview(); };
  const codeInput = $("[data-field=classCode]", tr);
  const refresh = async () => {
    const code = codeInput.value.trim();
    const info = await lookupClass(code);
    if (codeInput.value.trim() !== code) return; // a newer keystroke wins
    const perUnit = !!info?.perUnitBasis;
    $("[data-testid=payroll-label]", tr).textContent = perUnit ? "Units (per capita)" : "Payroll ($)";
    $("[data-field=payroll]", tr).placeholder = perUnit ? "units" : "dollars";
    $("[data-testid=elr-hint]", tr).textContent = !code ? "" : !info ? (code.length === 4 ? "Unknown class" : "")
      : perUnit ? `${info.elr} per unit (per capita)` : `${info.elr} per $100 payroll`;
  };
  codeInput.addEventListener("input", refresh);
  $("#payroll-rows").append(tr);
  if (code) refresh();
}

// ---- claim rows: one <tbody> per claim (main row + extras row), so per-claim test ids stay scoped
function addClaim(c = {}) {
  seq++;
  const u = `c${++uid}`;
  const tb = document.createElement("tbody");
  tb.className = "claim"; tb.dataset.testid = "claim-row";
  const opt = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? "selected" : ""}>${esc(l)}</option>`).join("");
  tb.innerHTML = `
    <tr>
      <td><label class="sr-only" for="${u}-id">Claim number</label><input id="${u}-id" data-field="id" data-testid="claim-id" maxlength="100" value="${esc(c.id ?? "C" + seq)}"></td>
      <td><label class="sr-only" for="${u}-inj">Injury type</label><select id="${u}-inj" data-field="injury" data-testid="injury-type">${opt(INJURY_TYPES, c.injury ?? "ttd")}</select></td>
      <td><label class="sr-only" for="${u}-oc">Open or closed</label><select id="${u}-oc" data-field="status" data-testid="open-closed" title="${OPEN_CLOSED_HELP}">${opt([["Open", "Open"], ["Closed", "Closed"]], c.status ?? "Open")}</select></td>
      <td><label class="sr-only" for="${u}-al">Actual Losses ($)</label><input id="${u}-al" data-field="actualLosses" data-testid="actual-losses" inputmode="decimal" title="${esc(ACTUAL_LOSSES_HELP)}" value="${esc(c.actualLosses ?? "")}"></td>
      <td class="n ap-cell" data-testid="actual-primary-input-row" aria-live="polite" title="${esc(ACTUAL_PRIMARY_HELP)}">—</td>
      <td><button class="btn x" type="button" aria-label="Remove claim" data-testid="remove-claim">✕</button></td>
    </tr>
    <tr class="claim-extra">
      <td colspan="6">
        <span class="extra" data-show="net" hidden><label for="${u}-net">Net incurred ($)</label><input id="${u}-net" data-field="netIncurred" data-testid="net-incurred" inputmode="decimal" value="${esc(c.netIncurred ?? "")}"></span>
        <span class="extra" data-show="cm" hidden><label for="${u}-cm">Class</label><input id="${u}-cm" data-field="cmClass" data-testid="cm-class" list="class-list" inputmode="numeric" maxlength="4" value="${esc(c.cmClass ?? "")}"></span>
        <details class="special" data-testid="special-handling" ${c.open ? "open" : ""}>
          <summary>Special handling</summary>
          <div class="special-body">
            <span class="extra"><label for="${u}-tr">Treatment</label><select id="${u}-tr" data-field="treatment" data-testid="treatment" class="auto">${opt([["none", "none"], ["subrogation", "subrogation"], ["fraud", "fraud"], ["joint", "joint coverage"]], c.treatment ?? "none")}</select></span>
            <label><input type="checkbox" data-field="nonCompensable" data-testid="non-compensable" ${c.nonCompensable ? "checked" : ""}> Non-compensable</label>
            <label><input type="checkbox" data-field="elAndWc" data-testid="el-wc" ${c.elAndWc ? "checked" : ""}> EL + WC</label>
            <span class="extra"><label for="${u}-acc">Accident id (multi-person)</label><input id="${u}-acc" data-field="accidentId" data-testid="accident-id" class="accident" value="${esc(c.accidentId ?? "")}"></span>
          </div>
        </details>
      </td>
    </tr>`;
  const g = (f) => $(`[data-field=${f}]`, tb);
  const sync = () => {
    const injury = g("injury").value;
    const sClaim = injury === "s-claim";
    const cm = injury === "contract-medical";
    // "S" claims are compromised deaths: their treatment is fixed, so the treatment picker is locked.
    g("treatment").disabled = sClaim;
    g("treatment").title = sClaim ? 'Fixed to "compromise" for a Compromised Death or "S" Claim' : "";
    $("[data-show=net]", tb).hidden = !(sClaim || (!cm && g("treatment").value !== "none"));
    $("[data-show=cm]", tb).hidden = !cm;
    $("details.special", tb).hidden = cm; // contract medical is valued by class D-ratio; no claim exceptions apply
  };
  g("injury").addEventListener("change", sync);
  g("treatment").addEventListener("change", sync);
  $(".x", tb).onclick = () => { tb.remove(); schedulePreview(); };
  $("#claim-rows").append(tb);
  sync();
  schedulePreview();
}
$("#add-payroll").onclick = () => addPayroll();
$("#add-claim").onclick = () => addClaim();

// ---- sample risks (fictional)
const SAMPLES = [
  ["loss-free", "Loss-free", { payroll: [["2024", "0005", 1_000_000]], claims: [] }],
  ["two-small", "Two small claims", { payroll: [["2024", "0005", 1_000_000]], claims: [
    { id: "C-1001", injury: "ttd", status: "Closed", actualLosses: 1_000 }, { id: "C-1002", injury: "med-only", status: "Closed", actualLosses: 1_000 }] }],
  ["one-large", "One large claim (cap applies)", { payroll: [["2024", "0005", 1_000_000]], claims: [
    { id: "C1", injury: "major-ppd", status: "Open", actualLosses: 20_000 }] }],
  ["death", "Death claim", { payroll: [["2024", "0005", 3_000_000]], claims: [
    { id: "D-2001", injury: "death", status: "Open", actualLosses: 250_000 }] }],
  ["per-capita", "Per-capita class 7707", { payroll: [["2024", "7707", 100]], claims: [] }],
];
$("#sample-select").innerHTML = SAMPLES.map(([k, l]) => `<option value="${k}" ${k === "one-large" ? "selected" : ""}>${esc(l)}</option>`).join("");

function reset() {
  $("#payroll-rows").innerHTML = ""; $("#claim-rows").querySelectorAll("tbody.claim").forEach((t) => t.remove()); seq = 0;
  for (const id of ["employer", "policy-number", "effective-date", "issue-date"]) $(`#${id}`).value = "";
  $("#prior-rated").checked = false; $("#excl-unaudited").checked = false;
  $("#result").innerHTML = `<h2>Experience rating worksheet</h2><p class="note" id="placeholder">Enter payroll and claims, then calculate.</p>`;
  addPayroll();
}
$("#reset").onclick = reset;
$("#load-sample").onclick = () => {
  const [, label, s] = SAMPLES.find(([k]) => k === $("#sample-select").value);
  reset(); $("#payroll-rows").innerHTML = "";
  $("#employer").value = `Sample employer: ${label}`;
  $("#policy-number").value = "SAMPLE-0001";
  for (const [year, code, payroll] of s.payroll) addPayroll({ year, code, payroll });
  for (const c of s.claims) addClaim(c);
};

// ---- collect: worksheet entry -> unchanged engine contract
const numOrUndef = (v) => (v === "" ? undefined : Number(v));
function collect() {
  const lines = [...document.querySelectorAll("#payroll-rows tr.payroll-line")].map((r) => ({
    policyYear: $("[data-field=policyYear]", r).value.trim(),
    classCode: $("[data-field=classCode]", r).value.trim(), payroll: Number($("[data-field=payroll]", r).value || 0),
  }));
  const claims = [];
  const contractMedical = [];
  const meta = { byId: new Map(), contractMedical: [], accidentTyped: new Map() }; // display-only data the engine does not take
  for (const tb of document.querySelectorAll("#claim-rows tbody.claim")) {
    const g = (f) => $(`[data-field=${f}]`, tb);
    const injury = g("injury").value;
    const number = g("id").value.trim();
    const typed = Number(g("actualLosses").value || 0); // indemnity + medical as entered, before Plan limits
    const info = { number, injury: injuryLabel(injury), status: g("status").value, typed };
    if (injury === "contract-medical") {
      contractMedical.push({ classCode: g("cmClass").value.trim(), incurred: typed });
      meta.contractMedical.push(info);
      continue;
    }
    const claim = { id: number, indemnity: typed, medical: 0 }; // one Actual Losses field: sent as indemnity, medical 0
    if (injury === "death") claim.death = true;
    if (injury === "s-claim") Object.assign(claim, { death: true, treatment: "compromise", netIncurred: numOrUndef(g("netIncurred").value) });
    else if (g("treatment").value !== "none") Object.assign(claim, { treatment: g("treatment").value, netIncurred: numOrUndef(g("netIncurred").value) });
    if (g("nonCompensable").checked) claim.nonCompensable = true;
    if (g("elAndWc").checked) claim.elAndWc = true;
    const accidentId = g("accidentId").value.trim();
    if (accidentId) {
      Object.assign(claim, { accidentId, multiPerson: true });
      meta.accidentTyped.set(accidentId, (meta.accidentTyped.get(accidentId) ?? 0) + typed);
    }
    claims.push(claim);
    meta.byId.set(number, info);
  }
  const body = {
    payroll: lines.map(({ classCode, payroll }) => ({ classCode, payroll })), claims,
    ...(contractMedical.length ? { contractMedical } : {}),
    priorYearExperienceRated: $("#prior-rated").checked, excludedUnauditedPayroll: $("#excl-unaudited").checked,
  };
  const heading = {
    employer: $("#employer").value.trim(), policy: $("#policy-number").value.trim(),
    effective: $("#effective-date").value, issued: $("#issue-date").value,
  };
  return { body, lines, meta, heading };
}

$("#calculate").onclick = async () => {
  const box = $("#result");
  box.setAttribute("aria-busy", "true");
  try {
    const { body: payload, lines, meta, heading } = collect();
    const res = await fetch("/api/xmod/calculate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const body = await res.json();
    if (!res.ok) {
      fillPrimaryCells(null);
      box.innerHTML = `<h2>Experience rating worksheet</h2><div class="err" role="alert" data-testid="error"><b data-testid="error-code">${esc(body.error.code)}</b>: <span data-testid="error-message">${esc(body.error.message)}</span></div>`;
      return;
    }
    render(box, body, { lines, meta, heading });
    fillPrimaryCells(body);
  } catch {
    box.innerHTML = `<h2>Experience rating worksheet</h2><div class="err" role="alert" data-testid="error">Could not reach the server.</div>`;
  } finally { box.removeAttribute("aria-busy"); }
};

// ---- live Actual Primary Losses in the entry table
// Debounced and silent: an incomplete or invalid form just shows "—". Only the Calculate button reports errors.
// Each preview is a normal POST /api/xmod/calculate, so it also counts toward that endpoint's rate limit and metrics.
const PREVIEW_DELAY_MS = 300;
let previewTimer = null;
let previewSeq = 0;
let lastPreviewKey = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, PREVIEW_DELAY_MS);
}
async function runPreview() {
  if (!document.querySelector("#claim-rows tbody.claim")) return; // nothing to fill
  const { body } = collect();
  if (!body.payroll.some((p) => p.payroll > 0)) { lastPreviewKey = null; return fillPrimaryCells(null); }
  const key = JSON.stringify(body);
  if (key === lastPreviewKey) return;
  const mine = ++previewSeq;
  let r = null;
  try {
    const res = await fetch("/api/xmod/calculate", { method: "POST", headers: { "content-type": "application/json" }, body: key });
    if (res.ok) r = await res.json();
  } catch { /* offline or server error: fall through to "—" */ }
  if (mine !== previewSeq) return; // a newer preview superseded this one
  lastPreviewKey = r ? key : null;
  fillPrimaryCells(r);
}
/** Fill each claim row's Actual Primary cell from a calculate response (null = not calculable). */
function fillPrimaryCells(r) {
  const cmLines = r ? r.claims.filter((c) => c.id.startsWith("contract-medical:")) : [];
  const byId = new Map(r ? r.claims.map((c) => [c.id, c]) : []);
  const seenAccidents = new Set();
  let cmi = 0;
  for (const tb of document.querySelectorAll("#claim-rows tbody.claim")) {
    const cell = $("[data-testid=actual-primary-input-row]", tb);
    const g = (f) => $(`[data-field=${f}]`, tb);
    if (!r) { cell.textContent = "—"; continue; }
    let line;
    if (g("injury").value === "contract-medical") {
      line = cmLines[cmi++];
    } else if (g("accidentId").value.trim()) {
      // A multi-person accident is one combined, capped line: show it once, on the group's first row.
      const acc = g("accidentId").value.trim();
      if (seenAccidents.has(acc)) { cell.textContent = "(included above)"; continue; }
      seenAccidents.add(acc);
      line = r.claims.find((c) => c.id.startsWith(`accident:${acc} (`));
    } else {
      line = byId.get(g("id").value.trim());
    }
    cell.textContent = line ? money(line.actualPrimary) : "—";
  }
}
for (const sel of ["#payroll-rows", "#claim-rows", "#prior-rated", "#excl-unaudited"]) {
  $(sel).addEventListener("input", schedulePreview);
  $(sel).addEventListener("change", schedulePreview);
}

// ---- render: worksheet layout
const dash = (v) => (v ? esc(v) : "—");
const fmtDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "");
const num = (n, col) => `<td class="n"${col ? ` data-col="${col}"` : ""}>${money(n)}</td>`;

function render(box, r, { lines, meta, heading }) {
  // Payroll summary. r.classes is index-aligned with the payroll lines sent.
  const classRows = r.classes.map((c, i) => ({ c, year: lines[i]?.policyYear ?? "" }));
  const grouped = classRows.some((x) => x.year);
  if (grouped) classRows.sort((a, b) => String(a.year).localeCompare(String(b.year)));
  let lastYear = null;
  const payrollBody = classRows.map(({ c, year }) => {
    const head = grouped && year !== lastYear
      ? `<tr class="group" data-testid="policy-year-group"><th scope="rowgroup" colspan="7">Policy year ${dash(year)}</th></tr>` : "";
    lastYear = year;
    const payroll = c.perUnitBasis ? `${Number(c.payroll).toLocaleString("en-US")} units` : `$${Number(c.payroll).toLocaleString("en-US")}`;
    return `${head}<tr data-testid="class-row"><th scope="row">${esc(c.classCode)}</th><td class="n" data-col="payroll">${esc(payroll)}</td>
      <td class="n">${esc(c.elr)}</td>${num(c.expectedLosses, "expected")}<td class="n">${esc(c.dRatio)}</td>${num(c.expectedPrimary, "ep")}${num(c.expectedExcess, "ee")}</tr>`;
  }).join("");

  // Claims summary: engine order is plain claims, then grouped multi-person accidents, then contract medical.
  let cm = 0;
  const claimRows = r.claims.map((c) => {
    let info = meta.byId.get(c.id);
    if (!info && c.id.startsWith("contract-medical:")) info = meta.contractMedical[cm++];
    if (!info && c.id.startsWith("accident:")) {
      const acc = c.id.slice("accident:".length, c.id.lastIndexOf(" ("));
      info = { number: c.id, injury: "Multi-person accident", status: "", typed: meta.accidentTyped.get(acc) };
    }
    info ??= { number: c.id, injury: "", status: "" };
    // The worksheet shows Plan-valued Actual Losses (MLV cap, Average Death Value, net/gross ratio, exclusions),
    // which can differ from the amount entered; say so on the row instead of silently showing another number.
    const limited = info.typed !== undefined && Math.round(info.typed * 100) !== Math.round(c.actualLosses * 100);
    const rule = limited
      ? `<span class="rule limit-note" data-testid="plan-limit-note" title="Entered ${money(info.typed)}">Limited by Plan rule: <span data-testid="claim-rule">${esc(c.rule)}</span></span>`
      : `<span class="rule" data-testid="claim-rule" title="Plan rule applied">${esc(c.rule)}</span>`;
    return `<tr data-testid="claim-result"><th scope="row"><span data-testid="claim-number">${esc(info.number)}</span>${rule}</th>
      <td>${esc(info.injury)}</td><td>${esc(info.status)}</td>${num(c.actualLosses, "al")}${num(c.actualPrimary, "ap")}${num(c.actualExcess, "ax")}</tr>`;
  }).join("") || `<tr><td colspan="6" class="note">No claims in the experience period.</td></tr>`;

  const capNote = r.capApplied
    ? `<p class="note" data-testid="cap-explanation">Only one claim has Actual Primary above $0, so the modification is limited to the loss-free rating plus 25 points (${esc(r.lossFreeModUnrounded)} + 0.25). Formula result before the limit: ${esc(r.modBeforeCap)}.</p>` : "";

  box.innerHTML = `
    <h2>Experience rating worksheet</h2>
    <div class="ws-head" data-testid="ws-heading">
      <dl class="ws-meta">
        <dt>Employer</dt><dd data-testid="ws-employer">${dash(heading.employer)}</dd>
        <dt>Policy number</dt><dd data-testid="ws-policy">${dash(heading.policy)}</dd>
        <dt>Effective date</dt><dd data-testid="ws-effective">${dash(fmtDate(heading.effective))}</dd>
        <dt>Issue date</dt><dd data-testid="ws-issued">${dash(fmtDate(heading.issued))}</dd>
      </dl>
      <div class="pt-box" data-testid="primary-threshold"><span class="kpi-label">Primary Threshold</span><a class="kpi-value pt-link" href="#table2" data-testid="pt-link" data-threshold="${r.primaryThreshold}" data-expected="${r.expectedLosses}" title="Show this band in Table II"><span data-testid="pt">${money(r.primaryThreshold)}</span></a></div>
    </div>

    <h3 class="sub">Summary of Payroll and Expected Losses</h3>
    <div class="table-wrap"><table data-testid="class-table">
      <thead><tr><th scope="col">Class</th><th scope="col" class="n">Payroll</th><th scope="col" class="n">Expected Loss Rate</th><th scope="col" class="n">Expected Losses</th><th scope="col" class="n">D-Ratio</th><th scope="col" class="n">Expected Primary</th><th scope="col" class="n">Expected Excess</th></tr></thead>
      <tbody>${payrollBody}</tbody>
      <tfoot><tr class="totals" data-testid="totals-row" data-table="payroll"><th scope="row">Total</th><td></td><td></td>${num(r.expectedLosses, "expected")}<td></td>${num(r.expectedPrimary, "ep")}${num(r.expectedExcess, "ee")}</tr></tfoot>
    </table></div>

    <h3 class="sub">Summary of Claims and Actual Losses</h3>
    <div class="table-wrap"><table data-testid="claim-table">
      <thead><tr><th scope="col">Claim number</th><th scope="col">Injury type</th><th scope="col">Open/Closed</th><th scope="col" class="n">Actual Losses</th><th scope="col" class="n">Actual Primary</th><th scope="col" class="n">Actual Excess</th></tr></thead>
      <tbody>${claimRows}</tbody>
      <tfoot><tr class="totals" data-testid="totals-row" data-table="claims"><th scope="row">Total</th><td></td><td></td>${num(r.actualLosses, "al")}${num(r.actualPrimary, "ap")}${num(r.actualExcess, "ax")}</tr></tfoot>
    </table></div>

    <h3 class="sub">Experience Period Totals</h3>
    <div class="table-wrap"><table data-testid="period-totals">
      <thead><tr><th scope="col" class="n">Expected</th><th scope="col" class="n">Expected Primary</th><th scope="col" class="n">Expected Excess</th><th scope="col" class="n">Actual</th><th scope="col" class="n">Actual Primary</th><th scope="col" class="n">Actual Excess</th></tr></thead>
      <tbody><tr><td class="n" data-testid="e">${money(r.expectedLosses)}</td><td class="n" data-testid="ep">${money(r.expectedPrimary)}</td><td class="n" data-testid="ee">${money(r.expectedExcess)}</td>
        <td class="n" data-testid="al">${money(r.actualLosses)}</td><td class="n" data-testid="ap">${money(r.actualPrimary)}</td><td class="n" data-testid="ax">${money(r.actualExcess)}</td></tr></tbody>
    </table></div>

    <div class="mod-row">
      <div class="mod-block" data-testid="experience-modification">
        <span class="kpi-label">Experience Modification</span>
        <div class="mod" data-testid="mod">${r.mod.toFixed(2)} <small>(${Math.round(r.mod * 100)}%)</small></div>
      </div>
      <div class="mod-block" data-testid="loss-free-rating">
        <span class="kpi-label">Loss-Free Rating</span>
        <div class="mod mod-sm" data-testid="loss-free">${r.lossFreeMod.toFixed(2)}</div>
      </div>
    </div>
    <p>
      <span class="pill ${r.eligible ? "ok" : "bad"}" data-testid="eligibility">${r.eligible ? "Eligible" : "Not eligible"}</span>
      ${r.capApplied ? `<span class="pill warn" data-testid="cap-applied">25-point cap applied</span>` : ""}
      <span class="note" data-testid="eligibility-reason">${esc(r.eligibilityReason)}</span>
    </p>
    ${capNote}
    <details class="explain" data-testid="calc-explain">
      <summary>How this was calculated</summary>
      <p>Experience Modification = (Actual Primary + Expected Excess) ÷ Expected<br>
        = (${money(r.actualPrimary)} + ${money(r.expectedExcess)}) ÷ ${money(r.expectedLosses)} = <span data-testid="mod-before-cap">${esc(r.modBeforeCap)}</span></p>
      ${r.capApplied ? `<p>Limited by the 25-point cap to <span data-testid="mod-unrounded">${esc(r.modUnrounded)}</span>.</p>` : `<p class="sr-only"><span data-testid="mod-unrounded">${esc(r.modUnrounded)}</span></p>`}
      <p>Loss-Free Rating = Expected Excess ÷ Expected = ${money(r.expectedExcess)} ÷ ${money(r.expectedLosses)} = ${esc(r.lossFreeModUnrounded)}</p>
      <p class="note">Published values are rounded to 2 decimals, half-up. That rounding rule is an assumption; the Plan pages read do not state it. Line amounts are rounded to cents, while totals come from unrounded values, so a total can differ from the sum of its lines by a cent.</p>
    </details>`;
}
reset();

// ---- quality dashboard
const fmtInt = (n) => Number(n).toLocaleString("en-US");
const fmtUptime = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h ? `${h}h ` : ""}${String(m).padStart(h ? 2 : 1, "0")}m ${String(sec).padStart(2, "0")}s`;
};
const GRAFANA_DEFAULT = "http://localhost:3001";

function createDashboard() {
  const REFRESH_MS = 5000;
  let active = false, paused = false, timer = null;

  // Grafana link: ?grafana=<url> overrides and is remembered; otherwise the server's GRAFANA_URL, else the default.
  let grafanaOverride = null;
  try {
    const q = new URLSearchParams(location.search).get("grafana");
    if (q && /^https?:\/\//.test(q)) localStorage.setItem("xmod.grafanaUrl", q);
    grafanaOverride = localStorage.getItem("xmod.grafanaUrl");
  } catch { /* storage unavailable: fall back to server/default */ }
  const setGrafana = (url) => { $("#grafana-link").href = grafanaOverride || url || GRAFANA_DEFAULT; };
  setGrafana(null);

  async function refreshStats() {
    try {
      const res = await fetch("/api/stats", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const s = await res.json();
      $("#dash-total-requests").textContent = fmtInt(s.totalRequests);
      $("#dash-calc-ok").textContent = fmtInt(s.calculations.ok);
      $("#dash-calc-invalid").textContent = fmtInt(s.calculations.validation_error);
      $("#dash-calc-error").textContent = fmtInt(s.calculations.server_error);
      $("#dash-p95").textContent = s.latency.p95Ms === null ? "–" : `${s.latency.p95Ms} ms`;
      $("#dash-uptime").textContent = fmtUptime(s.uptimeSeconds);
      $("#dash-mod-mean").textContent = s.mods.count ? `(${fmtInt(s.mods.count)} mods, mean ${s.mods.mean.toFixed(3)})` : "(none yet)";
      renderModRows(s.mods);
      setGrafana(s.links?.grafana);
      const now = new Date();
      $("#dash-updated").textContent = now.toLocaleTimeString("en-US", { hour12: false });
      $("#dash-updated").dateTime = now.toISOString();
      $("#dash-status").textContent = "";
    } catch {
      $("#dash-status").textContent = "Could not load stats; retrying.";
    }
  }

  function renderModRows(mods) {
    const tbody = $("#dash-mod-rows");
    tbody.replaceChildren();
    const max = Math.max(1, ...mods.buckets.map((b) => b.count));
    for (const b of mods.buckets) {
      const tr = document.createElement("tr");
      tr.dataset.testid = "dash-mod-bucket";
      const range = document.createElement("td"); range.textContent = b.le;
      const count = document.createElement("td"); count.className = "n"; count.textContent = fmtInt(b.count);
      const barCell = document.createElement("td"); barCell.className = "bar-cell";
      const bar = document.createElement("div"); bar.className = "bar";
      bar.style.width = `${(b.count / max) * 100}%`; // CSSOM, not a style attribute, so the CSP allows it
      barCell.append(bar);
      tr.append(range, count, barCell);
      tbody.append(tr);
    }
  }

  async function refreshTestResults() {
    const box = $("#test-results-body");
    try {
      const r = await (await fetch("/api/test-results", { cache: "no-store" })).json();
      if (!r.available) {
        box.innerHTML = `<p class="note" data-testid="test-results-empty">${esc(r.message ?? "No test results yet.")}</p>`;
        return;
      }
      const rows = Object.entries(r.projects).map(([name, c]) => `
        <tr data-testid="test-results-project" data-project="${esc(name)}"><td>${esc(name)}</td>
        <td class="n" data-testid="tr-passed">${c.passed}</td><td class="n" data-testid="tr-failed">${c.failed}</td>
        <td class="n" data-testid="tr-flaky">${c.flaky}</td><td class="n" data-testid="tr-skipped">${c.skipped}</td><td class="n">${c.total}</td></tr>`).join("");
      const when = r.startTime ? `Run started ${esc(new Date(r.startTime).toLocaleString("en-US"))}` : "Last run";
      const dur = r.durationMs != null ? `, took ${(r.durationMs / 1000).toFixed(1)} s` : "";
      const failed = r.failed.length
        ? `<h3 class="sub">Failed tests (${r.failed.length})</h3><ol class="fail-list" data-testid="test-results-failed">${r.failed.map((f) => `
            <li data-testid="failed-test"><b>[${esc(f.project)}]</b> ${esc(f.title)} <span class="note">${esc(f.file)}:${Number(f.line)}</span><br><code>${esc(f.error)}</code></li>`).join("")}</ol>`
        : `<p data-testid="test-results-all-passed">No failed tests.</p>`;
      box.innerHTML = `<p class="note">${when}${dur}. Source: Playwright JSON reporter (<code>test-results/results.json</code>).</p>
        <table data-testid="test-results-table"><thead><tr><th scope="col">Project</th><th scope="col" class="n">Passed</th><th scope="col" class="n">Failed</th><th scope="col" class="n">Flaky</th><th scope="col" class="n">Skipped</th><th scope="col" class="n">Total</th></tr></thead>
        <tbody>${rows}</tbody></table>${failed}`;
    } catch {
      box.innerHTML = `<p class="note" data-testid="test-results-error">Could not load test results.</p>`;
    }
  }

  const tick = () => { refreshStats(); refreshTestResults(); };
  function schedule() {
    clearInterval(timer); timer = null;
    if (active && !paused) { tick(); timer = setInterval(tick, REFRESH_MS); }
  }
  $("#dash-pause").onclick = () => {
    paused = !paused;
    $("#dash-pause").setAttribute("aria-pressed", String(paused));
    $("#dash-pause").textContent = paused ? "Resume auto-refresh" : "Pause auto-refresh";
    schedule();
  };
  return { setActive(on) { if (on !== active) { active = on; schedule(); } } };
}
const dashboard = createDashboard();

// ---- reference tables: Table II
const whole = (n) => Number(n).toLocaleString("en-US");
function createReference() {
  let loaded = null; // promise, so concurrent callers share one fetch
  let timer = null;
  let seqNo = 0;

  function load() {
    loaded ??= fetch("/api/table2").then((r) => r.json()).then((t) => {
      $("#mlv").textContent = `$${whole(t.maximumLossValue)}`;
      $("#adv").textContent = `$${whole(t.averageDeathValue)}`;
      $("#table2-body").innerHTML = t.bands.map((b) => `
        <tr data-testid="table2-row" data-threshold="${b.threshold}" data-min="${b.min}">
          <th scope="row" class="n">${whole(b.min)}</th><td class="n">${b.max === null ? "and over" : whole(b.max)}</td><td class="n">${whole(b.threshold)}</td></tr>`).join("");
    }).catch((err) => {
      console.error("Table II failed to load", err); // network or code error: keep it visible to developers
      loaded = null;
      $("#table2-body").innerHTML = `<tr><td colspan="3" class="note">Could not load Table II.</td></tr>`;
    });
    return loaded;
  }

  function highlight(threshold) {
    let current = null;
    for (const tr of document.querySelectorAll("#table2-body tr[data-testid=table2-row]")) {
      const on = Number(tr.dataset.threshold) === threshold;
      if (on) { tr.setAttribute("aria-current", "true"); current = tr; } else tr.removeAttribute("aria-current");
    }
    current?.scrollIntoView({ block: "center" });
  }
  const clear = () => {
    highlight(NaN);
    $("[data-testid=lookup-result]").textContent = "";
    $("[data-testid=lookup-message]").textContent = "";
  };

  async function lookup() {
    const raw = $("#lookup-input").value.trim().replace(/[$,\s]/g, ""); // accept "$47,636.59"
    if (!raw) return clear();
    const mine = ++seqNo;
    let res, body;
    try {
      [res] = await Promise.all([fetch(`/api/table2/lookup?expected=${encodeURIComponent(raw)}`), load()]);
      body = await res.json();
    } catch { res = null; }
    if (mine !== seqNo) return; // a newer keystroke won
    if (!res?.ok) {
      highlight(NaN);
      $("[data-testid=lookup-result]").textContent = "";
      $("[data-testid=lookup-message]").textContent = res ? "Enter a dollar amount of 0 or more, for example 47636.59." : "Could not reach the server.";
      return;
    }
    $("[data-testid=lookup-message]").textContent = "";
    const to = body.band.max === null ? "and over" : `to $${whole(body.band.max)}`;
    $("[data-testid=lookup-result]").textContent =
      `Primary threshold $${whole(body.threshold)}: rounded expected losses $${whole(body.roundedExpected)} fall in the band $${whole(body.band.min)} ${to}.`;
    highlight(body.threshold);
  }
  $("#lookup-input").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(lookup, 200); });

  /** From the Calculator: open the tab on the band the calculation used (the engine's threshold, not a re-lookup). */
  async function showBand(threshold, expected) {
    selectTab("reference");
    await load();
    ++seqNo; clearTimeout(timer); // cancel any pending typed lookup
    $("#lookup-input").value = expected;
    $("[data-testid=lookup-message]").textContent = "";
    $("[data-testid=lookup-result]").textContent = `Primary threshold $${whole(threshold)}: used by your calculation (expected losses $${money(expected)}).`;
    highlight(threshold);
    $("#tab-reference").focus();
  }
  return { load, showBand };
}
const reference = createReference();
$("#result").addEventListener("click", (e) => {
  const a = e.target.closest("a.pt-link");
  if (!a) return;
  e.preventDefault();
  reference.showBand(Number(a.dataset.threshold), Number(a.dataset.expected));
});
