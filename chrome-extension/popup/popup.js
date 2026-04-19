// ── Tab Switching ─────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');

    // Show scraper bar on LinkedIn and Glassdoor tabs only
    const bar = document.getElementById('scraper-bar');
    if (bar) bar.style.display = (btn.dataset.tab === 'linkedin' || btn.dataset.tab === 'glassdoor') ? 'block' : 'none';
  });
});

// ── Helpers ───────────────────────────────────────────────────

function showSavedTick() {
  const status = document.createElement('div');
  status.textContent = '✔';
  status.className = 'save-status';
  document.body.appendChild(status);
  setTimeout(() => window.close(), 1000);
}

function parseTextarea(id) {
  return document.getElementById(id).value
    .split(',')
    .map(k => k.trim())
    .filter(k => k);
}

// ── Seen Promoted List UI ─────────────────────────────────────

function updateSeenPromotedUI() {
  const mode    = document.querySelector('input[name="promotedMode"]:checked')?.value;
  const section = document.getElementById('seenPromotedSection');

  if (mode !== 'partial') {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  const today = new Date().toISOString().slice(0, 10);
  chrome.storage.local.get(['seen_promoted_list'], (data) => {
    const stored = data['seen_promoted_list'];
    const list   = (stored && stored.date === today) ? (stored.list || []) : [];
    const listEl = document.getElementById('seenPromotedList');

    if (!list.length) {
      listEl.textContent = 'No promoted jobs seen yet today.';
    } else {
      listEl.innerHTML = list.map(key => {
        const [title, company] = key.split('|');
        return `<div class="seen-item">• <strong>${title}</strong> @ ${company || ''}</div>`;
      }).join('');
    }
  });
}

document.querySelectorAll('input[name="promotedMode"]').forEach(r => {
  r.addEventListener('change', updateSeenPromotedUI);
});

document.getElementById('clearSeenPromoted').addEventListener('click', () => {
  chrome.storage.local.remove('seen_promoted_list', () => updateSeenPromotedUI());
});

// ── LinkedIn Save ─────────────────────────────────────────────

document.getElementById('saveLinkedIn').addEventListener('click', () => {
  const whitelistKeywords = parseTextarea('whitelistKeywords');
  const titleKeywords     = parseTextarea('titleKeywords');
  const companyNames      = parseTextarea('companyNames');
  const hideApplied       = document.getElementById('hideApplied').checked;
  const hideDismissed     = document.getElementById('hideDismissed').checked;
  const promotedMode      = document.querySelector('input[name="promotedMode"]:checked')?.value || 'show';

  chrome.storage.sync.set({
    whitelistKeywords, titleKeywords, companyNames,
    hideApplied, hideDismissed, promotedMode
  }, showSavedTick);
});

// ── Load Saved Settings on Popup Open ────────────────────────

chrome.storage.sync.get(
  ['whitelistKeywords', 'titleKeywords', 'companyNames',
   'hideApplied', 'hidePromoted', 'hideDismissed',
   'partialHidePromoted', 'promotedMode'],
  (data) => {
    document.getElementById('whitelistKeywords').value = data.whitelistKeywords?.join(', ') || '';
    document.getElementById('titleKeywords').value     = data.titleKeywords?.join(', ')     || '';
    document.getElementById('companyNames').value      = data.companyNames?.join(', ')      || '';
    document.getElementById('hideApplied').checked     = data.hideApplied    || false;
    document.getElementById('hideDismissed').checked   = data.hideDismissed  || false;

    const mode  = data.promotedMode ||
      (data.hidePromoted ? 'hide' : (data.partialHidePromoted ? 'partial' : 'show'));
    const radio = document.querySelector(`input[name="promotedMode"][value="${mode}"]`);
    if (radio) radio.checked = true;
    updateSeenPromotedUI();
  }
);

// ── Naukri Save ───────────────────────────────────────────────

document.getElementById('saveNaukri').addEventListener('click', () => {
  chrome.storage.sync.set({
    naukri_blacklistedKeywords:  parseTextarea('naukri_blacklistedKeywords'),
    naukri_blacklistedCompanies: parseTextarea('naukri_blacklistedCompanies'),
    naukri_hideSaved:            document.getElementById('naukri_hideSaved').checked,
    naukri_hidePromoted:         document.getElementById('naukri_hidePromoted').checked
  }, showSavedTick);
});

chrome.storage.sync.get(
  ['naukri_blacklistedKeywords', 'naukri_blacklistedCompanies', 'naukri_hideSaved', 'naukri_hidePromoted'],
  (data) => {
    document.getElementById('naukri_blacklistedKeywords').value  = data.naukri_blacklistedKeywords?.join(', ')  || '';
    document.getElementById('naukri_blacklistedCompanies').value = data.naukri_blacklistedCompanies?.join(', ') || '';
    document.getElementById('naukri_hideSaved').checked          = data.naukri_hideSaved    || false;
    document.getElementById('naukri_hidePromoted').checked       = data.naukri_hidePromoted || false;
  }
);

// ── Indeed Save ───────────────────────────────────────────────

document.getElementById('saveIndeed').addEventListener('click', () => {
  chrome.storage.sync.set({
    indeed_blacklistedKeywords:  parseTextarea('indeed_blacklistedKeywords'),
    indeed_blacklistedCompanies: parseTextarea('indeed_blacklistedCompanies'),
    indeed_hideSaved:            document.getElementById('indeed_hideSaved').checked
  }, showSavedTick);
});

chrome.storage.sync.get(
  ['indeed_blacklistedKeywords', 'indeed_blacklistedCompanies', 'indeed_hideSaved'],
  (data) => {
    document.getElementById('indeed_blacklistedKeywords').value  = data.indeed_blacklistedKeywords?.join(', ')  || '';
    document.getElementById('indeed_blacklistedCompanies').value = data.indeed_blacklistedCompanies?.join(', ') || '';
    document.getElementById('indeed_hideSaved').checked          = data.indeed_hideSaved || false;
  }
);

// ── Glassdoor Save ────────────────────────────────────────────

document.getElementById('saveGlassdoor').addEventListener('click', () => {
  chrome.storage.sync.set({
    glassdoor_blacklistedKeywords:  parseTextarea('glassdoor_blacklistedKeywords'),
    glassdoor_blacklistedCompanies: parseTextarea('glassdoor_blacklistedCompanies'),
    glassdoor_hideSaved:            document.getElementById('glassdoor_hideSaved').checked
  }, showSavedTick);
});

chrome.storage.sync.get(
  ['glassdoor_blacklistedKeywords', 'glassdoor_blacklistedCompanies', 'glassdoor_hideSaved'],
  (data) => {
    document.getElementById('glassdoor_blacklistedKeywords').value  = data.glassdoor_blacklistedKeywords?.join(', ')  || '';
    document.getElementById('glassdoor_blacklistedCompanies').value = data.glassdoor_blacklistedCompanies?.join(', ') || '';
    document.getElementById('glassdoor_hideSaved').checked          = data.glassdoor_hideSaved || false;
  }
);

// ── Foundit Save ──────────────────────────────────────────────

document.getElementById('saveFoundit').addEventListener('click', () => {
  chrome.storage.sync.set({
    foundit_blacklistedKeywords:  parseTextarea('foundit_blacklistedKeywords'),
    foundit_blacklistedCompanies: parseTextarea('foundit_blacklistedCompanies'),
    foundit_hideSaved:            document.getElementById('foundit_hideSaved').checked
  }, showSavedTick);
});

chrome.storage.sync.get(
  ['foundit_blacklistedKeywords', 'foundit_blacklistedCompanies', 'foundit_hideSaved'],
  (data) => {
    document.getElementById('foundit_blacklistedKeywords').value  = data.foundit_blacklistedKeywords?.join(', ')  || '';
    document.getElementById('foundit_blacklistedCompanies').value = data.foundit_blacklistedCompanies?.join(', ') || '';
    document.getElementById('foundit_hideSaved').checked          = data.foundit_hideSaved || false;
  }
);

// ── Scraper Bar ───────────────────────────────────────────────

const startBtn  = document.getElementById('startScraping');
const stopBtn   = document.getElementById('stopScraping');
const statusEl  = document.getElementById('scraper-status');
const countEl   = document.getElementById('scraper-count');

let pollInterval = null;

function setScrapingUI(active, count) {
  countEl.textContent = count > 0 ? `${count} scraped` : '';
  if (active) {
    startBtn.style.display = 'none';
    stopBtn.style.display  = 'block';
    statusEl.textContent   = 'Running… watch the page for highlights';
    statusEl.style.color   = '#057642';
  } else {
    startBtn.style.display = 'block';
    stopBtn.style.display  = 'none';
    startBtn.disabled      = false;
    startBtn.textContent   = '▶ Start Scraping';
  }
}

function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { action: 'getScrapeStatus' }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        setScrapingUI(res.active, res.count);
        if (!res.active) clearInterval(pollInterval);
      });
    });
  }, 800);
}

// ── On popup open: check if scraping is already running ──────────
// Fixes: popup disappears and reopens showing Start instead of Stop
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (!tabs[0]) return;
  chrome.tabs.sendMessage(tabs[0].id, { action: 'getScrapeStatus' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    setScrapingUI(res.active, res.count);
    if (res.active) startPolling(); // resume live count updates
  });
});

startBtn.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];

    const isLinkedIn  = tab?.url?.includes('linkedin.com/jobs');
    const isGlassdoor = tab?.url?.includes('glassdoor.co');

    if (!isLinkedIn && !isGlassdoor) {
      statusEl.textContent = '⚠️ Go to a LinkedIn Jobs or Glassdoor Jobs search page first.';
      statusEl.style.color = '#c62828';
      return;
    }

    startBtn.disabled    = true;
    startBtn.textContent = '⏳ Starting…';
    statusEl.style.color = '';

    chrome.tabs.sendMessage(tab.id, { action: 'startScraping' }, (res) => {
      if (chrome.runtime.lastError) {
        statusEl.textContent = '⚠️ Reload the page and try again.';
        statusEl.style.color = '#c62828';
        startBtn.disabled    = false;
        startBtn.textContent = '▶ Start Scraping';
        return;
      }
      setScrapingUI(true, 0);
      startPolling();
    });
  });
});

stopBtn.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { action: 'stopScraping' });
    setScrapingUI(false, 0);
    statusEl.textContent = 'Stopped.';
    statusEl.style.color = '#c62828';
    clearInterval(pollInterval);
  });
});