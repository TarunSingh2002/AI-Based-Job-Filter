// Job Filter v2 — popup.
// Edits chrome.storage.local "settings" (content scripts pick changes up via chrome.storage.onChanged),
// starts / stops / resumes the Glassdoor, Naukri and Indeed scrapers, and checks the backend.
// Uses jfLoadSettings / jfMergeSettings from ../common/filters.js.

const SITE_LABEL = { glassdoor: "Glassdoor", naukri: "Naukri", indeed: "Indeed", linkedin: "LinkedIn" };

// Start is only offered on a search-results page: that is the only page the scraper knows how to read.
const SEARCH_PAGE_TESTS = {
  glassdoor: (url) => /^www\.glassdoor\.(com|co\.in)$/.test(url.hostname) && url.pathname.startsWith("/Job/"),
  naukri: (url) => url.hostname === "www.naukri.com" && /(^\/|-)jobs(-|$)/.test(url.pathname),
  indeed: (url) => /^(in|www)\.indeed\.com$/.test(url.hostname)
    && (url.pathname === "/jobs" || url.pathname.startsWith("/q-")),
};

let settings = null; // settings as last loaded or saved
let activeTab = null; // tab the popup was opened over (looked up early: sidePanel.open must run synchronously)
let scrapeState = null; // copy of storage "scrape_state"
let dirty = false; // the form has edits that are not saved yet

init().catch((err) => showStatus("Popup failed to load: " + errorText(err), true));

async function init() {
  activeTab = await getActiveTab();
  settings = await jfLoadSettings();
  buildScrapeBoxes();
  fillForm(settings);
  wireEvents();

  const data = await chrome.storage.local.get(["scrape_state", "li_partial"]);
  scrapeState = data.scrape_state || null;
  renderScrape();
  renderPartialCount(data.li_partial);
  updateLinkedInUi();
  $("csvHint").textContent = "Results (jobs.xlsx + CSV files) are in AI-Based-Job-Filter/backend/output/" + localDate() + "/";
  showTab(tabForUrl(activeTab && activeTab.url));
  chrome.storage.onChanged.addListener(onStorageChanged);
}

function wireEvents() {
  for (const btn of document.querySelectorAll(".tabs button")) {
    btn.addEventListener("click", () => showTab(btn.dataset.tab));
  }
  for (const el of document.querySelectorAll("[data-setting]")) {
    el.addEventListener("input", markDirty);
    el.addEventListener("change", markDirty);
  }
  for (const radio of document.querySelectorAll('input[name="li-promoted"]')) {
    radio.addEventListener("change", updateLinkedInUi);
  }
  for (const btn of document.querySelectorAll(".scrape [data-action]")) {
    btn.addEventListener("click", safely(() => onScrapeButton(btn.closest(".scrape").dataset.site, btn.dataset.action)));
  }
  $("save").addEventListener("click", safely(saveSettings));
  $("clearPartial").addEventListener("click", safely(clearPartialList));
  $("checkHealth").addEventListener("click", safely(checkHealth));
  $("openSidePanel").addEventListener("click", openSidePanel); // not wrapped: must stay synchronous (see below)
}

// Click handlers are async; show any failure in the footer instead of losing it in the console.
function safely(handler) {
  return () => Promise.resolve().then(handler).catch((err) => showStatus(errorText(err), true));
}

function onStorageChanged(changes, area) {
  if (area !== "local") return;
  if (changes.scrape_state) {
    scrapeState = changes.scrape_state.newValue || null;
    renderScrape();
  }
  if (changes.li_partial) renderPartialCount(changes.li_partial.newValue);
}

function showTab(name) {
  for (const btn of document.querySelectorAll(".tabs button")) {
    btn.classList.toggle("active", btn.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll(".panel")) panel.hidden = panel.id !== "tab-" + name;
  if (name === "ai" && !dirty) checkHealth();
}

// Open the tab for the site the user is on, so the relevant controls are right there.
function tabForUrl(url) {
  const host = (parseUrl(url) || {}).hostname || "";
  if (host.endsWith("linkedin.com")) return "linkedin";
  if (host.includes("glassdoor.")) return "glassdoor";
  if (host.endsWith("naukri.com")) return "naukri";
  if (host.endsWith("indeed.com")) return "indeed";
  return "filters";
}


// ─── Settings form ──────────────────────────────────────────────────────────────────────────────

// Put settings into the form. Each control says which setting it shows via data-setting="section.key".
function fillForm(s) {
  for (const el of document.querySelectorAll("[data-setting]")) {
    const value = getPath(s, el.dataset.setting);
    if (el.type === "checkbox") el.checked = !!value;
    else if (el.type === "radio") el.checked = el.value === value;
    else if (el.dataset.kind === "list") el.value = (value || []).join(", ");
    else el.value = value == null ? "" : value;
  }
}

// Read the form back into a settings object (mutates and returns `s`).
function readForm(s) {
  for (const el of document.querySelectorAll("[data-setting]")) {
    const path = el.dataset.setting;
    if (el.type === "checkbox") setPath(s, path, el.checked);
    else if (el.type === "radio") { if (el.checked) setPath(s, path, el.value); }
    else if (el.dataset.kind === "list") setPath(s, path, splitList(el.value));
    else if (el.type === "number") setPath(s, path, clampInt(el.value, el.min, el.max, getPath(s, path)));
    else setPath(s, path, el.value.trim());
  }
  return s;
}

async function saveSettings() {
  const next = readForm(jfMergeSettings(settings)); // edit a copy; keep the old one if validation fails
  next.backendUrl = next.backendUrl.replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/.test(next.backendUrl)) {
    showTab("ai");
    showStatus("Backend URL must start with http:// or https://", true);
    return false;
  }
  try {
    await chrome.storage.local.set({ settings: next });
  } catch (err) {
    showStatus("Could not save: " + errorText(err), true);
    return false;
  }
  settings = next;
  dirty = false;
  fillForm(settings); // show the cleaned-up values (trimmed lists, clamped numbers)
  updateLinkedInUi();
  showStatus("Saved ✓");
  return true;
}

function markDirty() {
  dirty = true;
  showStatus("Unsaved changes");
}

function showStatus(text, isError) {
  const el = $("saveStatus");
  el.textContent = text;
  el.classList.toggle("error", !!isError);
}


// ─── LinkedIn tab ───────────────────────────────────────────────────────────────────────────────

function updateLinkedInUi() {
  const checked = document.querySelector('input[name="li-promoted"]:checked');
  $("partialScopeBox").hidden = !checked || checked.value !== "partial";
}

function renderPartialCount(partial) {
  const count = partial && Array.isArray(partial.items) ? partial.items.length : 0;
  $("partialCount").textContent = count + (count === 1 ? " job" : " jobs") + " in the partial-hide list";
  $("clearPartial").disabled = count === 0;
}

async function clearPartialList() {
  try {
    await chrome.storage.local.set({ li_partial: { items: [] } });
  } catch (err) {
    showStatus("Could not clear the list: " + errorText(err), true);
  }
}

// Chrome only opens the side panel from a user gesture, so this runs directly in the click handler
// with no await before the call (that is why activeTab was looked up when the popup opened).
function openSidePanel() {
  if (!activeTab) {
    showStatus("No active tab", true);
    return;
  }
  chrome.sidePanel.open({ tabId: activeTab.id })
    .then(() => window.close())
    .catch((err) => showStatus("Could not open the side panel: " + errorText(err), true));
}


// ─── Scraper controls (Glassdoor / Naukri / Indeed) ─────────────────────────────────────────────

function buildScrapeBoxes() {
  const template = $("scrapeTemplate");
  for (const box of document.querySelectorAll(".scrape")) box.appendChild(template.content.cloneNode(true));
}

function renderScrape() {
  const runningSite = scrapeState && scrapeState.running ? scrapeState.site : null;

  for (const box of document.querySelectorAll(".scrape")) {
    const site = box.dataset.site;
    const state = scrapeState && scrapeState.site === site ? scrapeState : null;
    const onSearchPage = isSearchPage(site, activeTab && activeTab.url);
    const counts = (state && state.counts) || {};

    const status = box.querySelector('[data-role="status"]');
    status.textContent = describeState(state);
    status.dataset.mode = !state ? "idle" : state.paused ? "paused" : state.running ? "running" : "stopped";
    for (const cell of box.querySelectorAll("[data-count]")) cell.textContent = counts[cell.dataset.count] || 0;

    box.querySelector('[data-action="start"]').disabled = !!runningSite || !onSearchPage;
    box.querySelector('[data-action="stop"]').disabled = !(state && state.running);
    box.querySelector('[data-action="resume"]').disabled = !(state && state.paused);

    let hint = "";
    if (runningSite && runningSite !== site) {
      hint = "A scrape is already running on " + (SITE_LABEL[runningSite] || runningSite) + ".";
    } else if (!runningSite && !onSearchPage) {
      hint = "Open a " + SITE_LABEL[site] + " search results page in this tab to start.";
    }
    box.querySelector('[data-role="hint"]').textContent = hint;
  }
}

function describeState(state) {
  if (!state) return "Idle";
  if (state.paused) return "Paused: " + (state.pauseReason || "unknown reason") + ". Fix it in the page, then Resume.";
  const done = (state.pagesDone || 0) + "/" + (state.maxPages || "?") + " pages done";
  if (state.running) return "Running · page " + (state.page || 1) + " · " + done;
  return "Stopped" + (state.pauseReason ? " (" + state.pauseReason + ")" : "") + " · " + done;
}

async function onScrapeButton(site, action) {
  const hint = document.querySelector('.scrape[data-site="' + site + '"] [data-role="hint"]');

  if (action === "start") {
    if (dirty && !(await saveSettings())) return; // the scraper reads settings when it starts
    const reply = await sendToTab(activeTab && activeTab.id, { type: "scrapeStart" });
    hint.textContent = reply.error ? "Could not start: " + reply.error : "Starting…";
    return;
  }

  // Stop / Resume go to the tab that is scraping, which may not be the tab in front.
  const tabId = scrapeState && scrapeState.tabId != null ? scrapeState.tabId : activeTab && activeTab.id;
  const reply = await sendToTab(tabId, { type: action === "stop" ? "scrapeStop" : "scrapeResume" });
  if (!reply.error) return;
  if (action === "stop" && scrapeState) {
    // The scraping page is gone (closed / crashed / navigated away): just mark the run stopped.
    await chrome.storage.local.set({ scrape_state: { ...scrapeState, running: false, paused: false } });
  } else {
    hint.textContent = "Could not resume: " + reply.error;
  }
}

// Send to a content script. A script that handles the message without replying makes Chrome report a
// closed message port; the message was still delivered, so that counts as success.
async function sendToTab(tabId, message) {
  if (tabId == null) return { error: "no tab" };
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) || { ok: true };
  } catch (err) {
    const text = errorText(err);
    if (/message port closed/i.test(text)) return { ok: true };
    if (/Receiving end does not exist/i.test(text)) return { error: "the page isn't ready, reload the tab and try again" };
    return { error: text };
  }
}

function isSearchPage(site, url) {
  const parsed = parseUrl(url);
  return !!parsed && SEARCH_PAGE_TESTS[site](parsed);
}


// ─── AI tab ─────────────────────────────────────────────────────────────────────────────────────

async function checkHealth() {
  if (dirty && !(await saveSettings())) return; // check the URL that is in the form, not the old one
  const box = $("health");
  box.className = "health";
  box.textContent = "Checking…";

  let reply;
  try {
    reply = (await chrome.runtime.sendMessage({ type: "health" })) || { error: "no reply" };
  } catch (err) {
    reply = { error: errorText(err) };
  }

  if (reply.error) {
    box.className = "health bad";
    box.textContent = "Not reachable: " + reply.error;
    return;
  }
  const years = reply.profile && reply.profile.experience_years;
  box.className = "health ok";
  box.textContent = "Connected · " + reply.provider + " · " + reply.model
    + (years != null ? " · profile: " + years + " yrs" : "");
}


// ─── Small helpers ──────────────────────────────────────────────────────────────────────────────

function $(id) {
  return document.getElementById(id);
}

async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch (_) {
    return null;
  }
}

function getPath(obj, path) {
  return path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  keys.reduce((node, key) => node[key], obj)[last] = value;
}

// "a, b,\n c" → ["a", "b", "c"]. Commas or new lines both separate entries.
function splitList(text) {
  return String(text).split(/[,\n]/).map((part) => part.trim()).filter(Boolean);
}

// Number inputs: keep within the input's own min/max attributes; an empty or garbage value keeps the old setting.
function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, Number(min)), Number(max));
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch (_) {
    return null;
  }
}

// Local date as YYYY-MM-DD (the backend names its output folders by local date too).
function localDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function errorText(err) {
  return err && err.message ? err.message : String(err);
}
