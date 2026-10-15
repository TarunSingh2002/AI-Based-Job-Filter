// sites/glassdoor.js — Glassdoor job search (www.glassdoor.co.in/Job/..., www.glassdoor.com/Job/...).
//
// Two jobs:
//   1. Passive filter (always, when no run is active): rules + hide saved.
//   2. Scraper adapter for JFScraper (sites/scraper-core.js), started from the popup.
//
// Selectors come from the old working extension (chrome-extension/glassdoor-content.js). The list selectors
// (card, title, company, location, save button, "Show more jobs") were re-checked live on 2026-10-14.
// The sign-in popup selectors were not (it did not appear), and in that test a job-page fetch got a
// Cloudflare "Security | Glassdoor" 403 — the run then pauses; the user passes the check, then Resume.
// Glassdoor has no page links: "Show more jobs" appends cards to the same list ('same-page').

const GLASSDOOR_SEL = {
  card: 'li[data-test="jobListing"]', // job id in data-jobid
  title: 'a[data-test="job-title"]', // href = job page
  company: ['span[class*="EmployerProfile_compactEmployerName"]', '[class*="EmployerProfile_employerName"]'],
  location: '[data-test="emp-location"]',
  saveButton: 'button[data-test="save-job"]', // aria-label="Saved" when saved
  loadMore: 'button[data-test="load-more"]',
  authModal: '[data-test="authModalContainerV2-content"]', // sign-in popup that appears after a few actions
  modalClose: 'button.CloseButton',
  jdFallback: ['[class*="JobDetails_jobDescription"]', '[data-test="jobDescriptionContent"]', '[class*="jobDescription"]'],
};

function glassdoorIsSaved(card) {
  const button = card.querySelector(GLASSDOOR_SEL.saveButton);
  return !!button && button.getAttribute('aria-label') === 'Saved';
}

function glassdoorCompany(card) {
  for (const selector of GLASSDOOR_SEL.company) {
    const text = jfsText(card.querySelector(selector));
    if (text) return text;
  }
  return '';
}

/** The sign-in popup if it is currently shown, else null. */
function glassdoorOpenAuthModal() {
  const modal = document.querySelector(GLASSDOOR_SEL.authModal);
  return modal && !jfsIsHidden(modal) ? modal : null;
}

/** Closes the sign-in popup if it is open. Resolves false when it is still open afterwards. */
async function glassdoorCloseAuthModal() {
  const modal = glassdoorOpenAuthModal();
  if (!modal) return true;
  const close = modal.querySelector(GLASSDOOR_SEL.modalClose) || document.querySelector(GLASSDOOR_SEL.modalClose);
  if (close) {
    close.click();
    await jfsWaitFor(() => !glassdoorOpenAuthModal(), 2000, 200);
  }
  return !glassdoorOpenAuthModal();
}

const glassdoorAdapter = {
  site: 'glassdoor',
  blockReason: null, // set when a job-page fetch hit a check page; reported once by detectBlock()

  findCards() {
    return [...document.querySelectorAll(GLASSDOOR_SEL.card)];
  },

  readCard(card) {
    const titleLink = card.querySelector(GLASSDOOR_SEL.title);
    const jobId = card.getAttribute('data-jobid');
    if (!titleLink || !jobId) return null; // nudge / ad tiles have no title link
    return {
      job_id: jobId,
      title: jfsText(titleLink),
      company: glassdoorCompany(card),
      location: jfsText(card.querySelector(GLASSDOOR_SEL.location)),
      experience_text: '', // Glassdoor cards don't show experience
      link: titleLink.href || '',
      isSaved: glassdoorIsSaved(card),
      isPromoted: false,
    };
  },

  hideCard: (card) => jfsSetHidden(card, true),
  showCard: (card) => jfsSetHidden(card, false),
  highlight: (card, kind) => jfsPaint(card, kind),

  async markProcessed(card) {
    const button = card.querySelector(GLASSDOOR_SEL.saveButton);
    if (!button || glassdoorIsSaved(card)) return;
    await jfsClickAndWait(button, () => glassdoorIsSaved(card));
  },

  /** Same-origin fetch of the job page; JSON-LD JobPosting first, then the JD containers. */
  async fetchJd(job) {
    if (!job.link) return '';
    const page = await jfsFetchJobPage(job.link, GLASSDOOR_SEL.jdFallback);
    if (page.blocked) {
      this.blockReason = 'Glassdoor answered a job page with a security check. Open any job from the list in a new tab, pass the check yourself, then press Resume';
    }
    return page.jd;
  },

  /** Clicks "Show more jobs" and waits ≤10 s for the card count to grow (same logic as the old extension). */
  async nextPage() {
    const button = document.querySelector(GLASSDOOR_SEL.loadMore);
    if (!button || button.disabled) return 'none';
    const before = this.findCards().length;
    button.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await jfsSleep(400);
    button.click();
    if (await jfsWaitFor(() => this.findCards().length > before, 10000, 300)) return 'same-page';
    // The sign-in popup can swallow the click: go round once more and let detectBlock() handle the popup.
    return glassdoorOpenAuthModal() ? 'same-page' : 'none';
  },

  /** Async (the engine awaits it): first tries to close the sign-in popup, then looks for a challenge page. */
  async detectBlock() {
    const pending = this.blockReason;
    this.blockReason = null;
    if (pending) return pending;
    if (!(await glassdoorCloseAuthModal())) {
      return 'login wall: close the Glassdoor sign-in popup (or sign in), then press Resume';
    }
    if (jfsPageLooksBlocked(this.findCards().length > 0)) {
      return 'Glassdoor is showing a security check / captcha. Solve it yourself, then press Resume';
    }
    return null;
  },
};

JFScraper.listen(glassdoorAdapter); // popup Start / Stop / Resume / Status
JFScraper.startPassiveFilter(glassdoorAdapter); // rules while no run is active
JFScraper.resumeIfRunning(glassdoorAdapter); // shared wiring; "Show more" stays on this page, so no run is ever handed over here
