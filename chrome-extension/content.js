let observer;
let currentFilters = {};
let seenPromotedList = [];

// ── Partial-hide helpers ──────────────────────────────────────

function getTodayStr() {
  return new Date().toISOString().slice(0, 10);
}

function loadSeenPromotedList(callback) {
  chrome.storage.local.get(['seen_promoted_list'], (data) => {
    const stored = data['seen_promoted_list'];
    seenPromotedList = stored ? (stored.list || []) : [];
    if (callback) callback();
  });
}

function saveSeenPromotedList() {
  chrome.storage.local.set({
    seen_promoted_list: { date: getTodayStr(), list: seenPromotedList }
  });
}

function clearSeenPromotedList() {
  seenPromotedList = [];
  chrome.storage.local.remove('seen_promoted_list');
}

function isPromotedCard(card) {
  return Array.from(card.querySelectorAll('.job-card-container__footer-item'))
    .some(el => el.textContent.trim().includes('Promoted'));
}

function addToSeenPromoted(title, company) {
  const key = normalizeForMatching(title) + '|' + company.trim().toLowerCase();
  if (!seenPromotedList.includes(key)) {
    seenPromotedList.push(key);
    saveSeenPromotedList();
  }
}

function isInSeenPromoted(title, company) {
  const key = normalizeForMatching(title) + '|' + company.trim().toLowerCase();
  return seenPromotedList.includes(key);
}

let clickTrackingInitialized = false;
function initClickTracking() {
  if (clickTrackingInitialized) return;
  clickTrackingInitialized = true;

  document.addEventListener('click', (e) => {
    if (currentFilters.promotedMode !== 'partial') return;
    const card = e.target.closest('.scaffold-layout__list-item');
    if (!card) return;
    const titleEl   = card.querySelector('.job-card-list__title--link');
    const companyEl = card.querySelector('.artdeco-entity-lockup__subtitle span');
    if (!titleEl || !companyEl) return;
    if (!isPromotedCard(card)) return;
    addToSeenPromoted(titleEl.textContent.trim(), companyEl.textContent.trim());
    filterJobs();
  }, true);
}

function showStartupDialog() {
  if (sessionStorage.getItem('jobshield_dialog_shown')) return;
  if (!seenPromotedList.length) return;
  if (currentFilters.promotedMode !== 'partial') return;
  sessionStorage.setItem('jobshield_dialog_shown', '1');

  if (!document.getElementById('jobshield-style')) {
    const style = document.createElement('style');
    style.id = 'jobshield-style';
    style.textContent = `
      @keyframes jsd-slidein {
        from { transform: translateX(110%); opacity: 0; }
        to   { transform: translateX(0);    opacity: 1; }
      }
      @keyframes jsd-slideout {
        from { transform: translateX(0);    opacity: 1; }
        to   { transform: translateX(110%); opacity: 0; }
      }
      #jobshield-toast { animation: jsd-slidein 0.35s ease-out forwards; }
      #jobshield-toast.closing { animation: jsd-slideout 0.3s ease-in forwards; }
      #jobshield-toast button:hover { filter: brightness(0.88); }
    `;
    document.head.appendChild(style);
  }

  const toast = document.createElement('div');
  toast.id = 'jobshield-toast';
  toast.style.cssText = [
    'position:fixed', 'top:14px', 'right:14px', 'z-index:2147483647',
    'background:#0a66c2', 'color:white',
    'border-radius:10px', 'padding:10px 14px',
    'box-shadow:0 4px 18px rgba(0,0,0,0.28)',
    'font-family:Arial,sans-serif', 'font-size:13px',
    'display:flex', 'align-items:center', 'gap:10px',
    'max-width:420px', 'line-height:1.4'
  ].join(';');

  toast.innerHTML = `
    <span style="font-size:18px;flex-shrink:0">🛡️</span>
    <span style="flex:1">
      <strong>${seenPromotedList.length}</strong> seen promoted job(s) today.
      Keep hiding them?
    </span>
    <button id="jsd-keep"
      style="background:white;color:#0a66c2;border:none;padding:5px 11px;
             border-radius:6px;cursor:pointer;font-weight:700;font-size:12px;
             white-space:nowrap;flex-shrink:0">
      ✅ Keep
    </button>
    <button id="jsd-clear"
      style="background:rgba(255,255,255,0.15);color:white;border:1px solid rgba(255,255,255,0.5);
             padding:5px 11px;border-radius:6px;cursor:pointer;font-weight:700;
             font-size:12px;white-space:nowrap;flex-shrink:0">
      🗑️ Clear
    </button>
  `;
  document.body.appendChild(toast);

  function dismissToast() {
    toast.classList.add('closing');
    setTimeout(() => toast.remove(), 300);
  }
  document.getElementById('jsd-keep').onclick = dismissToast;
  document.getElementById('jsd-clear').onclick = () => {
    clearSeenPromotedList();
    dismissToast();
    filterJobs();
  };
}

// ─────────────────────────────────────────────────────────────

function normalizeForMatching(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(string) {
  try {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  } catch (error) {
    console.error("Error escaping regex: ", error);
    return string;
  }
}

function checkPageAndInit() {
  try {
    if (window.location.href.includes('/jobs/search/')) {
      initializeFilters();
    }
  } catch (error) {
    console.error("Error in checkPageAndInit: ", error);
  }
}

window.addEventListener('hashchange', checkPageAndInit);
window.addEventListener('popstate', checkPageAndInit);
checkPageAndInit();

function initializeFilters() {
  try {
    if (observer) observer.disconnect();
    chrome.storage.sync.get(
      ['whitelistKeywords', 'titleKeywords', 'companyNames',
       'hideApplied', 'hidePromoted', 'hideDismissed',
       'partialHidePromoted', 'promotedMode'],
      (data) => {
        try {
          const whitelist = data.whitelistKeywords || [];
          const blacklist = data.titleKeywords     || [];
          const companies = (data.companyNames || []).map(c => c.trim().toLowerCase());

          const promotedMode = data.promotedMode ||
            (data.hidePromoted ? 'hide' : (data.partialHidePromoted ? 'partial' : 'show'));

          currentFilters = {
            whitelist, blacklist, companies,
            hideApplied:   data.hideApplied  || false,
            hideDismissed: data.hideDismissed || false,
            promotedMode
          };

          loadSeenPromotedList(() => {
            filterJobs();
            initObserver();
            initClickTracking();
            showStartupDialog();
          });
        } catch (error) {
          console.error("Error processing storage data: ", error);
        }
      }
    );
  } catch (error) {
    console.error("Error in initializeFilters: ", error);
  }
}

function keywordMatchesWhitelist(keyword, normalizedTitle) {
  const normalizedKeyword = normalizeForMatching(keyword);
  const titleWords        = normalizedTitle.split(' ');
  const keywordWords      = normalizedKeyword.split(' ');
  const exactMatch        = keywordWords.every(word => titleWords.includes(word));
  if (keywordWords.length > 1) {
    const compressedKeyword = keywordWords.join('');
    const compressedTitle   = normalizedTitle.replace(/\s/g, '');
    return exactMatch || compressedTitle.includes(compressedKeyword);
  }
  return exactMatch;
}

function keywordMatchesBlacklist(keyword, normalizedTitle) {
  const normalizedKeyword = normalizeForMatching(keyword);
  const keywordWords      = normalizedKeyword.split(' ');
  const titleWords        = normalizedTitle.split(' ');
  const compressedTitle   = normalizedTitle.replace(/\s/g, '');
  if (keywordWords.length > 1) {
    const regex = new RegExp(`\\b${normalizedKeyword.replace(/\s+/g, '\\s+')}\\b`);
    if (regex.test(normalizedTitle)) return true;
    const compressedKeyword = keywordWords.join('');
    return compressedTitle.includes(compressedKeyword);
  } else {
    return titleWords.includes(normalizedKeyword);
  }
}

function filterJobs() {
  try {
    const jobCards = document.querySelectorAll('.scaffold-layout__list-item');
    jobCards.forEach(card => {
      try {
        const titleElement   = card.querySelector('.job-card-list__title--link');
        const companyElement = card.querySelector('.artdeco-entity-lockup__subtitle span');
        if (!titleElement || !companyElement) return;

        const title           = titleElement.textContent.trim();
        const company         = companyElement.textContent.trim();
        const normalizedTitle = normalizeForMatching(title);
        let shouldHide = false;

        shouldHide = currentFilters.companies.includes(company.trim().toLowerCase());

        if (!shouldHide && currentFilters.whitelist.length > 0) {
          const hasWhitelist = currentFilters.whitelist.some(kw =>
            keywordMatchesWhitelist(kw, normalizedTitle)
          );
          if (!hasWhitelist) shouldHide = true;
        }

        if (!shouldHide) {
          const hasBlacklist = currentFilters.blacklist.some(kw =>
            keywordMatchesBlacklist(kw, normalizedTitle)
          );
          if (hasBlacklist) shouldHide = true;
        }

        if (!shouldHide && currentFilters.hideApplied) {
          shouldHide = !!card.querySelector('.job-card-container__footer-job-state')
            ?.textContent.includes('Applied');
        }

        if (!shouldHide && currentFilters.promotedMode === 'hide') {
          shouldHide = isPromotedCard(card);
        }
        if (!shouldHide && currentFilters.promotedMode === 'partial') {
          if (isPromotedCard(card) && isInSeenPromoted(title, company)) {
            shouldHide = true;
          }
        }

        if (!shouldHide && currentFilters.hideDismissed) {
          shouldHide = card.textContent.includes("show you this job again");
        }

        card.style.display = shouldHide ? 'none' : 'block';
      } catch (error) {
        console.error("Error processing job card: ", error);
      }
    });
  } catch (error) {
    console.error("Error in filterJobs: ", error);
  }
}

function initObserver() {
  try {
    const targetNode = document.querySelector('.scaffold-layout__list');
    if (!targetNode) {
      setTimeout(initObserver, 500);
      return;
    }
    observer = new MutationObserver(() => {
      try { filterJobs(); } catch (error) { console.error("Error in MutationObserver: ", error); }
    });
    observer.observe(targetNode, { childList: true, subtree: true });
  } catch (error) {
    console.error("Error in initObserver: ", error);
  }
}

if (document.querySelector('.scaffold-layout__list')) {
  initializeFilters();
}

chrome.storage.onChanged.addListener(() => {
  try { initializeFilters(); } catch (error) { console.error("Error handling storage change: ", error); }
});

function normalizeString(str) {
  return str.replace(/[^a-z0-9]/gi, '').toLowerCase();
}


// ═══════════════════════════════════════════════════════════════
// ── SCRAPER MODULE ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

let scrapingActive = false;
let scrapedJobs    = [];

// ── Utilities ──────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

const randomBetween = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

/**
 * After clicking a card, poll until:
 *   - aria-current="page" on the inner div matches our target job ID
 *   - AND #job-details has real content loaded
 * Falls through after timeout so we still attempt extraction.
 */
async function waitForDetailPane(targetJobId, timeout = 9000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const activeLi  = document.querySelector('[aria-current="page"]')
      ?.closest('li[data-occludable-job-id]');
    const activeId  = activeLi?.getAttribute('data-occludable-job-id');
    const jdEl      = document.querySelector('#job-details');
    const hasContent = jdEl && jdEl.textContent.trim().length > 80;

    if (String(activeId) === String(targetJobId) && hasContent) return true;
    await sleep(300);
  }
  return false; // timed out — caller still tries to extract
}

// ── Card highlight helpers ──────────────────────────────────────

function highlightCard(card, state) {
  const base = 'transition: background-color 0.4s, outline 0.4s;';
  if (state === 'active') {
    card.style.cssText += `${base}
      background-color: #fff9c4 !important;
      outline: 2px solid #f5c518 !important;
      border-radius: 8px;
    `;
  } else if (state === 'done') {
    card.style.cssText += `${base}
      background-color: #d4edda !important;
      outline: 2px solid #28a745 !important;
      border-radius: 8px;
    `;
  } else {
    card.style.backgroundColor = '';
    card.style.outline         = '';
  }
}

// ── Data extraction ─────────────────────────────────────────────

function extractJobData(card) {
  const detail = document.querySelector('.jobs-search__job-details--container');

  const titleEl = detail?.querySelector('.job-details-jobs-unified-top-card__job-title h1');
  const title   = titleEl?.textContent?.trim()
    || card.querySelector('.job-card-list__title--link')?.textContent?.trim() || '';

  const companyEl = detail?.querySelector('.job-details-jobs-unified-top-card__company-name');
  const company   = companyEl?.textContent?.trim()
    || card.querySelector('.artdeco-entity-lockup__subtitle span')?.textContent?.trim() || '';

  const location = card.querySelector('.artdeco-entity-lockup__caption li span')?.textContent?.trim()
    || detail?.querySelector('.tvm__text--low-emphasis')?.textContent?.trim() || '';

  const postedEl   = detail?.querySelector('.tvm__text--positive strong span');
  const cardTimeEl = card.querySelector('time');
  const posted     = postedEl?.textContent?.trim() || cardTimeEl?.textContent?.trim() || '';

  const workType = Array.from(
    detail?.querySelectorAll('.job-details-fit-level-preferences button') || []
  ).map(b => b.textContent.trim()).filter(Boolean);

  const jdEl = detail?.querySelector('#job-details');
  const jd   = jdEl?.innerText?.trim() || jdEl?.textContent?.trim() || '';

  const jobId = card.getAttribute('data-occludable-job-id');
  const link  = jobId
    ? `https://www.linkedin.com/jobs/view/${jobId}/`
    : card.querySelector('a.job-card-list__title--link')?.href || '';

  const easyApply = !!detail?.querySelector('.jobs-apply-button--top-card')
    ?.textContent?.includes('Easy Apply');

  return {
    job_id:     jobId || null,
    title, company, location, posted,
    work_type:  workType,
    easy_apply: easyApply,
    link, jd,
    source:     'linkedin',
    scraped_at: new Date().toISOString()
  };
}

// ── Dismiss a card ──────────────────────────────────────────────

async function dismissCard(card) {
  try {
    const btn = card.querySelector('button[aria-label^="Dismiss"]');
    if (!btn) return;
    btn.click();
    await sleep(350);
  } catch (_) { /* non-fatal */ }
}

// ── Scrape one card ─────────────────────────────────────────────

async function scrapeOneCard(card) {
  const jobId   = card.getAttribute('data-occludable-job-id');
  const titleEl = card.querySelector('.job-card-list__title--link');
  if (!titleEl || !jobId) return null;

  highlightCard(card, 'active');

  titleEl.click();
  await sleep(400);

  const loaded = await waitForDetailPane(jobId, 9000);
  if (!loaded) {
    console.warn(`[Scraper] Timeout on job ${jobId} — extracting anyway`);
  }
  await sleep(300);

  const data = extractJobData(card);

  highlightCard(card, 'done');
  await sleep(500);

  await dismissCard(card);

  return data;
}

// ── Scrape all visible cards on the current page ────────────────
// Returns an array of job objects. Does NOT download anything.
//
// WHY live re-query instead of upfront snapshot:
//   LinkedIn uses occluded/lazy rendering. The last ~3 cards on a page
//   are empty <li> shells when the page first loads — no title link yet.
//   They only get content once the viewport scrolls near them.
//   Snapshotting once at the start misses those cards entirely.
//   By re-querying after each dismiss we always see freshly-loaded cards.

async function scrapeCurrentPage() {
  const jobs       = [];
  const scrapedIds = new Set(); // track IDs we've already processed this page

  while (scrapingActive) {
    // Re-query DOM each time — picks up cards that loaded since last iteration
    const nextCard = Array.from(
      document.querySelectorAll('li.scaffold-layout__list-item')
    ).find(card => {
      const id = card.getAttribute('data-occludable-job-id');
      return (
        id &&
        !scrapedIds.has(id) &&
        card.style.display !== 'none' &&
        card.querySelector('.job-card-list__title--link')
      );
    });

    if (!nextCard) break; // no more cards available on this page

    // Mark as seen immediately so a DOM re-render can't offer it twice
    scrapedIds.add(nextCard.getAttribute('data-occludable-job-id'));

    // Scroll card into view — this is what triggers LinkedIn to load
    // occluded cards nearby, so by the time we finish this card the
    // next ones will already be rendered.
    nextCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(300); // small pause for nearby cards to load

    const job = await scrapeOneCard(nextCard);
    if (job && job.title) jobs.push(job);
    await sleep(600);
  }

  return jobs;
}

// ── Pagination: advance to next page and wait for cards to load ─

async function waitForPageChange(previousPage) {
  const timeout = 15000;
  const start   = Date.now();

  while (Date.now() - start < timeout) {
    await sleep(500);

    const pageState = document.querySelector('.jobs-search-pagination__page-state');
    if (pageState) {
      const match = pageState.textContent.trim().match(/Page (\d+) of (\d+)/);
      if (match && parseInt(match[1]) > previousPage) {
        await sleep(1500); // let job cards finish rendering
        return true;
      }
    }
  }

  console.warn('[JobShield] Timeout waiting for page change');
  return false;
}

// ── Multi-page scraping loop ────────────────────────────────────

async function scrapeAllPages() {
  let allJobs    = [];
  let postedIds  = new Set();
  let pageNum    = 1;

  while (scrapingActive) {
    console.log(`[JobShield] Scraping page ${pageNum}...`);

    const jobs = await scrapeCurrentPage();
    allJobs = allJobs.concat(jobs);
    console.log(`[JobShield] Page ${pageNum}: ${jobs.length} jobs (total: ${allJobs.length})`);

    // ── POST THIS PAGE IMMEDIATELY ────────────────────────────────
    // Server starts LLM processing while we scrape the next page.
    if (jobs.length > 0) {
      try {
        await postPageBatch(jobs);
        jobs.forEach(j => postedIds.add(j.job_id));
        console.log(`[JobShield] Page ${pageNum} sent to backend. LLM starting.`);
      } catch (err) {
        console.warn(`[JobShield] Page ${pageNum} POST failed — will retry at end:`, err.message);
      }
    }

    // ── Check if this is the last page ──────────────────────────
    const pageState = document.querySelector('.jobs-search-pagination__page-state');
    if (pageState) {
      const match = pageState.textContent.trim().match(/Page (\d+) of (\d+)/);
      if (match) {
        const current = parseInt(match[1]);
        const total   = parseInt(match[2]);
        console.log(`[JobShield] ${current} of ${total} pages done`);
        if (current >= total) {
          console.log('[JobShield] Last page reached. Finishing.');
          break;
        }
      }
    }

    // ── Find and click the Next button ──────────────────────────
    const nextBtn = document.querySelector(
      'button.jobs-search-pagination__button--next'
    );

    if (!nextBtn || nextBtn.disabled || nextBtn.hasAttribute('disabled')) {
      console.log('[JobShield] Next button not found or disabled. Finishing.');
      break;
    }

    nextBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(800);
    nextBtn.click();

    const changed = await waitForPageChange(pageNum);
    if (!changed) {
      console.warn('[JobShield] Page did not change after clicking Next. Stopping.');
      break;
    }

    pageNum++;
    await sleep(randomBetween(2500, 4500));
  }

  // Return unposted jobs (those whose batch POSTs failed mid-scrape)
  const unposted = allJobs.filter(j => !postedIds.has(j.job_id));
  return { allJobs, unposted };
}

// ── Public: start full scrape ───────────────────────────────────

async function startScraping() {
  if (scrapingActive) return;
  scrapingActive = true;
  scrapedJobs    = [];

  console.log('[JobShield] Starting multi-page scrape — LLM starts after each page...');

  const { allJobs, unposted } = await scrapeAllPages();
  scrapedJobs = allJobs;

  scrapingActive = false;
  console.log(`[JobShield] Done. Total: ${scrapedJobs.length} jobs`);

  // Send anything that failed to POST mid-scrape
  if (unposted.length > 0) {
    console.log(`[JobShield] Sending ${unposted.length} unposted jobs...`);
    sendToBackend(unposted);
  }
}

// ── Public: stop mid-scrape ─────────────────────────────────────

function stopScraping() {
  if (!scrapingActive) return;
  scrapingActive = false;
  // Most jobs already posted per-page. Nothing extra needed.
}

// ── Backend POST helpers ─────────────────────────────────────────

const LI_BACKEND_URL = 'http://localhost:8000/jobs';

// Per-page batch POST — no JSON fallback (called mid-scrape)
async function postPageBatch(jobs) {
  const date    = new Date().toISOString().slice(0, 10);
  const payload = { scraped_date: date, source: 'linkedin', total: jobs.length, jobs };
  const res     = await fetch(LI_BACKEND_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  console.log(`[JobShield] ✅ ${data.inserted} new, ${data.skipped} skipped`);
}

async function sendToBackend(jobs) {
  const date    = new Date().toISOString().slice(0, 10);
  const payload = { scraped_date: date, source: 'linkedin', total: jobs.length, jobs };
  try {
    const res  = await fetch(LI_BACKEND_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    console.log(`[JobShield] ✅ Backend: ${data.inserted} new, ${data.skipped} skipped`);
  } catch (err) {
    console.warn('[JobShield] Backend unreachable, falling back to JSON download:', err.message);
    downloadAsJSON(jobs);  // fallback — data never lost
  }
}

// ── JSON download (fallback only) ───────────────────────────────

function downloadAsJSON(jobs) {
  const date   = new Date().toISOString().slice(0, 10);
  const output = { scraped_date: date, source: 'linkedin', total: jobs.length, jobs };
  const blob   = new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement('a');
  a.href       = url;
  a.download   = `linkedin_jobs_${date}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Chrome message listener ─────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'startScraping') {
    startScraping();
    sendResponse({ ok: true });
  }
  if (msg.action === 'stopScraping') {
    stopScraping();
    sendResponse({ ok: true });
  }
  if (msg.action === 'getScrapeStatus') {
    sendResponse({ active: scrapingActive, count: scrapedJobs.length });
  }
  return true;
});