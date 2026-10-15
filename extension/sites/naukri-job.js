// sites/naukri-job.js — Naukri job-detail pages (www.naukri.com/job-listings-*).
//
// Naukri's JD API needs reCAPTCHA, so the scraper reads JDs by opening job pages in a minimized
// "worker" window (background.js). This script only acts inside those worker tabs: it waits until the
// JD has rendered and hands the text back. When YOU open a job page normally, it does nothing at all.
// Loaded on its own (no common/filters.js, no scraper-core.js), hence the small local helpers.

(() => {
  const SEL = {
    jd: ['[class*="JDC__dang-inner-html"]', '[class*="job-desc-container"]'], // first match wins
    title: '[class*="jd-header-title"]',
    company: '[class*="jd-header-comp-name"]',
    // "jhc__exp__" (not "jhc__exp"): the shorter one first matches the wrapper that also holds the salary
    experience: '[class*="jhc__exp__"]',
    keySkills: '[class*="key-skill"]',
  };
  const WAIT_MS = 20000; // the background gives up at 25 s, so we answer before that
  const STABLE_MS = 500; // the JD renders in chunks: wait until it stops changing
  const SHORT_STABLE_MS = 3000; // a JD under MIN_JD_CHARS may still be loading, so give it longer
  const MIN_JD_CHARS = 200;
  const BLOCK_TITLE_RE = /access denied|captcha|just a moment|attention required/i;
  // Body text is only checked while the JD is missing, so a JD that mentions these words is fine.
  const BLOCK_BODY_RE = /access denied|verify you are (a )?human|are you a robot|unusual traffic/i;

  /** chrome.runtime.sendMessage as a promise; null on any failure. */
  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          resolve(chrome.runtime.lastError ? null : reply); // reading lastError silences the console warning
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function textOf(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function readJd() {
    for (const selector of SEL.jd) {
      const text = textOf(document.querySelector(selector));
      if (text) return text;
    }
    return '';
  }

  /** Company link text; without a link, the first text in the header box (rating / reviews follow it). */
  function readCompany() {
    const box = document.querySelector(SEL.company);
    if (!box) return '';
    const link = box.querySelector('a');
    if (link) return textOf(link);
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent.trim();
      if (text) return text;
    }
    return '';
  }

  /** Key skills as "Python, SQL, ...". Read the innermost elements so chips don't glue together ("PythonSQL"). */
  function readKeySkills() {
    const box = document.querySelector(SEL.keySkills);
    if (!box) return '';
    const words = [...box.querySelectorAll('*')]
      .filter((el) => el.children.length === 0)
      .map((el) => el.textContent.trim())
      .filter((word) => word && !/^key skills$/i.test(word)); // drop the section heading
    return [...new Set(words)].join(', ');
  }

  function looksBlocked() {
    if (BLOCK_TITLE_RE.test(document.title || '')) return true;
    return BLOCK_BODY_RE.test(document.body ? document.body.innerText : '');
  }

  function readResult(jd) {
    const skills = readKeySkills();
    return {
      jd: skills ? `${jd}\n\nKey skills: ${skills}` : jd,
      title: textOf(document.querySelector(SEL.title)),
      company: readCompany(),
      experience_text: textOf(document.querySelector(SEL.experience)),
    };
  }

  /**
   * Waits until the JD stops changing (500 ms; 3 s while it is under 200 chars), then replies naukriJdReady once.
   * Some jobs really have a one-line JD: we send that too, and the backend answers "no_jd" instead of us timing out.
   */
  function waitForJd(jobId) {
    let finished = false;
    let lastJd = '';
    let stableTimer = 0;
    const observer = new MutationObserver(check);
    const giveUpTimer = setTimeout(() => finish({ error: looksBlocked() ? 'blocked' : 'timeout' }), WAIT_MS);

    function finish(result) {
      if (finished) return;
      finished = true;
      observer.disconnect();
      clearTimeout(stableTimer);
      clearTimeout(giveUpTimer);
      send({ type: 'naukriJdReady', jobId, ...result });
    }

    function check() {
      if (finished) return;
      try {
        const jd = readJd();
        if (jd.length < MIN_JD_CHARS && looksBlocked()) {
          finish({ error: 'blocked' }); // captcha / Access Denied — the user must solve it, never us
          return;
        }
        if (jd === lastJd) return; // unchanged → let the stability timer run out
        lastJd = jd;
        clearTimeout(stableTimer);
        if (jd) stableTimer = setTimeout(() => finish(readResult(jd)), jd.length >= MIN_JD_CHARS ? STABLE_MS : SHORT_STABLE_MS);
      } catch (e) {
        console.warn('[JobFilter] reading the JD failed:', e);
      }
    }

    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    check(); // the JD may already be on the page
  }

  // Only the background knows whether this tab is one of its worker tabs.
  send({ type: 'naukriWorkerHello' }).then((reply) => {
    if (reply && reply.worker) waitForJd(reply.jobId);
  });
})();
