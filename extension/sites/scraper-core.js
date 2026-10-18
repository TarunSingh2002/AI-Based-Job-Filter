// sites/scraper-core.js — shared scraper engine for Glassdoor, Naukri and Indeed (DESIGN.md 3.5).
//
// Load order (manifest): common/filters.js → sites/scraper-core.js → sites/<site>.js.
// Content scripts of one page share one global scope, so the site file uses everything defined here.
// Names are prefixed (jfs…) so they never clash with globals from common/filters.js.
//
// Pipeline for every card:
//   rules (instant) → title AI (batches of ≤20; a repost of a job judged before comes back `duplicate` and is
//   just hidden) → JD AI (several "lanes" at once: `jdParallel` on Glassdoor / Indeed, `jdTabs` worker tabs on
//   Naukri; each lane reads one job at a time with a short random gap) → highlight / hide / mark with the
//   site's own save button.
//
// Rate limits: a job page answered with 403 / 429 / a check page usually just means "too fast". Then ALL lanes
// wait 30 s, 60 s, 120 s and retry the same job; the run pauses only when the site still blocks after the third
// wait. A captcha on the results page itself pauses at once. We never try to solve or get around a captcha.
//
// Two speeds (scrape_state.mode): "manual" = you pressed Start in the popup and watch the screen: lanes and gaps
// as set. "automation" = the background's automation started the run (nobody watching): Indeed and Glassdoor read
// ONE job page at a time with no extra gap; Naukri is the same in both modes (see jfsJdPace).
// Long waits are ONE timer that Stop / Pause wake early (nap), not a chain of short polls: the browser slows the
// timers of a window that is covered or minimized, and a chain of short timers then crawls.
//
// How a run survives "Next page" navigation:
//   the run lives in chrome.storage.local "scrape_state". A content script cannot know its own tab id
//   (the background stamps `tabId` from the sender on every save; the popup and the tab-closed cleanup use it),
//   so the run hands itself over instead: right after starting the navigation it writes `handoffAt` (a time).
//   The next page's script (resumeIfRunning) takes the run over only while that hand-off is fresh, and clears
//   it. Pages the run did not just navigate to (another tab, a page opened hours later) leave the run alone.
//   Keep just ONE search-results tab of a site open while it is being scraped: during the few seconds of a
//   hand-off, the first results page of that site to load gets the run.

const JFS_TITLE_BATCH = 20; // max jobs per screenTitle call (DESIGN 3.5)
const JFS_MAX_ERRORS_IN_ROW = 3; // then pause — the backend or the site is probably down
const JFS_HANDOFF_MS = 60000; // the next page must pick the run up within a minute of the navigation
const JFS_JOB_PAGE_TIMEOUT_MS = 20000; // Glassdoor / Indeed job-page fetch gives up after this
const JFS_MAX_LANES = 4; // at most this many job pages are read at the same time
const JFS_BACKOFF_SECONDS = [30, 60, 120]; // waits after a blocked job page; still blocked after the last → pause
// Polite random gaps [min, max] in ms. Short enough to be quick, random so the rhythm is not machine-like.
const JFS_GAP_MS = {
  jobPage: [300, 900], // before each job page, per lane (not for automation runs on Indeed / Glassdoor: jfsJdPace)
  resultsPage: [1000, 2000], // before going to the next results page
  saveClick: [150, 400], // after clicking the site's save button
};
const JFS_BLOCK_TITLE_RE = /just a moment|verify you are (a )?human|captcha|access denied|attention required|help us protect|security \| glassdoor/i;
const JFS_BLOCK_BODY_RE = /just a moment|verify you are (a )?human|are you a robot|captcha|access denied|unusual traffic|help us protect/i;
const JFS_COLORS = {
  active: { outline: '#d4a72c', background: '#fff8c5' }, // yellow: being read right now
  pass: { outline: '#1a7f37', background: '#dafbe1' }, // green: match
  reject: { outline: '#cf222e', background: '#ffebe9' }, // red: rejected (hidden 600 ms later)
  skip: { outline: '#8c959f', background: '#f6f8fa' }, // grey: could not judge (error / no JD)
};

// ------------------------------------------------------------------ small helpers

function jfsSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Random wait between minMs and maxMs — keeps the request rhythm slow and human-like. */
function jfsRandomSleep(minMs, maxMs) {
  return jfsSleep(minMs + Math.random() * (maxMs - minMs));
}

/** Polls check() until it returns something truthy or timeoutMs passes. Resolves true / false. */
async function jfsWaitFor(check, timeoutMs, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (check()) return true;
    } catch (e) {
      // a half-rendered DOM can throw; just try again on the next tick
    }
    if (Date.now() >= deadline) return false;
    await jfsSleep(intervalMs);
  }
}

/** chrome.runtime.sendMessage as a promise that never rejects: every failure comes back as {error}. */
function jfsSend(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (reply) => {
        const err = chrome.runtime.lastError; // reading it also silences "Unchecked runtime.lastError"
        if (err) resolve({ error: err.message || String(err) });
        else resolve(reply || { error: 'empty reply' });
      });
    } catch (e) {
      resolve({ error: String((e && e.message) || e) }); // e.g. "Extension context invalidated" after a reload
    }
  });
}

/** Visible text of an element, whitespace collapsed ('' when the element is missing). */
function jfsText(el) {
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
}

/** True when the element (or an ancestor) is display:none. getClientRects also works for fixed elements. */
function jfsIsHidden(el) {
  return !el || el.getClientRects().length === 0;
}

function jfsSetHidden(el, hidden) {
  if (!el) return;
  if (hidden) el.style.setProperty('display', 'none', 'important');
  else el.style.removeProperty('display');
}

/** Card highlight. Final states are remembered in data-jf-state so the passive filter leaves the card alone. */
function jfsPaint(el, kind) {
  const color = JFS_COLORS[kind];
  if (!el || !color) return;
  el.style.setProperty('outline', `3px solid ${color.outline}`, 'important');
  el.style.setProperty('outline-offset', '-3px', 'important');
  el.style.setProperty('background-color', color.background, 'important');
  if (kind !== 'active') {
    el.dataset.jfState = kind;
    return;
  }
  // Lets you watch the run. Only scrolls when the card is off-screen, so parallel lanes don't make the list jump.
  const box = el.getBoundingClientRect();
  if (box.top < 0 || box.bottom > window.innerHeight) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** How many job pages are read at once: <site>.jdParallel (Glassdoor / Indeed) or naukri.jdTabs, 1..4. */
function jfsJdLanes(siteSettings) {
  const wanted = siteSettings.jdParallel != null ? siteSettings.jdParallel : siteSettings.jdTabs;
  return Math.min(Math.max(parseInt(wanted, 10) || 1, 1), JFS_MAX_LANES);
}

/**
 * How the JD stage reads job pages: {lanes, gapMs} (gapMs null = no gap).
 * Automation on Indeed / Glassdoor: one page at a time, no gap. Nobody is watching to solve a check page, and one
 * at a time trips far fewer rate limits; the page fetch + the AI call already take a few seconds per job.
 * Everything else (a popup Start, and Naukri in both modes): the lanes from the settings + the polite gap.
 */
function jfsJdPace(mode, site, siteSettings) {
  if (mode === 'automation' && (site === 'indeed' || site === 'glassdoor')) return { lanes: 1, gapMs: null };
  // Indeed reads each description from its single right-hand panel (one job at a time), so one lane always.
  if (site === 'indeed') return { lanes: 1, gapMs: JFS_GAP_MS.jobPage };
  return { lanes: jfsJdLanes(siteSettings), gapMs: JFS_GAP_MS.jobPage };
}

/** Clicks a site button (save / bookmark) and waits until isDone() confirms the new state. */
async function jfsClickAndWait(button, isDone, timeoutMs = 2000) {
  button.click(); // plain element.click() is enough for these sites' React buttons
  return jfsWaitFor(isDone, timeoutMs, 150);
}

/**
 * Captcha / Cloudflare / "Access Denied" detection for the current page.
 * The body text is only checked when there are no job cards: a real results page is never a block page,
 * and footers like "protected by reCAPTCHA" must not pause a run.
 */
function jfsPageLooksBlocked(hasCards) {
  if (JFS_BLOCK_TITLE_RE.test(document.title || '')) return true;
  if (hasCards) return false;
  return JFS_BLOCK_BODY_RE.test(document.body ? document.body.innerText : '');
}

/** The job fields the backend expects (DESIGN 2.2) — never the extra adapter flags. */
function jfsJobPayload(job) {
  return {
    job_id: String(job.job_id),
    title: job.title || '',
    company: job.company || '',
    location: job.location || '',
    experience_text: job.experience_text || '',
    link: job.link || '',
  };
}

/** adapter.readCard that never throws (one odd card must not stop the page). */
function jfsReadCard(adapter, el) {
  try {
    return adapter.readCard(el);
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------------ HTML → text, JSON-LD, job pages

/** Turns HTML into readable plain text: block elements become line breaks, whitespace is collapsed. */
function jfHtmlToText(html) {
  if (!html) return '';
  const body = new DOMParser().parseFromString(String(html), 'text/html').body;
  if (!body) return '';
  body.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
  body.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  body.querySelectorAll('li').forEach((li) => li.prepend('- '));
  body
    .querySelectorAll('p, div, li, ul, ol, h1, h2, h3, h4, h5, h6, tr, table, section, article, header, footer, blockquote, pre')
    .forEach((el) => el.append('\n'));
  return body.textContent
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Job description from the page's JSON-LD JobPosting (the most reliable source on Indeed / Glassdoor). */
function jfJsonLdJobDescription(doc) {
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try {
      data = JSON.parse(script.textContent);
    } catch (e) {
      continue; // some sites ship broken JSON-LD blocks next to good ones
    }
    // JSON-LD comes as one object, an array, or {"@graph": object or array}
    const graph = data && data['@graph'];
    const items = Array.isArray(data) ? data : graph ? [].concat(graph) : [data];
    for (const item of items) {
      const type = item && item['@type'];
      const isJob = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
      if (!isJob || typeof item.description !== 'string') continue;
      let text = jfHtmlToText(item.description);
      if (/<[a-z][^>]*>/i.test(text)) text = jfHtmlToText(text); // description was HTML-escaped twice
      if (text) return text;
    }
  }
  return '';
}

/** Text of the first selector that matches inside root ('' when none does). */
function jfsFirstText(root, selectors) {
  for (const selector of selectors) {
    const el = root.querySelector(selector);
    const text = el ? jfHtmlToText(el.innerHTML) : '';
    if (text) return text;
  }
  return '';
}

/**
 * Downloads a job page (same origin, with the user's cookies) and reads its JD: JSON-LD first, then the
 * fallback selectors. This is the adapter's fetchJd result: {jd, blocked}, where `blocked` is null, or
 * `blockedMessage` when the site answered with a rate limit / check page (the engine backs off, see readJd).
 */
async function jfsFetchJobPage(url, fallbackSelectors, blockedMessage) {
  // A job page that never answers must not freeze the run (one Indeed page took 27 s in testing).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JFS_JOB_PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { credentials: 'include', signal: controller.signal });
    // 403 = check page (Cloudflare), 429 = too many requests, 503 = "come back later" / older check pages
    if (res.status === 403 || res.status === 429 || res.status === 503) return { jd: '', blocked: blockedMessage };
    if (!res.ok) return { jd: '', blocked: null }; // e.g. 404 = job expired
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    if (JFS_BLOCK_TITLE_RE.test(doc.title || '')) return { jd: '', blocked: blockedMessage };
    return { jd: jfJsonLdJobDescription(doc) || jfsFirstText(doc, fallbackSelectors), blocked: null };
  } catch (e) {
    console.warn('[JobFilter] job page fetch failed:', e); // includes the timeout abort
    return { jd: '', blocked: null };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ the engine

const JFScraper = {
  adapter: null, // the site adapter from glassdoor.js / naukri.js / indeed.js
  state: null, // scrape_state of the run this page is working on
  runId: 0, // bumped by start / resume / stop / pause; an older loop sees the change and exits
  activeRunId: 0, // runId of the loop running on this page right now (0 = none)
  done: new Set(), // job ids finished on this page during this run
  errorsInRow: 0,
  blockLevel: 0, // rate-limit waits in a row so far (index into JFS_BACKOFF_SECONDS)
  lastBlockAt: 0, // when the last blocked job page started a wait (see backOff)
  sleepers: new Set(), // wake-up functions of the naps in progress (see nap)

  // ---------- wiring: every site file calls these three on page load ----------

  /**
   * Handles scrapeStart {mode} / scrapeStop {reason} / scrapeResume {onlyIfRunning} / scrapeStatus from the popup
   * and the background's automation; replies with scrape_state.
   */
  listen(adapter) {
    this.adapter = adapter;
    const actions = {
      scrapeStart: (msg) => this.start(msg.mode),
      scrapeStop: (msg) => this.stop(msg.reason),
      scrapeResume: (msg) => this.resume(msg.onlyIfRunning === true),
      scrapeStatus: () => this.status(),
    };
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      const action = msg && actions[msg.type];
      if (!action) return false;
      action(msg).then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
      return true; // the reply is sent asynchronously
    });
    // Our run was stopped or paused from elsewhere (popup, background, another tab): stop here as well and
    // keep that state, so our next save() can't write running / paused:false back over it.
    chrome.storage.onChanged.addListener((changes, area) => {
      const next = area === 'local' && changes.scrape_state && changes.scrape_state.newValue;
      const stoppedElsewhere = next && (next.running === false || next.paused === true);
      if (stoppedElsewhere && this.isBusy() && next.startedAt === this.state.startedAt) {
        this.cancelLoops();
        this.state = next;
      }
    });
  },

  /** Rules (blacklist / whitelist / hide saved / hide promoted) on every card while NO run is active here. */
  startPassiveFilter(adapter) {
    this.adapter = adapter;
    let settings = null;
    let timer = 0;
    const apply = () => {
      if (!settings || this.isBusy()) return; // during a run the engine applies the rules itself
      for (const el of adapter.findCards()) {
        if (el.dataset.jfState) continue; // judged by a run on this page — keep its highlight
        const job = jfsReadCard(adapter, el);
        if (job) this.applyRules(el, job, settings);
      }
    };
    const schedule = () => {
      clearTimeout(timer); // these pages mutate in bursts; filter once the burst settles
      timer = setTimeout(() => {
        try {
          apply();
        } catch (e) {
          console.warn('[JobFilter] filter error:', e);
        }
      }, 300);
    };
    const reloadSettings = async () => {
      try {
        settings = await jfLoadSettings();
      } catch (e) {
        console.warn('[JobFilter] could not load settings:', e);
      }
      schedule();
    };
    // New cards arrive (pagination, "show more") and cards change state (saved icon, aria flags).
    new MutationObserver(schedule).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'aria-label', 'aria-pressed'],
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) reloadSettings();
    });
    reloadSettings();
  },

  /** On page load: take over the run that the previous page just handed over ("Next page" navigation). */
  async resumeIfRunning(adapter) {
    this.adapter = adapter;
    if (!this.isOurRun(await this.loadState())) return; // a paused run waits for the user's Resume
    const hasCards = await jfsWaitFor(() => adapter.findCards().length > 0, 15000, 500);
    // Read again after the wait: by now the old page's hand-off has surely reached storage.
    const state = await this.loadState();
    const handedOver = this.isOurRun(state) && !!state.handoffAt && Date.now() - state.handoffAt < JFS_HANDOFF_MS;
    if (!handedOver || this.isBusy()) return; // not navigated here by the run: leave it alone
    this.state = state;
    this.state.handoffAt = null; // taken: no other page may pick it up now
    if (!hasCards) {
      // The run navigated here, so this page must end it: a captcha page pauses it, anything else ends it.
      if (!(await this.pauseIfBlocked())) await this.end('no job cards found on this page');
      return;
    }
    await this.save();
    this.done.clear();
    this.run();
  },

  isOurRun(state) {
    return (
      !!state && state.running && !state.paused && state.site === this.adapter.site && state.pageKey === location.host
    );
  },

  // ---------- popup / automation commands ----------

  /** mode "automation" = started by the background's automation (slower JD pace, see jfsJdPace); else "manual". */
  async start(mode) {
    if (this.isBusy()) return this.state; // already running on this page
    const settings = await jfLoadSettings();
    const siteSettings = settings[this.adapter.site] || {};
    this.state = {
      running: true,
      site: this.adapter.site,
      mode: mode === 'automation' ? 'automation' : 'manual', // kept through page hand-offs and Resume
      tabId: null, // content scripts can't see their tab id; the background stamps it from sender.tab.id
      pageKey: location.host,
      handoffAt: null, // set while the run moves to the next page (see the top of this file)
      page: 1,
      pagesDone: 0,
      maxPages: Number(siteSettings.maxPages) || 10,
      startedAt: Date.now(),
      counts: { seen: 0, ruleHidden: 0, titleRejected: 0, jdRejected: 0, matched: 0, duplicates: 0, errors: 0 },
      paused: false,
      pauseReason: null, // why it paused — or, once running is false, why it ended (the popup shows it)
      waitReason: null, // "waiting 30s (site rate limit)" while all lanes back off (the popup shows it)
      waitUntil: null, // when that wait ends (ms timestamp)
    };
    this.done.clear();
    await this.save();
    this.run(); // not awaited: the popup gets its reply right away
    return this.state;
  },

  /** reason: why it ended (the popup shows it); the automation passes its own, a popup Stop is "stopped by user". */
  async stop(reason) {
    const state = this.isBusy() ? this.state : await this.loadState();
    this.cancelLoops(); // the running loop (if any) exits at its next check
    if (!state) return null;
    const pauseReason = reason || 'stopped by user';
    Object.assign(state, { running: false, paused: false, pauseReason, waitReason: null, waitUntil: null });
    this.state = state;
    await this.save();
    return state;
  },

  /**
   * onlyIfRunning (the automation, after its tab loaded a page by itself): take over a run that is still going on
   * but lost its page; never restart one that ended meanwhile or one that is paused (that waits for your Resume).
   */
  async resume(onlyIfRunning = false) {
    if (this.isBusy()) return this.state;
    const state = await this.loadState();
    if (!state || state.site !== this.adapter.site) return state; // nothing of this site to resume
    if (onlyIfRunning && !(state.running && !state.paused)) return state;
    Object.assign(state, { running: true, paused: false, pauseReason: null, pageKey: location.host, handoffAt: null });
    this.state = state;
    await this.save();
    this.run();
    return state;
  },

  async status() {
    return this.isBusy() ? this.state : this.loadState();
  },

  // ---------- the loop ----------
  // After EVERY await we check alive(token): Stop, Pause or a newer run can happen at any moment.

  async run() {
    const token = ++this.runId;
    this.activeRunId = token;
    this.errorsInRow = 0;
    this.blockLevel = 0; // a Resume starts the rate-limit waits from 30 s again
    this.lastBlockAt = 0;
    Object.assign(this.state, { waitReason: null, waitUntil: null });
    try {
      while (this.alive(token)) {
        const hasCards = await jfsWaitFor(() => this.adapter.findCards().length > 0, 15000, 500);
        if (!(await this.canContinue(token))) return;
        if (!hasCards) {
          await this.end('no job cards found on this page');
          return;
        }
        await jfsSleep(800); // let the list finish rendering
        const settings = await jfLoadSettings(); // re-read per page so popup changes apply mid-run
        if (!this.alive(token)) return;

        await this.processPage(token, settings);
        if (!this.alive(token)) return;

        // A page is counted only when we leave it, so a pause + Resume on this page can't count it twice.
        if (this.state.pagesDone + 1 >= this.state.maxPages) {
          this.state.pagesDone += 1;
          await this.end('reached max pages');
          return;
        }
        await jfsRandomSleep(...JFS_GAP_MS.resultsPage); // polite gap between results pages
        if (!(await this.canContinue(token))) return;

        this.state.pagesDone += 1;
        const result = await this.adapter.nextPage();
        if (!this.alive(token)) return; // Stop came while Glassdoor was loading more jobs
        if (result === 'none') {
          await this.end('no more pages');
          return;
        }
        this.state.page += 1;
        if (result === 'navigating') {
          // Hand the run to the next page (resumeIfRunning). save() sends its message right away,
          // before this page unloads, and the background stores it.
          this.state.handoffAt = Date.now();
          await this.save();
          return;
        }
        await this.save();
        // 'same-page' (Glassdoor "Show more jobs"): loop again over the new cards
      }
    } catch (e) {
      console.warn('[JobFilter] scraper error:', e);
      if (this.alive(token)) await this.pause(`error: ${(e && e.message) || e}`);
    } finally {
      if (this.activeRunId === token) this.activeRunId = 0;
    }
  },

  async processPage(token, settings) {
    // Repeat until no new cards show up (Glassdoor appends cards to the same list).
    while (this.alive(token)) {
      const fresh = this.collectNewCards(settings);
      await this.save();
      if (fresh.length === 0) return;
      for (let i = 0; i < fresh.length && this.alive(token); i += JFS_TITLE_BATCH) {
        await this.screenTitles(token, settings, fresh.slice(i, i + JFS_TITLE_BATCH));
      }
    }
  },

  /** Step 1 — rules. Hides rule matches right away and returns the cards that need the AI. */
  collectNewCards(settings) {
    const fresh = [];
    const idsNow = new Set();
    for (const el of this.adapter.findCards()) {
      const job = jfsReadCard(this.adapter, el);
      if (!job) continue;
      if (!job.job_id || this.done.has(job.job_id) || idsNow.has(job.job_id)) {
        // Nothing to judge (no id, or a copy of a job we already have), but the rules still apply to it:
        // the passive filter is off during a run. Judged cards keep their highlight.
        if (!el.dataset.jfState) this.applyRules(el, job, settings);
        continue;
      }
      if (this.applyRules(el, job, settings)) {
        this.finishJob(job, 'ruleHidden');
        continue;
      }
      if (jfsIsHidden(el)) continue; // hidden by the site itself — not ours to judge
      idsNow.add(job.job_id);
      fresh.push({ el, job });
    }
    return fresh;
  },

  /** Step 2 — title AI for one batch, then step 3 (JD AI) for the jobs that passed. */
  async screenTitles(token, settings, items) {
    if (settings.aiEnabled === false) {
      items.forEach((item) => this.finishJob(item.job, null)); // rules-only run: leave the cards as they are
      return;
    }
    const reply = await jfsSend({
      type: 'screenTitle',
      site: this.adapter.site,
      jobs: items.map((item) => jfsJobPayload(item.job)),
    });
    if (!this.alive(token)) return;
    if (reply.error === 'ai_disabled') {
      items.forEach((item) => this.finishJob(item.job, null)); // AI switched off: rules only, mark nothing
      return;
    }

    let results = [];
    if (reply.error || !Array.isArray(reply.results)) {
      // Never hide on an error: count it and let every job of this batch go on to the JD step as a pass.
      await this.countError(`title AI: ${reply.error || 'unexpected reply'}`);
      if (!this.alive(token)) return;
    } else {
      this.errorsInRow = 0;
      results = reply.results;
    }

    const verdictById = new Map(results.map((r) => [String(r.job_id), r]));
    const needJd = [];
    for (const item of items) {
      const verdict = verdictById.get(String(item.job.job_id));
      if (verdict && verdict.duplicate === true) {
        this.hideDuplicate(item);
      } else if (verdict && (verdict.final || verdict.decision === 'reject')) {
        // final = the JD verdict is already cached → no need to read the JD again
        await this.applyVerdict(token, item, verdict, settings);
        if (!this.alive(token)) return;
      } else {
        needJd.push(item);
      }
    }
    await this.save();

    // Several lanes, each reading one job at a time. JS runs one callback at a time, so shift() hands
    // every job to exactly one lane: no job is read twice.
    const pace = jfsJdPace(this.state.mode, this.adapter.site, settings[this.adapter.site] || {});
    const lane = async () => {
      while (needJd.length && this.alive(token)) await this.screenJd(token, settings, needJd.shift(), pace.gapMs);
    };
    await Promise.all(Array.from({ length: Math.min(pace.lanes, needJd.length) }, lane));
  },

  /** A repost of a job judged before (same title + company, found by the backend): hide it. No JD, no save click. */
  hideDuplicate(item) {
    item.el.dataset.jfState = 'duplicate'; // the passive filter leaves judged cards alone
    this.adapter.hideCard(item.el);
    this.finishJob(item.job, 'duplicates');
  },

  /** Step 3 — read the full JD and let the backend judge it. gapMs: [min, max] wait before the job page, or null. */
  async screenJd(token, settings, item, gapMs) {
    const jd = await this.readJd(token, item, gapMs);
    if (jd === null) return; // stopped / paused meanwhile: the job stays unfinished and is retried after Resume
    if (!jd) {
      await this.skipJob(item, 'could not read the job description');
      return;
    }

    const verdict = await jfsSend({
      type: 'screenJd',
      site: this.adapter.site,
      job: { ...jfsJobPayload(item.job), jd },
    });
    if (!this.alive(token)) return;
    if (verdict.error) {
      await this.skipJob(item, `JD AI: ${verdict.error}`, verdict.error !== 'ai_disabled');
      return;
    }
    await this.applyVerdict(token, item, verdict, settings);
  },

  /**
   * Step 3a — the JD text of one job ('' = none), or null when the run stopped / paused meanwhile.
   * adapter.fetchJd answers {jd, blocked}. A blocked job page is usually a short rate limit: back off, then
   * retry the SAME job (backOff decides how long, or pauses).
   */
  async readJd(token, item, gapMs) {
    for (;;) {
      if (!(await this.waitOutBackoff(token))) return null; // every lane holds back while the site rate-limits us
      if (gapMs) await jfsRandomSleep(...gapMs); // polite gap between job pages; also staggers lanes after a wait
      if (!(await this.canContinue(token))) return null;
      if (this.state.waitUntil) continue; // another lane started a wait during our gap: wait as well

      this.adapter.highlight(item.el, 'active');
      const startedAt = Date.now();
      let page = null;
      try {
        page = await this.adapter.fetchJd(item.job);
      } catch (e) {
        console.warn('[JobFilter] fetchJd failed:', e);
      }
      if (!this.alive(token)) return null;
      if (!page || !page.blocked) {
        if (startedAt > this.lastBlockAt) this.blockLevel = 0; // the site answers normally again
        return (page && page.jd) || '';
      }
      if (!(await this.backOff(token, page.blocked, startedAt))) return null;
    }
  },

  /**
   * A job page came back blocked. A NEW block starts the next wait (30 s → 60 s → 120 s) for all lanes; a block
   * on a request that was already under way when the last wait began is the same burst, so it just joins that
   * wait. Still blocked after the last wait → pause with the adapter's message. False = the run must not go on.
   */
  async backOff(token, blockedMessage, startedAt) {
    if (startedAt > this.lastBlockAt) {
      if (this.blockLevel >= JFS_BACKOFF_SECONDS.length) {
        await this.pause(`Still blocked after waiting ${JFS_BACKOFF_SECONDS.join(', ')} seconds. ${blockedMessage}`);
        return false;
      }
      const seconds = JFS_BACKOFF_SECONDS[this.blockLevel];
      this.blockLevel += 1;
      this.lastBlockAt = Date.now();
      Object.assign(this.state, {
        waitReason: `waiting ${seconds}s (site rate limit)`,
        waitUntil: this.lastBlockAt + seconds * 1000,
      });
      console.warn('[JobFilter] job page blocked,', this.state.waitReason);
      await this.save();
    }
    return this.waitOutBackoff(token);
  },

  /** Waits while a rate-limit wait is on: one nap per lane, which Stop / Pause end at once (see nap). */
  async waitOutBackoff(token) {
    while (this.alive(token) && this.state.waitUntil) {
      const left = this.state.waitUntil - Date.now();
      if (left > 0) {
        await this.nap(left);
      } else {
        Object.assign(this.state, { waitReason: null, waitUntil: null }); // over: the popup stops showing it
        await this.save();
      }
    }
    return this.alive(token);
  },

  /** Shows a verdict on the card, counts it, and clicks the site's save button per settings.<site>.markProcessed. */
  async applyVerdict(token, item, verdict, settings) {
    const { el, job } = item;
    // A "pass" without a real judgement (no JD / AI error) is not a match: skip it so a later run retries it.
    // Only ai_error counts toward the "backend is down" pause; no_jd just means a (nearly) empty description.
    const reason = verdict.reason || '';
    if (verdict.decision !== 'reject' && /^(no_jd|ai_error)/.test(reason)) {
      await this.skipJob(item, reason, reason.startsWith('ai_error'));
      return;
    }
    this.errorsInRow = 0;
    const rejected = verdict.decision === 'reject';
    if (rejected) {
      this.adapter.highlight(el, 'reject');
      setTimeout(() => this.adapter.hideCard(el), 600); // short red flash, then gone
      this.finishJob(job, verdict.stage === 'jd' ? 'jdRejected' : 'titleRejected');
    } else {
      this.adapter.highlight(el, 'pass');
      if (verdict.cached && verdict.final) this.adapter.hideCard(el); // matched in an earlier run: already in a CSV
      this.finishJob(job, 'matched');
    }

    // Saving the job on the site = "processed": with hideSaved on, it stays hidden on later visits.
    const mode = (settings[this.adapter.site] || {}).markProcessed || 'none';
    if (mode === 'all' || (mode === 'rejected' && rejected)) {
      try {
        await this.adapter.markProcessed(el);
      } catch (e) {
        console.warn('[JobFilter] markProcessed failed:', e);
      }
      if (!this.alive(token)) return;
      await jfsRandomSleep(...JFS_GAP_MS.saveClick); // no rapid-fire save clicks
    }
    await this.save();
  },

  /** Grey card: could not be judged. Never hidden, never marked, so the next run tries again. */
  async skipJob(item, why, isError = true) {
    this.adapter.highlight(item.el, 'skip');
    this.finishJob(item.job, null);
    if (isError) await this.countError(why);
    await this.save();
  },

  // ---------- rules ----------

  /** Why the rules hide this job ('saved' | 'promoted' | 'company' | 'blacklist:<kw>' | 'whitelist'), or null. */
  ruleReason(job, settings) {
    const siteSettings = settings[this.adapter.site] || {};
    if (siteSettings.hideSaved && job.isSaved) return 'saved';
    if (siteSettings.hidePromoted && job.isPromoted) return 'promoted';
    const check = jfRuleCheck(job.title, job.company, settings.global);
    return check.hide ? check.reason : null;
  },

  /** Hides the card when a rule matches; shows it again when a rule hid it earlier but no longer matches. */
  applyRules(el, job, settings) {
    const reason = this.ruleReason(job, settings);
    if (reason) {
      el.dataset.jfRule = reason;
      this.adapter.hideCard(el);
    } else if (el.dataset.jfRule) {
      delete el.dataset.jfRule; // the user loosened the filters
      this.adapter.showCard(el);
    }
    return reason;
  },

  // ---------- state ----------

  alive(token) {
    return token === this.runId && !!this.state && this.state.running && !this.state.paused;
  },

  isBusy() {
    return this.activeRunId !== 0 && this.activeRunId === this.runId;
  },

  /** Makes every running loop exit at its next alive() check, and ends the naps they are in right now. */
  cancelLoops() {
    this.runId += 1;
    for (const wake of [...this.sleepers]) wake();
  },

  /**
   * Sleeps ms with ONE timer; cancelLoops() (Stop / Pause) wakes it at once. A covered or minimized browser
   * window runs its timers late; one long timer is late once, a chain of 0.2 s polls would be late every time.
   */
  nap(ms) {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.sleepers.add(wake);
    });
  },

  finishJob(job, countKey) {
    const counts = this.state.counts;
    this.done.add(job.job_id);
    counts.seen += 1;
    if (countKey) counts[countKey] = (counts[countKey] || 0) + 1; // `|| 0`: a run resumed from an older version
  },

  async countError(why) {
    console.warn('[JobFilter]', why);
    this.state.counts.errors += 1;
    this.errorsInRow += 1;
    if (this.errorsInRow >= JFS_MAX_ERRORS_IN_ROW) {
      await this.pause(`${JFS_MAX_ERRORS_IN_ROW} errors in a row (last: ${why}). Check the backend, then press Resume`);
    }
  },

  /** Asks the adapter for a captcha / login wall / challenge ON THE RESULTS PAGE. We never try to solve one — we pause. */
  async pauseIfBlocked() {
    let reason = null;
    try {
      reason = await this.adapter.detectBlock(); // may be sync or async (Glassdoor closes a popup first)
    } catch (e) {
      console.warn('[JobFilter] detectBlock failed:', e);
    }
    if (reason) await this.pause(reason);
    return !!reason;
  },

  /** alive() + no captcha / login wall. Checks alive again after detectBlock, which can take a moment
   *  (Glassdoor closes a popup first): a Stop that came meanwhile must not be followed by more work. */
  async canContinue(token) {
    if (!this.alive(token) || (await this.pauseIfBlocked())) return false;
    return this.alive(token);
  },

  async pause(reason) {
    if (!this.state.running || this.state.paused) return; // with parallel lanes the first reason wins
    Object.assign(this.state, { paused: true, pauseReason: reason, waitReason: null, waitUntil: null });
    this.cancelLoops(); // like stop(): lanes still waiting on a job page exit, and Resume works right away
    await this.save();
  },

  async end(reason) {
    Object.assign(this.state, { running: false, paused: false, pauseReason: reason, waitReason: null, waitUntil: null });
    await this.save();
  },

  /**
   * The background writes scrape_state to storage (+ badge) and replies once it is stored, so after
   * `await save()` the next page can resume from it. If the background can't be reached, write it ourselves.
   */
  async save() {
    if (!this.state) return;
    const reply = await jfsSend({ type: 'scrapeProgress', state: this.state });
    if (!reply.error) return;
    try {
      await chrome.storage.local.set({ scrape_state: this.state });
    } catch (e) {
      console.warn('[JobFilter] could not save scrape_state:', e);
    }
  },

  async loadState() {
    try {
      const data = await chrome.storage.local.get('scrape_state');
      return data.scrape_state || null;
    } catch (e) {
      return null;
    }
  },
};
