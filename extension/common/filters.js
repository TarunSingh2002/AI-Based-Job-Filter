// Job Filter v2 — shared rule functions + settings defaults.
//
// Loaded as a plain script by the content scripts (before the site file), the popup, the side panel and the
// background (importScripts). Everything here is a global with a "jf" prefix so it cannot clash with site code.
// Pure logic only: no DOM writes, no clicks, no network. The only chrome API used is storage, in jfLoadSettings.

// Settings shape and defaults (DESIGN.md 3.2). Stored under chrome.storage.local "settings".
const JF_DEFAULT_SETTINGS = {
  backendUrl: "http://localhost:8765",
  aiEnabled: true,
  global: {
    blacklistKeywords: ["teacher", "trainer", "tutor", "instructor", "faculty", "lecturer", "professor",
                        "teaching", "intern", "internship", "annotator", "annotation"],
    whitelistKeywords: [],        // if non-empty, the title must match at least one
    blacklistCompanies: [],       // exact, case-insensitive
  },
  linkedin: {
    promotedMode: "partial",      // "show" | "hide" | "partial"
    partialScope: "all",          // "all" = every job you open is remembered; "promoted" = only promoted ones
    hideApplied: true,
    hideDismissed: true,
    titleAI: true,
    jdAI: true,
  },
  // markProcessed: "all" | "rejected" | "none".  jdParallel / jdTabs (Naukri: one worker tab each) = how many job
  // pages are read at the same time, 1..4.
  glassdoor: { hideSaved: true, markProcessed: "all", maxPages: 10, jdParallel: 3 },
  naukri: { hideSaved: true, hidePromoted: true, markProcessed: "all", maxPages: 10, jdTabs: 2 },
  indeed: { hideSaved: true, markProcessed: "all", maxPages: 10, jdParallel: 3 },
  // The automation (popup → Automation tab, DESIGN.md 3.7) runs these saved searches one after another:
  // every Naukri link, then every Indeed link, then every Glassdoor link, each list in its own order.
  automation: {
    searches: {
      naukri: [
        "https://www.naukri.com/data-scientist-data-analysis-data-analytics-data-science-machine-learning-deep-learning-natural-language-processing-artificial-intelligence-tensorflow-scikit-learn-keras-pytorch-pandas-numpy-rnn-cnn-nltk-data-science-jobs?k=data%20scientist%2C%20data%20analysis%2C%20data%20analytics%2C%20data%20science%2C%20machine%20learning%2C%20deep%20learning%2C%20natural%20language%20processing%2C%20artificial%20intelligence%2C%20tensorflow%2C%20scikit-learn%2C%20keras%2C%20pytorch%2C%20pandas%2C%20numpy%2C%20rnn%2C%20cnn%2C%20nltk%2C%20data%20science&nignbevent_src=jobsearchDeskGNB&experience=1&jobAge=1",
      ],
      indeed: [
        "https://in.indeed.com/jobs?q=Machine+Learning+OR+Data+Scientist%2C+Deep+Learning%2C+Generative+AI%2C+Data+Analysis%2C+Retrieval+Augmented+Generation%2C+Large+Language+Models%2C+Natural+Language+Processing%2C+Artificial+Intelligence%2C+TensorFlow%2C+Pandas%2C+NLP%2C+LLM%2C+RAG%2C+GenAI%2C+NumPy%2C+MLOps%2C+MLflow%2C+DVC%2C+LangChain&l=india&fromage=1&from=searchOnDesktopSerp&vjk=dc58df39893638bb",
      ],
      glassdoor: [
        "https://www.glassdoor.co.in/Job/india-%22TensorFlow%22-OR-%22Pandas%22-OR-%22NLP%22-OR-%22LLM%22-OR-%22RAG%22-OR-%22GenAI%22-OR-%22NumPy%22-OR-%22LangChain%22-OR-%22Machine-Learning%22-OR-%22Python%22-jobs-SRCH_IL.0,5_IN115_KO6,128.htm?locId=115&locT=N&fromAge=1",
        "https://www.glassdoor.co.in/Job/india-%22Natural-Language-Processing%22-OR-%22Large-Language-Models%22-OR-%22Retrieval-Augmented-Generation%22-OR-%22MLOps%22-OR-%22MLflow%22-OR-%22DVC%22-jobs-SRCH_IL.0,5_IN115_KO6,130.htm?locId=115&locT=N&fromAge=1",
        "https://www.glassdoor.co.in/Job/india-%22Data-Scientist%22-OR-%22Deep-Learning%22-OR-%22Generative-AI%22-OR-%22Data-Analysis%22-OR-%22Artificial-Intelligence%22-OR-%22Data-Science%22-jobs-SRCH_IL.0,5_IN115_KO6,126.htm?locId=115&locT=N&fromAge=1",
      ],
    },
    clearRepostListsBeforeStart: false,
    startOnBrowserOpen: false,    // only starts once the internet is up AND the backend answers
    captchaWaitMinutes: 10,       // a paused site waits this long for you (captcha), then the run moves on
    stallMinutes: 15,             // a site run that shows no progress for this long is given up
  },
};

// Read settings from storage and fill anything missing with defaults.
// Never rejects: if storage is unavailable (e.g. the extension was reloaded under an open page) we use defaults.
async function jfLoadSettings() {
  try {
    const data = await chrome.storage.local.get("settings");
    return jfMergeSettings(data.settings);
  } catch (err) {
    console.warn("[JobFilter] could not read settings, using defaults:", err);
    return jfMergeSettings(null);
  }
}

// Fresh copy of the defaults with the stored values laid on top, section by section.
// Saved settings from an older version (missing keys) still work, and callers may mutate the result freely.
function jfMergeSettings(stored) {
  return jfMergeInto(JSON.parse(JSON.stringify(JF_DEFAULT_SETTINGS)), stored);
}

function jfMergeInto(base, extra) {
  if (!jfIsPlainObject(extra)) return base;
  for (const key of Object.keys(extra)) {
    const value = extra[key];
    if (jfIsPlainObject(base[key])) jfMergeInto(base[key], value);  // a section: merge field by field (ignores junk)
    else if (Array.isArray(base[key]) && !Array.isArray(value)) continue; // a list stays a list (ignores junk)
    else if (value !== undefined && value !== null) base[key] = value; // a value or a list: the stored one wins
    // (a stored list REPLACES the default list, never mixes with it: an emptied search list stays empty)
  }
  return base;
}

function jfIsPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Lowercase, turn every run of non-letters/digits into one space, trim.
// "Sr. AI/ML Engineer (GenAI)" → "sr ai ml engineer genai". Note: "C++" becomes "c".
function jfNormalize(text) {
  return String(text == null ? "" : text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Does the (already normalized) title contain this keyword? Always on whole words:
// - one word:   "intern" matches "Data Science Intern" but NOT "International Sales".
// - many words: the words in order ("machine learning" matches "Machine-Learning Engineer"), or glued into one
//               title word ("machine learning" also matches "MachineLearning Engineer").
function jfTitleMatchesKeyword(keyword, normTitle) {
  const words = jfNormalize(keyword).split(" ").filter(Boolean);
  if (!words.length || !normTitle) return false;

  const titleWords = normTitle.split(" ");
  if (words.length === 1) return titleWords.includes(words[0]);

  // Normalized text only contains [a-z0-9] and single spaces, so the words are safe to put in a regex as-is.
  const phrase = new RegExp("\\b" + words.join(" ") + "\\b");
  return phrase.test(normTitle) || titleWords.includes(words.join(""));
}

// Exact company-name match, ignoring case and surrounding spaces: "soul ai" hides "Soul AI" but not "Soul AI Pvt Ltd".
function jfCompanyBlacklisted(company, list) {
  const name = String(company == null ? "" : company).trim().toLowerCase();
  if (!name || !Array.isArray(list)) return false;
  return list.some((entry) => String(entry).trim().toLowerCase() === name);
}

// The free, instant rule step that runs before any AI (DESIGN.md section 1, step [1]).
// globalSettings = settings.global. Returns {hide, reason}; reason is "company" | "blacklist:<kw>" | "whitelist" | null.
function jfRuleCheck(title, company, globalSettings) {
  const rules = globalSettings || {};
  if (jfCompanyBlacklisted(company, rules.blacklistCompanies)) return { hide: true, reason: "company" };

  const normTitle = jfNormalize(title);
  const blocked = (rules.blacklistKeywords || []).find((kw) => jfTitleMatchesKeyword(kw, normTitle));
  if (blocked) return { hide: true, reason: "blacklist:" + String(blocked).trim() };

  const required = (rules.whitelistKeywords || []).filter((kw) => jfNormalize(kw));
  if (required.length && !required.some((kw) => jfTitleMatchesKeyword(kw, normTitle))) {
    return { hide: true, reason: "whitelist" };
  }
  return { hide: false, reason: null };
}
