// Job Filter v2 — automation (DESIGN.md 3.7). Part of the background service worker: background.js loads it
// with importScripts, so both files share one global scope.
//
// "Start automation" (popup, or the browser opening when that switch is on) runs every saved search one after
// another — all Naukri links, then Indeed, then Glassdoor — in ONE window of its own, with each site's normal
// scraper started in mode "automation" (Indeed / Glassdoor then read one job page at a time, scraper-core.js).
// It never solves a captcha: a site that pauses gets one notification and waits for you (captchaWaitMinutes);
// if nobody comes, the run moves on. At the end the backend writes automation-finished.json (for Power Automate).
//
// The browser stops an idle service worker at any moment, so everything the run needs is in
// chrome.storage.local "auto_state"; memory only knows "this worker is starting a search right now".
// driveAutomation() reads auto_state + scrape_state and takes the next step. It runs on every scrape_state
// change, when a tab / window closes, and every minute from the "auto-watchdog" alarm (an alarm also wakes a
// stopped service worker). Running it twice in a row changes nothing the second time.
//
// Helpers used from background.js (only inside functions: this file runs before background.js has set its
// constants): getFromBackend, callBackend, clearRepostList, markScrapeStopped, notify, holdAwake, errorText,
// logError, jfLoadSettings, DEDUPE_GROUPS, SCRAPER_LABEL, TIMEOUT_MS.

const AUTO_SITES = ["naukri", "indeed", "glassdoor"]; // fixed run order
const AUTO_HOSTS = { // a saved link must be on its site (https only)
  naukri: /^www\.naukri\.com$/,
  indeed: /^(in|www)\.indeed\.com$/,
  glassdoor: /^www\.glassdoor\.(com|co\.in)$/,
};
const AUTO_ACTIVE = ["starting", "running", "waiting_for_you"]; // item statuses of the search being worked on
const AUTO_ALARM = "auto-watchdog";
const AUTO_NOTIFICATION_ID = "jf-auto"; // its own id, so it never replaces a scraper notification
const AUTO_SESSION_KEY = "auto_session"; // storage.session: id of this browser session (gone after a restart)
const AUTO_BOOT_KEY = "auto_boot"; // storage.session: {since} while "start when the browser opens" waits
// storage.session: time Start began checking the backend (up to 2 minutes); a popup opened meanwhile shows it
const AUTO_STARTING_KEY = "auto_starting";
const AUTO_PAGE_LOAD_MS = 60000; // a search page that hasn't finished loading by then is started anyway
const AUTO_SETTLE_MS = 5000; // after the page loaded, let the site draw its job cards before Start
const AUTO_START_RETRY_MS = 3000; // scrapeStart is sent again this often...
const AUTO_START_GIVE_UP_MS = 60000; // ...until the page's scraper answers, at most this long
const AUTO_START_ATTEMPTS = 3; // a start cut short by a service-worker restart is tried again, this often in all
const AUTO_STOP_REPLY_MS = 10000; // a scraper that doesn't confirm Stop within this is marked stopped by us
const AUTO_HANDOFF_LOST_MS = 120000; // Naukri "Next page" that no page took over after this = stalled
const AUTO_HEALTH_RETRY_MS = 15000; // Start button: ask the backend's /health this often...
const AUTO_HEALTH_WAIT_MS = 120000; // ...for up to this long
const AUTO_BOOT_POLL_MS = 20000; // browser opened: look for internet + backend this often...
const AUTO_BOOT_WAIT_MS = 600000; // ...for up to this long
const AUTO_BOOT_GUARD_MS = 6 * 3600000; // no automatic start if a run started less than 6 hours ago
const AUTO_MARKER_TRIES = 10; // the "finished" marker is sent again every minute until the backend took it

let lastScrapeChangeAt = 0; // when scrape_state last changed (seen by this service worker)
let startingKey = null; // "<run startedAt>/<index>" of the search this service worker is starting right now
let autoStarting = false; // autoStart is checking the backend (up to 2 minutes)
let autoStartCancelled = false; // Stop automation was pressed during that check
let bootLoopRunning = false;


// ─── Listeners (top level, so a restarted service worker gets them at once) ─────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.scrape_state) return;
  lastScrapeChangeAt = Date.now();
  driveAutomation();
});

// Tab / window closed: the drive notices when it was the automation's own tab.
chrome.tabs.onRemoved.addListener(() => driveAutomation());
chrome.windows.onRemoved.addListener(() => driveAutomation());

// startItem waits for the run tab to finish loading (see loadInRunTab); any other page the run tab loads may
// need the run taken over (see onRunTabLoaded).
const tabLoadWaiters = new Map(); // tabId → function(changeInfo)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const waiter = tabLoadWaiters.get(tabId);
  if (waiter) waiter(changeInfo);
  else if (changeInfo.status === "complete") onRunTabLoaded(tabId).catch(logError("automation: page loaded"));
});

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUTO_ALARM) onWatchdog().catch(logError("automation watchdog"));
  });
}

if (chrome.notifications) {
  chrome.notifications.onClicked.addListener((id) => {
    if (id === AUTO_NOTIFICATION_ID) showAutomationWindow().catch(logError("show automation window"));
  });
}

chrome.runtime.onStartup.addListener(() => {
  onBrowserStartup().catch(logError("automation on browser start"));
});

// The extension was reloaded or updated: storage.session and the alarm are gone, and the search page's script lost
// its link to us. Without this the popup would say "Running" until some other event; the drive closes the run.
chrome.runtime.onInstalled.addListener(() => driveAutomation());


// ─── Start / Stop (popup messages autoStart / autoStop) ─────────────────────────────────────────

// waitForBackend: the Start button gives you 2 minutes to start the backend; the browser-open start already waited.
async function autoStart({ waitForBackend }) {
  if (autoStarting) return { error: "the automation is already starting" };
  autoStarting = true;
  autoStartCancelled = false;
  try {
    await chrome.storage.session.remove(AUTO_BOOT_KEY); // started now: a waiting start-on-browser-open is not needed
    await chrome.storage.session.set({ [AUTO_STARTING_KEY]: Date.now() });
    const last = await loadAuto();
    if (last && last.running) return { error: "the automation is already running" };
    const scrape = await loadScrapeState();
    if (scrape && scrape.running) {
      if (await getTab(scrape.tabId)) {
        return { error: (SCRAPER_LABEL[scrape.site] || scrape.site) + " is being scraped right now: stop it first" };
      }
      await markScrapeStopped(null, "tab closed"); // left over: its tab is gone
    }

    const settings = await jfLoadSettings();
    const items = buildAutoItems(settings.automation.searches);
    if (!items.some((item) => item.status === "pending")) {
      return { error: "no valid search links saved (popup → Automation tab)" };
    }
    const ready = await backendReady(waitForBackend ? AUTO_HEALTH_WAIT_MS : 0);
    // Stop automation can come during any wait here (each one takes seconds): look again after every one.
    if (autoStartCancelled) return { error: "cancelled" };
    if (!ready) return { error: navigator.onLine ? "backend not reachable — start it first" : "no internet connection" };

    // Recorded in the run, never a reason to stop it.
    const notes = [];
    if (settings.automation.clearRepostListsBeforeStart) {
      for (const group of DEDUPE_GROUPS) {
        if (autoStartCancelled) return { error: "cancelled" }; // never clear lists for a run you stopped
        const reply = await clearRepostList(group);
        notes.push(reply.error ? "could not clear the " + group + " repost list: " + reply.error
          : "repost list " + group + " cleared (" + (reply.cleared || 0) + ")");
      }
    }
    await autoLocked(settleOldMarker); // the last run's "finished" must not land after this run's "started"
    if (autoStartCancelled) return { error: "cancelled" };
    const marked = await postAutomationMarker("/automation/started", {});
    if (marked.error) notes.push("the backend did not record the start: " + marked.error);
    // Stopped from here on: the backend has "started", so close it with "finished" too, or a Power Automate
    // flow would wait for nothing.
    const cancel = async (win) => {
      if (win) await chrome.windows.remove(win.id).catch(() => {});
      if (!marked.error) {
        for (const item of items) if (item.status === "pending") item.status = "skipped";
        await postAutomationMarker("/automation/finished", { summary: "stopped by user", items: finishedItems({ items }) });
      }
      return { error: "cancelled" };
    };
    if (autoStartCancelled) return cancel(null);

    // One window of its own, so you can keep working in your other windows.
    const win = await chrome.windows.create({ url: "about:blank", type: "normal", focused: true });
    const tabId = win.tabs && win.tabs.length ? win.tabs[0].id : (await chrome.tabs.query({ windowId: win.id }))[0].id;
    const now = Date.now();
    const auto = {
      running: true,
      startedAt: now,
      finishedAt: null,
      sessionId: await getSessionId(true),
      windowId: win.id,
      tabId,
      index: 0, // the search being worked on
      lastProgressAt: now, // last scrape_state change of the current search (stall check)
      items,
      notes,
      summary: null, // one line per search, written at the end
      marker: null, // "pending" → "sent" (or "failed: …"): the backend's automation-finished.json
    };
    // Last look for Stop + the save in one locked step: a Stop after it finds the run and stops it properly.
    const go = await autoLocked(async () => {
      if (autoStartCancelled) return false;
      await saveAuto(auto);
      return true;
    });
    if (!go) return cancel(win);
    ensureWatchdog();
    driveAutomation();
    return { ok: true };
  } finally {
    autoStarting = false;
    await chrome.storage.session.remove(AUTO_STARTING_KEY).catch(logError("automation: starting flag"));
  }
}

// A "finished" marker of the last run that the backend never took is sent now, or else dropped: sent later
// (by the watchdog) it would land after the new run's "started" and tell Power Automate the new run is over.
async function settleOldMarker() {
  const last = await loadAuto();
  if (!last || last.running || last.marker !== "pending") return;
  await sendFinishedMarker(last);
  if (last.marker === "pending") {
    last.marker = "failed: a new run started first";
    await saveAuto(last);
  }
}

// Stop automation: the current search is stopped and skipped, the rest skipped; no notification (you pressed it),
// but the backend still gets "finished" so a Power Automate flow waiting for it goes on.
async function autoStop() {
  autoStartCancelled = true; // a Start still checking the backend gives up
  await chrome.storage.session.remove(AUTO_BOOT_KEY);
  return autoLocked(async () => {
    const auto = await loadAuto();
    if (!auto || !auto.running) return { ok: true };
    const current = auto.items[auto.index];
    const wasActive = !!current && AUTO_ACTIVE.includes(current.status);
    const now = Date.now();
    for (const item of auto.items) {
      if (item.status !== "pending" && !AUTO_ACTIVE.includes(item.status)) continue;
      Object.assign(item, { status: "skipped", reason: item === current ? "stopped by user" : null, endedAt: now });
    }
    Object.assign(auto, { running: false, finishedAt: now, summary: "stopped by user", marker: "pending" });
    await saveAuto(auto);
    if (wasActive) await stopScrape(auto.tabId, "stopped by user");
    await sendFinishedMarker(auto);
    return { ok: true };
  });
}

// The saved links → one item per link, in run order. A link on the wrong site is an "error" item (shown, skipped).
function buildAutoItems(searches) {
  const items = [];
  for (const site of AUTO_SITES) {
    const urls = ((searches && searches[site]) || []).map((url) => String(url).trim()).filter(Boolean);
    urls.forEach((url, i) => {
      const fits = autoUrlFits(site, url);
      items.push({
        site,
        label: SCRAPER_LABEL[site] + (urls.length > 1 ? " " + (i + 1) + "/" + urls.length : ""), // "Glassdoor 2/3"
        url,
        status: fits ? "pending" : "error",
        reason: fits ? null : "this link is not on " + SCRAPER_LABEL[site],
        counts: null, // scrape_state.counts of its run
        startedAt: null,
        endedAt: null,
      });
    });
  }
  return items;
}

function autoUrlFits(site, url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && AUTO_HOSTS[site].test(parsed.hostname);
  } catch (_) {
    return false;
  }
}


// ─── The state machine ──────────────────────────────────────────────────────────────────────────

// Every change of auto_state goes through this queue, so two events close together can never both
// finish a search or both start the next one.
let autoQueue = Promise.resolve();
function autoLocked(fn) {
  const result = autoQueue.then(fn);
  autoQueue = result.catch(logError("automation"));
  return result;
}

// One drive waiting in the queue is enough: it reads the newest state when its turn comes.
let driveQueued = false;
function driveAutomation() {
  if (!driveQueued) {
    driveQueued = true;
    autoLocked(() => {
      driveQueued = false;
      return driveOnce();
    });
  }
  return autoQueue;
}

async function driveOnce() {
  const auto = await loadAuto();
  if (auto && !auto.running && auto.marker === "pending") return sendFinishedMarker(auto); // see finishAutomation
  if (!auto || !auto.running) return;

  // A run from before the browser was closed (its window is gone) or the extension was reloaded (its pages' scripts
  // can't reach us any more) can't go on.
  if (auto.sessionId !== (await getSessionId(false))) return endStaleRun(auto);

  const tab = await getTab(auto.tabId);
  if (!tab) return finishAutomation(auto, "the automation window was closed");
  auto.windowId = tab.windowId; // the tab may have been dragged into another window

  while (auto.items[auto.index] && !["pending", ...AUTO_ACTIVE].includes(auto.items[auto.index].status)) {
    auto.index += 1; // ended already (e.g. a link on the wrong site)
  }
  const item = auto.items[auto.index];
  if (!item) return finishAutomation(auto, null);

  if (item.status === "pending") {
    Object.assign(item, { status: "starting", startedAt: Date.now(), startAttempts: 1 });
    await saveAuto(auto);
    launchStart(auto);
  } else if (item.status === "starting") {
    await checkStarting(auto, item);
  } else {
    await checkRunning(auto, item);
  }
}

// "starting" with no start going on in this service worker = the worker was restarted in the middle of it.
async function checkStarting(auto, item) {
  if (startingKey === auto.startedAt + "/" + auto.index) return saveAuto(auto); // still busy; it reports back
  const scrape = await loadScrapeState();
  if (isRunOf(scrape, auto, item)) {
    // The scraper did start before the restart: carry on with it.
    Object.assign(item, { status: "running", runStartedAt: scrape.startedAt });
    auto.lastProgressAt = Date.now();
    await saveAuto(auto);
  } else if (item.startAttempts >= AUTO_START_ATTEMPTS) {
    endItem(auto, item, "error", "could not start the scraper on this page");
    await saveAuto(auto);
    driveAutomation();
  } else {
    Object.assign(item, { startedAt: Date.now(), startAttempts: item.startAttempts + 1 });
    await saveAuto(auto);
    launchStart(auto);
  }
}

// The search's scraper is running (or paused): follow its scrape_state.
async function checkRunning(auto, item) {
  const now = Date.now();
  const { automation: options } = await jfLoadSettings();
  const scrape = await loadScrapeState();
  let askForYou = false; // it just paused: one notification
  let stopReason = null; // we give up on this search: its scraper must be stopped

  if (isRunOf(scrape, auto, item)) {
    item.counts = scrape.counts || null;
    if (lastScrapeChangeAt > auto.lastProgressAt) auto.lastProgressAt = lastScrapeChangeAt;

    if (!scrape.running) {
      // Ended by itself (max pages, no more pages, ...), or someone pressed this site's Stop in the popup.
      const byUser = scrape.pauseReason === "stopped by user";
      endItem(auto, item, byUser ? "skipped" : "done", scrape.pauseReason);
    } else if (scrape.paused) {
      // A captcha / login wall / site still blocking: only you can fix it. Ask once, then wait.
      if (item.status !== "waiting_for_you") {
        Object.assign(item, { status: "waiting_for_you", waitingSince: now, reason: scrape.pauseReason });
        askForYou = true;
      }
    } else if (item.status === "waiting_for_you") {
      // You solved it and pressed Resume.
      Object.assign(item, { status: "running", waitingSince: null, reason: null });
      auto.lastProgressAt = now;
    } else if (scrape.handoffAt && now - scrape.handoffAt > AUTO_HANDOFF_LOST_MS) {
      endItem(auto, item, "stalled", "the next results page never took over");
      stopReason = "the automation moved on (the next page never loaded)";
    }
  }
  if (item.status === "waiting_for_you" && now - item.waitingSince >= minutes(options.captchaWaitMinutes)) {
    endItem(auto, item, "paused", item.reason);
    stopReason = "the automation moved on (nobody solved it in time)";
  }
  // No change at all for stallMinutes: the page hangs (or something else took scrape_state over).
  if (item.status === "running" && now - auto.lastProgressAt >= minutes(options.stallMinutes)) {
    endItem(auto, item, "stalled", "no progress for " + options.stallMinutes + " minutes");
    stopReason = "the automation moved on (no progress)";
  }

  await saveAuto(auto);
  if (askForYou) await notifyNeedsYou(item, options.captchaWaitMinutes);
  if (stopReason) await stopScrape(auto.tabId, stopReason);
  if (!AUTO_ACTIVE.includes(item.status)) driveAutomation(); // this search ended: on to the next one
}

// The scrape_state belongs to the run this item started (same tab, same site, started after the item).
function isRunOf(scrape, auto, item) {
  if (!scrape || scrape.tabId !== auto.tabId || scrape.site !== item.site) return false;
  return item.runStartedAt ? scrape.startedAt === item.runStartedAt : scrape.startedAt >= item.startedAt;
}

// The run tab loaded a page while its search runs. A Naukri "Next page" is taken over by the new page itself
// (resumeIfRunning, via handoffAt). Any other load (the site reloading or redirecting by itself, e.g. a "Just a
// moment…" check that clears on its own, or you clicking in that window) killed the old page's scraper, and no
// page would take the run over: the search would only end as "stalled" 15 minutes later, with nothing read.
// So the new page is asked to take the same run over (same startedAt: the item keeps following it). A page
// that runs it already just answers; a paused run still waits for your Resume.
async function onRunTabLoaded(tabId) {
  const auto = await loadAuto();
  if (!auto || !auto.running || auto.tabId !== tabId) return;
  const item = auto.items[auto.index];
  if (!item || !AUTO_ACTIVE.includes(item.status)) return; // "starting" too: its start may be finishing right now
  holdAwake(+1);
  try {
    await sleep(AUTO_SETTLE_MS); // let the site draw its job cards, and a Naukri hand-off reach storage
    const latest = await loadAuto();
    const same = !!latest && latest.running && latest.startedAt === auto.startedAt && latest.index === auto.index;
    const current = same ? latest.items[latest.index] : null;
    const scrape = await loadScrapeState();
    if (!current || current.status !== "running" || !isRunOf(scrape, latest, current)) return;
    if (!scrape.running || scrape.paused || scrape.handoffAt) return; // ended / waits for you / being handed over
    await chrome.tabs.sendMessage(tabId, { type: "scrapeResume", onlyIfRunning: true })
      .catch(() => {}); // not one of our search pages: the stall check deals with it
  } finally {
    holdAwake(-1);
  }
}

function endItem(auto, item, status, reason) {
  Object.assign(item, { status, reason: reason || null, endedAt: Date.now(), waitingSince: null });
  auto.index = auto.items.indexOf(item) + 1;
  auto.lastProgressAt = Date.now();
}

// The whole run is over: every search ran (error = it was cut short). One notification + the backend marker.
async function finishAutomation(auto, error) {
  const now = Date.now();
  for (const item of auto.items) {
    if (AUTO_ACTIVE.includes(item.status)) Object.assign(item, { status: "error", reason: error, endedAt: now });
    else if (item.status === "pending") Object.assign(item, { status: "skipped", reason: null, endedAt: now });
  }
  Object.assign(auto, {
    running: false,
    finishedAt: now,
    summary: (error ? "stopped: " + error + " · " : "") + autoSummary(auto.items),
    marker: "pending", // saved together with running:false, so a worker restart can't lose the marker
  });
  await saveAuto(auto);
  await notify("Automation finished", auto.summary, AUTO_NOTIFICATION_ID);
  await sendFinishedMarker(auto);
}

// POST /automation/finished (what Power Automate waits for). Until the backend took it, the watchdog alarm stays
// on and every drive sends it again (at most AUTO_MARKER_TRIES times, a minute apart).
async function sendFinishedMarker(auto) {
  const reply = await postAutomationMarker("/automation/finished", { summary: auto.summary, items: finishedItems(auto) });
  auto.markerTries = (auto.markerTries || 0) + 1;
  if (!reply.error) auto.marker = "sent";
  else if (auto.markerTries >= AUTO_MARKER_TRIES) auto.marker = "failed: " + reply.error;
  await saveAuto(auto);
  if (auto.marker !== "pending") await clearWatchdog();
}

// A run the browser was closed (or the extension reloaded) in the middle of. Closed quietly: no notification, and
// NO "finished" marker, because a Power Automate flow that just opened the browser for a new run must not see one.
async function endStaleRun(auto) {
  const now = Date.now();
  for (const item of auto.items) {
    if (AUTO_ACTIVE.includes(item.status)) {
      Object.assign(item, { status: "error", reason: "the browser or the extension restarted during the run", endedAt: now });
    } else if (item.status === "pending") {
      Object.assign(item, { status: "skipped", reason: null, endedAt: now });
    }
  }
  Object.assign(auto, {
    running: false,
    finishedAt: now,
    summary: "the browser or the extension restarted before the run finished · " + autoSummary(auto.items),
    marker: null, // never sent for this run
  });
  await saveAuto(auto);
  await clearWatchdog();
}

// "Naukri: 12 matches · Indeed: paused (captcha) · Glassdoor 1/3: 4 matches · …"
function autoSummary(items) {
  return items.map((item) => item.label + ": " + itemOutcome(item)).join(" · ");
}

function itemOutcome(item) {
  const matched = itemMatched(item);
  const matches = matched + (matched === 1 ? " match" : " matches");
  if (item.status === "done") return matches;
  const why = shortReason(item.reason);
  const text = item.status + (why ? " (" + why + ")" : "");
  return matched ? text + ", " + matches : text;
}

function shortReason(reason) {
  if (!reason) return "";
  if (/still blocked/i.test(reason)) return "rate limit";
  if (/captcha|security check|verify you are|access denied/i.test(reason)) return "captcha";
  if (/login|sign.?in/i.test(reason)) return "login wall";
  return reason.length > 50 ? reason.slice(0, 49) + "…" : reason;
}

function itemMatched(item) {
  return (item.counts && item.counts.matched) || 0;
}

// What the backend stores in automation-finished.json (DESIGN.md 2.2).
function finishedItems(auto) {
  return auto.items.map((item) => ({
    site: item.site,
    url: item.url,
    status: item.status,
    matched: itemMatched(item),
    reason: item.reason,
  }));
}

async function notifyNeedsYou(item, waitMinutes) {
  const site = SCRAPER_LABEL[item.site] || item.site;
  const fix = shortReason(item.reason) === "captcha" || shortReason(item.reason) === "rate limit"
    ? "Solve the captcha in the Job Filter window, then press Resume"
    : "The run paused (" + (item.reason || "unknown reason") + "). Fix it in the Job Filter window, then press Resume";
  await notify(site + " needs you",
    fix + " (extension icon → " + site + "). Without you it moves on in " + waitMinutes + " min.",
    AUTO_NOTIFICATION_ID);
}

// Clicking an automation notification brings the automation window to the front.
async function showAutomationWindow() {
  await chrome.notifications.clear(AUTO_NOTIFICATION_ID);
  const auto = await loadAuto();
  if (!auto || auto.tabId == null) return;
  const tab = await chrome.tabs.update(auto.tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}


// ─── Starting one search ────────────────────────────────────────────────────────────────────────

// Runs startItem in the background of the drive (it can take a minute); the drive goes on meanwhile.
function launchStart(auto) {
  const key = auto.startedAt + "/" + auto.index;
  startingKey = key;
  startItem(auto.startedAt, auto.index, auto.items[auto.index].startedAt)
    .catch(logError("automation: start search"))
    .finally(() => {
      if (startingKey === key) startingKey = null;
      driveAutomation(); // on success it follows the run; on failure it retries or moves on
    });
}

// Open the search in the run tab, wait until it loaded + 5 s, then start its scraper in mode "automation".
async function startItem(runStartedAt, index, itemStartedAt) {
  // Still the same run, the same search, the same attempt? (Stop, the window closing or a newer attempt end us.)
  const current = async () => {
    const auto = await loadAuto();
    const item = auto && auto.items[index];
    const same = !!auto && auto.running && auto.startedAt === runStartedAt && auto.index === index
      && item.status === "starting" && item.startedAt === itemStartedAt;
    return same ? auto : null;
  };
  holdAwake(+1); // the waits below are longer than an idle service worker lives
  try {
    const auto = await current();
    if (!auto) return;
    const tabId = auto.tabId;
    await ensureScrapeStopped(); // never two scraper runs at once
    await loadInRunTab(tabId, auto.items[index].url);
    if (!(await current())) return;
    await sleep(AUTO_SETTLE_MS);
    if (!(await current())) return;
    const reply = await sendScrapeStart(tabId, current);

    await autoLocked(async () => {
      const latest = await current();
      if (!latest) {
        if (reply.state) await stopScrape(tabId, "stopped by user"); // Stop automation came meanwhile
        return;
      }
      const item = latest.items[index];
      if (reply.state) {
        Object.assign(item, { status: "running", runStartedAt: reply.state.startedAt });
        latest.lastProgressAt = Date.now();
      } else {
        endItem(latest, item, "error", reply.error);
      }
      await saveAuto(latest);
    });
  } finally {
    holdAwake(-1);
  }
}

// Navigate the run tab and wait for "complete" after a fresh "loading" (the old page was complete too).
// Resolves false when the page is still loading after AUTO_PAGE_LOAD_MS: we try to start it anyway.
function loadInRunTab(tabId, url) {
  return new Promise((resolve, reject) => {
    let sawLoading = false;
    const finish = (loaded) => {
      clearTimeout(timer);
      tabLoadWaiters.delete(tabId);
      resolve(loaded);
    };
    const timer = setTimeout(() => finish(false), AUTO_PAGE_LOAD_MS);
    tabLoadWaiters.set(tabId, (changeInfo) => {
      if (changeInfo.status === "loading") sawLoading = true;
      else if (changeInfo.status === "complete" && sawLoading) finish(true);
    });
    chrome.tabs.update(tabId, { url }).catch((err) => {
      clearTimeout(timer);
      tabLoadWaiters.delete(tabId);
      reject(err); // the tab is gone: the next drive ends the run
    });
  });
}

// scrapeStart until the page's scraper answers with a running automation run. → {state} or {error}
async function sendScrapeStart(tabId, current) {
  const giveUpAt = Date.now() + AUTO_START_GIVE_UP_MS;
  let problem = "";
  for (;;) {
    try {
      const state = await chrome.tabs.sendMessage(tabId, { type: "scrapeStart", mode: "automation" });
      if (state && state.running && state.mode === "automation") return { state };
      problem = (state && state.error) || "the scraper did not start";
    } catch (err) {
      problem = errorText(err); // e.g. "Receiving end does not exist": the page's script isn't there (yet)
    }
    if (Date.now() >= giveUpAt || !(await current())) {
      const silent = /receiving end does not exist/i.test(problem);
      return { error: silent ? "the page never answered (is it a search page?)" : "the page did not start: " + problem };
    }
    await sleep(AUTO_START_RETRY_MS);
  }
}

// Stop the scraper in that tab and make sure scrape_state says so, even if the page doesn't answer.
async function stopScrape(tabId, reason) {
  try {
    await withTimeout(chrome.tabs.sendMessage(tabId, { type: "scrapeStop", reason }), AUTO_STOP_REPLY_MS);
  } catch (_) {
    // No scraper on that page any more.
  }
  await markScrapeStopped(tabId, reason);
}

async function ensureScrapeStopped() {
  const scrape = await loadScrapeState();
  if (!scrape || !scrape.running) return;
  await stopScrape(scrape.tabId, "the automation moved on");
  await markScrapeStopped(null, "the automation moved on"); // whatever tab it claimed to be in
}


// ─── Watchdog alarm + "start when the browser opens" ────────────────────────────────────────────

function ensureWatchdog() {
  if (chrome.alarms) chrome.alarms.create(AUTO_ALARM, { periodInMinutes: 1 });
}

async function clearWatchdog() {
  if (chrome.alarms) await chrome.alarms.clear(AUTO_ALARM);
}

async function onWatchdog() {
  await driveAutomation();
  if ((await chrome.storage.session.get(AUTO_BOOT_KEY))[AUTO_BOOT_KEY]) {
    resumeBoot(); // a restarted worker picks the wait for the backend up again
    return;
  }
  const auto = await loadAuto();
  if (!auto || (!auto.running && auto.marker !== "pending")) await clearWatchdog(); // nothing left to watch
}

// The browser opened (onStartup only: not when the extension is reloaded or a window is opened).
async function onBrowserStartup() {
  await driveAutomation(); // closes, quietly, a run the browser was closed in the middle of
  const { automation: options } = await jfLoadSettings();
  if (!options.startOnBrowserOpen) return;
  const last = await loadAuto();
  if (last && last.startedAt && Date.now() - last.startedAt < AUTO_BOOT_GUARD_MS) return; // ran today already
  await chrome.storage.session.set({ [AUTO_BOOT_KEY]: { since: Date.now() } });
  ensureWatchdog();
  resumeBoot();
}

function resumeBoot() {
  if (bootLoopRunning) return;
  bootLoopRunning = true;
  holdAwake(+1);
  bootLoop()
    .catch(logError("start on browser open"))
    .finally(() => {
      bootLoopRunning = false;
      holdAwake(-1);
    });
}

// Opening the browser starts the run only when the internet is up AND the backend answers, so someone who
// opens the browser without the backend starts nothing. Checked every 20 s for 10 minutes.
async function bootLoop() {
  for (;;) {
    const boot = (await chrome.storage.session.get(AUTO_BOOT_KEY))[AUTO_BOOT_KEY];
    if (!boot) return; // started by hand meanwhile
    if (navigator.onLine && (await backendHealthy())) {
      await chrome.storage.session.remove(AUTO_BOOT_KEY);
      const reply = await autoStart({ waitForBackend: false });
      // You pressed Start (or Stop) at the same moment: nothing to tell you.
      const startedByHand = reply.error && /already|cancelled/.test(reply.error);
      if (reply.error && !startedByHand) await notify("Automation not started", reply.error, AUTO_NOTIFICATION_ID);
      return;
    }
    if (Date.now() - boot.since >= AUTO_BOOT_WAIT_MS) {
      await chrome.storage.session.remove(AUTO_BOOT_KEY);
      await notify("Automation not started", "backend not running / no internet", AUTO_NOTIFICATION_ID);
      const auto = await loadAuto();
      if (!auto || (!auto.running && auto.marker !== "pending")) await clearWatchdog();
      return;
    }
    await sleep(AUTO_BOOT_POLL_MS);
  }
}


// ─── Backend + small helpers ────────────────────────────────────────────────────────────────────

async function backendHealthy() {
  const reply = await getFromBackend("/health", TIMEOUT_MS.health);
  return !!reply && !reply.error && reply.ok === true;
}

// True as soon as the internet is up and /health answers; asks now and then every 15 s for up to waitMs
// (2 minutes = 9 times).
async function backendReady(waitMs) {
  const tries = 1 + Math.floor(waitMs / AUTO_HEALTH_RETRY_MS);
  for (let i = 1; ; i++) {
    if (navigator.onLine && (await backendHealthy())) return true;
    if (i >= tries || autoStartCancelled) return false;
    await sleep(AUTO_HEALTH_RETRY_MS);
  }
}

// started / finished markers: not screening, so they go through even with AI off. Never throws.
async function postAutomationMarker(path, body) {
  const settings = await jfLoadSettings();
  return callBackend(settings.backendUrl, path, { method: "POST", body }, TIMEOUT_MS.dedupe);
}

async function loadAuto() {
  return (await chrome.storage.local.get("auto_state")).auto_state || null;
}

async function saveAuto(auto) {
  await chrome.storage.local.set({ auto_state: auto });
}

async function loadScrapeState() {
  return (await chrome.storage.local.get("scrape_state")).scrape_state || null;
}

// Id of this browser session, kept in storage.session (emptied when the browser or the extension restarts).
async function getSessionId(create) {
  const stored = (await chrome.storage.session.get(AUTO_SESSION_KEY))[AUTO_SESSION_KEY];
  if (stored || !create) return stored || null;
  const id = Date.now() + "-" + Math.random().toString(36).slice(2);
  await chrome.storage.session.set({ [AUTO_SESSION_KEY]: id });
  return id;
}

async function getTab(tabId) {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch (_) {
    return null; // closed
  }
}

function minutes(n) {
  return Math.max(1, Number(n) || 1) * 60000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
