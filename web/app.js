import { STORIES } from "./stories.js";
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---- tabs
const tabs = [["calc", "panel-calc"], ["stories", "panel-stories"], ["dash", "panel-dash"]];
for (const [k, panel] of tabs) {
  $(`#tab-${k}`).addEventListener("click", () => {
    for (const [k2, p2] of tabs) { $(`#tab-${k2}`).setAttribute("aria-selected", String(k2 === k)); $(`#${p2}`).hidden = p2 !== panel; }
    dashboard.setActive(k === "dash");
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
