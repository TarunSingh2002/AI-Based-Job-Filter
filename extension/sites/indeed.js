// sites/indeed.js — Indeed search results (in.indeed.com/jobs?..., www.indeed.com/jobs?...).
//
// Two jobs:
//   1. Passive filter (always, when no run is active): rules + hide saved.
//   2. Scraper adapter for JFScraper (sites/scraper-core.js), started from the popup.
//
// Selectors verified live 2026-10-14 (DESIGN.md 3.5).

const INDEED_SEL = {
  card: 'li.css-1ac2h1w', // hashed class; cards are recognised by the title link inside
  titleLink: 'a.jcs-JobTitle', // data-jk = job id
  titleText: 'a.jcs-JobTitle span[title]', // attr "title" = full title
  ghostCard: '.cardOutline[aria-hidden="true"]', // hidden duplicate Indeed renders for the selected job
  company: '[data-testid="company-name"]',
  location: '[data-testid="text-location"]',
  bookmark: 'button.bookmark', // aria-pressed="true" when saved
  next: 'a[data-testid="pagination-page-next"]',
  jdFallback: ['#jobDescriptionText'], // used when the job page has no JSON-LD JobPosting
};
// Pause message when job pages stay blocked after the engine's waits (a short 403 / 429 burst never gets here).
const INDEED_JOB_BLOCKED =
  'Indeed answers job pages with a security check. Open any job from the list in a new tab, pass the check yourself, then press Resume';

function indeedIsSaved(card) {
  return !!card.querySelector(`${INDEED_SEL.bookmark}[aria-pressed="true"]`);
}

const indeedAdapter = {
  site: 'indeed',

  findCards() {
    return [...document.querySelectorAll(INDEED_SEL.card)].filter(
      (li) => li.querySelector(INDEED_SEL.titleLink) && !li.querySelector(INDEED_SEL.ghostCard)
    );
  },

  readCard(li) {
    const link = li.querySelector(INDEED_SEL.titleLink);
    const jk = link && link.getAttribute('data-jk');
    if (!jk) return null;
    const titleEl = li.querySelector(INDEED_SEL.titleText);
    return {
      job_id: jk,
      title: (titleEl && titleEl.getAttribute('title')) || jfsText(link),
      company: jfsText(li.querySelector(INDEED_SEL.company)),
      location: jfsText(li.querySelector(INDEED_SEL.location)),
      experience_text: '', // Indeed cards don't show experience
      link: `${location.origin}/viewjob?jk=${jk}`,
      isSaved: indeedIsSaved(li),
      isPromoted: false,
    };
  },

  hideCard: (li) => jfsSetHidden(li, true),
  showCard: (li) => jfsSetHidden(li, false),
  highlight: (li, kind) => jfsPaint(li, kind),

  async markProcessed(li) {
    const button = li.querySelector(INDEED_SEL.bookmark);
    if (!button || indeedIsSaved(li)) return;
    await jfsClickAndWait(button, () => indeedIsSaved(li));
  },

  /** Same-origin fetch of the job page; the JD comes from its JSON-LD JobPosting (fallback #jobDescriptionText). → {jd, blocked} */
  async fetchJd(job) {
    return jfsFetchJobPage(`/viewjob?jk=${encodeURIComponent(job.job_id)}`, INDEED_SEL.jdFallback, INDEED_JOB_BLOCKED);
  },

  async nextPage() {
    const next = document.querySelector(INDEED_SEL.next);
    if (!next || !next.href) return 'none';
    location.href = next.href; // full page load; the next page resumes the run from scrape_state
    return 'navigating';
  },

  detectBlock() {
    if (jfsPageLooksBlocked(this.findCards().length > 0)) {
      return 'Indeed is showing a security check / captcha. Solve it yourself, then press Resume';
    }
    return null;
  },
};

JFScraper.listen(indeedAdapter); // popup Start / Stop / Resume / Status
JFScraper.startPassiveFilter(indeedAdapter); // rules while no run is active
JFScraper.resumeIfRunning(indeedAdapter); // continue a run after "Next" navigation
