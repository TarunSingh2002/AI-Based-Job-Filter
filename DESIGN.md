# Job Filter v2 — Design & Contracts

This file is the single source of truth for how the pieces talk to each other.
Every file in this project must follow the contracts below exactly (names, shapes, keys).

```
AI-Based-Job-Filter/       ← repo root (v2; the old v1 code is git tag v1-old-code)
  DESIGN.md                ← this file
  README.md                ← how to run (user-facing)
  backend/                 ← Python: FastAPI + LangGraph + Jev (the only AI provider)
    output/                ← results: output/YYYY-MM-DD/jobs.xlsx (open this) + <site>_matches.csv, <site>_rejected.csv
  extension/               ← Chrome MV3 extension (load unpacked; NEVER publish to the Web Store)
```
`backend/.gitignore` keeps `.env` (the Jev key), `.venv/`, `data/` (verdict cache), `output/` and caches out of git.

---------------------------------------------------------------------------------------------------

## 1. The pipeline (same idea on every site)

```
card on page
  → [1] RULES (extension, instant, free): blacklisted company / blacklisted title keyword /
         whitelist (title must contain one) / hide saved / promoted handling
  → [2] TITLE AI (backend /screen/title): title + company (+ card experience text)  → pass | reject
  → [3] JD AI    (backend /screen/jd):    title + company + full job description    → pass | reject
  → pass  → row appended to backend/output/<date>/<site>_matches.csv
  → every reject (title or jd) → row appended to backend/output/<date>/<site>_rejected.csv (for debugging drift)
  → a couple of seconds later: backend/output/<date>/jobs.xlsx rebuilt from that day's CSVs (section 2.7)
```

Golden rule from the drift discussion: **the AI answers simple questions; plain code makes the decisions.**
Numbers (years of experience) are compared in code, never by the model.

---------------------------------------------------------------------------------------------------

## 2. Backend (`backend/`)

Python 3.11. Run: `uvicorn app:app --port 8765` from `backend/`. Port **8765** (old project used 8000; keep them apart).

Files:
```
backend/
  app.py              FastAPI app + endpoints (section 2.2)
  graph.py            LangGraph graph (section 2.3) — must read top-to-bottom like a story
  questions.py        THE PROMPT: all question definitions for title + JD stages (section 2.4)
  decide.py           pure-code decisions (thresholds, experience comparison) — no AI here
  experience.py       regex parser: "3-8 Yrs", "2+ years", "minimum 3 years", "0-1 years", "fresher" → (min,max)
  store.py            SQLite cache (data/jobs.db) + CSV writer (output/<date>/...) + keeps jobs.xlsx up to date
  excel.py            jobs.xlsx builder (openpyxl): the day's CSVs as sortable Excel tables (section 2.7)
  providers/
    __init__.py       get_provider(): always Jev
    base.py           Provider protocol + Answer dataclass
    jev.py            TypeSafe Jev REST provider (httpx, async)
  config.py           JEV_URL / JEV_MODEL constants + pydantic-settings (backend/.env holds only JEV_API_KEY)
  profile.yaml        candidate profile (skills, experience, avoided role types, thresholds)
  .env.example
  requirements.txt    minimal: fastapi, uvicorn, langgraph, httpx, pydantic, pydantic-settings, pyyaml, openpyxl
```

### 2.1 Config
`backend/.env` holds ONE line: `JEV_API_KEY=<OpenCode or TypeSafe key>`.
Which Jev is used is two constants at the top of `config.py`:
`JEV_URL = "https://opencode.ai/inference/v1/systemone"`, `JEV_MODEL = "jev-1.13"` (paid)
(OpenCode free, rate-limited: `jev-1.13-free`; TypeSafe direct: `https://api.typesafe.ai/v1/systemone` + `jev-latest`).
OUTPUT_DIR (`output`), DB_PATH (`data/jobs.db`), PROFILE_PATH (`profile.yaml`) have fixed defaults, resolved against
`backend/` (so results land in `backend/output/`).

### 2.2 HTTP API (JSON). CORS: allow all origins (extension background calls it).

`GET /health` → `{"ok": true, "provider": "jev", "model": "<model id>", "profile": {"experience_years": n}}`

`POST /screen/title`
```json
{ "site": "linkedin|glassdoor|naukri|indeed",
  "jobs": [ { "job_id": "str", "title": "str", "company": "str",
              "location": "str?", "experience_text": "str? (e.g. '3-8 Yrs' from Naukri card)", "link": "str?" } ] }
```
→
```json
{ "results": [ { "job_id": "str",
                 "decision": "pass" | "reject",
                 "reason": "short human text, e.g. 'role: teaching_training (0.94)'",
                 "confidence": 0.0-1.0,
                 "stage": "title" | "jd",        // stage the decision came from
                 "cached": true|false,           // true = came from SQLite, no AI call
                 "final": true|false } ] }       // true = JD stage already done earlier → extension skips JD fetch
```
- Results come back in the same order as `jobs`. Jobs are processed concurrently (asyncio.gather, provider-limited).
- Cache: if (site, job_id) already has a JD-stage verdict → return it with `cached:true, final:true`.
  If it has a title-stage verdict → return it with `cached:true, final:false` (reject stays reject; pass → extension continues to JD).
- Provider failure for one job → that job returns `decision:"pass", reason:"ai_error: ..."`, confidence 0 (never hide on error). Not cached.

`POST /screen/jd`
```json
{ "site": "...", "job": { "job_id": "...", "title": "...", "company": "...", "location": "?", "experience_text": "?",
                          "link": "?", "jd": "full job description text" } }
```
→
```json
{ "job_id": "str", "decision": "pass" | "reject", "reason": "str",
  "match_score": 1-10 | null, "confidence": 0.0-1.0,
  "role_family": "str|null", "min_years": int|null, "max_years": int|null, "work_mode": "str|null",
  "cached": bool, "saved_to_csv": bool, "stage": "jd", "final": true }
```
- If (site, job_id) already has a JD verdict → return cached, do NOT write CSV again.
- Empty/too-short JD (< 200 chars) → run title-only logic again and return `decision:"pass", reason:"no_jd"` with
  match_score null, and do NOT cache as final (so a later run can retry).
- Provider failure → `decision:"pass", reason:"ai_error: ..."`, not cached, not written.

`GET /stats` → `{"date": "YYYY-MM-DD", "sites": {"naukri": {"matches": n, "rejected": n}, ...}}` for today.

### 2.3 LangGraph (`graph.py`)

One compiled graph, state is a TypedDict:
```
JobState: site, stage ("title"|"jd"), job (dict), answers (dict|None), verdict (dict|None), error (str|None)
```
Nodes (each a small async function with a docstring):
```
START ─route─┬─ stage=="title" → ask_title  → decide_title ─┐
             └─ stage=="jd"    → ask_jd     → decide_jd    ─┴→ record → END
```
- `ask_title` / `ask_jd`: build state + questions from `questions.py`, call `provider.ask(state, questions)`.
- `decide_title` / `decide_jd`: call pure functions in `decide.py` → verdict dict (shape = API response fields).
- `record`: write SQLite cache + CSV row (matches if jd pass; rejected for any reject). Skips writing when `error` set.
  It only queues the day's jobs.xlsx; the rebuild happens later, off the request path (2.7).
- Errors in ask_* are caught → `error` set → decide_* returns pass with reason "ai_error: ...".

### 2.4 Questions (`questions.py`) — written per Jev best practices
(literal instructions, one judgment per question, numbers in code, short state, boundary cases in criteria)

Shared `ROLE_FAMILY_CRITERIA` (Choice; order matters — keep "unclear" last):
```
ai_ml_engineering   : Builds or improves AI, machine-learning, deep-learning, GenAI/LLM, NLP or computer-vision systems as an engineer or scientist (AI Engineer, ML Engineer, GenAI/LLM Engineer, Data Scientist, MLOps, Applied Scientist).
software_engineering: Builds software as a developer where AI/ML is not the main work (backend, full-stack, Python developer, data engineer, DevOps, QA automation).
data_analytics      : Analyses data or builds reports and dashboards (data analyst, BI analyst) without building ML models.
teaching_training   : Teaches, trains, tutors, mentors or creates course content for students or learners — trainer, instructor, faculty, lecturer, professor, tutor, teaching assistant, curriculum or content developer — even when the subject is AI, ML or Python.
ai_data_annotation  : Labels data, or writes, rates or reviews prompts and model answers to train AI models (AI trainer, AI tutor, data annotator, RLHF or LLM evaluator, prompt rater), usually freelance or contract task work.
internship          : An internship, apprenticeship, trainee or student programme.
research_academic   : Academic or university research position (PhD, postdoc, research fellow, research associate at a university).
non_technical       : Sales, marketing, business development, HR, recruiting, customer support, operations or other non-engineering work.
unclear             : The information given does not make the main type of work clear.
```

TITLE stage — state: `{"job_title", "company", "location"?}` ; questions:
- `role_family` (choice, ROLE_FAMILY_CRITERIA): "Judging only from `job_title` and `company`, what is the main type of work in this job? If the title could reasonably fit two types, choose unclear."
- `seniority` (choice): entry = "Fresher, junior, associate, graduate, trainee or level I"; mid = "No seniority word, or level II"; senior = "Senior, Sr. or level III"; lead_plus = "Lead, staff, principal, architect, manager, head, director or VP". Instruction: "Which seniority level does `job_title` state?"

JD stage — state: `{"job_title", "company", "job_description" (cleaned, max 12000 chars)}` ; questions:
- `role_family` (choice): "According to the responsibilities in `job_description`, what is the main day-to-day work in this job? Judge by what the person will actually do, not by the keywords listed: a job that teaches Python or ML to students is teaching_training even though it mentions Python and ML."
- `skills_match` (score, 6 levels low→high) with instructions object `{"question": "How well do the skills in `candidate_skills` cover the core technical skills that `job_description` requires?", "candidate_skills": [...from profile]}`:
  0 "Almost none of the required core skills are in the candidate's list"
  1 "One or two minor skills overlap, but the core skills are missing"
  2 "Some overlap, but most core skills are missing"
  3 "About half of the core skills are in the candidate's list"
  4 "Most core skills are in the candidate's list; one or two important ones are missing"
  5 "Nearly all core skills are in the candidate's list"
  → match_score (1–10) = round(1 + score * 9 / 5)
- `min_years` (choice) — ONLY asked when experience.py could not parse years from experience_text or the JD:
  "What is the minimum number of years of work experience that `job_description` requires? For a range like 2-5 years, choose the lower number." options: `y0` "Freshers welcome, or 0 years", `y1`…`y7` "N years", `y8_plus` "8 or more years", `not_stated` "No number of years is stated".
- `work_mode` (choice): remote / hybrid / onsite / not_stated — "Where does `job_description` say the work is done?"

### 2.5 Decisions (`decide.py`, profile.yaml values)
```yaml
experience_years: 1            # YOUR years of experience  ← user must set
experience_tolerance: 1        # allow jobs asking up to experience_years + tolerance
avoid_role_families: [teaching_training, ai_data_annotation, internship, research_academic, non_technical]
allowed_seniority: [entry, mid]   # title stage rejects senior / lead_plus (if confident)
min_match_score: 6             # JD stage: reject below this
reject_confidence: 0.6         # only reject on an AI answer whose confidence >= this
skills: [Python, Machine Learning, Deep Learning, NLP, LLM, RAG, LangChain, LangGraph, GenAI, Data Science,
         TensorFlow, PyTorch, Pandas, NumPy, SQL, Data Analysis, Generative AI, FastAPI]
```
Title decision: reject if role_family ∈ avoid (conf ≥ reject_confidence) → reason `role: <family> (<conf>)`;
else reject if seniority ∉ allowed_seniority (conf ≥ reject_confidence) → `seniority: <level> (<conf>)`;
else reject if experience_text parses and min_years > experience_years + tolerance → `needs <min>+ yrs`; else pass.
JD decision (in this order): role_family avoid (confident) → reject; min_years (parsed or AI) > exp + tol → reject;
max_years parsed and max_years < experience_years - tolerance... (ignore when null) → reject `overqualified`;
match_score < min_match_score → reject `skills <score>/10`; else pass.
Overall confidence = min(role_family.confidence, skills_match.confidence).

### 2.6 Provider protocol (`providers/base.py`)
```python
@dataclass
class Answer:
    type: str                    # "choice" | "score" | "noul"
    choice: str | None = None
    score: float | None = None   # level index, may be fractional
    noul: float | None = None
    confidence: float = 0.0
    probabilities: dict | None = None

class Provider(Protocol):
    name: str
    model: str
    async def ask(self, state: dict, questions: dict) -> dict[str, Answer]: ...
```
`questions` uses the **exact Jev wire format**: `{qid: {"type": "choice"|"score"|"noul", "instructions": str|obj, "criteria": ...}}`
- choice criteria: `{option: description}` (≤255) ; score criteria: `[level0, level1, ...]` (2–10) ; noul criteria: `{"true": .., "false": ..}`.

**Jev** (`providers/jev.py`): `POST <JEV_URL>` (TypeSafe `https://api.typesafe.ai/v1/systemone` or OpenCode `https://opencode.ai/inference/v1/systemone` — identical wire format), headers `Authorization: Bearer <key>`,
body `{"state": state, "model": JEV_MODEL, "questions": questions}`. Response `{"model", "answers": {qid: {...}}, "usage"}`.
Choice answer: `{"type":"choice","choice":str,"probabilities":{opt:float},"confidence":float}`;
Score answer: `{"type":"score","score":float,"legend":{"0":..},"probabilities":{"0":float},"confidence":float}`;
Noul answer: `{"type":"noul","noul":float}` (confidence = abs(noul-0.5)*2).
Errors: 401 → raise clear "bad TYPESAFE_API_KEY"; 422 → raise with body; 429/529 → retry with exponential backoff (0.5,1,2,4s; max 4 tries).
Concurrency: asyncio.Semaphore(16). Timeout 20 s.

Jev is the only provider. (The offline test suite was removed after v2 shipped; it is in git history, commit 941c6d6.)

### 2.7 Storage (`store.py`)
SQLite table `jobs(site, job_id, stage, decision, reason, confidence, match_score, role_family, min_years, max_years, work_mode,
title, company, location, link, provider, model, created_at, PRIMARY KEY(site, job_id))` — upsert; JD stage overwrites title stage.
CSV (UTF-8 with BOM so Excel opens it; header written once):
`<site>_matches.csv`: `time, site, job_id, title, company, location, match_score, confidence, role_family, min_years, work_mode, link, provider`
`<site>_rejected.csv`: `time, site, job_id, stage, title, company, reason, confidence, link, provider`
Date folder = local date when the row is written: `OUTPUT_DIR/YYYY-MM-DD/`.

`OUTPUT_DIR/YYYY-MM-DD/jobs.xlsx` (`excel.py`) — what the user opens; the CSVs stay the source of truth (raw log):
- Sheet `Matches`: all sites' matches rows, sorted match_score desc, then confidence desc. Columns:
  `match_score, confidence, title, company, site, location, min_years, work_mode, role_family, link, time, job_id`.
- Sheet `Rejected`: all rejected rows, newest first. Columns: `time, site, stage, title, company, reason, confidence, link, job_id`.
- Each sheet is an Excel Table (filter buttons; no Table when there are no data rows), frozen header, set widths.
  Numbers are numbers, `time` is a datetime, `job_id` is text (leading zeros kept), `link` is a clickable "open"
  hyperlink (http/https only). Every other value is a text cell (never a formula); store.py's CSV formula guard
  (leading `'`) is dropped there, and characters XML 1.0 forbids are removed.
- Rebuilt from scratch, so edits saved in jobs.xlsx are lost (README says: Save As for your own notes).
- When: an appended CSV row only queues its day folder. `Store.keep_workbooks_fresh` (a background task started in
  app.py's lifespan) rebuilds queued folders every 2 s in a worker thread, so a request never waits for a rebuild and
  rows that arrive together share one. Written to `jobs.xlsx.tmp`, then `os.replace` (one rebuild at a time).
- A failed rebuild (jobs.xlsx open in Excel → PermissionError) logs one warning, leaves no temp file, never raises into
  the screening path, and stays queued: retried every 15 s until it succeeds.
- Startup: every day folder whose jobs.xlsx is missing or older than its CSVs is rebuilt before serving.
  Shutdown: one last rebuild for the rows of the last couple of seconds.

---------------------------------------------------------------------------------------------------

## 3. Extension (`extension/`) — Chrome MV3

```
extension/
  manifest.json
  background.js            service worker (section 3.3)
  common/filters.js        pure rule functions + settings defaults (no DOM writes, no clicks, no network)
  sites/linkedin.js        PASSIVE ONLY (section 3.4)
  sites/scraper-core.js    shared scraper engine for glassdoor/naukri/indeed (section 3.5)
  sites/glassdoor.js
  sites/naukri.js          Naukri search-results pages
  sites/naukri-job.js      Naukri job-detail pages (reads JD when opened by the scraper worker)
  sites/indeed.js
  popup/popup.html, popup.js, popup.css
  sidepanel/sidepanel.html, sidepanel.js, sidepanel.css
  icons/ (none required; default icon is fine)
```

### 3.1 manifest.json (exact)
- `"manifest_version": 3`, name "Job Filter v2", version "2.0.0"
- `"permissions": ["storage", "tabs", "scripting", "sidePanel"]`
- `"host_permissions": ["https://www.linkedin.com/*", "https://www.glassdoor.com/*", "https://www.glassdoor.co.in/*", "https://www.naukri.com/*", "https://in.indeed.com/*", "https://www.indeed.com/*", "http://localhost:8765/*", "http://127.0.0.1:8765/*"]`
- `"background": {"service_worker": "background.js"}` (classic, not module)
- `"action": {"default_popup": "popup/popup.html"}`, `"side_panel": {"default_path": "sidepanel/sidepanel.html"}`
- content_scripts (run_at document_idle):
  - linkedin: matches `https://www.linkedin.com/*` → `["common/filters.js", "sites/linkedin.js"]`  (NOTHING else).
    All of LinkedIn, because it is a single-page app: going Feed → Jobs never reloads the page, so a `/jobs/*`-only
    script would never load. Outside `/jobs/` linkedin.js only reads the URL and stays idle (the top-frame copy may clear the side panel, 3.4).
    `"all_frames": true`: since 2026 LinkedIn draws classic job search inside a same-origin frame
    (`/preload/?_bprMode=vanilla`) whose own URL never changes. Every LinkedIn frame gets the script; only the copy
    whose document contains the jobs list / JD acts, and it reads the open job from `window.top.location`.
  - glassdoor: `https://www.glassdoor.com/*`, `https://www.glassdoor.co.in/*` → `["common/filters.js", "sites/scraper-core.js", "sites/glassdoor.js"]`
  - naukri list: `https://www.naukri.com/*` with `"exclude_matches": ["https://www.naukri.com/job-listings-*"]` → `["common/filters.js", "sites/scraper-core.js", "sites/naukri.js"]`
  - naukri job: `https://www.naukri.com/job-listings-*` → `["sites/naukri-job.js"]`
  - indeed: `https://in.indeed.com/*`, `https://www.indeed.com/*` → `["common/filters.js", "sites/scraper-core.js", "sites/indeed.js"]`
- **FORBIDDEN** (stealth): `web_accessible_resources`, `externally_connectable`, `content_security_policy` tweaks.

### 3.2 Settings — `chrome.storage.local` key `"settings"` (defaults live in `common/filters.js` as `JF_DEFAULT_SETTINGS`)
```js
{
  backendUrl: "http://localhost:8765",
  aiEnabled: true,
  global: {                               // applied on ALL sites
    blacklistKeywords: ["teacher","trainer","tutor","instructor","faculty","lecturer","professor","teaching","intern","internship","annotator","annotation"],
    whitelistKeywords: [],                // if non-empty, title must match at least one
    blacklistCompanies: []                // exact, case-insensitive
  },
  linkedin:  { promotedMode: "partial",   // "show" | "hide" | "partial"
               partialScope: "all",       // "all" = every job you click is remembered; "promoted" = only promoted ones
               hideApplied: true, hideDismissed: true, titleAI: true, jdAI: true },
  glassdoor: { hideSaved: true, markProcessed: "all", maxPages: 10 },   // markProcessed: "all" | "rejected" | "none"
  naukri:    { hideSaved: true, hidePromoted: true, markProcessed: "all", maxPages: 10, jdTabs: 2 },
  indeed:    { hideSaved: true, markProcessed: "all", maxPages: 10 }
}
```
Other storage keys (chrome.storage.local):
- `"li_partial"`: `{ items: ["<normTitle>|<company lower>", ...] }` — LinkedIn partial-hide list (no auto-expiry; user keeps/clears)
- `"li_verdicts"`: `{ "<jobId>": {decision, stage, reason, confidence, match_score, t} }` — cap 3000 newest
- `"li_current"`: `{ jobId, title, company, status: "reading"|"scoring"|"done"|"error", verdict?, t }` — side panel renders this
- `"scrape_state"`: `{ running, site, tabId, page, pagesDone, maxPages, startedAt, counts: {seen, ruleHidden, titleRejected, jdRejected, matched, errors}, paused, pauseReason, pageKey, handoffAt }`
  (`tabId` is stamped by background from the message sender — content scripts can't know it; `handoffAt` = time of the last
  "Next page" navigation: the next page's script takes the run over only while it is < 60 s old)
chrome.storage.session: `"li_partial_prompted"` (true after the keep/clear prompt was shown this browser session).
**Never** use the page's `localStorage` / `sessionStorage` / cookies / `document.cookie` from any content script.

`common/filters.js` exports (as globals, since content scripts share scope): `JF_DEFAULT_SETTINGS`, `jfLoadSettings(): Promise<settings>` (deep-merged with defaults),
`jfNormalize(text)`, `jfTitleMatchesKeyword(keyword, normTitle)` (multi-word regex + compressed match, single word = whole word),
`jfCompanyBlacklisted(company, list)`, `jfRuleCheck(title, company, globalSettings) → {hide: bool, reason: "company"|"blacklist:<kw>"|"whitelist"|null}`.

### 3.3 Messages (content ⇄ background) — `chrome.runtime.sendMessage({type, ...})`, background replies via sendResponse (return true)
| type | from | payload | reply |
|---|---|---|---|
| `screenTitle` | any site | `{site, jobs:[job]}` | backend `/screen/title` JSON, or `{error}` |
| `screenJd` | any site | `{site, job}` (job has `jd`) | backend `/screen/jd` JSON, or `{error}` |
| `liHide` | linkedin.js | `{jobIds: [..all ids that must be hidden now..]}` | `{ok}` — background replaces the injected CSS of the sending document/frame (3.4) |
| `liVerdict` | linkedin.js | `{jobId, verdict}` | `{ok}` — background sets badge for that tab |
| `naukriFetchJd` | naukri.js | `{url, jobId}` | `{jd, title, company, experience_text}` or `{error}` — background opens/reuses a minimized worker window (3.5) |
| `naukriWorkerHello` | naukri-job.js | `{}` (sent on load) | `{worker: true, jobId}` if this tab is a scraper worker tab, else `{worker: false}` |
| `naukriJdReady` | naukri-job.js | `{jobId, jd, title, company, experience_text}` or `{jobId, error}` | — |
| `scrapeProgress` | scrapers | `{state}` | — (background mirrors to storage `scrape_state` + badge text = matched count) |
| `health` | popup/sidepanel | `{}` | backend `/health` or `{error}` |
| `stats` | sidepanel | `{}` | backend `/stats` or `{error}` |
Popup → content (chrome.tabs.sendMessage): `{type:"scrapeStart"}`, `{type:"scrapeStop"}`, `{type:"scrapeResume"}`, `{type:"scrapeStatus"}`. LinkedIn content script registers NO onMessage listener.

Background never forwards page data anywhere except the backend URL in settings.

### 3.4 LinkedIn — under the radar (`sites/linkedin.js` + background)
HARD RULES for linkedin.js: no `.click()`, no `dispatchEvent`, no `fetch`/XHR, no `scrollIntoView`/`scrollTo`, no `window.open`,
no DOM writes of any kind (no `style`, no `classList`, no `appendChild`, no attributes), no page storage, no `chrome.runtime.onMessage` listener.
It only READS the DOM and sends messages to background.

- Cards: `li.scaffold-layout__list-item` (job id from `data-occludable-job-id`, fallback inner `[data-job-id]`).
  Title `.job-card-list__title--link` (fallback `a[href*="/jobs/view/"]`), company `.artdeco-entity-lockup__subtitle span`.
  Promoted: any `.job-card-container__footer-item` text includes "Promoted". Applied: `.job-card-container__footer-job-state` includes "Applied".
  Dismissed: card text includes "show you this job again".
- Frames: since 2026 LinkedIn draws classic job search inside a same-origin frame (`/preload/?_bprMode=vanilla`) whose
  own URL never changes. The script runs in every LinkedIn frame (all_frames). A copy STARTS only when the address bar
  (`window.top.location`, same-origin, read-only) shows `/jobs/` AND its own document holds the jobs UI (list / card /
  JD selectors); only then does it load settings + li_verdicts and listen to storage changes (idle frames just poll the
  URL). "Shows the jobs UI" = the UI is in this document AND this frame is on screen (read-only size check of
  `window.frameElement`), so a hidden frame with a stale list never acts. Only a copy that shows it RIGHT NOW
  (`ownsPanel`) writes the side panel / badge (li_current, liVerdict); a write it had to skip during a brief re-render is
  redrawn once it shows the UI again. A running copy goes DORMANT after ~3.5 s (5 polls) without showing the jobs UI
  (drops its own hide CSS, leaves the side panel alone). An empty card list never sends an empty hide set (re-render:
  the CSS stays). When the address bar is off `/jobs/` for 2 polls in a row, the running copy stops and clears the panel;
  independently, the top-frame copy clears the side panel + badge once the address bar (URL only, never the DOM) has
  named no open job for 2 polls in a row (the jobs frame may already be gone; 2 polls so a quick bounce away and back
  can't blank it).
- Current job: `currentJobId` query param of the ADDRESS BAR (`window.top.location`; own `location` only if top is
  cross-origin, then the detail title link id) — polled every 700 ms, reading it is invisible ;
  detail title `.job-details-jobs-unified-top-card__job-title` (fallback `.t-24`, `h1`), company `.job-details-jobs-unified-top-card__company-name`,
  JD `#job-details` (fallback `.jobs-description__content`, `.jobs-description-content__text`, `.jobs-box__html-content`).
  JD is "ready" when its text length ≥ 200 and unchanged for 600 ms, and the detail title matches the clicked card (or 8 s timeout).
- Hiding = background `chrome.scripting.insertCSS({target:{tabId, documentIds:[sender.documentId]}, css, origin:"USER"})` with
  `li[data-occludable-job-id="ID"], li.scaffold-layout__list-item:has([data-job-id="ID"]) {display:none !important}` for every id;
  i.e. into the exact document (frame) that sent liHide. Before inserting the new CSS, `removeCSS` the previous string for that
  document (records in storage.session `li_css_<tabId>` → `{<documentId>: css}`, newest 6 documents per tab).
  Injected user stylesheets are not part of the page DOM / `document.styleSheets`. NO fallback to inline styles.
- Hide set = ids hidden by RULES ∪ title-AI rejects ∪ JD-AI rejects (from li_verdicts) ∪ partial-list matches — EXCEPT the currently open job
  (never hide the job the user is looking at; it gets hidden after the user opens another job).
- Partial hide: when the current job changes to X (user clicked it), if promotedMode=="partial" and (partialScope=="all" or X is promoted)
  → add `normTitle|company` of X to `li_partial`. Every card whose key is in li_partial is hidden (except the open one).
  promotedMode "hide" hides all promoted; "show" ignores promotion.
- Title AI: debounce 800 ms after cards change; send unseen visible non-rule-hidden cards (max 25 per call) via `screenTitle`; store verdicts in li_verdicts.
- JD AI: when job X is open and JD ready and no JD verdict cached → `li_current.status="scoring"`, send `screenJd`; store verdict; send `liVerdict`.
- Badge (background): pass → text = match score (e.g. "8"), green `#1a7f37`; reject → "✕" red `#cf222e`; scoring → "…" grey; cleared when no job open.
- Side panel shows `li_current` (title, company, decision, score, confidence, reason, stage) live via storage.onChanged,
  partial-list size + **Keep / Clear** buttons (prompted once per browser session when list non-empty), and today's stats.

### 3.5 Scrapers (glassdoor / naukri / indeed) — `sites/scraper-core.js`
`JFScraper` engine, configured by each site file with an adapter:
```js
{ site: "naukri",
  findCards(): Element[],                    // cards currently in the DOM
  readCard(el): {job_id, title, company, location, experience_text, link, isSaved, isPromoted} | null,
  hideCard(el), highlight(el, "active"|"pass"|"reject"|"skip"),
  markProcessed(el): Promise<void>,          // click the site's own save/bookmark button if not saved
  fetchJd(job): Promise<string>,             // full JD text ('' if unavailable)
  nextPage(): Promise<"same-page"|"navigating"|"none">,   // load more on same page, or navigate to next URL
  detectBlock(): string|null }               // captcha / login wall / cloudflare text → pause reason
```
Engine loop (state persisted in `scrape_state` so it resumes after page navigation): wait for cards → for each new card:
rules → hide; collect remaining → `screenTitle` in batches of ≤20 → rejects: hide + markProcessed(if markProcessed in {all,rejected});
passes (not `final`) → for each, sequentially with polite random delay 0.8–2.0 s: `fetchJd` → `screenJd` → hide card, highlight,
markProcessed(if "all", or "rejected" and rejected) → counts → `scrapeProgress`. Already-final cached jobs are hidden & skipped.
After the page: random delay 2–4 s → `nextPage()`; stop at `maxPages`, "none", user stop, or `detectBlock()` → `paused` with reason
(user solves captcha/login themselves, then presses Resume). Never try to solve or bypass a captcha/challenge.
On page load each site file calls `JFScraper.resumeIfRunning(adapter)` which continues when `scrape_state.running && site matches && tabId matches`.

Site specifics (verified live 2026-10-14 unless noted):
- **Naukri list** (`www.naukri.com/<keyword>-jobs[-N]`): card `.srp-jobtuple-wrapper[data-job-id]`; title `a.title` (attr `title`, href = job page);
  company `a.comp-name`; experience `.expwdth` (e.g. "3-8 Yrs"); location `.locWdth`; saved = `.ni-job-tuple-icon-srpSaveFilled` exists;
  save button `span.save-job-tag` (unsaved has class `un-saved`); promoted wrapper `.cust-job-tuple.srp-tuple.checkbox` (hide its `section`);
  next page = pagination `a` whose text is "Next" (href like `/ai-engineer-jobs-2`) → `location.href = href`; disabled/missing → "none".
  JD: the job page is an app shell; its JD API requires reCAPTCHA (do NOT call it). So `fetchJd` sends `naukriFetchJd` → background
  opens the job URL in a dedicated **minimized worker window** (create once, `focused:false, state:"minimized"`; up to `jdTabs` tabs, reuse them),
  naukri-job.js on that page waits for the JD, replies `naukriJdReady`, background resolves and navigates the tab to the next URL (or about:blank).
  Timeout 25 s → `{error:"timeout"}`. Close the worker window when scraping stops.
- **Naukri job page** (`/job-listings-*`): only acts when background says this tab is a worker tab (naukri-job.js sends `{type:"naukriWorkerHello"}` and
  background replies `{worker:true, jobId}`) — when opened by the user normally it does nothing.
  JD `[class*="JDC__dang-inner-html"]` (fallback `[class*="job-desc-container"]`); title `[class*="jd-header-title"]`;
  company `[class*="jd-header-comp-name"] a` (fallback first text of `[class*="jd-header-comp-name"]`); experience `[class*="jhc__exp"]`;
  key skills section (append to JD) `[class*="key-skill"]` text if present.
- **Indeed** (`in.indeed.com/jobs?...`): card `li.css-1ac2h1w` containing `a.jcs-JobTitle` (skip cards whose `.cardOutline` has aria-hidden="true");
  job id = `a.jcs-JobTitle[data-jk]`; title `a.jcs-JobTitle span[title]` (attr `title`); company `[data-testid="company-name"]`;
  location `[data-testid="text-location"]`; saved = `button.bookmark[aria-pressed="true"]`; save = click `button.bookmark` if aria-pressed false;
  link = `${location.origin}/viewjob?jk=${jk}`; JD = `fetch('/viewjob?jk=JK', {credentials:'include'})` → DOMParser →
  `script[type="application/ld+json"]` JobPosting `.description` (HTML → text), fallback `#jobDescriptionText`;
  next = `a[data-testid="pagination-page-next"]` href → navigate. Block: title/body contains "Just a moment", "Verify you are human", "captcha".
- **Glassdoor** (`glassdoor.co.in|com/Job/...`; selectors from the existing working extension, NOT re-verified live because of a Cloudflare check):
  card `li[data-test="jobListing"]` (id `data-jobid`); title `a[data-test="job-title"]` (href = job page); company `span[class*="EmployerProfile_compactEmployerName"]`
  (fallback `[class*="EmployerProfile_employerName"]`); location `[data-test="emp-location"]`; saved = `button[data-test="save-job"][aria-label="Saved"]`;
  save = click that button; JD = `fetch(titleHref)` → DOMParser → JSON-LD JobPosting `.description` first, then `[class*="JobDetails_jobDescription"]`,
  `[data-test="jobDescriptionContent"]`, `[class*="jobDescription"]`; next = `button[data-test="load-more"]` (same page; wait ≤10 s for more cards) → "same-page", none → "none";
  also close a login/signup modal if it blocks (`[data-test="authModalContainerV2-content"]` / button `.CloseButton`) — if it can't be closed, pause with reason "login wall".
- Highlights on scraper sites (fine there): active = yellow outline, pass = green, reject = red then hidden after 600 ms, skip = grey.

### 3.6 Popup
Tabs: **Filters** (global blacklist/whitelist/companies textareas, comma separated), **LinkedIn**, **Glassdoor**, **Naukri**, **Indeed**, **AI**.
- Each site tab: its toggles from settings. Glassdoor/Naukri/Indeed tabs: Start / Stop / Resume buttons + live counts from `scrape_state`
  (Start only enabled when the active tab is that site's search page). LinkedIn tab: NO scrape button at all; "Open side panel" button
  (`chrome.sidePanel.open({tabId})` from the click handler), partial list count + Clear.
- AI tab: backend URL, AI on/off, backend health + provider/model (via `health` message), link text "Results (jobs.xlsx + CSV files) are in AI-Based-Job-Filter/backend/output/<today>/".
- Save writes `settings`; content scripts react via `chrome.storage.onChanged`.
