// ============================================================
// Foundit.in Job Filter - Content Script
// Features:
//   - Hide saved jobs (+ hide on save-click in real time)
//   - Hide jobs by blacklisted company name (exact, case-insensitive)
//   - Hide jobs by blacklisted title keywords
// ============================================================

let founditObserver = null;
let founditFilters = {};

// ── Helpers (same logic as naukri/indeed/glassdoor) ───────────

function fnNormalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fnTitleMatchesBlacklist(keyword, normalizedTitle) {
  const normalizedKeyword = fnNormalizeText(keyword);
  const keywordWords = normalizedKeyword.split(' ');
  const titleWords   = normalizedTitle.split(' ');

  if (keywordWords.length > 1) {
    const regex = new RegExp(`\\b${normalizedKeyword.replace(/\s+/g, '\\s+')}\\b`);
    if (regex.test(normalizedTitle)) return true;
    const compressedKeyword = keywordWords.join('');
    const compressedTitle   = normalizedTitle.replace(/\s/g, '');
    return compressedTitle.includes(compressedKeyword);
  } else {
    return titleWords.includes(normalizedKeyword);
  }
}

function fnCompanyMatchesBlacklist(companyText, blacklistedCompanies) {
  // Exact match only, case-insensitive.
  const trimmedCompany = companyText.trim().toLowerCase();
  return blacklistedCompanies.some(name => trimmedCompany === name.trim().toLowerCase());
}

// ── Card Processor ────────────────────────────────────────────
//
// Foundit card structure (verified via console debug):
//   .jobCardWrapper                         <- one card per job
//     h2.jobCardTitle a[aria-label]         <- job title
//     span.jobCardCompany a                 <- company name
//     button.jobCardSaveUnsaveBtn           <- has class "save-job-icon" when saved

function processFounditCard(card) {
  const titleEl   = card.querySelector('h2.jobCardTitle a');
  const companyEl = card.querySelector('span.jobCardCompany a');
  const saveBtn   = card.querySelector('button.jobCardSaveUnsaveBtn');

  if (!titleEl || !companyEl) return; // skip non-job wrappers

  const title           = (titleEl.getAttribute('aria-label') || titleEl.textContent).trim();
  const company         = companyEl.textContent.trim();
  const isSaved         = saveBtn?.classList.contains('save-job-icon') || false;
  const normalizedTitle = fnNormalizeText(title);

  let shouldHide = false;

  // 1. Hide saved jobs
  if (!shouldHide && founditFilters.hideSaved && isSaved) {
    shouldHide = true;
  }

  // 2. Blacklisted company (exact match, case-insensitive)
  if (!shouldHide && founditFilters.blacklistedCompanies.length > 0) {
    shouldHide = fnCompanyMatchesBlacklist(company, founditFilters.blacklistedCompanies);
  }

  // 3. Blacklisted title keywords
  if (!shouldHide && founditFilters.blacklistedKeywords.length > 0) {
    shouldHide = founditFilters.blacklistedKeywords.some(kw =>
      fnTitleMatchesBlacklist(kw, normalizedTitle)
    );
  }

  // Hide the whole .jobCardWrapper
  card.style.display = shouldHide ? 'none' : '';
}

// ── Main Filter Runner ────────────────────────────────────────

function filterFounditJobs() {
  document.querySelectorAll('.jobCardWrapper').forEach(processFounditCard);
}

// ── Save-button Click Listener ────────────────────────────────
// Foundit toggles the "save-job-icon" class on click.
// We wait a moment for the DOM to update then re-check the card.

document.addEventListener('click', function(event) {
  if (!founditFilters.hideSaved) return;

  const saveBtn = event.target.closest('button.jobCardSaveUnsaveBtn');
  if (!saveBtn) return;

  const card = saveBtn.closest('.jobCardWrapper');
  if (!card) return;

  setTimeout(() => {
    const isNowSaved = saveBtn.classList.contains('save-job-icon');
    if (isNowSaved) {
      card.style.display = 'none';
    }
  }, 600);
}, true);

// ── Init ──────────────────────────────────────────────────────

function founditLoadFiltersAndRun() {
  chrome.storage.sync.get(
    ['foundit_blacklistedKeywords', 'foundit_blacklistedCompanies', 'foundit_hideSaved'],
    (data) => {
      founditFilters = {
        blacklistedKeywords:  data.foundit_blacklistedKeywords  || [],
        blacklistedCompanies: data.foundit_blacklistedCompanies || [],
        hideSaved:            data.foundit_hideSaved            || false,
      };
      filterFounditJobs();
    }
  );
}

function founditStartObserver() {
  if (founditObserver) founditObserver.disconnect();

  // Watch the job list container — re-filter on each page navigation (SPA)
  const target = document.querySelector('#middleSection') || document.body;

  founditObserver = new MutationObserver((mutations) => {
    const hasNewNodes = mutations.some(m => m.addedNodes.length > 0);
    if (hasNewNodes) {
      filterFounditJobs();
    }
  });

  founditObserver.observe(target, { childList: true, subtree: true });
}

// Re-run whenever settings change in popup
chrome.storage.onChanged.addListener((changes) => {
  const fnKeys = ['foundit_blacklistedKeywords', 'foundit_blacklistedCompanies', 'foundit_hideSaved'];
  const hasFnChange = Object.keys(changes).some(k => fnKeys.includes(k));
  if (hasFnChange) {
    founditLoadFiltersAndRun();
  }
});

// Kick off
founditLoadFiltersAndRun();
founditStartObserver();
