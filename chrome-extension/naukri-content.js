// ============================================================
// Naukri.com Job Filter - Content Script
// Features:
//   - Hide saved jobs (+ hide on save-click in real time)
//   - Hide jobs by blacklisted company name
//   - Hide jobs by blacklisted title keywords
//   - Hide promoted/ad job cards
// ============================================================

let naukriObserver = null;
let naukriFilters = {};

// ── Helpers ──────────────────────────────────────────────────

function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleMatchesBlacklist(keyword, normalizedTitle) {
  const normalizedKeyword = normalizeText(keyword);
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

function companyMatchesBlacklist(companyText, blacklistedCompanies) {
  // Exact match only, case-insensitive.
  // "soul ai" matches "Soul Ai" but NOT "Soul Ai Private Ltd"
  const trimmedCompany = companyText.trim().toLowerCase();
  return blacklistedCompanies.some(name => {
    return trimmedCompany === name.trim().toLowerCase();
  });
}

// ── Card Processors ──────────────────────────────────────────

/**
 * Process a single REGULAR job card.
 * Wrapper: .srp-jobtuple-wrapper
 * Title:   a.title
 * Company: a.comp-name
 * Saved:   .ni-job-tuple-icon-srpSaveFilled  (class present = saved)
 */
function processRegularCard(wrapper) {
  const titleEl = wrapper.querySelector('a.title');
  const companyEl = wrapper.querySelector('a.comp-name');
  const savedEl = wrapper.querySelector('.ni-job-tuple-icon-srpSaveFilled');

  if (!titleEl) return; // skip non-job wrappers

  const title = titleEl.textContent.trim();
  const company = companyEl ? companyEl.textContent.trim() : '';
  const isSaved = !!savedEl;
  const normalizedTitle = normalizeText(title);

  let shouldHide = false;

  // 1. Hide saved jobs
  if (!shouldHide && naukriFilters.hideSaved && isSaved) {
    shouldHide = true;
  }

  // 2. Blacklisted company
  if (!shouldHide && naukriFilters.blacklistedCompanies.length > 0) {
    shouldHide = companyMatchesBlacklist(company, naukriFilters.blacklistedCompanies);
  }

  // 3. Blacklisted title keywords
  if (!shouldHide && naukriFilters.blacklistedKeywords.length > 0) {
    shouldHide = naukriFilters.blacklistedKeywords.some(kw =>
      titleMatchesBlacklist(kw, normalizedTitle)
    );
  }

  wrapper.style.display = shouldHide ? 'none' : '';
}

/**
 * Process a PROMOTED/AD job card.
 * These live inside <section> widgets and have class srp-tuple checkbox.
 * We hide the nearest <section> ancestor to cleanly remove the slot.
 * Title:   a.title or a.srp-title
 * Company: span.srp-company (NOT an <a> tag)
 */
function processPromotedCard(card) {
  // Find the section ancestor to hide the whole slot
  const sectionAncestor = card.closest('section');
  const targetEl = sectionAncestor || card;

  // Option: always hide promoted cards
  if (naukriFilters.hidePromoted) {
    targetEl.style.display = 'none';
    return;
  }

  const titleEl = card.querySelector('a.title, a.srp-title');
  const companyEl = card.querySelector('span.srp-company');

  if (!titleEl) return;

  const title = titleEl.textContent.trim();
  const company = companyEl ? companyEl.textContent.trim() : '';
  const normalizedTitle = normalizeText(title);

  let shouldHide = false;

  // Blacklisted company
  if (!shouldHide && naukriFilters.blacklistedCompanies.length > 0) {
    shouldHide = companyMatchesBlacklist(company, naukriFilters.blacklistedCompanies);
  }

  // Blacklisted title keywords
  if (!shouldHide && naukriFilters.blacklistedKeywords.length > 0) {
    shouldHide = naukriFilters.blacklistedKeywords.some(kw =>
      titleMatchesBlacklist(kw, normalizedTitle)
    );
  }

  targetEl.style.display = shouldHide ? 'none' : '';
}

// ── Main Filter Runner ────────────────────────────────────────

function filterNaukriJobs() {
  // Regular cards
  document.querySelectorAll('.srp-jobtuple-wrapper').forEach(processRegularCard);

  // Promoted / ad cards
  document.querySelectorAll('.cust-job-tuple.srp-tuple.checkbox').forEach(processPromotedCard);
}

// ── Save-button Click Listener ────────────────────────────────
// When the user clicks Save on a job card, hide it after the DOM updates.

document.addEventListener('click', function(event) {
  if (!naukriFilters.hideSaved) return;

  // Match both the save icon and its parent span
  const saveBtn = event.target.closest(
    '.ni-job-tuple-icon-srpSaveUnfilled, .ni-job-tuple-icon-srpSaveFilled, .save-job-tag'
  );
  if (!saveBtn) return;

  // Find the parent .srp-jobtuple-wrapper and hide it after save completes
  const wrapper = saveBtn.closest('.srp-jobtuple-wrapper');
  if (wrapper) {
    setTimeout(() => {
      // Re-check: if now showing "saved" icon, hide it
      const isNowSaved = !!wrapper.querySelector('.ni-job-tuple-icon-srpSaveFilled');
      if (isNowSaved) {
        wrapper.style.display = 'none';
      }
    }, 600); // small delay for Naukri DOM to update
  }
}, true);

// ── Init ──────────────────────────────────────────────────────

function loadFiltersAndRun() {
  chrome.storage.sync.get(
    ['naukri_blacklistedKeywords', 'naukri_blacklistedCompanies', 'naukri_hideSaved', 'naukri_hidePromoted'],
    (data) => {
      naukriFilters = {
        blacklistedKeywords: data.naukri_blacklistedKeywords || [],
        blacklistedCompanies: data.naukri_blacklistedCompanies || [],
        hideSaved: data.naukri_hideSaved || false,
        hidePromoted: data.naukri_hidePromoted || false,
      };
      filterNaukriJobs();
    }
  );
}

function startObserver() {
  if (naukriObserver) naukriObserver.disconnect();

  const target = document.querySelector('[class*="styles_job-listing-container"]') || document.body;

  naukriObserver = new MutationObserver(() => {
    filterNaukriJobs();
  });

  naukriObserver.observe(target, { childList: true, subtree: true });
}

// Re-run whenever settings change
chrome.storage.onChanged.addListener((changes) => {
  const naukriKeys = ['naukri_blacklistedKeywords', 'naukri_blacklistedCompanies', 'naukri_hideSaved', 'naukri_hidePromoted'];
  const hasNaukriChange = Object.keys(changes).some(k => naukriKeys.includes(k));
  if (hasNaukriChange) {
    loadFiltersAndRun();
  }
});

// Kick off
loadFiltersAndRun();
startObserver();
