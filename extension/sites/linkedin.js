// Job Filter v2 - LinkedIn content script. PASSIVE ONLY (DESIGN.md 3.4).
//
// Why so strict: the user's LinkedIn account was restricted once. This script must be invisible to LinkedIn,
// so it only READS the page and talks to our own background service worker:
//   - no clicks, no synthetic events, no focus/scroll, no network calls, no navigation
//   - no DOM writes of any kind. Hiding is done by background with chrome.scripting.insertCSS (a user
//     stylesheet that is not part of the page DOM), driven by the {type:"liHide"} message we send.
//   - no page localStorage/sessionStorage/cookies, no chrome.runtime.onMessage listener
// Everything lives inside one IIFE so nothing leaks onto window.
//
// Frames: LinkedIn now draws classic job search inside a same-origin frame (/preload/?_bprMode=vanilla), so the
// manifest loads this script into every LinkedIn frame (all_frames). Only the copy whose document holds the jobs
// list / job description acts (hasJobsUi); it reads the address bar from the top window (pageLocation). Only a copy
// whose document shows the jobs UI right now writes the side panel and badge (ownsPanel); a copy whose document loses
// it goes dormant (tick). The other copies only poll the URL, and the top-frame copy clears the side panel and badge
// once the address bar no longer names an open job (topFrameClear).
//
// Flow:
//   poll the URL every 700 ms   -> are we on /jobs/? which job is open (currentJobId)?
//   MutationObserver (read-only) -> cards changed -> recompute the hide set -> liHide when it changed
//   title AI (debounced 800 ms) -> unscreened visible cards -> screenTitle -> li_verdicts
//   a job is opened             -> partial list + JD AI -> screenJd -> li_verdicts, li_current, liVerdict
//
// Globals from common/filters.js (loaded first by the manifest): jfLoadSettings, jfNormalize, jfRuleCheck.

(function () {
  'use strict';

  const DEBUG = false;

  // Every loop stays at >= 300 ms: our work runs on the page's main thread, so it should stay small.
  const POLL_MS = 700;
  const REFRESH_THROTTLE_MS = 300;
  const TITLE_DEBOUNCE_MS = 800;
  const TITLE_BATCH = 25;
  const TITLE_RETRY_MS = 60000;
  const MAX_VERDICTS = 3000;
  const JD_MIN_CHARS = 200;
  const JD_STABLE_MS = 600;
  const JD_TIMEOUT_MS = 8000;
  const JD_CHECK_MS = 300;
  const UI_GONE_POLLS = 5;          // polls (~3.5 s) without the jobs UI before a running copy goes dormant
  const NO_DETAIL = { title: '', company: '', linkId: null, jd: '' };

  // Selector arrays are tried in order (first match wins), so a LinkedIn redesign of one class only costs a fallback.
  const SEL = {
    list: '.scaffold-layout__list',
    card: 'li.scaffold-layout__list-item, li[data-occludable-job-id]',
    cardTitle: ['.job-card-list__title--link', 'a[href*="/jobs/view/"]'],
    cardCompany: ['.artdeco-entity-lockup__subtitle span', '.artdeco-entity-lockup__subtitle'],
    cardLocation: ['.artdeco-entity-lockup__caption', '.job-card-container__metadata-item'],
    cardFooterItem: '.job-card-container__footer-item',
    cardJobState: '.job-card-container__footer-job-state',
    detailPane: ['.scaffold-layout__detail', '.jobs-search__job-details--container'],
    detailTitle: ['.job-details-jobs-unified-top-card__job-title', '.t-24', 'h1'],
    detailCompany: ['.job-details-jobs-unified-top-card__company-name'],
    jd: ['#job-details', '.jobs-description__content', '.jobs-description-content__text', '.jobs-box__html-content'],
  };

  // ---- state -------------------------------------------------------------------------------------------

  let loadState = 'cold';           // 'cold' -> 'loading' -> 'ready' (or 'failed'): see loadCache()
  let settings = null;              // deep-merged settings from jfLoadSettings()
  let partial = new Set();          // li_partial.items  ("normTitle|company")
  let verdicts = {};                // li_verdicts       (jobId -> verdict)
  const known = new Map();          // jobId -> last card info we could read (LinkedIn empties off-screen cards)

  const titleInFlight = new Set();  // ids currently being screened by title AI
  const titleFailed = new Map();    // id -> when its title screening errored; retried after TITLE_RETRY_MS
  const jdInFlight = new Set();     // ids with a screenJd request in flight
  let titleQueue = [];              // latest unscreened visible cards, consumed by runTitleAI()
  let titleKey = '';                // ids in titleQueue, to restart the debounce only when they change

  let onJobsPage = false;           // this copy is running (its document holds the jobs UI)
  let uiMisses = 0;                 // polls in a row without the jobs UI while running
  let topSawJob = false;            // top frame: the address bar named an open job since the last top-frame clear
  let topNoJobPolls = 0;            // top frame: polls in a row without an open job in the address bar
  let nonJobsPolls = 0;             // polls in a row with the address bar off /jobs/ while running (see tick)
  let panelMissed = false;          // a side-panel write was skipped while this copy didn't own the panel (see tick)
  let currentJobId = null;
  let currentPicked = false;        // true when the user chose the open job (not LinkedIn's auto-selected first result)
  let openSeq = 0;                  // bumped on every job switch; async work compares its token against it
  let lastHref = null;
  let openedListKey = null;         // listKey() when the open job was opened
  let seenJd = { jobId: null, jd: '' };   // the last JD read for a job, so the next job can't take it as its own
  let lastHideKey = null;           // sorted ids we last sent with liHide

  let observer = null;
  let observedNode = null;
  let refreshTimer = 0;
  let refreshPending = false;       // a mutation arrived during the throttle window
  let titleTimer = 0;
  let pollTimer = 0;
  let storeQueue = Promise.resolve();

  // ---- small helpers -----------------------------------------------------------------------------------

  function log(...args) {
    if (DEBUG) console.debug('[jf-li]', ...args);
  }

  function text(el) {
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function first(root, selectors) {
    for (const s of selectors) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function jobLink(id) {
    return 'https://www.linkedin.com/jobs/view/' + id + '/';
  }

  function jobIdFromHref(href) {
    const m = /\/jobs\/view\/(\d+)/.exec(href || '');
    return m ? m[1] : null;
  }

  // The URL in the address bar. LinkedIn now draws classic job search inside a same-origin frame
  // (/preload/?_bprMode=vanilla) whose own URL never changes, so a copy of this script running in that frame
  // reads the top window's URL instead. Same origin, so it's allowed; reading it is invisible to the page.
  function pageLocation() {
    try {
      if (window.top !== window && window.top.location.href) return window.top.location;
    } catch (err) {
      // top is cross-origin (LinkedIn embedded somewhere else): fall back to this frame's own URL
    }
    return location;
  }

  // True when the jobs list or a job description is drawn in THIS document. The script runs in every LinkedIn frame
  // (all_frames), and only the copy that actually holds the jobs UI may act: the others stay idle so they never
  // overwrite the side panel or send an empty hide list.
  function hasJobsUi() {
    return !!(document.querySelector(SEL.list) || document.querySelector(SEL.card) || first(document, SEL.jd));
  }

  // Only the copy whose document shows the jobs UI right now may write the side panel and badge. A copy in a frame
  // that just lost it (it goes dormant a few polls later) must not overwrite the copy that actually shows the job.
  function ownsPanel() {
    return onJobsPage && showsJobsUi();
  }

  // The jobs UI is in this document AND this frame is on screen: the condition to start, to stay awake (tick) and
  // to own the side panel.
  function showsJobsUi() {
    return hasJobsUi() && frameIsShown();
  }

  // Is this frame actually on screen? A hidden frame that LinkedIn left with a stale list must not own the side panel.
  // Only reads the frame element's size, which is invisible to the page.
  function frameIsShown() {
    if (window.top === window) return true;
    try {
      const frame = window.frameElement;   // null when the parent is cross-origin: nothing to check
      if (!frame) return true;
      const box = frame.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    } catch (err) {
      return true;
    }
  }

  // The open job: ?currentJobId=X on search/collection pages, or /jobs/view/X/ when a job page is opened directly.
  // Fallback: the job the detail pane's title links to (only used if the address bar can't be read).
  function jobIdFromUrl() {
    const page = pageLocation();
    let id = new URLSearchParams(page.search).get('currentJobId') || jobIdFromHref(page.pathname);
    if (!id && onJobsPage && page === location) {   // only while running: idle copies read just the address bar
      const titleEl = first(document, SEL.detailTitle);
      const link = titleEl && (titleEl.closest('a') || titleEl.querySelector('a[href*="/jobs/view/"]'));
      id = link ? jobIdFromHref(link.getAttribute('href')) : null;
    }
    return id && /^\d+$/.test(id) ? id : null;   // digits only: the id is used inside a CSS selector below
  }

  // Which results page we are on, ignoring the open job. "origin" and "refresh" only say how the page was reached.
  // Search words, filters and the page number ("start") all change this key.
  function listKey() {
    const page = pageLocation();
    const params = page.search.replace(/^\?/, '').split('&')
      .filter((p) => p && !/^(currentJobId|origin|refresh)=/.test(p));
    return page.pathname + '?' + params.join('&');
  }

  function partialKey(title, company) {
    return jfNormalize(title) + '|' + String(company || '').trim().toLowerCase();
  }

  function aiOn(flag) {
    return !!(settings && settings.aiEnabled && settings.linkedin[flag]);
  }

  // Background replies {error} on failure; a closed port or an invalidated extension becomes {error} too.
  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (err) {
      log('sendMessage failed', msg.type, err);
      return { error: String((err && err.message) || err) };
    }
  }

  // All storage writes run one after another, so our read-modify-write updates never overwrite each other.
  function queueStore(task) {
    storeQueue = storeQueue.then(task).catch((err) => log('storage write failed', err));
    return storeQueue;
  }

  // ---- reading cards and the detail pane (read-only) ----------------------------------------------------

  function cardId(li) {
    const own = li.getAttribute('data-occludable-job-id');
    if (own) return own;
    const inner = li.querySelector('[data-job-id]');
    return inner ? inner.getAttribute('data-job-id') : null;
  }

  // Returns null when LinkedIn has emptied the card (off-screen cards stay in the list as bare <li> placeholders).
  function readCard(li) {
    const link = first(li, SEL.cardTitle);
    // The title link also holds a visually-hidden copy ("... with verification"); <strong> has the clean title.
    const title = text(link && (link.querySelector('strong') || link.querySelector('span[aria-hidden="true"]') || link));
    const company = text(first(li, SEL.cardCompany));
    if (!title || !company) return null;
    const footerItems = Array.from(li.querySelectorAll(SEL.cardFooterItem));
    return {
      title,
      company,
      location: text(first(li, SEL.cardLocation)),
      promoted: footerItems.some((el) => (el.textContent || '').includes('Promoted')),
      applied: text(li.querySelector(SEL.cardJobState)).includes('Applied'),
      dismissed: (li.textContent || '').includes('show you this job again'),
    };
  }

  // Card info for one job: the live card if it is rendered, else what we read earlier, else null.
  function cardInfoFor(id) {
    let li = document.querySelector('li[data-occludable-job-id="' + id + '"]');
    if (!li) {
      const inner = document.querySelector('[data-job-id="' + id + '"]');
      li = inner && inner.closest('li');
    }
    const info = li && readCard(li);
    if (info) known.set(id, info);
    return info || known.get(id) || null;
  }

  function readDetail() {
    const pane = first(document, SEL.detailPane) || document;
    const titleEl = first(pane, SEL.detailTitle);
    const link = titleEl && (titleEl.closest('a') || titleEl.querySelector('a[href*="/jobs/view/"]'));
    const jdEl = first(pane, SEL.jd);
    // innerText keeps line breaks between paragraphs/bullets, which textContent would glue together.
    const jd = jdEl ? (jdEl.innerText || jdEl.textContent || '') : '';
    return {
      title: text(titleEl),
      company: text(first(pane, SEL.detailCompany)),
      linkId: link ? jobIdFromHref(link.getAttribute('href')) : null,
      jd: jd.replace(/[ \t\r]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim(),
    };
  }

  // Loose on purpose: the top card and the list card can word the same title slightly differently.
  function titlesMatch(cardTitle, detailTitle) {
    const a = jfNormalize(cardTitle);
    const b = jfNormalize(detailTitle);
    return a === b || a.includes(b) || b.includes(a);
  }

  // Best evidence first: the top-card title links to /jobs/view/<id>/; otherwise compare its title with the card's.
  function detailShowsJob(jobId, detail, card) {
    if (detail.linkId) return detail.linkId === jobId;
    if (!detail.title) return false;
    if (!card) return true;   // nothing to compare with
    return titlesMatch(card.title, detail.title);
  }

  // ---- hide set ----------------------------------------------------------------------------------------

  // Why the extension itself (no AI) hides a card, or null. Cards hidden here are never sent to the AI.
  function localHideReason(info) {
    const li = settings.linkedin;
    const rule = jfRuleCheck(info.title, info.company, settings.global);
    if (rule && rule.hide) return rule.reason || 'rule';
    if (li.hideApplied && info.applied) return 'applied';
    if (li.hideDismissed && info.dismissed) return 'dismissed';
    if (li.promotedMode === 'hide' && info.promoted) return 'promoted';
    if (li.promotedMode === 'partial' && partial.has(partialKey(info.title, info.company))) return 'partial';
    return null;
  }

  // Works by id alone, so a rejected card stays hidden even while LinkedIn has emptied it. A reject only counts while
  // the AI stage that made it is on: turning off "Title AI" brings back the cards it rejected.
  function aiRejected(id) {
    const v = verdicts[id];
    return !!(v && v.decision === 'reject' && aiOn(isJdVerdict(v) ? 'jdAI' : 'titleAI'));
  }

  // Recomputes everything from the cards in the DOM: the hide set (sent only when it changed) and the
  // cards still waiting for title AI.
  function refresh() {
    if (!onJobsPage || !settings) return;
    const hide = new Set();
    const unscreened = [];
    const openNow = jobIdFromUrl();   // currentJobId can lag the URL by one poll; the job just clicked counts as open too
    const cards = document.querySelectorAll(SEL.card);
    for (const li of cards) {
      try {
        const id = cardId(li);
        if (!id) continue;
        const fresh = readCard(li);
        if (fresh) known.set(id, fresh);
        const info = fresh || known.get(id);
        const reason = info ? localHideReason(info) : null;
        const isOpen = id === currentJobId || id === openNow;
        // Never hide the job the user is looking at; it gets hidden after they open another one.
        if (!isOpen && (reason || aiRejected(id))) hide.add(id);
        // The open job gets the JD stage, so a title call for it would be wasted (and would race the JD verdict).
        const jdWillScore = isOpen && aiOn('jdAI');
        if (fresh && !reason && !jdWillScore && !verdicts[id] && !titleInFlight.has(id) && !titleFailedRecently(id)) {
          unscreened.push({ job_id: id, title: fresh.title, company: fresh.company,
                            location: fresh.location || undefined, link: jobLink(id) });
        }
      } catch (err) {
        log('card skipped', err);
      }
    }
    // No cards at all = the list is being re-rendered: keep the current CSS (it only targets job ids) instead of
    // un-hiding everything for a moment. stop() drops it when this copy really stops.
    if (cards.length) sendHideSet(Array.from(hide));
    queueTitleJobs(unscreened);
  }

  function safeRefresh() {
    try {
      refresh();
    } catch (err) {
      log('refresh failed', err);
    }
  }

  function sendHideSet(ids) {
    const key = ids.slice().sort().join(',');
    if (key === lastHideKey) return;
    lastHideKey = key;
    log('hide set', key);
    send({ type: 'liHide', jobIds: key ? key.split(',') : [] }).then((reply) => {
      if (!reply || reply.error) lastHideKey = null;   // not applied: resend on the next change
    });
  }

  // ---- title AI ----------------------------------------------------------------------------------------

  // Restarts the debounce only when the set of unscreened cards changed, so unrelated page mutations
  // cannot postpone the AI call forever.
  function queueTitleJobs(jobs) {
    titleQueue = jobs;
    const key = jobs.map((j) => j.job_id).join(',');
    if (key === titleKey) return;
    titleKey = key;
    clearTimeout(titleTimer);
    if (jobs.length && aiOn('titleAI')) {
      titleTimer = setTimeout(() => {
        runTitleAI().catch((err) => log('title AI failed', err));
      }, TITLE_DEBOUNCE_MS);
    }
  }

  // A failed card waits a minute before it is tried again: LinkedIn is a single-page app, so without a retry a
  // backend started after the page (or a passing AI error) would leave those cards unscreened for hours.
  function titleFailedRecently(id) {
    const failedAt = titleFailed.get(id);
    return failedAt !== undefined && Date.now() - failedAt < TITLE_RETRY_MS;
  }

  async function runTitleAI() {
    if (!onJobsPage || !aiOn('titleAI')) return;
    const jobs = titleQueue.filter((j) => !verdicts[j.job_id] && !titleInFlight.has(j.job_id) && !titleFailedRecently(j.job_id));
    jobs.forEach((j) => titleInFlight.add(j.job_id));
    for (let i = 0; i < jobs.length; i += TITLE_BATCH) {
      const batch = jobs.slice(i, i + TITLE_BATCH);
      const reply = await send({ type: 'screenTitle', site: 'linkedin', jobs: batch });
      const fresh = {};
      // On {error} nothing is stored, so nothing gets hidden: never hide on error.
      const results = reply && !reply.error && Array.isArray(reply.results) ? reply.results : [];
      for (const r of results) {
        if (r && r.job_id && isUsableVerdict(r)) fresh[r.job_id] = toVerdict(r, 'title');
      }
      for (const j of batch) {
        titleInFlight.delete(j.job_id);
        if (fresh[j.job_id]) titleFailed.delete(j.job_id);
        else titleFailed.set(j.job_id, Date.now());
      }
      if (Object.keys(fresh).length) saveVerdicts(fresh);
    }
  }

  // ---- verdict storage ---------------------------------------------------------------------------------

  // "ai_error" and "no_jd" answers are "pass for now", not real verdicts: keeping them out of the cache
  // means a later visit tries again.
  function isUsableVerdict(r) {
    const reason = String(r.reason || '');
    return (r.decision === 'pass' || r.decision === 'reject') && !reason.startsWith('ai_error') && reason !== 'no_jd';
  }

  function toVerdict(r, stage) {
    return {
      decision: r.decision,
      stage: r.stage || stage,
      reason: r.reason || '',
      confidence: r.confidence ?? null,
      match_score: r.match_score ?? null,
      t: Date.now(),
    };
  }

  function isJdVerdict(v) {
    return !!(v && v.stage === 'jd');
  }

  // Copies `fresh` into `into`, except that a JD-stage verdict is never replaced by a title-stage one: a slow title
  // batch can answer after the JD stage already did (same rule as the backend cache).
  function mergeVerdicts(into, fresh) {
    for (const id of Object.keys(fresh || {})) {
      if (isJdVerdict(into[id]) && !isJdVerdict(fresh[id])) continue;
      into[id] = fresh[id];
    }
    return into;
  }

  // Memory first (the hide set reacts at once), then merged into storage keeping the newest MAX_VERDICTS.
  function saveVerdicts(fresh) {
    mergeVerdicts(verdicts, fresh);
    safeRefresh();
    return queueStore(async () => {
      const data = await chrome.storage.local.get('li_verdicts');
      const all = mergeVerdicts(Object.assign({}, data.li_verdicts), fresh);
      await chrome.storage.local.set({ li_verdicts: newest(all, MAX_VERDICTS) });
    });
  }

  function newest(all, max) {
    const ids = Object.keys(all);
    if (ids.length <= max) return all;
    ids.sort((a, b) => ((all[b] && all[b].t) || 0) - ((all[a] && all[a].t) || 0));
    const kept = {};
    for (const id of ids.slice(0, max)) kept[id] = all[id];
    return kept;
  }

  // ---- the open job: partial list + JD AI ---------------------------------------------------------------

  // `info` may be null when the job has no card; then only scope "all" can apply (we can't tell if it's promoted).
  function partialWanted(info) {
    const li = settings.linkedin;
    return li.promotedMode === 'partial' && (li.partialScope === 'all' || !!(info && info.promoted));
  }

  // Remembers the opened job so it is hidden once the user moves on to another one.
  function rememberPartial(info) {
    if (!info || !info.title || !partialWanted(info)) return;
    const key = partialKey(info.title, info.company);
    if (partial.has(key)) return;
    partial.add(key);
    queueStore(async () => {
      const data = await chrome.storage.local.get('li_partial');
      const items = (data.li_partial && data.li_partial.items) || [];
      if (!items.includes(key)) await chrome.storage.local.set({ li_partial: { ...data.li_partial, items: items.concat([key]) } });
    });
  }

  // The open job's state goes to two places that must always agree: li_current (side panel) and the toolbar
  // badge. Background draws the badge from liVerdict: verdict -> score or ✕, {error} -> "!", null -> "…".
  function setCurrent(jobId, job, status, extra) {
    if (!ownsPanel()) {
      if (onJobsPage) panelMissed = true;   // redrawn by tick() once this document shows the jobs UI again
      return;
    }
    const value = Object.assign(
      { jobId, title: (job && job.title) || '', company: (job && job.company) || '', status, t: Date.now() },
      extra
    );
    queueStore(() => chrome.storage.local.set({ li_current: value }));
    const verdict = status === 'done' ? value.verdict : status === 'error' ? { error: value.error } : null;
    send({ type: 'liVerdict', jobId, verdict });
  }

  // Nothing to show for the open job (none is open, or it won't be scored): empty side panel and no badge, so
  // neither keeps showing a job that is no longer on screen. jobId null tells background to clear the badge.
  // `force`: clear even though this copy doesn't own the panel (leaving /jobs/, or the top-frame clear in tick()).
  function clearCurrent(force) {
    if (!force && !ownsPanel()) {
      if (onJobsPage) panelMissed = true;
      return;
    }
    queueStore(() => chrome.storage.local.set({ li_current: null }));
    send({ type: 'liVerdict', jobId: null, verdict: null });
  }

  // True when our own rules would hide this job, so it must not go to the AI either (rules come first, DESIGN 1).
  // "partial" doesn't count: that list holds jobs opened before, and opening one again is no reason to skip it.
  function hiddenByRules(info) {
    const reason = info ? localHideReason(info) : null;
    return !!reason && reason !== 'partial';
  }

  // JD AI scores the open job unless it is switched off or our own rules would hide the job.
  function jdWanted(info) {
    return aiOn('jdAI') && !hiddenByRules(info);
  }

  // Waits until the detail pane shows `jobId` with a settled JD: >= 200 chars, unchanged for 600 ms, not the JD
  // read for the previous job, and the detail matches the card (or 8 s pass). Resolves null if the user opened
  // another job meanwhile. Only reads: we never scroll or click to make LinkedIn load anything.
  function waitForDetail(jobId, card, token) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let lastJd = null;
      let changedAt = startedAt;
      const accept = (d) => {
        if (d.jd) seenJd = { jobId, jd: d.jd };
        resolve(d);
      };
      const check = () => {
        try {
          if (token !== openSeq || !onJobsPage) return resolve(null);
          const d = readDetail();
          const now = Date.now();
          if (d.jd !== lastJd) {
            lastJd = d.jd;
            changedAt = now;
          }
          // LinkedIn can draw the new job's top card before its JD, so the old JD can sit under the new title.
          const oldJd = !!d.jd && d.jd === seenJd.jd && seenJd.jobId !== jobId;
          const settled = d.jd.length >= JD_MIN_CHARS && now - changedAt >= JD_STABLE_MS && !oldJd;
          if (settled && detailShowsJob(jobId, d, card)) return accept(d);
          if (now - startedAt >= JD_TIMEOUT_MS) {
            // Out of time: use what is there, unless the top card names another job. The previous job's JD text is
            // only trusted when the top-card link names this job (a company can post the same text twice).
            const otherJob = d.linkId ? d.linkId !== jobId : !!(card && d.title && !titlesMatch(card.title, d.title));
            return otherJob || (oldJd && d.linkId !== jobId) ? resolve(NO_DETAIL) : accept(d);
          }
          setTimeout(check, JD_CHECK_MS);
        } catch (err) {
          log('detail check failed', err);
          resolve(NO_DETAIL);   // reported as "job description not found", so the panel doesn't stay on "reading"
        }
      };
      check();
    });
  }

  // Runs once per job switch. `token` goes stale as soon as the user opens something else.
  async function onJobOpened(jobId, token) {
    const picked = currentPicked;
    const card = cardInfoFor(jobId);
    if (picked) rememberPartial(card);
    const jdOn = jdWanted(card);
    if (!jdOn) clearCurrent();   // no JD verdict will come for this job: don't keep showing the previous one
    // Without a card, title/company only come from the detail pane, so the partial list may still need it.
    const partialNeedsDetail = !card && picked && partialWanted(null);
    if (!jdOn && !partialNeedsDetail) return;

    const cached = verdicts[jobId];
    if (jdOn && card && isJdVerdict(cached)) {
      setCurrent(jobId, card, 'done', { verdict: cached });   // already scored earlier: no backend call
      waitForDetail(jobId, card, token);   // still learn its JD text, so the next job's wait can tell it apart
      return;
    }
    if (jdOn) setCurrent(jobId, card, 'reading');

    const detail = await waitForDetail(jobId, card, token);
    if (!detail) return;   // user opened another job or left /jobs/
    const job = card || { title: detail.title, company: detail.company, location: '', promoted: false };
    if (!card && picked) rememberPartial(job);
    if (!jdOn) return;
    if (!card && hiddenByRules(job)) return clearCurrent();   // only now do we know its title and company

    if (isJdVerdict(verdicts[jobId])) {
      setCurrent(jobId, job, 'done', { verdict: verdicts[jobId] });
      return;
    }
    if (!detail.jd) {
      setCurrent(jobId, job, 'error', { error: 'job description not found on the page' });
      return;
    }
    if (jdInFlight.has(jobId)) {
      setCurrent(jobId, job, 'scoring');   // the earlier request for this job will fill in the result
      return;
    }
    await scoreJd(jobId, job, detail.jd);
  }

  async function scoreJd(jobId, job, jd) {
    jdInFlight.add(jobId);
    setCurrent(jobId, job, 'scoring');
    const reply = await send({
      type: 'screenJd',
      site: 'linkedin',
      job: { job_id: jobId, title: job.title, company: job.company, location: job.location || undefined,
             link: jobLink(jobId), jd },
    });
    jdInFlight.delete(jobId);

    const answered = reply && !reply.error && (reply.decision === 'pass' || reply.decision === 'reject');
    const verdict = answered ? toVerdict(reply, 'jd') : null;
    const usable = !!verdict && isUsableVerdict(reply);
    // Cache even if the user has moved on: that job may get hidden now, and reopening it is instant.
    if (usable) saveVerdicts({ [jobId]: verdict });

    // Stale reply: the side panel now belongs to another job, or JD AI was switched off and the panel cleared.
    if (jobId !== currentJobId || !jdWanted(job)) return;
    if (!verdict) {
      setCurrent(jobId, job, 'error', { error: (reply && reply.error) || 'no reply from background' });
      return;
    }
    if (!usable) {
      // Backend says "pass" when the AI failed (ai_error) or the JD was too short to use (no_jd), so nothing gets
      // hidden. For the panel and badge the job was not scored: an error, not a match.
      const error = verdict.reason === 'no_jd' ? 'job description too short to score (no_jd)' : verdict.reason;
      setCurrent(jobId, job, 'error', { error });
      return;
    }
    // li_verdicts keeps only the DESIGN fields; the panel also shows the reply's role_family, work_mode,
    // min_years and cached.
    setCurrent(jobId, job, 'done', { verdict: Object.assign({}, reply, verdict) });
  }

  // ---- watching the page (URL poll + read-only MutationObserver) ----------------------------------------

  function checkCurrentJob() {
    const id = jobIdFromUrl();
    if (id === currentJobId) return;
    // A user's click changes only the open job on the same results page. LinkedIn itself opens the first result on
    // page load, a new search or a new results page: the user hasn't chosen that one, so it is not remembered.
    // Compared with the list the previous job was opened on, so a list change that reaches the URL before
    // LinkedIn's pick of the first result still counts as a new list.
    const sameList = currentJobId !== null && listKey() === openedListKey;
    panelMissed = false;   // the new job's own flow below writes the panel
    currentJobId = id;
    openedListKey = listKey();
    currentPicked = !!id && (sameList || /^\/jobs\/view\//.test(pageLocation().pathname));   // a job page was opened on purpose
    const token = ++openSeq;
    safeRefresh();   // un-hide the job just opened, hide the one the user just left (if it qualifies)
    if (id) onJobOpened(id, token).catch((err) => log('job flow failed', err));
    else clearCurrent();
  }

  // Throttle that acts at once: the first change is handled now, so a card that must be hidden never flashes up;
  // changes after it are handled together at most once per 300 ms, however busy the page is.
  function onMutations() {
    if (refreshTimer) {
      refreshPending = true;
      return;
    }
    safeRefresh();
    refreshTimer = setTimeout(() => {
      refreshTimer = 0;
      if (refreshPending) {
        refreshPending = false;
        onMutations();
      }
    }, REFRESH_THROTTLE_MS);
  }

  // Observes the jobs list, or document.body until the list exists. Re-attaches when LinkedIn re-renders it.
  function attachObserver() {
    const target = document.querySelector(SEL.list) || document.body;
    if (!target || (target === observedNode && target.isConnected)) return;
    detachObserver();
    observer = new MutationObserver(onMutations);
    observer.observe(target, { childList: true, subtree: true, characterData: true });
    observedNode = target;
    onMutations();
  }

  function detachObserver() {
    if (observer) observer.disconnect();
    observer = null;
    observedNode = null;
  }

  // attachObserver() refreshes at once; that can't hide the open job, because refresh() reads it from the URL.
  function start() {
    onJobsPage = true;
    attachObserver();
    if (!jobIdFromUrl()) clearCurrent();   // no job open: drop whatever the side panel showed before
  }

  // LinkedIn is a single-page app: leaving /jobs/ keeps this script alive, so we go idle until it comes back.
  // clearPanel is false when only this document lost the jobs UI (the address bar is still on /jobs/): the copy in
  // the frame that holds it now owns the side panel and badge, so we leave them alone. (If no frame holds it any
  // more, the top-frame clear in tick() empties the panel once the address bar has no open job.)
  function stop(clearPanel) {
    onJobsPage = false;
    uiMisses = 0;
    nonJobsPolls = 0;
    panelMissed = false;
    detachObserver();
    clearTimeout(refreshTimer);
    clearTimeout(titleTimer);
    refreshTimer = 0;
    refreshPending = false;
    titleKey = '';
    openSeq++;                   // cancels a JD wait in progress
    currentJobId = null;
    currentPicked = false;
    sendHideSet([]);             // no cards to hide here any more: let background drop this document's CSS
    if (clearPanel) clearCurrent(true);   // forced: onJobsPage is already false, so this copy no longer "owns" it
  }

  // After the extension is reloaded this orphaned copy can no longer reach it: stop all timers quietly.
  function shutdown() {
    clearInterval(pollTimer);
    detachObserver();
    clearTimeout(refreshTimer);
    clearTimeout(titleTimer);
    openSeq++;
  }

  // Top frame only. When the address bar stops naming an open job (left /jobs/, or a /jobs/ page with no job), the
  // frame that held the jobs UI may already be gone - and with it the copy that would clear the side panel and
  // badge - so the top-frame copy clears them. It waits for 2 polls (>= 700 ms) in a row, so a quick bounce away
  // and back can't blank the panel behind the running copy's back: in that time the running copy has polled too
  // and will redraw the panel when the job comes back.
  function topFrameClear() {
    if (jobIdFromUrl()) {
      topSawJob = true;
      topNoJobPolls = 0;
    } else if (topSawJob && ++topNoJobPolls >= 2) {
      topSawJob = false;
      topNoJobPolls = 0;
      clearCurrent(true);
    }
  }

  // Reading the URL is invisible to the page, unlike patching history.pushState.
  // Starts only when the address bar shows a /jobs/ page and this document holds the jobs UI (hasJobsUi). Goes
  // dormant when the UI has been missing for UI_GONE_POLLS polls in a row (LinkedIn drew it in another frame), so a
  // list that briefly disappears during a re-render doesn't toggle it off and on.
  function tick() {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return shutdown();
      const page = pageLocation();
      const jobsUrl = /^\/jobs(\/|$)/.test(page.pathname);
      if (window.top === window) topFrameClear();
      if (!jobsUrl) {
        // Left /jobs/ - acted on after 2 polls in a row, so a quick bounce away and back neither un-hides the
        // cards nor blanks the side panel.
        if (onJobsPage && ++nonJobsPolls >= 2) stop(true);
        return;
      }
      nonJobsPolls = 0;
      if (!onJobsPage && showsJobsUi()) {
        if (loadState === 'cold') loadCache();   // calls tick() again once loaded
        if (loadState !== 'ready') return;
        start();
        lastHref = null;   // check the open job right away
      }
      if (!onJobsPage) return;
      uiMisses = showsJobsUi() ? 0 : uiMisses + 1;
      if (uiMisses >= UI_GONE_POLLS) return stop(false);
      // A side-panel write was dropped while the jobs UI was briefly gone (e.g. the JD verdict landed mid re-render):
      // redraw the open job now that this copy owns the panel again. A cached verdict makes this instant.
      if (panelMissed && ownsPanel()) {
        panelMissed = false;
        if (currentJobId) onJobOpened(currentJobId, ++openSeq).catch((err) => log('job flow failed', err));
        else clearCurrent();
      }
      attachObserver();
      if (page.href === lastHref) return;
      lastHref = page.href;
      checkCurrentJob();
    } catch (err) {
      log('tick failed', err);
    }
  }

  async function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    try {
      if (changes.li_partial) {
        const v = changes.li_partial.newValue;
        partial = new Set((v && v.items) || []);
      }
      // Merge, never replace: verdicts still waiting in storeQueue (or lost to another tab writing at the same
      // moment) must stay in memory, or their cards would reappear and be screened again.
      if (changes.li_verdicts) mergeVerdicts(verdicts, changes.li_verdicts.newValue);
      if (changes.settings) {
        settings = await jfLoadSettings();
        titleFailed.clear();   // a fixed backend URL or AI switched back on deserves a fresh try
        titleKey = '';
        // Apply the new settings to the open job too (partial list, JD AI); a cached verdict makes this instant.
        if (onJobsPage && currentJobId) {
          onJobOpened(currentJobId, ++openSeq).catch((err) => log('job flow failed', err));
        }
      }
      if (changes.li_partial || changes.li_verdicts || changes.settings) safeRefresh();
    } catch (err) {
      log('storage change failed', err);
    }
  }

  // Loaded the first time this document holds the jobs UI, not at page load: every LinkedIn frame runs this script
  // (all_frames), and only the copy that shows the jobs needs the verdict cache (up to 3000 entries) and its change
  // events. Idle copies cost only the URL poll.
  async function loadCache() {
    loadState = 'loading';
    try {
      settings = await jfLoadSettings();
      const data = await chrome.storage.local.get(['li_partial', 'li_verdicts']);
      partial = new Set((data.li_partial && data.li_partial.items) || []);
      verdicts = data.li_verdicts || {};
    } catch (err) {
      log('load failed', err);
      loadState = 'failed';   // without settings we cannot decide anything: stay completely idle
      return;
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      onStorageChanged(changes, area);
    });
    loadState = 'ready';
    tick();   // start now instead of on the next poll
  }

  function init() {
    pollTimer = setInterval(tick, POLL_MS);
    tick();
  }

  init();
})();
