// ============================================================
// Indeed.com Job Filter - Content Script
// Features:
//   - Hide saved jobs (+ hide on save-click in real time)
//   - Hide jobs by blacklisted company name (exact, case-insensitive)
//   - Hide jobs by blacklisted title keywords
// ============================================================

let indeedObserver = null;
let indeedFilters = {};

// ── Helpers (same logic as naukri-content.js) ─────────────────

function indeedNormalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function indeedTitleMatchesBlacklist(keyword, normalizedTitle) {
  const normalizedKeyword = indeedNormalizeText(keyword);
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

function indeedCompanyMatchesBlacklist(companyText, blacklistedCompanies) {
  // Exact match only, case-insensitive.
  // "inmobi" matches "InMobi" but NOT "InMobi Technologies"
  const trimmedCompany = companyText.trim().toLowerCase();
  return blacklistedCompanies.some(name => trimmedCompany === name.trim().toLowerCase());
}

// ── Card Processor ────────────────────────────────────────────
//
// Indeed card structure (verified via debug panel):
//   li.css-1ac2h1w                          <- one card per list item
//     .cardOutline[aria-hidden="true"]       <- ghost/duplicate, skip it
//     a.jcs-JobTitle span[title]             <- job title
//     span[data-testid="company-name"]       <- company name
//     button.bookmark[aria-pressed="true"]   <- saved when aria-pressed is true

function processIndeedCard(li) {
  // Skip the hidden ghost card Indeed renders for the selected job
  const cardDiv = li.querySelector('.cardOutline');
  if (cardDiv?.getAttribute('aria-hidden') === 'true') return;

  const titleEl     = li.querySelector('a.jcs-JobTitle span[title]');
  const companyEl   = li.querySelector('span[data-testid="company-name"]');
  const bookmarkBtn = li.querySelector('button.bookmark');

  if (!titleEl || !companyEl) return; // not a real job card

  const title           = titleEl.getAttribute('title') || titleEl.textContent.trim();
  const company         = companyEl.textContent.trim();
  const isSaved         = bookmarkBtn?.getAttribute('aria-pressed') === 'true';
  const normalizedTitle = indeedNormalizeText(title);

  let shouldHide = false;

  // 1. Hide saved jobs
  if (!shouldHide && indeedFilters.hideSaved && isSaved) {
    shouldHide = true;
  }

  // 2. Blacklisted company (exact match, case-insensitive)
  if (!shouldHide && indeedFilters.blacklistedCompanies.length > 0) {
    shouldHide = indeedCompanyMatchesBlacklist(company, indeedFilters.blacklistedCompanies);
  }

  // 3. Blacklisted title keywords
  if (!shouldHide && indeedFilters.blacklistedKeywords.length > 0) {
    shouldHide = indeedFilters.blacklistedKeywords.some(kw =>
      indeedTitleMatchesBlacklist(kw, normalizedTitle)
    );
  }

  li.style.display = shouldHide ? 'none' : '';
}

// ── Main Filter Runner ────────────────────────────────────────

function filterIndeedJobs() {
  document.querySelectorAll('li.css-1ac2h1w').forEach(processIndeedCard);
}

// ── Save-button Click Listener ────────────────────────────────
// When user saves a job, hide it after the DOM updates the aria-pressed attr.

document.addEventListener('click', function(event) {
  if (!indeedFilters.hideSaved) return;

  const bookmarkBtn = event.target.closest('button.bookmark');
  if (!bookmarkBtn) return;

  const li = bookmarkBtn.closest('li.css-1ac2h1w');
  if (!li) return;

  setTimeout(() => {
    const isNowSaved = bookmarkBtn.getAttribute('aria-pressed') === 'true';
    if (isNowSaved) {
      li.style.display = 'none';
    }
  }, 600); // small delay for Indeed DOM to update aria-pressed
}, true);

// ── Init ──────────────────────────────────────────────────────

function indeedLoadFiltersAndRun() {
  chrome.storage.sync.get(
    ['indeed_blacklistedKeywords', 'indeed_blacklistedCompanies', 'indeed_hideSaved'],
    (data) => {
      indeedFilters = {
        blacklistedKeywords:  data.indeed_blacklistedKeywords  || [],
        blacklistedCompanies: data.indeed_blacklistedCompanies || [],
        hideSaved:            data.indeed_hideSaved            || false,
      };
      filterIndeedJobs();
    }
  );
}

function indeedStartObserver() {
  if (indeedObserver) indeedObserver.disconnect();

  const target = document.querySelector('ul.css-pygyny') || document.body;

  indeedObserver = new MutationObserver(() => {
    filterIndeedJobs();
  });

  indeedObserver.observe(target, { childList: true, subtree: true });
}

// Re-run whenever settings change in popup
chrome.storage.onChanged.addListener((changes) => {
  const indeedKeys = ['indeed_blacklistedKeywords', 'indeed_blacklistedCompanies', 'indeed_hideSaved'];
  const hasIndeedChange = Object.keys(changes).some(k => indeedKeys.includes(k));
  if (hasIndeedChange) {
    indeedLoadFiltersAndRun();
  }
});

// Kick off
indeedLoadFiltersAndRun();
indeedStartObserver();
