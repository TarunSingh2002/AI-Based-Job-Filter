// tests/linkedin-console-test.js — READ-ONLY structure report for LinkedIn job search pages.
//
// HOW TO USE: open a LinkedIn jobs search page and click one job so its details show on the right.
// F12 → Console → paste this whole file → Enter. The report is copied to your clipboard; paste it to Claude.
// It only READS the page: no clicks, no scrolling, no network, no storage, no changes to the page.
// It reports tag names / classes / attributes around job cards and the job-details pane, plus the card text
// lines (job titles, companies, locations) — nothing from your profile, messages or the nav bar.

(() => {
  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const cls = (el) => clip(typeof el.className === 'string' ? el.className : el.getAttribute('class'), 160);
  const attrs = (el) =>
    [...el.attributes]
      .filter((a) => /^(id|role|data-|aria-label|componentkey|href)/.test(a.name))
      .map((a) => `${a.name}=${clip(a.value, 70)}`)
      .join(' ');
  const describe = (el) => `${el.tagName.toLowerCase()}${cls(el) ? ' .' + cls(el) : ''}${attrs(el) ? ' [' + attrs(el) + ']' : ''}`;
  const chain = (el, levels) => {
    const out = [];
    for (let e = el, i = 0; e && e !== document.body && i < levels; e = e.parentElement, i++) out.push(describe(e));
    return out;
  };
  const lines = (el, n) => (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, n);
  const idOf = (href) => (/\/jobs\/view\/(\d+)/.exec(href || '') || /currentJobId=(\d+)/.exec(href || '') || [])[1];

  // 1. The selectors the extension uses today.
  const current = {};
  for (const s of [
    '.scaffold-layout__list', 'li.scaffold-layout__list-item', 'li[data-occludable-job-id]', '[data-job-id]',
    '.job-card-list__title--link', '.artdeco-entity-lockup__subtitle', '.job-card-container__footer-item',
    '.scaffold-layout__detail', '.jobs-search__job-details--container', '.job-details-jobs-unified-top-card__job-title',
    '.job-details-jobs-unified-top-card__company-name', '.t-24', 'h1', '#job-details', '.jobs-description__content',
    '.jobs-description-content__text', '.jobs-box__html-content',
  ]) current[s] = document.querySelectorAll(s).length;

  // 2. Job cards: found through links to a job, not through class names.
  const links = [...document.querySelectorAll('a[href*="/jobs/view/"], a[href*="currentJobId="]')];
  const byId = new Map();
  for (const a of links) {
    const id = idOf(a.getAttribute('href'));
    if (id && !byId.has(id)) byId.set(id, a);
  }
  const openId = new URLSearchParams(location.search).get('currentJobId');
  const sampleIds = [...byId.keys()].slice(0, 3);
  if (openId && byId.has(openId) && !sampleIds.includes(openId)) sampleIds.push(openId);
  const cards = sampleIds.map((id) => {
    const a = byId.get(id);
    const li = a.closest('li');
    const box = li || a.parentElement.parentElement.parentElement;
    return {
      id,
      isOpenJob: id === openId,
      link: { el: describe(a), text: clip(a.innerText, 120), strong: clip(a.querySelector('strong') && a.querySelector('strong').innerText, 100) },
      ancestors: chain(a, 12),
      cardTextLines: lines(box, 10),
      liAttrs: li ? describe(li) : null,
    };
  });

  // 3. Details pane: found through the "About the job" heading and the job-title heading.
  const about = [...document.querySelectorAll('h1, h2, h3, h4, span, div, p')].find(
    (e) => e.children.length <= 1 && /^about the job$/i.test(clip(e.innerText, 40))
  );
  let jdBox = null;
  if (about) {
    for (let e = about.parentElement, i = 0; e && i < 6; e = e.parentElement, i++) {
      if ((e.innerText || '').length > 300) { jdBox = e; break; }
    }
  }
  const headings = [...document.querySelectorAll('h1, h2')].slice(0, 12).map((h) => ({
    el: describe(h), text: clip(h.innerText, 80), insideLink: h.closest('a') ? idOf(h.closest('a').getAttribute('href')) : null,
    linkInside: h.querySelector('a') ? idOf(h.querySelector('a').getAttribute('href')) : null,
  }));
  const openLinks = openId
    ? [...document.querySelectorAll(`a[href*="/jobs/view/${openId}"]`)].slice(0, 6).map((a) => ({ el: describe(a), text: clip(a.innerText, 80), ancestors: chain(a, 5) }))
    : [];

  const report = {
    url: location.pathname + location.search.replace(/keywords=[^&]*/, 'keywords=…'),
    totals: { jobLinks: links.length, distinctJobs: byId.size, li: document.querySelectorAll('li').length },
    currentSelectors: current,
    cards,
    detail: {
      aboutHeading: about ? { el: describe(about), ancestors: chain(about, 8) } : null,
      jdBox: jdBox ? { el: describe(jdBox), textLength: (jdBox.innerText || '').length, firstLines: lines(jdBox, 4) } : null,
      headings,
      linksToOpenJob: openLinks,
    },
  };
  const json = JSON.stringify(report, null, 1);
  try { copy(json); console.log('%c[LinkedIn test] report copied to clipboard — paste it to Claude', 'font-weight:bold'); }
  catch (e) { console.log('[LinkedIn test] copy() unavailable — copy the text below'); }
  console.log(json);
  return 'Full report is in your clipboard (and printed above) - paste it with Ctrl+V';
})();
