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
  // The right-hand job panel (verified live 2026-10-18): its first line is the job title, the description is in
  // .react-native-html-content (new layout); #jobDescriptionText is the older layout.
  pane: '#jobsearch-ViewjobPaneWrapper',
  paneJd: ['.react-native-html-content', '#jobDescriptionText'],
  // Verified live 2026-10-28: the panel now opens with "Return to Search Result" / "Job Post Details", so its first
  // line is no longer the title. Older layouts: .jobsearch-JobInfoHeader-title.
  paneTitle: ['[data-testid="vj-job-title"]', '.jobsearch-JobInfoHeader-title', '[data-testid="jobsearch-JobInfoHeader-title"]'],
};
const INDEED_PANE_TIMEOUT_MS = 15000; // the panel normally shows the clicked job within 1-1.5 s
const INDEED_PANE_STABLE_MS = 400; // the description renders in chunks: wait until it stops changing
// Pause message when the job panel keeps showing a check page after the engine's waits.
const INDEED_JOB_BLOCKED =
  'Indeed is showing a security check. Solve it yourself in this tab, then press Resume';

function indeedIsSaved(card) {
  return !!card.querySelector(`${INDEED_SEL.bookmark}[aria-pressed="true"]`);
}

/** The job currently open in Indeed's right-hand panel: {title, jd} ('' when the panel is empty). */
function indeedPane() {
  const pane = document.querySelector(INDEED_SEL.pane);
  if (!pane) return { title: '', jd: '' };
  let jd = '';
  for (const selector of INDEED_SEL.paneJd) {
    const el = pane.querySelector(selector);
    const text = el ? (el.innerText || el.textContent || '').trim() : '';
    if (text) {
      jd = text;
      break;
    }
  }
  let title = '';
  for (const selector of INDEED_SEL.paneTitle) {
    const el = pane.querySelector(selector);
    title = el ? (el.innerText || el.textContent || '').trim() : '';
    if (title) break;
  }
  if (!title) title = (pane.innerText || '').split('\n')[0].trim(); // last resort: the panel's first line
  return { title, jd };
}

/** Loose title compare: the panel and the card can differ in punctuation / spacing. */
function indeedSameTitle(a, b) {
  const x = jfNormalize(a);
  const y = jfNormalize(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
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

  /**
   * Opens the job in Indeed's own right-hand panel by clicking its card title - what you do by hand - and reads the
   * description there. Background fetches of /viewjob pages got rate-limited / bot-checked by Indeed (2026-10-18);
   * the panel loads through Indeed's normal requests. One job at a time (the panel shows one job). → {jd, blocked}
   * No JD in time → '' (the backend answers "no_jd": the job stays visible and is tried again on a later run).
   */
  async fetchJd(job) {
    const link = document.querySelector(`${INDEED_SEL.titleLink}[data-jk="${CSS.escape(String(job.job_id))}"]`);
    if (!link) return { jd: '', blocked: null }; // the card left the list (re-render): skip it, it stays visible
    const before = indeedPane();
    link.click();
    const deadline = Date.now() + INDEED_PANE_TIMEOUT_MS;
    let last = '';
    let stableSince = 0;
    while (Date.now() < deadline) {
      await jfsSleep(200);
      if (jfsPageLooksBlocked(true)) return { jd: '', blocked: INDEED_JOB_BLOCKED }; // check page in the title
      const pane = indeedPane();
      const opened = new URLSearchParams(location.search).get('vjk') === String(job.job_id);
      // The old description can sit under the new title for a moment; identical text is fine only for the same title
      // (a company's repost with the very same description).
      const fresh = pane.jd !== before.jd || indeedSameTitle(before.title, pane.title);
      if (!opened || pane.jd.length < 200 || !fresh || !indeedSameTitle(pane.title, job.title)) {
        last = ''; // not ready: the stability wait starts over once it is
        continue;
      }
      if (pane.jd !== last) {
        last = pane.jd;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= INDEED_PANE_STABLE_MS) {
        return { jd: pane.jd, blocked: null };
      }
    }
    return { jd: '', blocked: null };
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
