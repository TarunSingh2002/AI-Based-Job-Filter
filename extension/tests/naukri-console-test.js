// tests/naukri-console-test.js — selector check for Naukri search pages.
//
// HOW TO USE: open a Naukri search page (e.g. https://www.naukri.com/ai-engineer-jobs), open DevTools
// (F12) → Console, paste this whole file and press Enter.
// It only READS the page: no clicks, no navigation, no network, no chrome.* APIs.
// It uses the same selectors as extension/sites/naukri.js (NAUKRI_SEL) — keep the two in sync.
// If the table is empty or columns are blank, Naukri changed its markup: update both files.

(() => {
  const SEL = {
    card: '.srp-jobtuple-wrapper[data-job-id]',
    promotedCard: '.cust-job-tuple.srp-tuple.checkbox',
    title: 'a.title',
    promotedTitle: 'a.title, a.srp-title',
    company: 'a.comp-name',
    promotedCompany: 'a.comp-name, span.srp-company',
    experience: '.expwdth',
    location: '.locWdth',
    savedIcon: '.ni-job-tuple-icon-srpSaveFilled',
    saveButton: 'span.save-job-tag',
  };

  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const idFromLink = (link) => {
    const match = /-(\d{6,})(?=[?#/]|$)/.exec(link || '');
    return match ? match[1] : null;
  };

  // Same card list as naukriAdapter.findCards(): regular cards + promoted widgets outside them.
  const regular = [...document.querySelectorAll(SEL.card)];
  const promoted = [...document.querySelectorAll(SEL.promotedCard)].filter((el) => !el.closest('.srp-jobtuple-wrapper'));

  const rows = regular.concat(promoted).map((card) => {
    const isPromoted = !card.matches(SEL.card);
    const titleLink = card.querySelector(isPromoted ? SEL.promotedTitle : SEL.title);
    const link = titleLink ? titleLink.href : '';
    return {
      job_id: card.getAttribute('data-job-id') || idFromLink(link),
      title: (titleLink && titleLink.getAttribute('title')) || text(titleLink),
      company: text(card.querySelector(isPromoted ? SEL.promotedCompany : SEL.company)),
      experience_text: text(card.querySelector(SEL.experience)),
      link,
      isSaved: !!card.querySelector(SEL.savedIcon),
      isPromoted,
      hasSaveButton: !!card.querySelector(SEL.saveButton),
    };
  });

  // Same rule as naukriNextLink(): the link whose text is exactly "Next", unless disabled.
  const nextLink = [...document.querySelectorAll('a')].find((a) => text(a) === 'Next');
  const nextDisabled =
    !nextLink ||
    !nextLink.href ||
    nextLink.getAttribute('href') === '#' ||
    nextLink.hasAttribute('disabled') ||
    nextLink.getAttribute('aria-disabled') === 'true' ||
    /disabled/i.test(nextLink.className) ||
    nextLink.href === location.href;
  const nextUrl = nextDisabled ? null : nextLink.href;

  console.log(`[Naukri test] ${regular.length} regular cards, ${promoted.length} promoted cards`);
  if (rows.length === 0) console.warn(`[Naukri test] no cards found — "${SEL.card}" may be outdated`);
  const missing = rows.filter((r) => !r.job_id || !r.title || !r.company);
  if (missing.length) console.warn(`[Naukri test] ${missing.length} card(s) without job_id / title / company`, missing);
  console.table(rows);
  console.log('[Naukri test] next page URL:', nextUrl || '(none — last page, or the "Next" link was not found)');
  return { cards: rows.length, promoted: promoted.length, nextUrl };
})();
