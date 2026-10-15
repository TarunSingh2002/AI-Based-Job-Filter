// Job Filter v2 — side panel (LinkedIn companion).
// Shows the verdict for the job open on LinkedIn (storage "li_current", written by linkedin.js), the
// partial-hide list with Keep / Clear, and today's CSV counts from the backend ({type: "stats"} message).
// It only reads/writes extension storage; nothing is drawn inside LinkedIn's page.

const SITE_LABEL = { linkedin: "LinkedIn", naukri: "Naukri", indeed: "Indeed", glassdoor: "Glassdoor" };
const WAITING_TEXT = { reading: "Waiting for the job description…", scoring: "Scoring…" };

let statsTimer = null;

init().catch((err) => console.warn("[JobFilter] side panel failed to load:", err));

async function init() {
  $("promptKeep").addEventListener("click", () => { $("partialPrompt").hidden = true; });
  $("promptClear").addEventListener("click", clearPartialList);
  $("clearPartial").addEventListener("click", clearPartialList);
  $("refreshStats").addEventListener("click", loadStats);
  chrome.storage.onChanged.addListener(onStorageChanged);

  const data = await chrome.storage.local.get(["li_current", "li_partial"]);
  renderCurrent(data.li_current);
  renderPartial(data.li_partial);
  renderAiNotice(await jfLoadSettings());
  loadStats();
  await maybeAskKeepOrClear(data.li_partial);
}

function onStorageChanged(changes, area) {
  if (area !== "local") return;
  if (changes.li_current) {
    const current = changes.li_current.newValue;
    renderCurrent(current);
    if (current && current.status === "done") scheduleStatsRefresh(); // a new verdict may have added a CSV row
  }
  if (changes.li_partial) renderPartial(changes.li_partial.newValue);
  if (changes.settings) renderAiNotice(jfMergeSettings(changes.settings.newValue));
}


// ─── Current job ────────────────────────────────────────────────────────────────────────────────

// li_current = {jobId, title, company, status: "reading"|"scoring"|"done"|"error", verdict?, t}
function renderCurrent(current) {
  const hasJob = !!(current && current.jobId);
  $("emptyState").hidden = hasJob;
  $("jobBox").hidden = !hasJob;
  if (!hasJob) return;

  $("jobTitle").textContent = current.title || "(title not found)";
  $("jobCompany").textContent = current.company || "";

  const verdict = current.verdict || null;
  const decided = current.status === "done" && !!verdict && !!verdict.decision;
  const waiting = current.status === "reading" || current.status === "scoring";

  const status = $("statusLine");
  status.dataset.status = waiting ? current.status : decided ? "done" : "error";
  if (waiting) status.textContent = WAITING_TEXT[current.status];
  else if (decided) status.textContent = "";
  else status.textContent = "Error: " + ((verdict && verdict.error) || current.error || "no verdict");

  $("verdictBox").hidden = !decided;
  $("verdictReason").textContent = decided ? verdict.reason || "" : "";
  $("verdictDetails").textContent = decided ? describeDetails(verdict) : "";
  if (!decided) return;

  const pass = verdict.decision === "pass";
  $("verdictBox").className = "verdict " + (pass ? "pass" : "reject");
  $("verdictWord").textContent = pass ? "PASS" : "REJECT";
  $("verdictScore").textContent = verdict.match_score != null ? verdict.match_score + "/10" : "";
  $("verdictMeta").textContent = [
    verdict.confidence != null ? "confidence " + Math.round(verdict.confidence * 100) + "%" : null,
    verdict.stage === "title" ? "title stage" : "JD stage",
    verdict.cached ? "cached" : null,
  ].filter(Boolean).join(" · ");
}

// Extra facts from the JD stage, e.g. "ai ml engineering · hybrid · 2+ yrs".
function describeDetails(verdict) {
  return [
    verdict.role_family ? String(verdict.role_family).replace(/_/g, " ") : null,
    verdict.work_mode && verdict.work_mode !== "not_stated" ? verdict.work_mode : null,
    verdict.min_years != null ? verdict.min_years + "+ yrs" : null,
  ].filter(Boolean).join(" · ");
}

function renderAiNotice(settings) {
  let text = "";
  if (!settings.aiEnabled) text = "AI screening is off, so only rules apply (popup → AI).";
  else if (!settings.linkedin.jdAI) text = "Scoring the open job is off (popup → LinkedIn).";
  $("aiNotice").textContent = text;
  $("aiNotice").hidden = !text;
}


// ─── Partial-hide list ──────────────────────────────────────────────────────────────────────────

function partialCount(partial) {
  return partial && Array.isArray(partial.items) ? partial.items.length : 0;
}

function renderPartial(partial) {
  const count = partialCount(partial);
  $("partialCount").textContent = count + (count === 1 ? " job" : " jobs") + " in the partial-hide list";
  $("clearPartial").disabled = count === 0;
  if (count === 0) $("partialPrompt").hidden = true;
}

// Ask "keep or clear?" once per browser session (storage.session "li_partial_prompted"), only if the list has items.
async function maybeAskKeepOrClear(partial) {
  const count = partialCount(partial);
  if (!count) return;
  const session = await chrome.storage.session.get("li_partial_prompted");
  if (session.li_partial_prompted) return;
  await chrome.storage.session.set({ li_partial_prompted: true });
  $("promptCount").textContent = count;
  $("partialPrompt").hidden = false;
}

async function clearPartialList() {
  try {
    await chrome.storage.local.set({ li_partial: { items: [] } }); // linkedin.js re-hides via storage.onChanged
    $("partialPrompt").hidden = true;
  } catch (err) {
    console.warn("[JobFilter] could not clear the partial-hide list:", err);
  }
}


// ─── Today's stats (backend GET /stats via the background) ──────────────────────────────────────

async function loadStats() {
  let reply;
  try {
    reply = (await chrome.runtime.sendMessage({ type: "stats" })) || { error: "no reply" };
  } catch (err) {
    reply = { error: err && err.message ? err.message : String(err) };
  }

  const failed = !!reply.error;
  $("statsTable").hidden = failed;
  $("statsError").hidden = !failed;
  $("statsError").textContent = failed ? "Backend not reachable: " + reply.error : "";
  $("statsDate").textContent = failed ? "" : reply.date || "";
  if (failed) return;

  // Always list the four sites (zeros included), plus any other site the backend reports.
  const sites = reply.sites || {};
  const names = Object.keys(SITE_LABEL).concat(Object.keys(sites).filter((name) => !(name in SITE_LABEL)));
  $("statsBody").replaceChildren(...names.map((name) => statsRow(SITE_LABEL[name] || name, sites[name] || {})));
}

function statsRow(label, counts) {
  const row = document.createElement("tr");
  for (const text of [label, counts.matches || 0, counts.rejected || 0]) {
    const cell = document.createElement("td");
    cell.textContent = String(text);
    row.appendChild(cell);
  }
  return row;
}

// Several verdicts can land within a second; refresh once after they settle.
function scheduleStatsRefresh() {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(loadStats, 1500);
}


function $(id) {
  return document.getElementById(id);
}
