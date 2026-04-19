// ============================================================
// Glassdoor.com Job Filter - Content Script
// Features:
//   - Hide saved jobs (+ hide on save-click in real time)
//   - Hide jobs by blacklisted company name (exact, case-insensitive)
//   - Hide jobs by blacklisted title keywords
// ============================================================

let glassdoorObserver = null;
let glassdoorFilters = {};

// ── Helpers (same logic as naukri-content.js) ─────────────────

function gdNormalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function gdTitleMatchesBlacklist(keyword, normalizedTitle) {
  const normalizedKeyword = gdNormalizeText(keyword);
  const keywordWords = normalizedKeyword.split(' ');
  const titleWords = normalizedTitle.split(' ');

  if (keywordWords.length > 1) {
    const regex = new RegExp(`\\b${normalizedKeyword.replace(/\s+/g, '\\s+')}\\b`);
    if (regex.test(normalizedTitle)) return true;
    const compressedKeyword = keywordWords.join('');
    const compressedTitle = normalizedTitle.replace(/\s/g, '');
    return compressedTitle.includes(compressedKeyword);
  } else {
    return titleWords.includes(normalizedKeyword);
  }
}

function gdCompanyMatchesBlacklist(companyText, blacklistedCompanies) {
  // Exact match only, case-insensitive.
  // "inmobi" matches "InMobi" but NOT "InMobi Technologies"
  const trimmedCompany = companyText.trim().toLowerCase();
  return blacklistedCompanies.some(name => trimmedCompany === name.trim().toLowerCase());
}

// ── Card Processor ────────────────────────────────────────────
//
// Glassdoor card structure (verified via debug panel):
//   li[data-test="jobListing"]                          <- one card per job
//     a[data-test="job-title"]                          <- job title
//     span.EmployerProfile_compactEmployerName__9MGcV   <- company name
//     button[data-test="save-job"]                      <- aria-label="Saved" when saved

function processGlassdoorCard(li) {
  const titleEl   = li.querySelector('a[data-test="job-title"]');
  const companyEl = li.querySelector('span.EmployerProfile_compactEmployerName__9MGcV');
  const saveBtn   = li.querySelector('button[data-test="save-job"]');

  if (!titleEl || !companyEl) return; // not a real job card (nudge cards etc.)

  const title           = titleEl.textContent.trim();
  const company         = companyEl.textContent.trim();
  const isSaved         = saveBtn?.getAttribute('aria-label') === 'Saved';
  const normalizedTitle = gdNormalizeText(title);

  let shouldHide = false;

  // 1. Hide saved jobs
  if (!shouldHide && glassdoorFilters.hideSaved && isSaved) {
    shouldHide = true;
  }

  // 2. Blacklisted company (exact match, case-insensitive)
  if (!shouldHide && glassdoorFilters.blacklistedCompanies.length > 0) {
    shouldHide = gdCompanyMatchesBlacklist(company, glassdoorFilters.blacklistedCompanies);
  }

  // 3. Blacklisted title keywords
  if (!shouldHide && glassdoorFilters.blacklistedKeywords.length > 0) {
    shouldHide = glassdoorFilters.blacklistedKeywords.some(kw =>
      gdTitleMatchesBlacklist(kw, normalizedTitle)
    );
  }

  // Hide the whole <li> card
  li.style.display = shouldHide ? 'none' : '';
}

// ── Main Filter Runner ────────────────────────────────────────

function filterGlassdoorJobs() {
  document.querySelectorAll('li[data-test="jobListing"]').forEach(processGlassdoorCard);
}

// ── Save-button Click Listener ────────────────────────────────
// When user saves a job, hide it after the DOM updates the aria-label.

document.addEventListener('click', function(event) {
  if (!glassdoorFilters.hideSaved) return;

  const saveBtn = event.target.closest('button[data-test="save-job"]');
  if (!saveBtn) return;

  const li = saveBtn.closest('li[data-test="jobListing"]');
  if (!li) return;

  setTimeout(() => {
    // Re-check: if now showing "Saved", hide the card
    const isNowSaved = saveBtn.getAttribute('aria-label') === 'Saved';
    if (isNowSaved) {
      li.style.display = 'none';
    }
  }, 600); // small delay for Glassdoor DOM to update aria-label
}, true);

// ── Init ──────────────────────────────────────────────────────

function glassdoorLoadFiltersAndRun() {
  chrome.storage.sync.get(
    ['glassdoor_blacklistedKeywords', 'glassdoor_blacklistedCompanies', 'glassdoor_hideSaved'],
    (data) => {
      glassdoorFilters = {
        blacklistedKeywords:  data.glassdoor_blacklistedKeywords  || [],
        blacklistedCompanies: data.glassdoor_blacklistedCompanies || [],
        hideSaved:            data.glassdoor_hideSaved            || false,
      };
      filterGlassdoorJobs();
    }
  );
}

function glassdoorStartObserver() {
  if (glassdoorObserver) glassdoorObserver.disconnect();

  // Watch the job list <ul> — new <li> cards are injected here on "Show more jobs" click
  const target = document.querySelector('ul.JobsList_jobsList__lqjTr') || document.body;

  glassdoorObserver = new MutationObserver((mutations) => {
    const hasNewNodes = mutations.some(m => m.addedNodes.length > 0);
    if (hasNewNodes) {
      filterGlassdoorJobs();
    }
  });

  glassdoorObserver.observe(target, { childList: true, subtree: true });
}

// Re-run whenever settings change in popup
chrome.storage.onChanged.addListener((changes) => {
  const gdKeys = ['glassdoor_blacklistedKeywords', 'glassdoor_blacklistedCompanies', 'glassdoor_hideSaved'];
  const hasGdChange = Object.keys(changes).some(k => gdKeys.includes(k));
  if (hasGdChange) {
    glassdoorLoadFiltersAndRun();
  }
});

// Kick off — wait for job list to exist first
if (document.querySelector('ul.JobsList_jobsList__lqjTr')) {
  glassdoorLoadFiltersAndRun();
  glassdoorStartObserver();
} else {
  const waitObserver = new MutationObserver(() => {
    if (document.querySelector('ul.JobsList_jobsList__lqjTr')) {
      waitObserver.disconnect();
      glassdoorLoadFiltersAndRun();
      glassdoorStartObserver();
    }
  });
  waitObserver.observe(document.body, { childList: true, subtree: true });
}


// ═══════════════════════════════════════════════════════════════
// ── GLASSDOOR SCRAPER MODULE (fetch-based) ──────────────────────
// ═══════════════════════════════════════════════════════════════
//
// WHY FETCH INSTEAD OF CLICKING:
//   Glassdoor is a React 17+ app — all event listeners live at the
//   root element. Any synthetic click dispatched from a content script
//   is silently ignored by React; the JD pane never updates.
//   The fix: each job card's title <a> has a real URL. That URL
//   serves a full server-rendered page containing the JD.
//   We fetch() it, parse with DOMParser, and extract the JD directly.
//   No clicking, no polling, no timeouts. ~300-600ms per card.
//
// FLOW:
//   for each visible, unsaved, unblacklisted card on the page:
//     → highlight yellow
//     → fetch job page URL
//     → parse JD from fetched HTML
//     → save card (= marks as scraped, hides on next visit)
//     → highlight green
//   when no more visible cards → click "Show more jobs" → repeat
//   when no more pages → download JSON

let gdScrapingActive = false;
let gdScrapedJobs    = [];
let gdScrapedIds     = new Set();

const gdSleep = ms => new Promise(r => setTimeout(r, ms));

// ── Card highlight ──────────────────────────────────────────────

function gdHighlightCard(card, state) {
  if (state === 'active') {
    card.style.setProperty('background-color', '#fff9c4', 'important');
    card.style.setProperty('outline', '2px solid #f5c518', 'important');
    card.style.borderRadius = '8px';
  } else if (state === 'done') {
    card.style.setProperty('background-color', '#d4edda', 'important');
    card.style.setProperty('outline', '2px solid #28a745', 'important');
    card.style.borderRadius = '8px';
  }
}

// ── Fetch JD from job page URL ──────────────────────────────────

async function gdFetchJD(jobUrl) {
  try {
    const res  = await fetch(jobUrl, { credentials: 'include' });
    if (!res.ok) return '';
    const html = await res.text();
    const doc  = new DOMParser().parseFromString(html, 'text/html');

    // Primary selector — same class as the detail pane in the SPA
    const jdEl = doc.querySelector('.JobDetails_jobDescription__uW_fK');
    if (jdEl) return jdEl.innerText?.trim() || jdEl.textContent?.trim() || '';

    // Fallbacks in case Glassdoor renames the class
    const fallbacks = [
      '[class*="jobDescription"]',
      '[data-test="jobDescriptionContent"]',
      '[class*="JobDescription"]',
    ];
    for (const sel of fallbacks) {
      const el = doc.querySelector(sel);
      if (el) return el.textContent?.trim() || '';
    }
    return '';
  } catch (err) {
    console.warn('[GD Scraper] fetch error:', err.message);
    return '';
  }
}

// ── Extract card metadata (no detail pane needed) ───────────────

function gdExtractCardData(card) {
  const jobId     = card.getAttribute('data-jobid');
  const titleEl   = card.querySelector('a[data-test="job-title"]');
  const companyEl = card.querySelector('span.EmployerProfile_compactEmployerName__9MGcV');
  const locationEl = card.querySelector('[data-test="emp-location"]');
  const salaryEl  = card.querySelector('[data-test="detailSalary"]');
  const ageEl     = card.querySelector('[data-test="job-age"]');
  const easyApplyEl = card.querySelector('[aria-label="Easy Apply"]');

  return {
    job_id:     jobId || null,
    title:      titleEl?.textContent?.trim()  || '',
    company:    companyEl?.textContent?.trim() || '',
    location:   locationEl?.textContent?.trim() || '',
    salary:     salaryEl?.textContent?.replace(/\(.*?\)/g, '').trim() || '',
    posted:     ageEl?.textContent?.trim() || '',
    easy_apply: !!easyApplyEl,
    link:       titleEl?.href || '',
    jd:         '',          // filled in by fetch
    source:     'glassdoor',
    scraped_at: new Date().toISOString(),
  };
}

// ── Save a card (marks it as scraped — hideSaved filter hides it next visit) ──

async function gdSaveCard(card) {
  try {
    const btn = card.querySelector('button[data-test="save-job"]');
    if (!btn || btn.getAttribute('aria-label') === 'Saved') return;
    btn.click();
    await gdSleep(150); // wait for aria-label to update
  } catch (_) {}
}

// ── Scrape one card ─────────────────────────────────────────────

async function gdScrapeOneCard(card) {
  const jobId   = card.getAttribute('data-jobid');
  const titleEl = card.querySelector('a[data-test="job-title"]');
  if (!jobId || !titleEl) return null;

  const jobUrl = titleEl.href;
  if (!jobUrl) return null;

  // Extract card metadata
  const data = gdExtractCardData(card);

  // Fetch full JD from the job's own URL (parallel-safe — own URL, no shared state)
  data.jd = await gdFetchJD(jobUrl);

  // Save card (→ hideSaved filter hides it on next visit)
  await gdSaveCard(card);

  gdHighlightCard(card, 'done');

  return data;
}

// ── Get next scrapeable card ────────────────────────────────────
// Skip: already scraped this session, hidden by filter, already saved

function gdGetNextCard() {
  return Array.from(
    document.querySelectorAll('li[data-test="jobListing"]')
  ).find(card => {
    const jobId   = card.getAttribute('data-jobid');
    const saveBtn = card.querySelector('button[data-test="save-job"]');
    const isSaved = saveBtn?.getAttribute('aria-label') === 'Saved';
    const hasTitle = !!card.querySelector('a[data-test="job-title"]');
    const isHidden = card.style.display === 'none';

    return jobId && !gdScrapedIds.has(jobId) && !isSaved && !isHidden && hasTitle;
  }) || null;
}

// ── Click "Show more jobs" and wait for new cards ───────────────

async function gdClickLoadMore() {
  const btn = document.querySelector('button[data-test="load-more"]');
  if (!btn) return false;

  const countBefore = document.querySelectorAll('li[data-test="jobListing"]').length;

  btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await gdSleep(200);
  btn.click();

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await gdSleep(300);
    const countNow = document.querySelectorAll('li[data-test="jobListing"]').length;
    if (countNow > countBefore) {
      filterGlassdoorJobs(); // apply existing filters to new cards
      await gdSleep(150);
      return true;
    }
  }
  return false;
}

// ── Main scraping loop ──────────────────────────────────────────

const GD_BATCH_SIZE = 4; // fetch 4 jobs in parallel — fast but safe

async function gdStartScraping() {
  if (gdScrapingActive) return;
  gdScrapingActive = true;
  gdScrapedJobs    = [];
  gdScrapedIds     = new Set();
  gdPostedIds      = new Set(); // track which jobs made it to backend

  console.log('[GD Scraper] Starting — LLM processing will begin after first batch...');

  while (gdScrapingActive) {

    // Collect next batch of cards
    const batch = [];
    while (batch.length < GD_BATCH_SIZE) {
      const card = gdGetNextCard();
      if (!card) break;
      const jobId = card.getAttribute('data-jobid');
      gdScrapedIds.add(jobId);
      batch.push(card);
    }

    if (batch.length === 0) {
      console.log('[GD Scraper] No more visible cards — trying Load More...');
      const hasMore = await gdClickLoadMore();
      if (!hasMore) {
        console.log('[GD Scraper] All done.');
        break;
      }
      continue;
    }

    // Highlight all batch cards yellow immediately
    batch.forEach(card => gdHighlightCard(card, 'active'));

    // Fetch all in parallel
    const results = await Promise.all(batch.map(card => gdScrapeOneCard(card)));

    // Collect valid results
    const batchJobs = results.filter(j => j && j.title);
    batchJobs.forEach(job => gdScrapedJobs.push(job));

    // ── POST THIS BATCH IMMEDIATELY ───────────────────────────────
    // The server inserts these jobs and starts LLM processing in the background.
    // Scraping of the next batch starts right away — fully independent.
    if (batchJobs.length > 0) {
      try {
        await gdPostBatch(batchJobs);
        batchJobs.forEach(j => gdPostedIds.add(j.job_id));
        console.log(`[GD Scraper] Batch of ${batchJobs.length} pushed. LLM started on server.`);
      } catch (err) {
        console.warn('[GD Scraper] Batch POST failed — will retry at end:', err.message);
      }
    }
  }

  gdScrapingActive = false;
  console.log(`[GD Scraper] Finished. Total: ${gdScrapedJobs.length} jobs`);

  // Post any jobs that failed to POST mid-scrape (backend was briefly down etc.)
  const unposted = gdScrapedJobs.filter(j => !gdPostedIds.has(j.job_id));
  if (unposted.length > 0) {
    console.log(`[GD Scraper] Sending ${unposted.length} unposted jobs...`);
    await gdSendToBackend(unposted); // this one has the JSON fallback
  }
}

// ── Stop ────────────────────────────────────────────────────────

function gdStopScraping() {
  if (!gdScrapingActive) return;
  gdScrapingActive = false;
  // Most jobs already posted in real-time batches. Post anything still unposted.
  const unposted = gdScrapedJobs.filter(j => !gdPostedIds.has(j.job_id));
  if (unposted.length > 0) gdSendToBackend(unposted);
}

// ── Download JSON ───────────────────────────────────────────────

const GD_BACKEND_URL = 'http://localhost:8000/jobs';
let gdPostedIds = new Set(); // persists across batches in one session

// Post a single batch — no JSON fallback (called per batch during scraping)
async function gdPostBatch(jobs) {
  const date    = new Date().toISOString().slice(0, 10);
  const payload = { scraped_date: date, source: 'glassdoor', total: jobs.length, jobs };
  const res     = await fetch(GD_BACKEND_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  console.log(`[GD Scraper] ✅ Batch: ${data.inserted} new, ${data.skipped} skipped`);
}

// Post all (with JSON fallback) — called for any unposted jobs at end/stop
async function gdSendToBackend(jobs) {
  const date    = new Date().toISOString().slice(0, 10);
  const payload = { scraped_date: date, source: 'glassdoor', total: jobs.length, jobs };
  try {
    const res  = await fetch(GD_BACKEND_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    console.log(`[GD Scraper] ✅ Final push: ${data.inserted} new, ${data.skipped} skipped`);
  } catch (err) {
    console.warn('[GD Scraper] Backend unreachable, falling back to JSON download:', err.message);
    gdDownloadAsJSON(jobs);
  }
}

// Kept as fallback only
function gdDownloadAsJSON(jobs) {
  const date   = new Date().toISOString().slice(0, 10);
  const output = { scraped_date: date, source: 'glassdoor', total: jobs.length, jobs };
  const blob   = new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });
  const url    = URL.createObjectURL(blob);
  const a      = Object.assign(document.createElement('a'), {
    href: url, download: `glassdoor_jobs_${date}.json`
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Chrome message listener ─────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'startScraping')  { gdStartScraping(); sendResponse({ ok: true }); }
  if (msg.action === 'stopScraping')   { gdStopScraping();  sendResponse({ ok: true }); }
  if (msg.action === 'getScrapeStatus') {
    sendResponse({ active: gdScrapingActive, count: gdScrapedJobs.length });
  }
  return true;
});