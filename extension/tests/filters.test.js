// Tests for the pure functions in common/filters.js (no browser needed). Run from the extension/ folder:
//   <jsvenv>/Scripts/python.exe jscheck.py --run common/filters.js tests/filters.test.js
// QuickJS has no `chrome`, so jfLoadSettings is not exercised here. Any failure throws → non-zero exit.

var passed = 0;
var failures = [];

function check(name, actual, expected) {
  var got = JSON.stringify(actual);
  var want = JSON.stringify(expected);
  if (got === want) passed++;
  else failures.push(name + ": expected " + want + ", got " + got);
}

function matches(keyword, title) {
  return jfTitleMatchesKeyword(keyword, jfNormalize(title));
}

check("chrome is not available here", typeof chrome, "undefined");

// jfNormalize
check("normalize punctuation", jfNormalize("  Sr. AI/ML Engineer (GenAI) "), "sr ai ml engineer genai");
check("normalize null", jfNormalize(null), "");

// Multi-word keywords
check("multi-word in title", matches("machine learning", "Senior Machine Learning Engineer"), true);
check("multi-word across punctuation", matches("machine learning", "Machine-Learning Engineer"), true);
check("multi-word wrong order", matches("machine learning", "Learning Machine Operator"), false);
check("multi-word needs whole words", matches("machine learn", "Machine Learning Engineer"), false);

// Compressed match (keyword words glued into one title word)
check("compressed title", matches("machine learning", "MachineLearning Engineer"), true);
check("compressed title, keyword case", matches("Machine Learning", "machinelearning engineer"), true);
check("compressed needs a whole word", matches("data entry", "Big Dataentryway Lead"), false);

// Whole-word single keywords
check("intern not in international", matches("intern", "International Sales Manager"), false);
check("intern whole word", matches("intern", "Data Science Intern"), true);
check("keyword gets normalized", matches("  Intern! ", "AI intern - remote"), true);
check("empty keyword never matches", matches("  ", "anything"), false);
check("ai not in maintenance", matches("ai", "Maintenance Engineer"), false);

// Company exact match
check("company exact, any case", jfCompanyBlacklisted("  Soul AI ", ["soul ai"]), true);
check("company is not a prefix match", jfCompanyBlacklisted("Soul AI Private Ltd", ["soul ai"]), false);
check("empty company never matches", jfCompanyBlacklisted("", ["", "soul ai"]), false);
check("missing list", jfCompanyBlacklisted("Acme", undefined), false);

// jfRuleCheck: company → blacklist → whitelist
var rules = { blacklistKeywords: ["teacher", "intern"], whitelistKeywords: [], blacklistCompanies: ["Acme"] };
check("rule: company", jfRuleCheck("ML Engineer", "acme", rules), { hide: true, reason: "company" });
check("rule: blacklist", jfRuleCheck("Python Teacher", "Other", rules), { hide: true, reason: "blacklist:teacher" });
check("rule: pass", jfRuleCheck("International ML Engineer", "Other", rules), { hide: false, reason: null });

var wl = { blacklistKeywords: ["intern"], whitelistKeywords: ["machine learning", "ai"], blacklistCompanies: [] };
check("whitelist hit (multi-word)", jfRuleCheck("Machine Learning Engineer", "X", wl), { hide: false, reason: null });
check("whitelist hit (compressed)", jfRuleCheck("MachineLearning Engineer", "X", wl), { hide: false, reason: null });
check("whitelist miss", jfRuleCheck("Java Developer", "X", wl), { hide: true, reason: "whitelist" });
check("whitelist whole word", jfRuleCheck("Maintenance Engineer", "X", wl), { hide: true, reason: "whitelist" });
check("blacklist beats whitelist", jfRuleCheck("AI Intern", "X", wl), { hide: true, reason: "blacklist:intern" });
check("blank whitelist entries ignored", jfRuleCheck("Java Developer", "X", { whitelistKeywords: [" ", ""] }),
      { hide: false, reason: null });
check("no settings at all", jfRuleCheck("Anything", "X", undefined), { hide: false, reason: null });

// jfMergeSettings: stored values over defaults
var merged = jfMergeSettings({ aiEnabled: false, naukri: { jdTabs: 3 }, global: "corrupt", indeed: { maxPages: 4 } });
check("merge: value override", merged.aiEnabled, false);
check("merge: nested override", merged.naukri.jdTabs, 3);
check("merge: nested default kept", merged.naukri.maxPages, 10);
check("merge: corrupt section ignored", merged.global.blacklistKeywords, JF_DEFAULT_SETTINGS.global.blacklistKeywords);
check("merge: emptied list stays empty", jfMergeSettings({ global: { blacklistKeywords: [] } }).global.blacklistKeywords, []);
check("merge: null storage", jfMergeSettings(null).backendUrl, "http://localhost:8765");
merged.linkedin.titleAI = false;
check("merge: result is a copy", JF_DEFAULT_SETTINGS.linkedin.titleAI, true);

if (failures.length) throw new Error(failures.length + " test(s) failed:\n" + failures.join("\n"));
"all " + passed + " filter tests passed";
