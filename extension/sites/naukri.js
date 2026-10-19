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
// Pause message when job pages stay blocked after the engine's waits (a short "Access Denied" burst never gets here).
const NAUKRI_JOB_BLOCKED =
  'Naukri shows a captcha / "Access Denied" on its job pages. Open any Naukri job page, solve it yourself, then press Resume';

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
 * The filters of the search being scraped: the copy saved when the run started (scrape_state.searchQuery), so a
 * page whose own address lost them can't pass that on. Falls back to this page's address outside a run.
 */
function naukriSearchQuery() {
  const state = JFScraper.state;
  return (state && state.running && state.searchQuery) || location.search;
}

/**
 * The next page's URL WITH the search filters. Naukri's "Next" link holds only the page path (/ai-engineer-jobs-2);
 * Naukri's own script adds the filters (?k=...&experience=1&jobAge=1) when you click it. Going to the bare link
 * drops them, and the search explodes from ~200 to ~40,000 jobs. So: the link's path + the run's saved query string
 * (kept exactly as it is); a parameter the link itself carries is kept unless the saved filters set it too.
 */
function naukriNextUrl(link) {
  const url = new URL(link.href, location.href);
  const saved = naukriSearchQuery();
  if (!url.search) {
    url.search = saved;
  } else {
    const params = new URLSearchParams(url.search);
    new URLSearchParams(saved).forEach((value, key) => params.set(key, value)); // the saved filters win
    url.search = params.toString();
  }
  return url.href;
}

/** Naukri's total job count for the search, from the tab title ("154 Data Scientist…", "Page 2 - 154 …"). */
function naukriTotalJobs() {
  const match = /^(?:page \d+ - )?([\d,]+)\s/i.exec(document.title || '');
  return match ? parseInt(match[1].replace(/,/g, ''), 10) : null;
}

/** True when every filter saved at the start of the run is in this page's address with the same value. */
function naukriFiltersKept(savedQuery) {
  const now = new URLSearchParams(location.search);
  let kept = true;
  new URLSearchParams(savedQuery).forEach((value, key) => {
    if (now.get(key) !== value) kept = false;
  });
  return kept;
}

const naukriAdapter = {
  site: 'naukri',

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
   * minimized worker window; sites/naukri-job.js reads the rendered JD there and sends it back. → {jd, blocked}
   */
  async fetchJd(job) {
    if (!/\/job-listings-/.test(job.link)) return { jd: '', blocked: null }; // only real job pages run naukri-job.js
    const reply = await jfsSend({ type: 'naukriFetchJd', url: job.link, jobId: job.job_id });
    return { jd: reply.jd || '', blocked: reply.error === 'blocked' ? NAUKRI_JOB_BLOCKED : null };
  },

  /**
   * Called by the engine before each results page is processed. Guards against a search that lost its filters:
   *  - this page's address misses a saved filter → reload it once with the saved filters ({navigate});
   *  - still missing after that reload, or the total job count exploded (more than double page 1's, e.g. 145 →
   *    11,786) → end the run ({stop}) instead of scraping every Naukri job.
   */
  checkSearch(state) {
    const saved = state.searchQuery || '';
    if (saved && !naukriFiltersKept(saved)) {
      if (state.searchFixedPage !== state.page) {
        state.searchFixedPage = state.page;
        return { navigate: location.pathname + saved };
      }
      return { stop: `Naukri dropped the search filters on page ${state.page} and they could not be restored. Stopped so it doesn't scrape all jobs` };
    }
    const total = naukriTotalJobs();
    if (total == null) return null;
    if (state.firstTotal == null) {
      state.firstTotal = total; // page 1 (or the first page this run saw)
      return null;
    }
    if (total > Math.max(state.firstTotal * 2, state.firstTotal + 300)) {
      return { stop: `Naukri's results jumped from ${state.firstTotal} to ${total} jobs on page ${state.page} (search filters lost). Stopped so it doesn't scrape all jobs` };
    }
    return null;
  },

  async nextPage() {
    const next = naukriNextLink();
    if (!next) return 'none';
    location.href = naukriNextUrl(next); // full page load, filters kept; the next page resumes the run from scrape_state
    return 'navigating';
  },

  detectBlock() {
    if (jfsPageLooksBlocked(this.findCards().length > 0)) {
      return 'Naukri is showing a captcha / "Access Denied" page. Solve it yourself, then press Resume';
    }
    return null;
  },
};

JFScraper.listen(naukriAdapter); // popup Start / Stop / Resume / Status
JFScraper.startPassiveFilter(naukriAdapter); // rules while no run is active
JFScraper.resumeIfRunning(naukriAdapter); // continue a run after "Next" navigation
