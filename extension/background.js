// Job Filter v2 — background service worker (Chrome MV3, classic script).
//
// What lives here:
//   1. Backend calls: the ONLY place page data leaves the browser, and only to settings.backendUrl.
//   2. LinkedIn hiding: a USER stylesheet injected into the tab (linkedin.js itself never writes to the page).
//   3. Toolbar badge per tab: LinkedIn verdict, or matched count while scraping ("!" while a run is paused).
//   4. Naukri worker window: a minimized window whose tabs open job pages so naukri-job.js can read the JD.
//   5. Desktop notifications when a Glassdoor / Naukri / Indeed run pauses or finishes (never for LinkedIn).
//
// Chrome kills an idle service worker at any time and starts it again on the next event, so global variables
// can vanish. State that must survive (CSS injected per page, worker window id) is kept in chrome.storage.session.
// Pending replies (promises) can't be stored; if the worker dies they die too, and the content script just sees
// a closed message port, which it already treats as an error.
//
// Messages: see DESIGN.md 3.3. One extra type used by the side panel:
//   {type: "stats"} → GET <backend>/stats → {date, sites: {<site>: {matches, rejected}}} or {error}

importScripts("common/filters.js"); // JF_DEFAULT_SETTINGS, jfLoadSettings

// title: one call holds up to 25 jobs; Jev answers each fast, but retries on 429 can add up,
// so allow a generous 60 s. Timing out earlier would count an error while the backend keeps working.
const TIMEOUT_MS = { title: 60000, jd: 60000, health: 5000, stats: 5000, dedupe: 10000 };
const NAUKRI_JOB_TIMEOUT_MS = 25000;
const NAUKRI_MAX_TABS = 4; // hard cap, whatever settings.naukri.jdTabs says (the popup allows 1-4)
const DEDUPE_GROUPS = ["naukri", "glassdoor_indeed"]; // backend repost lists (Glassdoor + Indeed share one)
const SCRAPER_LABEL = { glassdoor: "Glassdoor", naukri: "Naukri", indeed: "Indeed" }; // sites that notify
const NOTIFICATION_ID = "jf-scrape"; // one id: a new notification replaces the previous one
// 48x48 blue tile with a white funnel. Chrome requires an icon for notifications, and this one needs no file.
const NOTIFICATION_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAqElEQVR42u2aOxKAIAwFaT2qV/Yy2tn4BQJ5yWxm7Cx2G/IgKeWhlnXblb7yt9TAq0TU4V8losDfSkSDv0iEFogKf0oggAAC3z95FQIIIGB4CinCVx+javBNfUAJvrmRqcB3dWIF+O4o4Q1vkoU84c3CnBe8aRr1gDeP07Phh9wHZsIPu9DMgkcAAQQQQAABBFIK8LiLAHMyppT5Z8X5Vg1SLHtEXLc5AMidxJ1dNla5AAAAAElFTkSuQmCC";
const BADGE_COLOR = { pass: "#1a7f37", reject: "#cf222e", busy: "#6e7781" };
const LI_CSS_KEY = "li_css_"; // storage.session "li_css_<tabId>" → {<documentId>: css} stylesheet in each page of that tab
const LI_CSS_PAGES_KEPT = 6; // newest pages remembered per tab (about what Chrome's back/forward cache holds)
const WORKER_WINDOW_KEY = "naukri_worker_window"; // storage.session → id of the minimized worker window


// ─── 1. Message router ──────────────────────────────────────────────────────────────────────────

// Each handler gets (msg, sender) and returns the reply (or a promise of it).
const HANDLERS = {
  screenTitle: (msg) => postToBackend("/screen/title", { site: msg.site, jobs: msg.jobs || [] }, TIMEOUT_MS.title),
  screenJd: (msg) => postToBackend("/screen/jd", { site: msg.site, job: msg.job }, TIMEOUT_MS.jd),
  health: () => getFromBackend("/health", TIMEOUT_MS.health),
  stats: () => getFromBackend("/stats", TIMEOUT_MS.stats),
  dedupeClear: (msg) => clearRepostList(msg.group),
  liHide: (msg, sender) => queueLinkedInHide(sender, msg.jobIds),
  liVerdict: (msg, sender) => showLinkedInBadge(sender, msg.jobId, msg.verdict),
  scrapeProgress: (msg, sender) => mirrorScrapeProgress(sender, msg.state),
  naukriFetchJd: (msg) => naukriFetchJd(msg.url, msg.jobId),
  naukriWorkerHello: (msg, sender) => naukriWorkerHello(sender),
  naukriJdReady: (msg, sender) => naukriJdReady(sender, msg),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && HANDLERS[msg.type];
  if (!handler) return false; // not ours: let other listeners answer

  const reply = (value) => {
    try { sendResponse(value); } catch (_) { /* the sender went away (tab closed / navigated) */ }
  };
  holdAwake(+1);
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((value) => reply(value || { ok: true }))
    .catch((err) => {
      console.warn("[JobFilter] " + msg.type + " failed:", err);
      reply({ error: errorText(err) });
    })
    .finally(() => holdAwake(-1));
  return true; // we always answer asynchronously, so keep the message channel open
});


// ─── 2. Backend ─────────────────────────────────────────────────────────────────────────────────

// Screening calls respect the AI on/off switch; health/stats are diagnostics and always go through.
async function postToBackend(path, body, timeoutMs) {
  const settings = await jfLoadSettings();
  if (!settings.aiEnabled) return { error: "ai_disabled" };
  return callBackend(settings.backendUrl, path, { method: "POST", body }, timeoutMs);
}

async function getFromBackend(path, timeoutMs) {
  const settings = await jfLoadSettings();
  return callBackend(settings.backendUrl, path, { method: "GET" }, timeoutMs);
}

// Popup "Clear repost list": the backend forgets the (title, company) pairs it has seen for one group, so
// reposts are judged again. Not screening, so it works with AI off too. → {cleared: n} or {error}
async function clearRepostList(group) {
  if (!DEDUPE_GROUPS.includes(group)) return { error: "unknown repost list: " + group };
  const settings = await jfLoadSettings();
  return callBackend(settings.backendUrl, "/dedupe/clear", { method: "POST", body: { group } }, TIMEOUT_MS.dedupe);
}

// fetch + timeout. Never throws: any failure becomes {error: "..."} for the caller to show or count.
async function callBackend(baseUrl, path, { method, body }, timeoutMs) {
  const url = String(baseUrl || JF_DEFAULT_SETTINGS.backendUrl).replace(/\/+$/, "") + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { error: "backend HTTP " + res.status + (text ? ": " + text.slice(0, 200) : "") };
    }
    return await res.json();
  } catch (err) {
    if (err && err.name === "AbortError") return { error: "timeout" };
    return { error: "backend request failed (" + url + "): " + errorText(err) };
  } finally {
    clearTimeout(timer);
  }
}


// ─── 3. LinkedIn: hide cards with an injected USER stylesheet (DESIGN.md 3.4) ───────────────────

// Two liHide messages close together must not interleave (both would remove the same old CSS and the
// first new CSS would stay stuck in the page), so they run one after another.
let liHideChain = Promise.resolve();

function queueLinkedInHide(sender, jobIds) {
  const run = () => applyLinkedInHide(sender, jobIds);
  liHideChain = liHideChain.then(run, run);
  return liHideChain;
}

// Replace the page's stylesheet: remove the previous CSS, insert the new one.
// The record is kept per document (sender.documentId), not per tab, because a tab can hold several:
//   - a reload makes a new document; the old stylesheet died with the old one, so the new page starts empty;
//   - LinkedIn's in-page navigations keep the same document, and its stylesheet stays applied;
//   - Back / Forward can bring an older document back from Chrome's cache WITH its stylesheet still applied.
async function applyLinkedInHide(sender, jobIds) {
  const tabId = sender.tab && sender.tab.id;
  const documentId = sender.documentId;
  if (tabId == null || !documentId) return { error: "no_tab" };

  const key = LI_CSS_KEY + tabId;
  const pages = (await chrome.storage.session.get(key))[key] || {};
  const previous = pages[documentId] || "";
  const css = buildLinkedInHideCss(jobIds);
  if (previous === css) return { ok: true }; // nothing changed

  // Target the sender's document, not "whatever is in the tab now": a late message from a page that was
  // just reloaded must fail, instead of landing in the new page where nothing would ever remove it.
  const target = { tabId, documentIds: [documentId] };
  if (previous) {
    try {
      await chrome.scripting.removeCSS({ target, css: previous, origin: "USER" });
    } catch (_) {
      // That document is gone: nothing to undo.
    }
  }
  let applied = "";
  try {
    if (css) await chrome.scripting.insertCSS({ target, css, origin: "USER" });
    applied = css;
  } finally {
    // Record what is really in that page now (even if the insert failed) so the next call never skips it.
    delete pages[documentId]; // re-added below, so it becomes the newest entry
    if (applied) pages[documentId] = applied;
    for (const oldId of Object.keys(pages).slice(0, -LI_CSS_PAGES_KEPT)) delete pages[oldId];
    await chrome.storage.session.set({ [key]: pages });
  }
  return { ok: true };
}

// One rule hiding every given card. Both selectors are needed: some cards carry the id on the <li>,
// others only on an inner element.
function buildLinkedInHideCss(jobIds) {
  // LinkedIn job ids are numbers; stripping anything else means a weird id can never break the CSS.
  const ids = [...new Set((jobIds || []).map((id) => String(id).replace(/[^A-Za-z0-9_-]/g, "")).filter(Boolean))];
  if (!ids.length) return "";
  const selectors = ids.flatMap((id) => [
    'li[data-occludable-job-id="' + id + '"]',
    'li.scaffold-layout__list-item:has([data-job-id="' + id + '"])',
  ]);
  return selectors.join(",\n") + " {display:none !important}";
}

// The tab closed: all its pages and our stylesheets are gone.
async function forgetLinkedInTab(tabId) {
  await chrome.storage.session.remove(LI_CSS_KEY + tabId);
}

// The tab went from LinkedIn to another site. Only tabs that showed LinkedIn have a record, so other
// tabs' badges (e.g. a scrape count) are left alone.
async function clearLinkedInBadge(tabId) {
  const key = LI_CSS_KEY + tabId;
  if ((await chrome.storage.session.get(key))[key]) await setBadge(tabId, "");
}


// ─── 4. Badges ──────────────────────────────────────────────────────────────────────────────────

async function setBadge(tabId, text, color) {
  if (tabId == null) return;
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text && color) await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch (_) {
    // The tab closed meanwhile; nothing to show.
  }
}

// LinkedIn: pass → match score in green, reject → ✕ in red, still working → … in grey, no job open → empty.
async function showLinkedInBadge(sender, jobId, verdict) {
  const tabId = sender.tab && sender.tab.id;
  if (!jobId) {
    await setBadge(tabId, "");
  } else if (verdict && verdict.decision === "pass") {
    const score = verdict.match_score != null ? String(Math.round(verdict.match_score)) : "✓";
    await setBadge(tabId, score, BADGE_COLOR.pass);
  } else if (verdict && verdict.decision === "reject") {
    await setBadge(tabId, "✕", BADGE_COLOR.reject);
  } else if (verdict && verdict.error) {
    await setBadge(tabId, "!", BADGE_COLOR.busy);
  } else {
    await setBadge(tabId, "…", BADGE_COLOR.busy);
  }
  return { ok: true };
}


// ─── 5. Scraper progress ────────────────────────────────────────────────────────────────────────

// Scrapers report their state here; the popup reads it from storage and the badge shows matched count
// (a red "!" while the run is paused and waits for you).
// A content script can't know its own tab id, so we stamp it from the sender: the tab-closed cleanup
// (markScrapeStopped) and the popup's Stop / Resume both need scrape_state.tabId.
// The popup also sends one ("stopped by user") when Stop can't reach the scraping page; it has no sender
// tab, so the tabId already in the state is kept.
async function mirrorScrapeProgress(sender, state) {
  if (!state || typeof state !== "object") return { error: "missing state" };
  const tabId = sender.tab ? sender.tab.id : state.tabId;
  await chrome.storage.local.set({ scrape_state: { ...state, tabId } });
  if (state.paused) {
    await setBadge(tabId, "!", BADGE_COLOR.reject);
  } else {
    const matched = (state.counts && state.counts.matched) || 0;
    await setBadge(tabId, String(matched), BADGE_COLOR.pass);
  }
  return { ok: true };
}

// A run whose tab is gone can never finish by itself; mark it stopped so the popup isn't stuck on "running".
// onlyTabId = null means "whatever tab it was".
async function markScrapeStopped(onlyTabId, reason) {
  const { scrape_state: state } = await chrome.storage.local.get("scrape_state");
  if (!state || !state.running) return;
  if (onlyTabId != null && state.tabId !== onlyTabId) return;
  await chrome.storage.local.set({ scrape_state: { ...state, running: false, paused: false, pauseReason: reason } });
}

// A run that pauses (captcha, login wall, site still blocking after the rate-limit waits, backend down) waits
// for you, and you may be in another window, so it pops a desktop notification. So does a finished run.
// before / after = scrape_state before and after a change (see the storage listener in section 7).
async function notifyScrapeChange(before, after) {
  if (!after || !SCRAPER_LABEL[after.site]) return; // only the scrapers; LinkedIn never notifies
  const site = SCRAPER_LABEL[after.site];
  if (after.running && after.paused && !(before && before.paused)) {
    await notify(site + " paused", after.pauseReason || "unknown reason");
  } else if (before && before.running && !after.running && after.pauseReason !== "stopped by user") {
    await notify(site + " finished", scrapeSummary(after)); // (no notification when you pressed Stop yourself)
  }
}

// "no more pages · 3 pages. 12 matched, 48 rejected by AI, 15 reposts hidden, 30 hidden by rules, 1 error"
function scrapeSummary(state) {
  const c = state.counts || {};
  const parts = [
    (c.matched || 0) + " matched",
    (c.titleRejected || 0) + (c.jdRejected || 0) + " rejected by AI",
    (c.duplicates || 0) + " reposts hidden",
    (c.ruleHidden || 0) + " hidden by rules",
  ];
  if (c.errors) parts.push(c.errors + (c.errors === 1 ? " error" : " errors"));
  const pages = (state.pagesDone || 0) + (state.pagesDone === 1 ? " page" : " pages");
  return (state.pauseReason || "done") + " · " + pages + ". " + parts.join(", ") + ".";
}

async function notify(title, message) {
  if (!chrome.notifications) return; // "notifications" permission missing: nothing to show
  try {
    await chrome.notifications.create(NOTIFICATION_ID, {
      type: "basic",
      iconUrl: NOTIFICATION_ICON,
      title: "Job Filter: " + title,
      message: String(message).slice(0, 300),
      priority: 1,
    });
  } catch (err) {
    logError("notification")(err);
  }
}

// Clicking the notification brings the scraping tab to the front.
async function showScrapeTab(notificationId) {
  if (notificationId !== NOTIFICATION_ID) return;
  await chrome.notifications.clear(notificationId);
  const { scrape_state: state } = await chrome.storage.local.get("scrape_state");
  if (!state || state.tabId == null) return;
  const tab = await chrome.tabs.update(state.tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}


// ─── 6. Naukri worker window (DESIGN.md 3.5) ────────────────────────────────────────────────────
//
// Naukri's JD API needs reCAPTCHA, so we never call it. Instead the real job page is opened in a minimized,
// unfocused window and naukri-job.js reads the JD from the rendered page and sends it back (naukriJdReady).
// At most settings.naukri.jdTabs pages load at once; extra requests wait in a queue. Tabs are reused.

const naukriQueue = []; // requests waiting for a free tab: {url, jobId, resolve}
const naukriBusy = new Map(); // tabId → {jobId, pageKey, resolve, timer} for the job that tab is loading right now
let naukriPumping = false;

function naukriFetchJd(url, jobId) {
  if (typeof url !== "string" || !url.startsWith("https://www.naukri.com/")) return { error: "bad_url" };
  return new Promise((resolve) => {
    naukriQueue.push({ url, jobId: String(jobId), resolve });
    pumpNaukriQueue();
  });
}

// Hand queued requests to free worker tabs. Only one pump runs at a time so two requests never grab the same tab.
async function pumpNaukriQueue() {
  if (naukriPumping) return;
  naukriPumping = true;
  try {
    while (naukriQueue.length) {
      const { naukri } = await jfLoadSettings();
      const maxTabs = Math.min(Math.max(parseInt(naukri.jdTabs, 10) || 1, 1), NAUKRI_MAX_TABS);
      if (naukriBusy.size >= maxTabs) break; // all tabs busy; settleNaukriJob() pumps again when one frees up

      const job = naukriQueue.shift();
      if (!job) break; // scraping stopped while we read the settings: closeNaukriWorker emptied the queue
      try {
        startNaukriJob(await getFreeWorkerTab(), job);
      } catch (err) {
        job.resolve({ error: "worker window: " + errorText(err) });
      }
    }
  } finally {
    naukriPumping = false;
  }
}

// Register the job BEFORE navigating, so the page's naukriWorkerHello always finds it.
function startNaukriJob(tabId, job) {
  const timer = setTimeout(() => settleNaukriJob(tabId, { error: "timeout" }), NAUKRI_JOB_TIMEOUT_MS);
  naukriBusy.set(tabId, { jobId: job.jobId, pageKey: naukriPageKey(job.url), resolve: job.resolve, timer });
  chrome.tabs.update(tabId, { url: job.url })
    .catch((err) => settleNaukriJob(tabId, { error: "could not open job page: " + errorText(err) }));
}

// Reply to the scraper waiting on this tab. Returns false if the tab had no job.
function finishNaukriJob(tabId, result) {
  const entry = naukriBusy.get(tabId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  naukriBusy.delete(tabId);
  entry.resolve(result);
  return true;
}

// Finish the job, then give the tab to the next request, or park it on about:blank so the job page stops running.
function settleNaukriJob(tabId, result) {
  if (!finishNaukriJob(tabId, result)) return;
  if (naukriQueue.length) pumpNaukriQueue();
  else chrome.tabs.update(tabId, { url: "about:blank" }).catch(() => { /* tab already closed */ });
}

async function getFreeWorkerTab() {
  const win = await ensureWorkerWindow();
  const free = (win.tabs || []).find((tab) => !naukriBusy.has(tab.id));
  if (free) return free.id;
  const tab = await chrome.tabs.create({ windowId: win.id, url: "about:blank", active: false });
  return tab.id;
}

// The worker window (with its tabs), created on first use or again if the user closed it.
async function ensureWorkerWindow() {
  const windowId = (await chrome.storage.session.get(WORKER_WINDOW_KEY))[WORKER_WINDOW_KEY];
  if (windowId != null) {
    try {
      return await chrome.windows.get(windowId, { populate: true });
    } catch (_) {
      // Closed by the user: make a new one below.
    }
  }
  const created = await chrome.windows.create({ url: "about:blank", focused: false, state: "minimized" });
  await chrome.storage.session.set({ [WORKER_WINDOW_KEY]: created.id });
  return chrome.windows.get(created.id, { populate: true });
}

// Which job a Naukri job-page URL shows: the number at the end of its path
// (".../job-listings-ai-engineer-acme-bengaluru-3-to-8-years-141024012345?src=…" → "141024012345"),
// or the whole path when there is none. The query string (tracking params) is ignored.
function naukriPageKey(url) {
  try {
    const path = new URL(url).pathname;
    const match = /-(\d{6,})\/?$/.exec(path);
    return match ? match[1] : path;
  } catch (_) {
    return "";
  }
}

// The job the sender's tab is loading, but only if the sender IS that job's page. Right after a timeout the
// tab already has the next job while the old job's page may still be the one showing; that page must not
// take the new jobId, or it would send its own JD back under the new job's id.
function naukriJobFor(sender) {
  const entry = sender.tab && naukriBusy.get(sender.tab.id);
  return entry && naukriPageKey(sender.url) === entry.pageKey ? entry : null;
}

// naukri-job.js asks on load: "was I opened by the scraper?" Only worker tabs get a jobId.
function naukriWorkerHello(sender) {
  const entry = naukriJobFor(sender);
  return entry ? { worker: true, jobId: entry.jobId } : { worker: false };
}

function naukriJdReady(sender, msg) {
  const entry = naukriJobFor(sender);
  // Ignore late answers for a job we already gave up on (timeout) or that belong to an older job in this tab.
  if (!entry || String(msg.jobId) !== entry.jobId) return { ok: false };

  settleNaukriJob(sender.tab.id, msg.error ? { error: String(msg.error) } : {
    jd: msg.jd || "",
    title: msg.title || "",
    company: msg.company || "",
    experience_text: msg.experience_text || "",
  });
  return { ok: true };
}

// Scraping stopped: answer everything still waiting, then close the worker window.
async function closeNaukriWorker(reason) {
  for (const job of naukriQueue.splice(0)) job.resolve({ error: reason });
  for (const tabId of [...naukriBusy.keys()]) finishNaukriJob(tabId, { error: reason });

  const windowId = (await chrome.storage.session.get(WORKER_WINDOW_KEY))[WORKER_WINDOW_KEY];
  if (windowId == null) return;
  await chrome.storage.session.remove(WORKER_WINDOW_KEY);
  try {
    await chrome.windows.remove(windowId);
  } catch (_) {
    // Already closed.
  }
}


// ─── 7. Browser events ──────────────────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetLinkedInTab(tabId).catch(logError("forget LinkedIn tab"));
  settleNaukriJob(tabId, { error: "worker tab closed" });
  markScrapeStopped(tabId, "tab closed").catch(logError("mark scrape stopped"));
});

// When a LinkedIn tab navigates to another site, clear its LinkedIn badge. Its stylesheet records stay:
// pressing Back can restore the LinkedIn page from Chrome's back/forward cache with our stylesheet still
// applied, and only the record lets the next liHide remove it. Closed tabs are cleaned up in onRemoved.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "loading" || !tab.url || tab.url.startsWith("https://www.linkedin.com/")) return;
  clearLinkedInBadge(tabId).catch(logError("clear LinkedIn badge"));
});

// The user closed the worker window: forget it, the next request creates a new one.
// (Jobs that were loading in it are failed by tabs.onRemoved above.)
chrome.windows.onRemoved.addListener(async (windowId) => {
  try {
    const stored = (await chrome.storage.session.get(WORKER_WINDOW_KEY))[WORKER_WINDOW_KEY];
    if (stored === windowId) await chrome.storage.session.remove(WORKER_WINDOW_KEY);
  } catch (err) {
    logError("worker window closed")(err);
  }
});

// scrape_state changed: notify on pause / finish (section 5); and when running went true → false (finished,
// stopped, tab closed), close the Naukri worker window.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.scrape_state) return;
  const before = changes.scrape_state.oldValue;
  const after = changes.scrape_state.newValue;
  notifyScrapeChange(before, after).catch(logError("notify"));
  if (before && before.running && !(after && after.running)) {
    closeNaukriWorker("stopped").catch(logError("close worker window"));
  }
});

if (chrome.notifications) {
  chrome.notifications.onClicked.addListener((id) => {
    showScrapeTab(id).catch(logError("show scraping tab")); // the tab may be closed by now
  });
}

// After a browser restart nothing can still be scraping (tab ids changed too).
chrome.runtime.onStartup.addListener(() => {
  markScrapeStopped(null, "browser restarted").catch(logError("onStartup"));
});


// ─── 8. Small helpers ───────────────────────────────────────────────────────────────────────────

// Chrome stops an idle service worker after ~30 s, even while a backend call or a Naukri page is still
// in flight. Any extension API call resets that timer, so we make a cheap one every 20 s while work is pending.
let pendingWork = 0;
let keepAliveTimer = null;

function holdAwake(delta) {
  pendingWork = Math.max(0, pendingWork + delta);
  if (pendingWork > 0 && !keepAliveTimer) {
    keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  } else if (pendingWork === 0 && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function errorText(err) {
  return err && err.message ? err.message : String(err);
}

function logError(where) {
  return (err) => console.warn("[JobFilter] " + where + ":", err);
}
