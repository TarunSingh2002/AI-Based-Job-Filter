// sites/scraper-core.js — shared scraper engine for Glassdoor, Naukri and Indeed (DESIGN.md 3.5).
//
// Load order (manifest): common/filters.js → sites/scraper-core.js → sites/<site>.js.
// Content scripts of one page share one global scope, so the site file uses everything defined here.
// Names are prefixed (jfs…) so they never clash with globals from common/filters.js.
//
// Pipeline for every card:
//   rules (instant) → title AI (batches of ≤20) → JD AI (one job at a time, polite random delays;
//   Naukri: one job per worker tab, `jdTabs` tabs) → highlight / hide / mark with the site's own save button.
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
  if (kind === 'active') el.scrollIntoView({ block: 'center', behavior: 'smooth' }); // lets you watch the run
  else el.dataset.jfState = kind;
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
 * Downloads a job page (same origin, with the user's cookies) and reads its JD:
 * JSON-LD first, then the fallback selectors. `blocked` = the site answered with a check page.
 */
async function jfsFetchJobPage(url, fallbackSelectors) {
  // A job page that never answers must not freeze the run (one Indeed page took 27 s in testing).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JFS_JOB_PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { credentials: 'include', signal: controller.signal });
    if (res.status === 403 || res.status === 429) return { jd: '', blocked: true };
    if (!res.ok) return { jd: '', blocked: false }; // e.g. 404 = job expired
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    if (JFS_BLOCK_TITLE_RE.test(doc.title || '')) return { jd: '', blocked: true };
    return { jd: jfJsonLdJobDescription(doc) || jfsFirstText(doc, fallbackSelectors), blocked: false };
  } catch (e) {
    console.warn('[JobFilter] job page fetch failed:', e); // includes the timeout abort
    return { jd: '', blocked: false };
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

  // ---------- wiring: every site file calls these three on page load ----------

  /** Handles the popup's scrapeStart / scrapeStop / scrapeResume / scrapeStatus; replies with scrape_state. */
  listen(adapter) {
    this.adapter = adapter;
    const actions = {
      scrapeStart: () => this.start(),
      scrapeStop: () => this.stop(),
      scrapeResume: () => this.resume(),
      scrapeStatus: () => this.status(),
    };
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      const action = msg && actions[msg.type];
      if (!action) return false;
      action().then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
      return true; // the reply is sent asynchronously
    });
    // Our run was stopped or paused from elsewhere (popup, background, another tab): stop here as well and
    // keep that state, so our next save() can't write running / paused:false back over it.
    chrome.storage.onChanged.addListener((changes, area) => {
      const next = area === 'local' && changes.scrape_state && changes.scrape_state.newValue;
      const stoppedElsewhere = next && (next.running === false || next.paused === true);
      if (stoppedElsewhere && this.isBusy() && next.startedAt === this.state.startedAt) {
        this.runId += 1;
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

  // ---------- popup commands ----------

  async start() {
    if (this.isBusy()) return this.state; // already running on this page
    const settings = await jfLoadSettings();
    const siteSettings = settings[this.adapter.site] || {};
    this.state = {
      running: true,
      site: this.adapter.site,
      tabId: null, // content scripts can't see their tab id; the background stamps it from sender.tab.id
      pageKey: location.host,
      handoffAt: null, // set while the run moves to the next page (see the top of this file)
      page: 1,
      pagesDone: 0,
      maxPages: Number(siteSettings.maxPages) || 10,
      startedAt: Date.now(),
      counts: { seen: 0, ruleHidden: 0, titleRejected: 0, jdRejected: 0, matched: 0, errors: 0 },
      paused: false,
      pauseReason: null, // why it paused — or, once running is false, why it ended (the popup shows it)
    };
    this.done.clear();
    await this.save();
    this.run(); // not awaited: the popup gets its reply right away
    return this.state;
  },

  async stop() {
    const state = this.isBusy() ? this.state : await this.loadState();
    this.runId += 1; // the running loop (if any) exits at its next check
    if (!state) return null;
    Object.assign(state, { running: false, paused: false, pauseReason: 'stopped by user' });
    this.state = state;
    await this.save();
    return state;
  },

  async resume() {
    if (this.isBusy()) return this.state;
    const state = await this.loadState();
    if (!state || state.site !== this.adapter.site) return state; // nothing of this site to resume
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
        await jfsRandomSleep(2000, 4000); // polite gap between pages
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
      // final = the JD verdict is already cached → no need to read the JD again
      if (verdict && (verdict.final || verdict.decision === 'reject')) {
        await this.applyVerdict(token, item, verdict, settings);
        if (!this.alive(token)) return;
      } else {
        needJd.push(item);
      }
    }
    await this.save();

    // One job at a time per lane. Naukri runs `jdTabs` lanes (one per worker tab); the other sites run one.
    const lanes = Math.max(1, Number((settings[this.adapter.site] || {}).jdTabs) || 1);
    const lane = async () => {
      while (needJd.length && this.alive(token)) await this.screenJd(token, settings, needJd.shift());
    };
    await Promise.all(Array.from({ length: Math.min(lanes, needJd.length) }, lane));
  },

  /** Step 3 — read the full JD and let the backend judge it. */
  async screenJd(token, settings, item) {
    await jfsRandomSleep(800, 2000); // polite gap between job pages
    if (!(await this.canContinue(token))) return;

    this.adapter.highlight(item.el, 'active');
    let jd = '';
    try {
      jd = await this.adapter.fetchJd(item.job);
    } catch (e) {
      console.warn('[JobFilter] fetchJd failed:', e);
    }
    if (!this.alive(token)) return;
    if (!jd) {
      // A check page instead of the JD → pause; this job stays unfinished and is retried after Resume.
      if (!(await this.canContinue(token))) return;
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
      await jfsRandomSleep(300, 800); // no rapid-fire save clicks
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

  finishJob(job, countKey) {
    this.done.add(job.job_id);
    this.state.counts.seen += 1;
    if (countKey) this.state.counts[countKey] += 1;
  },

  async countError(why) {
    console.warn('[JobFilter]', why);
    this.state.counts.errors += 1;
    this.errorsInRow += 1;
    if (this.errorsInRow >= JFS_MAX_ERRORS_IN_ROW) {
      await this.pause(`${JFS_MAX_ERRORS_IN_ROW} errors in a row (last: ${why}). Check the backend, then press Resume`);
    }
  },

  /** Asks the adapter for a captcha / login wall / challenge. We never try to solve one — we pause. */
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
    if (!this.state.running) return;
    Object.assign(this.state, { paused: true, pauseReason: reason });
    this.runId += 1; // like stop(): lanes still waiting on a job page exit, and Resume works right away
    await this.save();
  },

  async end(reason) {
    Object.assign(this.state, { running: false, paused: false, pauseReason: reason });
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
