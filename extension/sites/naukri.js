// sites/naukri.js — Naukri search-result pages (www.naukri.com/<keyword>-jobs[-N]).
//
// Two jobs:
//   1. Passive filter (always, when no run is active): rules + hide saved + hide promoted.
//   2. Scraper adapter for JFScraper (sites/scraper-core.js), started from the popup.
// Job pages (/job-listings-*) are handled by sites/naukri-job.js instead.
//
// Selectors verified live 2026-10-14 (DESIGN.md 3.5).

const NAUKRI_SEL = {
  card: '.srp-jobtuple-wrapper[data-job-id]',
  promotedCard: '.cust-job-tuple.srp-tuple.checkbox', // ad / promoted widgets; we hide their whole <section>
  title: 'a.title', // attr "title" = full title, href = job page
  promotedTitle: 'a.title, a.srp-title',
  company: 'a.comp-name',
  promotedCompany: 'a.comp-name, span.srp-company',
  experience: '.expwdth', // e.g. "3-8 Yrs"
  location: '.locWdth',
  savedIcon: '.ni-job-tuple-icon-srpSaveFilled', // present only when the job is saved
  saveButton: 'span.save-job-tag', // has class "un-saved" while not saved
};

/** Job id from a Naukri job URL: ".../job-listings-ai-engineer-acme-bengaluru-3-to-8-years-141024012345?src=..." */
function naukriIdFromLink(link) {
  const match = /-(\d{6,})(?=[?#/]|$)/.exec(link || '');
  return match ? match[1] : null;
}

function naukriIsSaved(card) {
  return !!card.querySelector(NAUKRI_SEL.savedIcon);
}

/** Promoted cards are hidden via their <section> so the whole ad slot disappears. */
function naukriHideTarget(card) {
  return card.matches(NAUKRI_SEL.card) ? card : card.closest('section') || card;
}

/** The pagination link whose text is "Next" — null on the last page (missing or disabled). */
function naukriNextLink() {
  const link = [...document.querySelectorAll('a')].find((a) => jfsText(a) === 'Next');
  if (!link || !link.href || link.getAttribute('href') === '#') return null;
  const disabled =
    link.hasAttribute('disabled') || link.getAttribute('aria-disabled') === 'true' || /disabled/i.test(link.className);
  if (disabled || new URL(link.href).pathname === location.pathname) return null;
  return link;
}

/**
 * The next page's URL WITH the search filters. Naukri's "Next" link holds only the page path (/ai-engineer-jobs-2);
 * Naukri's own script adds the filters (?k=...&experience=1&jobAge=1) when you click it. Going to the bare link
 * drops them, and the search explodes from ~200 to ~40,000 jobs. So: the link's path + the current query string
 * (kept exactly as it is), plus any parameter the link itself carries.
 */
function naukriNextUrl(link) {
  const url = new URL(link.href, location.href);
  if (!url.search) {
    url.search = location.search;
  } else {
    const params = new URLSearchParams(location.search);
    new URLSearchParams(url.search).forEach((value, key) => params.set(key, value));
    url.search = params.toString();
  }
  return url.href;
}

const naukriAdapter = {
  site: 'naukri',
  blockReason: null, // set when a JD worker tab hit a captcha; reported once by detectBlock()

  findCards() {
    const regular = [...document.querySelectorAll(NAUKRI_SEL.card)];
    // promoted widgets only — a regular card's inner markup must not count twice
    const promoted = [...document.querySelectorAll(NAUKRI_SEL.promotedCard)].filter(
      (el) => !el.closest('.srp-jobtuple-wrapper')
    );
    return regular.concat(promoted);
  },

  readCard(card) {
    const promoted = !card.matches(NAUKRI_SEL.card);
    const titleLink = card.querySelector(promoted ? NAUKRI_SEL.promotedTitle : NAUKRI_SEL.title);
    if (!titleLink && !promoted) return null; // not a job card
    const link = titleLink ? titleLink.href : '';
    return {
      job_id: card.getAttribute('data-job-id') || naukriIdFromLink(link), // null → rules only, never sent to AI
      title: (titleLink && titleLink.getAttribute('title')) || jfsText(titleLink),
      company: jfsText(card.querySelector(promoted ? NAUKRI_SEL.promotedCompany : NAUKRI_SEL.company)),
      location: jfsText(card.querySelector(NAUKRI_SEL.location)),
      experience_text: jfsText(card.querySelector(NAUKRI_SEL.experience)),
      link,
      isSaved: naukriIsSaved(card),
      isPromoted: promoted,
    };
  },

  hideCard: (card) => jfsSetHidden(naukriHideTarget(card), true),
  showCard: (card) => jfsSetHidden(naukriHideTarget(card), false),
  highlight: (card, kind) => jfsPaint(card, kind),

  async markProcessed(card) {
    const button = card.querySelector(NAUKRI_SEL.saveButton);
    if (!button || naukriIsSaved(card)) return;
    await jfsClickAndWait(button, () => naukriIsSaved(card));
  },

  /**
   * Naukri's JD API needs reCAPTCHA, so we never call it. The background opens the job page in a
   * minimized worker window; sites/naukri-job.js reads the rendered JD there and sends it back.
   */
  async fetchJd(job) {
    if (!/\/job-listings-/.test(job.link)) return ''; // only real job pages run naukri-job.js
    const reply = await jfsSend({ type: 'naukriFetchJd', url: job.link, jobId: job.job_id });
    if (reply.error === 'blocked') {
      this.blockReason =
        'Naukri showed a captcha / "Access Denied" on a job page. Open any Naukri job page, solve it yourself, then press Resume';
    }
    return reply.jd || '';
  },

  async nextPage() {
    const next = naukriNextLink();
    if (!next) return 'none';
    location.href = naukriNextUrl(next); // full page load, filters kept; the next page resumes the run from scrape_state
    return 'navigating';
  },

  detectBlock() {
    const pending = this.blockReason;
    this.blockReason = null;
    if (pending) return pending;
    if (jfsPageLooksBlocked(this.findCards().length > 0)) {
      return 'Naukri is showing a captcha / "Access Denied" page. Solve it yourself, then press Resume';
    }
    return null;
  },
};

JFScraper.listen(naukriAdapter); // popup Start / Stop / Resume / Status
JFScraper.startPassiveFilter(naukriAdapter); // rules while no run is active
JFScraper.resumeIfRunning(naukriAdapter); // continue a run after "Next" navigation
