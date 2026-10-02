import { STORIES } from "./stories.js";
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---- tabs
const tabs = [["calc", "panel-calc"], ["stories", "panel-stories"], ["dash", "panel-dash"]];
for (const [k, panel] of tabs) {
  $(`#tab-${k}`).addEventListener("click", () => {
    for (const [k2, p2] of tabs) { $(`#tab-${k2}`).setAttribute("aria-selected", String(k2 === k)); $(`#${p2}`).hidden = p2 !== panel; }
  });
}

// ---- stories
$("#stories").innerHTML = STORIES.map((s) => `
  <div class="story" data-testid="story-${s.id}"><h3>${s.id} — ${esc(s.title)}</h3><p>${esc(s.story)}</p>
  <ul>${s.ac.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>`).join("");

// ---- class datalist
fetch("/api/classes").then((r) => r.json()).then((list) => {
  $("#class-list").innerHTML = list.map((c) => `<option value="${c.classCode}">`).join("");
}).catch(() => {});

// ---- rows
let seq = 0;
function addPayroll(code = "", payroll = "") {
  const d = document.createElement("div");
  d.className = "row payroll"; d.dataset.testid = "payroll-row";
  d.innerHTML = `<div><label>Class code</label><input list="class-list" data-field="classCode" data-testid="class-code" inputmode="numeric" maxlength="4" value="${esc(code)}"></div>
    <div><label>Payroll ($) / units</label><input data-field="payroll" data-testid="payroll" inputmode="decimal" value="${esc(payroll)}"></div>
    <button class="btn x" type="button" aria-label="Remove class" data-testid="remove-payroll">✕</button>`;
  $(".x", d).onclick = () => d.remove();
  $("#payroll-rows").append(d);
}
function addClaim(c = {}) {
  seq++;
  const d = document.createElement("div");
  d.className = "row claim"; d.dataset.testid = "claim-row";
  d.innerHTML = `
    <div><label>Claim id</label><input data-field="id" data-testid="claim-id" value="${esc(c.id ?? "C" + seq)}"></div>
    <div><label>Indemnity ($)</label><input data-field="indemnity" data-testid="indemnity" inputmode="decimal" value="${esc(c.indemnity ?? "")}"></div>
    <div><label>Medical ($)</label><input data-field="medical" data-testid="medical" inputmode="decimal" value="${esc(c.medical ?? "")}"></div>
    <div><label>Treatment</label><select data-field="treatment" data-testid="treatment">
      ${["none", "subrogation", "fraud", "compromise", "joint"].map((t) => `<option ${c.treatment === t ? "selected" : ""}>${t}</option>`).join("")}</select></div>
    <button class="btn x" type="button" aria-label="Remove claim" data-testid="remove-claim">✕</button>
    <div class="opts">
      <label class="net">Net incurred ($) <input data-field="netIncurred" data-testid="net-incurred" inputmode="decimal" value="${esc(c.netIncurred ?? "")}"></label>
      <label><input type="checkbox" data-field="death" data-testid="death" ${c.death ? "checked" : ""}> Death</label>
      <label><input type="checkbox" data-field="nonCompensable" data-testid="non-compensable" ${c.nonCompensable ? "checked" : ""}> Non-compensable</label>
      <label><input type="checkbox" data-field="elAndWc" data-testid="el-wc" ${c.elAndWc ? "checked" : ""}> EL + WC</label>
      <label>Accident id <input data-field="accidentId" data-testid="accident-id" style="width:90px" value="${esc(c.accidentId ?? "")}"></label>
    </div>`;
  $(".x", d).onclick = () => d.remove();
  $("#claim-rows").append(d);
}
$("#add-payroll").onclick = () => addPayroll();
$("#add-claim").onclick = () => addClaim();

function reset() {
  $("#payroll-rows").innerHTML = ""; $("#claim-rows").innerHTML = ""; seq = 0;
  $("#prior-rated").checked = false; $("#excl-unaudited").checked = false;
  $("#result").innerHTML = `<h2>Result</h2><p class="note" id="placeholder">Enter payroll and claims, then calculate.</p>`;
  addPayroll();
}
$("#reset").onclick = reset;
$("#load-sample").onclick = () => {
  reset(); $("#payroll-rows").innerHTML = ""; addPayroll("0005", "1000000");
  addClaim({ id: "C1", indemnity: 20000, medical: 0 });
};

// ---- calculate
const numOrUndef = (v) => (v === "" ? undefined : Number(v));
function collect() {
  const payroll = [...document.querySelectorAll("#payroll-rows .row")].map((r) => ({
    classCode: $('[data-field=classCode]', r).value.trim(), payroll: Number($('[data-field=payroll]', r).value || 0),
  }));
  const claims = [...document.querySelectorAll("#claim-rows .row")].map((r) => {
    const g = (f) => $(`[data-field=${f}]`, r);
    const treatment = g("treatment").value;
    const accidentId = g("accidentId").value.trim();
    return {
      id: g("id").value.trim(), indemnity: Number(g("indemnity").value || 0), medical: Number(g("medical").value || 0),
      treatment, netIncurred: numOrUndef(g("netIncurred").value), death: g("death").checked,
      nonCompensable: g("nonCompensable").checked, elAndWc: g("elAndWc").checked,
      ...(accidentId ? { accidentId, multiPerson: true } : {}),
    };
  });
  return { payroll, claims, priorYearExperienceRated: $("#prior-rated").checked, excludedUnauditedPayroll: $("#excl-unaudited").checked };
}

$("#calculate").onclick = async () => {
  const box = $("#result");
  box.setAttribute("aria-busy", "true");
  try {
    const res = await fetch("/api/xmod/calculate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(collect()) });
    const body = await res.json();
    if (!res.ok) {
      box.innerHTML = `<h2>Result</h2><div class="err" role="alert" data-testid="error"><b data-testid="error-code">${esc(body.error.code)}</b>: <span data-testid="error-message">${esc(body.error.message)}</span></div>`;
      return;
    }
    render(box, body);
  } catch {
    box.innerHTML = `<h2>Result</h2><div class="err" role="alert" data-testid="error">Could not reach the server.</div>`;
  } finally { box.removeAttribute("aria-busy"); }
};

function render(box, r) {
  box.innerHTML = `
    <h2>Result</h2>
    <div class="mod" data-testid="mod">${r.mod.toFixed(2)} <small>(${Math.round(r.mod * 100)}%)</small></div>
    <p>
      <span class="pill ${r.eligible ? "ok" : "bad"}" data-testid="eligibility">${r.eligible ? "Eligible" : "Not eligible"}</span>
      ${r.capApplied ? `<span class="pill warn" data-testid="cap-applied">25-point cap applied</span>` : ""}
      <span class="note" data-testid="eligibility-reason">${esc(r.eligibilityReason)}</span>
    </p>
    <dl>
      <dt>Expected losses (E)</dt><dd data-testid="e">${money(r.expectedLosses)}</dd>
      <dt>Primary threshold</dt><dd data-testid="pt">${money(r.primaryThreshold)}</dd>
      <dt>Expected primary</dt><dd data-testid="ep">${money(r.expectedPrimary)}</dd>
      <dt>Expected excess (Ee)</dt><dd data-testid="ee">${money(r.expectedExcess)}</dd>
      <dt>Actual primary (Ap)</dt><dd data-testid="ap">${money(r.actualPrimary)}</dd>
      <dt>Loss-free mod</dt><dd data-testid="loss-free">${r.lossFreeMod.toFixed(2)}</dd>
      <dt>Unrounded mod</dt><dd data-testid="mod-unrounded">${esc(r.modUnrounded)}</dd>
    </dl>
    <h2>Classes</h2>
    <table data-testid="class-table"><thead><tr><th>Class</th><th class="n">ELR</th><th class="n">Expected</th><th class="n">D-ratio</th><th class="n">Exp. primary</th></tr></thead><tbody>
    ${r.classes.map((c) => `<tr><td>${c.classCode}</td><td class="n">${c.elr}</td><td class="n">${money(c.expectedLosses)}</td><td class="n">${c.dRatio}</td><td class="n">${money(c.expectedPrimary)}</td></tr>`).join("")}</tbody></table>
    ${r.claims.length ? `<h2 style="margin-top:14px">Claims</h2>
    <table data-testid="claim-table"><thead><tr><th>Claim</th><th class="n">Actual losses</th><th class="n">Actual primary</th><th>Rule</th></tr></thead><tbody>
    ${r.claims.map((c) => `<tr data-testid="claim-result"><td>${esc(c.id)}</td><td class="n">${money(c.actualLosses)}</td><td class="n">${money(c.actualPrimary)}</td><td>${esc(c.rule)}</td></tr>`).join("")}</tbody></table>` : ""}
    <p class="note">Mod rounding (2 decimals, half-up) is an assumption; the Plan text read so far does not state it.</p>`;
}
reset();
