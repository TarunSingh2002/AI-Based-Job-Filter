// Job Filter v2 — popup.
// Edits chrome.storage.local "settings" (content scripts pick changes up via chrome.storage.onChanged),
// starts / stops / resumes the Glassdoor, Naukri and Indeed scrapers, starts / stops the automation (it runs in
// the background: automation.js) and shows its progress from storage "auto_state", clears the backend's repost
// lists, checks the backend, and copies / clears the debug log. Uses jfLoadSettings / jfMergeSettings from
// ../common/filters.js.

const SITE_LABEL = { glassdoor: "Glassdoor", naukri: "Naukri", indeed: "Indeed", linkedin: "LinkedIn" };
const AUTO_STATUS_TEXT = {
  pending: "queued", starting: "opening…", running: "running", waiting_for_you: "needs you",
  done: "done", paused: "paused", stalled: "stalled", error: "error", skipped: "skipped",
};
// automation.js keeps "Start is checking the backend" in storage.session "auto_starting" (its start time), so a
// popup opened again meanwhile still shows "Starting…" and offers Stop. Older = left by a stopped service worker.
const AUTO_STARTING_MAX_MS = 3 * 60000;
const DEBUG_LOG_KEY = "jf_debug_log"; // storage.local, written by background.js (section 9)

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
let autoState = null; // copy of storage "auto_state" (the automation run)
let autoStartPending = false; // "Start automation" pressed (here or in an earlier popup); the backend is being checked
let autoStartWarned = false; // "unsaved changes" was shown once; a second press starts with the saved settings
let autoMessage = ""; // why the last Start / Stop automation failed
let dirty = false; // the form has edits that are not saved yet

init().catch((err) => showStatus("Popup failed to load: " + errorText(err), true));

async function init() {
  activeTab = await getActiveTab();
  settings = await jfLoadSettings();
  buildScrapeBoxes();
  buildDebugBoxes();
  fillForm(settings);
  wireEvents();

  const data = await chrome.storage.local.get(["scrape_state", "li_partial", "auto_state"]);
  scrapeState = data.scrape_state || null;
  autoState = data.auto_state || null;
  autoStartPending = await readAutoStarting();
  renderScrape();
  renderAuto();
  renderPartialCount(data.li_partial);
  updateLinkedInUi();
  updateSidePanelUi();
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
  for (const btn of document.querySelectorAll("[data-dedupe]")) {
    btn.addEventListener("click", safely(() => clearRepostList(btn)));
  }
  for (const btn of document.querySelectorAll("[data-debug]")) {
    btn.addEventListener("click", safely(() => onDebugButton(btn)));
  }
  $("save").addEventListener("click", safely(saveSettings));
  $("clearPartial").addEventListener("click", safely(clearPartialList));
  $("forgetLiVerdicts").addEventListener("click", safely(forgetLinkedInVerdicts));
  $("checkHealth").addEventListener("click", safely(checkHealth));
  $("autoStart").addEventListener("click", safely(startAutomation));
  $("autoStop").addEventListener("click", safely(stopAutomation));
  $("openSidePanel").addEventListener("click", openSidePanel); // not wrapped: must stay synchronous (see below)
}

// Click handlers are async; show any failure in the footer instead of losing it in the console.
function safely(handler) {
  return () => Promise.resolve().then(handler).catch((err) => showStatus(errorText(err), true));
}

function onStorageChanged(changes, area) {
  if (area === "session" && changes.auto_starting) {
    autoStartPending = isFreshStart(changes.auto_starting.newValue);
    renderAuto();
  }
  if (area !== "local") return;
  if (changes.scrape_state) {
    scrapeState = changes.scrape_state.newValue || null;
    renderScrape();
    renderAuto(); // "Start automation" is off while a scrape runs
  }
  if (changes.auto_state) {
    autoState = changes.auto_state.newValue || null;
    renderAuto();
    renderScrape(); // the sites' Start buttons are off while the automation runs
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
    else if (el.dataset.kind === "lines") el.value = (value || []).join("\n");
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
    else if (el.dataset.kind === "lines") setPath(s, path, splitLines(el.value)); // links contain commas
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
  autoStartWarned = false; // the next unsaved edit warns again
  fillForm(settings); // show the cleaned-up values (trimmed lists, clamped numbers)
  updateLinkedInUi();
  showStatus("Saved ✓");
  return true;
}

function markDirty() {
  dirty = true;
  autoStartWarned = false; // a new edit after the warning: Start automation warns again
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

/**
 * LinkedIn keeps the AI verdicts it has seen (li_verdicts) and shows them without asking the backend. Forgetting
 * them makes the next LinkedIn page ask again, and the backend re-checks its saved verdicts against today's
 * profile.yaml (e.g. a lower experience limit). The LinkedIn tab keeps its copy in memory until it is refreshed.
 */
async function forgetLinkedInVerdicts() {
  try {
    await chrome.storage.local.remove("li_verdicts");
    showStatus("Saved LinkedIn verdicts forgotten. Refresh the LinkedIn tab.");
  } catch (err) {
    showStatus("Could not forget them: " + errorText(err), true);
  }
}

// Opera (and some other Chromium browsers) have no chrome.sidePanel: the button is off and a note says why.
function hasSidePanel() {
  return !!(chrome.sidePanel && typeof chrome.sidePanel.open === "function");
}

function updateSidePanelUi() {
  $("openSidePanel").disabled = !hasSidePanel();
  $("noSidePanel").hidden = hasSidePanel();
}

// Chrome only opens the side panel from a user gesture, so this runs directly in the click handler
// with no await before the call (that is why activeTab was looked up when the popup opened).
function openSidePanel() {
  if (!hasSidePanel()) return;
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
  const autoRunning = !!(autoState && autoState.running);

  for (const box of document.querySelectorAll(".scrape")) {
    const site = box.dataset.site;
    const state = scrapeState && scrapeState.site === site ? scrapeState : null;
    const onSearchPage = isSearchPage(site, activeTab && activeTab.url);
    const counts = (state && state.counts) || {};

    const status = box.querySelector('[data-role="status"]');
    status.textContent = describeState(state);
    status.dataset.mode = !state ? "idle" : state.paused ? "paused" : !state.running ? "stopped"
      : state.waitReason ? "waiting" : "running";
    for (const cell of box.querySelectorAll("[data-count]")) cell.textContent = counts[cell.dataset.count] || 0;

    box.querySelector('[data-action="start"]').disabled = autoRunning || !!runningSite || !onSearchPage;
    box.querySelector('[data-action="stop"]').disabled = !(state && state.running);
    box.querySelector('[data-action="resume"]').disabled = !(state && state.paused);

    let hint = "";
    if (autoRunning) {
      // Stop / Resume stay usable: Resume is how you continue after solving a captcha in the automation window.
      hint = "The automation is running (Automation tab), so Start is off until it ends.";
    } else if (runningSite && runningSite !== site) {
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
  if (state.running && state.waitReason) {
    // The site said "too fast": every job-page reader waits, then retries by itself (no need to do anything).
    const retryAt = state.waitUntil ? ", retry at " + new Date(state.waitUntil).toLocaleTimeString() : "";
    return "Running · " + state.waitReason + retryAt + " · page " + (state.page || 1) + " · " + done;
  }
  if (state.running) return "Running · page " + (state.page || 1) + " · " + done;
  return "Stopped" + (state.pauseReason ? " (" + state.pauseReason + ")" : "") + " · " + done;
}

async function onScrapeButton(site, action) {
  const hint = document.querySelector('.scrape[data-site="' + site + '"] [data-role="hint"]');

  if (action === "start") {
    if (dirty && !(await saveSettings())) return; // the scraper reads settings when it starts
    // "manual": you are watching, so the lanes and gaps from the settings apply (scraper-core.js jfsJdPace)
    const reply = await sendToTab(activeTab && activeTab.id, { type: "scrapeStart", mode: "manual" });
    hint.textContent = reply.error ? "Could not start: " + reply.error : "Starting…";
    return;
  }

  // Stop / Resume go to the tab that is scraping, which may not be the tab in front.
  const tabId = scrapeState && scrapeState.tabId != null ? scrapeState.tabId : activeTab && activeTab.id;
  const reply = await sendToTab(tabId, { type: action === "stop" ? "scrapeStop" : "scrapeResume" });
  if (!reply.error) return;
  if (action === "stop" && scrapeState) {
    // The scraping page is gone (closed / crashed / extension reloaded): mark the run stopped ourselves.
    // It goes through the background like a scraper's own update, so the red "!" badge is reset too, and
    // "stopped by user" keeps the background from announcing it as a finished run.
    const stopped = { ...scrapeState, running: false, paused: false, pauseReason: "stopped by user", waitReason: null, waitUntil: null };
    let stopReply;
    try {
      stopReply = (await chrome.runtime.sendMessage({ type: "scrapeProgress", state: stopped })) || { ok: true };
    } catch (err) {
      stopReply = { error: errorText(err) };
    }
    if (stopReply.error) hint.textContent = "Could not stop: " + stopReply.error;
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

// "Clear repost list": the backend forgets which (title, company) pairs it has already judged for this
// group (Naukri, or Glassdoor + Indeed together), so the next run judges reposts again instead of hiding them.
async function clearRepostList(button) {
  button.disabled = true;
  let reply;
  try {
    reply = (await chrome.runtime.sendMessage({ type: "dedupeClear", group: button.dataset.dedupe })) || { error: "no reply" };
  } catch (err) {
    reply = { error: errorText(err) };
  } finally {
    button.disabled = false;
  }
  if (reply.error) showStatus("Could not clear the repost list: " + reply.error, true);
  else showStatus("Repost list cleared (" + (reply.cleared || 0) + " jobs)");
}


// ─── Automation tab ─────────────────────────────────────────────────────────────────────────────

function renderAuto() {
  const auto = autoState;
  const running = !!(auto && auto.running);
  const scraping = !!(scrapeState && scrapeState.running);

  const status = $("autoStatus");
  if (autoStartPending && !running) {
    status.textContent = "Starting… checking the backend (up to 2 minutes)";
    status.dataset.mode = "waiting";
  } else if (running) {
    const current = auto.items[auto.index];
    status.textContent = "Running · search " + Math.min(auto.index + 1, auto.items.length) + " of " + auto.items.length
      + (current ? " · " + current.label + ": " + AUTO_STATUS_TEXT[current.status] : "");
    status.dataset.mode = current && current.status === "waiting_for_you" ? "waiting" : "running";
  } else {
    status.textContent = "Idle";
    status.dataset.mode = "idle";
  }

  $("autoItems").replaceChildren(...((auto && auto.items) || []).map(autoItemRow));

  const last = [];
  if (auto && !running && auto.finishedAt) {
    last.push("Last run: " + new Date(auto.finishedAt).toLocaleString() + " — " + (auto.summary || ""));
  }
  if (auto && auto.notes && auto.notes.length) last.push(auto.notes.join("; "));
  $("autoLast").textContent = last.join(" · ");

  $("autoStart").disabled = running || autoStartPending || scraping;
  $("autoStop").disabled = !running && !autoStartPending;
  const scrapingHint = !running && scraping
    ? "A " + (SITE_LABEL[scrapeState.site] || scrapeState.site) + " scrape is running: stop it first (its tab here)."
    : "";
  $("autoHint").textContent = autoMessage || scrapingHint;
}

// One line per saved search: "Glassdoor 1/3 · running · 4 matched", its link, and why it ended / waits.
function autoItemRow(item) {
  const row = document.createElement("li");
  row.dataset.status = item.status;
  const head = document.createElement("div");
  head.className = "head";
  const matched = item.counts ? (item.counts.matched || 0) + " matched" : "";
  head.append(
    textBox("span", "label", item.label || SITE_LABEL[item.site] || item.site),
    textBox("span", "state", [AUTO_STATUS_TEXT[item.status] || item.status, matched].filter(Boolean).join(" · ")),
  );
  row.append(head, textBox("div", "url", shortUrl(item.url)));
  if (item.reason) row.append(textBox("div", "why", item.reason));
  return row;
}

function textBox(tag, className, text) {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}

// "glassdoor.co.in/Job/india-"TensorFlow"-OR-"Pandas"…" — enough to tell the searches apart.
function shortUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed) return String(url);
  let path = parsed.pathname + parsed.search;
  try {
    path = decodeURIComponent(path);
  } catch (_) {
    // keep it encoded
  }
  const text = parsed.hostname.replace(/^www\./, "") + path;
  return text.length > 55 ? text.slice(0, 54) + "…" : text;
}

async function startAutomation() {
  if (dirty && !autoStartWarned) {
    autoStartWarned = true;
    showStatus("Unsaved changes! Save first, or press Start automation again to run with the saved settings.", true);
    return;
  }
  autoStartWarned = false;
  autoStartPending = true;
  autoMessage = "";
  renderAuto();
  let reply;
  try {
    reply = (await chrome.runtime.sendMessage({ type: "autoStart" })) || { error: "no reply" };
  } catch (err) {
    reply = { error: errorText(err) };
  } finally {
    autoStartPending = false;
  }
  autoMessage = reply.error === "cancelled" ? "Start cancelled (Stop automation)."
    : reply.error ? "Could not start: " + reply.error : "";
  renderAuto();
}

// Is the background checking the backend for a Start right now (pressed in an earlier popup, or the browser opened)?
async function readAutoStarting() {
  try {
    return isFreshStart((await chrome.storage.session.get("auto_starting")).auto_starting);
  } catch (_) {
    return false; // no storage.session in this browser: only this popup's own Start shows "Starting…"
  }
}

function isFreshStart(since) {
  return typeof since === "number" && Date.now() - since < AUTO_STARTING_MAX_MS;
}

async function stopAutomation() {
  let reply;
  try {
    reply = (await chrome.runtime.sendMessage({ type: "autoStop" })) || { ok: true };
  } catch (err) {
    reply = { error: errorText(err) };
  }
  autoMessage = reply.error ? "Could not stop: " + reply.error : "";
  renderAuto();
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


// ─── Debug log (Glassdoor / Naukri / Indeed / AI tabs) ──────────────────────────────────────────
// The scrapers and background.js log every step (storage "jf_debug_log", the newest 1500 events). "Copy debug log"
// puts it on the clipboard to paste into a bug report; "Clear log" empties it for a clean try.

function buildDebugBoxes() {
  const template = $("debugTemplate");
  for (const box of document.querySelectorAll(".debug")) box.appendChild(template.content.cloneNode(true));
}

async function onDebugButton(button) {
  const status = button.closest(".debug").querySelector('[data-role="debugStatus"]');
  status.textContent = "";
  button.disabled = true;
  try {
    if (button.dataset.debug === "clear") {
      await clearDebugLog();
      status.textContent = "Log cleared.";
      return;
    }
    const entries = await readDebugLog();
    const text = debugLogText(entries);
    await copyText(text);
    status.textContent = "copied " + entries.length + " events (" + Math.ceil(text.length / 1024)
      + " KB). Paste it into your message.";
  } finally {
    button.disabled = false;
  }
}

// From the background (it adds the events of the last half second first); straight from storage if it can't answer.
async function readDebugLog() {
  try {
    const reply = await chrome.runtime.sendMessage({ type: "debugLogGet" });
    if (reply && Array.isArray(reply.entries)) return reply.entries.filter((e) => e && typeof e === "object");
  } catch (_) {
    // background not reachable: read what it stored
  }
  const stored = (await chrome.storage.local.get(DEBUG_LOG_KEY))[DEBUG_LOG_KEY];
  return stored && Array.isArray(stored.entries) ? stored.entries.filter((e) => e && typeof e === "object") : [];
}

async function clearDebugLog() {
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ type: "debugLogClear" });
  } catch (err) {
    reply = { error: errorText(err) };
  }
  if (!reply || reply.error) await chrome.storage.local.remove(DEBUG_LOG_KEY); // background not reachable
}

// Valid JSON, one event per line (short to paste, easy to read), oldest first. "about" adds the extension version,
// the browser, the saved settings and the current run, which explain most events.
function debugLogText(entries) {
  const about = {
    exportedAt: new Date().toISOString(),
    version: chrome.runtime.getManifest().version,
    browser: navigator.userAgent,
    events: entries.length,
    scrape_state: scrapeState,
    settings,
  };
  const lines = entries
    .slice()
    .sort((a, b) => (a.t || 0) - (b.t || 0))
    .map((entry) => "    " + JSON.stringify(Object.assign({ time: clockTime(entry.t) }, entry)));
  return '{\n  "about": ' + JSON.stringify(about) + ',\n  "entries": [\n' + lines.join(",\n") + "\n  ]\n}\n";
}

// 21:04:05.123 (local time of an event, so the log reads like a timeline)
function clockTime(ms) {
  if (typeof ms !== "number") return null;
  const d = new Date(ms);
  const pad = (n, width) => String(n).padStart(width, "0");
  return pad(d.getHours(), 2) + ":" + pad(d.getMinutes(), 2) + ":" + pad(d.getSeconds(), 2) + "." + pad(d.getMilliseconds(), 3);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    // The clipboard API said no (e.g. the popup lost focus): the older way, through a hidden text box.
    const box = document.createElement("textarea");
    box.value = text;
    document.body.appendChild(box);
    box.select();
    const copied = document.execCommand("copy");
    box.remove();
    if (!copied) throw new Error("Could not copy the debug log: " + errorText(err));
  }
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

// One entry per line (search links contain commas). Blank lines are dropped.
function splitLines(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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
