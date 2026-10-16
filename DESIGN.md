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
  → [2] TITLE    (backend /screen/title): repost of a (title, company) already screened in this site group → hidden,
                 no AI (2.2); else card years by regex (free, before any AI call) → reject (+ seniority words,
                 only when profile.yaml sets the optional allowed_seniority — off by default, 2.5);
                 else AI role type from title + company → pass | reject
  → [3] JD AI    (backend /screen/jd):    title + company + cleaned job description    → pass | reject
  → pass  → row appended to backend/output/<date>/<site>_matches.csv
  → every reject (title or jd) → row appended to backend/output/<date>/<site>_rejected.csv (for debugging drift)
  → a couple of seconds later: backend/output/<date>/jobs.xlsx rebuilt from that day's CSVs (section 2.7)
```

Golden rule from the drift discussion: **the AI answers simple questions; plain code makes the decisions.**
Numbers (years of experience) are compared in code, never by the model; seniority words (an optional filter, off by
default) are read by a regex.
**Position first:** a job is rejected for being the wrong TYPE of job (profile.yaml `target_role_families`), never
for its skills (skills can be learned); skills only feed the match score that sorts jobs.xlsx.

---------------------------------------------------------------------------------------------------

## 2. Backend (`backend/`)

Python 3.11. Run: `uvicorn app:app --port 8765` from `backend/`. Port **8765** (old project used 8000; keep them apart).

Files:
```
backend/
  app.py              FastAPI app + endpoints (section 2.2)
  graph.py            LangGraph graph (section 2.3) — must read top-to-bottom like a story
  questions.py        THE PROMPT: all question definitions for title + JD stages (section 2.4)
  decide.py           pure-code decisions (role probabilities, experience comparison, scores, optional seniority regex) — no AI here
  experience.py       regex parser: "3-8 Yrs", "2+ years", "minimum 3 years", "0-1 years", "fresher" → (min,max)
  dedupe.py           repost key (normalized title|company) + site groups (section 2.2); company_name() also used by clean_jd
  store.py            SQLite cache + repost lists (data/jobs.db) + CSV writer (output/<date>/...) + keeps jobs.xlsx up to date
  excel.py            jobs.xlsx builder (openpyxl): the day's CSVs as sortable Excel tables (section 2.7)
  providers/
    __init__.py       get_provider(): always Jev
    base.py           Provider protocol + Answer dataclass
    jev.py            TypeSafe Jev REST provider (httpx, async)
  config.py           JEV_URL / JEV_MODEL constants + pydantic-settings (backend/.env holds only JEV_API_KEY)
  profile.yaml        candidate profile (skills, experience, wanted role types, reject_confidence, optional seniority)
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

`GET /health` → `{"ok": true, "provider": "jev", "model": "<model id>", "profile": {"experience_years": n, "target_role_families": [..]}}`

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
                 "match_score": null,            // title stage never scores (a cached JD verdict may carry one)
                 "stage": "title" | "jd",        // stage the decision came from
                 "cached": true|false,           // true = came from SQLite, no AI call
                 "final": true|false,            // true = JD stage already done earlier → extension skips JD fetch
                 "duplicate": true|false } ] }   // true = repost of another job (see below): hide, no JD
```
- Results come back in the same order as `jobs`. Jobs are processed concurrently (asyncio.gather, provider-limited).
- Per job, in this order (steps 1–3 run with no `await` in between, so two copies in one batch dedupe too):
  1. Cache: if (site, job_id) already has a JD-stage verdict → return it with `cached:true, final:true`.
     If it has a title-stage verdict → return it with `cached:true, final:false` (reject stays reject; pass → extension continues to JD).
     Exception: a cached `seniority: <level>` reject that the current profile no longer makes (allowed_seniority
     removed, or that level added; `decide.outdated_seniority_reject`, 2.5) is ignored → the job goes on to step 2.
  2. Reposts (`dedupe.py`): group = naukri → `"naukri"`; glassdoor and indeed → `"glassdoor_indeed"` (one shared list:
     Glassdoor merged into Indeed on 2026-07-01, a third of Glassdoor's jobs also show on Indeed); linkedin → none.
     key = normalized title + `|` + normalized company (lowercase, punctuation → space, spaces collapsed; trailing company
     suffixes pvt/private/ltd/limited/inc/llp/llc/corp/corporation/co/company/technologies/technology/solutions/india/
     plc/pte/gmbh/opc stripped, at least one word kept). No key when title or company is empty. If the key is held by a
     DIFFERENT (site, job_id) → `{job_id, decision:"reject", reason:"repost of <site> <job_id>", confidence:1.0,
     stage:"title", cached:true, final:true, duplicate:true, match_score:null}` — no AI call, no CSV row, not cached
     (so clearing the list brings it back).
  3. Else the job claims the key (INSERT before the AI runs) and the title stage runs.
- Provider failure for one job → that job returns `decision:"pass", reason:"ai_error: ..."`, confidence 0 (never hide on error).
  Not cached (its key stays claimed by it, so the retry of that same job is screened normally).

`POST /screen/jd`
```json
{ "site": "...", "job": { "job_id": "...", "title": "...", "company": "...", "location": "?", "experience_text": "?",
                          "link": "?", "jd": "full job description text" } }
```
→
```json
{ "job_id": "str", "decision": "pass" | "reject", "reason": "str, e.g. 'position 5/5, skills 3/5'",
  "match_score": 0-10 | null, "position_score": 0-5 | null, "skills_score": 0-5 | null, "confidence": 0.0-1.0,
  "role_family": "str|null", "min_years": int|null, "max_years": int|null, "work_mode": "str|null",
  "cached": bool, "saved_to_csv": bool, "stage": "jd", "final": true }
```
(`position_score` / `skills_score` are null for verdicts cached before they existed; such an old `match_score` is the
old 1–10 skills score.)
- If (site, job_id) already has a JD verdict → return cached, do NOT write CSV again.
- Empty/too-short JD (< 200 chars) → run title-only logic again and return `decision:"pass", reason:"no_jd"` with
  match_score null, and do NOT cache as final (so a later run can retry).
- Provider failure → `decision:"pass", reason:"ai_error: ..."`, not cached, not written.

`GET /stats` → `{"date": "YYYY-MM-DD", "sites": {"naukri": {"matches": n, "rejected": n}, ...}}` for today
(set-aside `.before-HHMMSS` CSVs included, 2.7).

`POST /dedupe/clear` `{"group": "naukri" | "glassdoor_indeed"}` → `{"cleared": n}` — empties that repost list
(any other group → 422). The popup's "Clear repost list" button.

### 2.3 LangGraph (`graph.py`)

One compiled graph, state is a TypedDict:
```
JobState: site, stage ("title"|"jd"), job (dict), answers (dict|None), verdict (dict|None), error (str|None)
```
Nodes (each a small async function with a docstring):
```
START ─route─┬─ stage=="title" → check_title ─ok─→ ask_title → decide_title ─┐
             │                         └─ too many years / too senior* ──────┤
             └─ stage=="jd"    → ask_jd ───────────────────→ decide_jd ─────┴→ record → END
                                          * only when profile.yaml sets allowed_seniority (off by default)
```
- `check_title`: `decide.check_title_words` — the card's experience_text and, only when `allowed_seniority` is set,
  the seniority regex on the title (2.5). Both are certain, so a reject goes straight to `record` (CSV row + cache
  like any reject) and the AI is not asked. Nothing found → `ask_title`.
- `ask_title` / `ask_jd`: build state + questions from `questions.py`, call `provider.ask(state, questions)`.
- `decide_title` / `decide_jd`: call pure functions in `decide.py` → verdict dict (shape = API response fields).
- `record`: write SQLite cache + CSV row (matches if jd pass; rejected for any reject). Skips writing when `error` set.
  It only queues the day's jobs.xlsx; the rebuild happens later, off the request path (2.7).
- Errors in ask_* are caught → `error` set → decide_* returns pass with reason "ai_error: ...".
- Before the graph, in app.py: the cache lookup, the repost check (2.2) and the "JD too short" fallback.

### 2.4 Questions (`questions.py`) — written per Jev best practices
(literal instructions, one judgment per question, numbers in code, short state, boundary cases in criteria)
Jev is paid per input token, so the state is short and the role list (sent with EVERY title call) is terse.

Shared `ROLE_FAMILY_CRITERIA` (Choice; order matters — keep "unclear" last; each ≤ 255 chars):
```
ai_ml_engineering : Builds, trains, fine-tunes or deploys AI/ML models or LLM apps (RAG, AI agents) as the core work: AI, ML, GenAI, LLM, NLP or computer-vision engineer, MLOps.
data_science      : Data scientist who builds statistical or ML models (prediction, forecasting, experiments), not mainly reports.
data_engineering  : Data pipelines, ETL, data warehouses, big-data platforms (Spark, Airflow, Kafka): data engineer.
backend_software  : Software, backend, full-stack, web or mobile development (Node.js, PHP, Java, .NET, Python web, React), even if it calls an AI API.
data_analytics    : Data, business or BI analyst, SQL developer or SQL engineer, MIS: reports, dashboards, Excel, Power BI, SQL queries.
qa_testing        : Software testing, QA, SDET, test automation.
devops_cloud_it   : DevOps, cloud, SRE, infrastructure, networking, sysadmin, DBA, IT support, cybersecurity (MLOps is ai_ml_engineering).
other_engineering : Other engineering: embedded, hardware, VLSI, mechanical, civil, electrical, ERP/SAP.
teaching_training : Teaches, trains or tutors students or learners, or writes course content (trainer, faculty, lecturer), even about AI or Python.
ai_data_annotation: Labels data or writes/rates prompts and model answers to train AI (AI trainer, AI tutor, annotator, RLHF/LLM evaluator).
internship        : Internship, apprenticeship, trainee or student programme.
research_academic : University research post (PhD, postdoc, research fellow).
non_technical     : Sales, marketing, HR, recruiting, support, operations, product or project management, other non-engineering work.
unclear           : The information given does not make the main type of work clear.
```

TITLE stage — only for jobs the free code checks let through (2.3) — state: `{"job_title", "company"}` (location and
the card's experience text say nothing about the type of work; code reads the experience text) ; ONE question
(seniority is never asked: it is an optional regex in decide.py, 2.5), built once from profile `target_role_families`
(`questions.title_questions`):
- `role_family` (choice, ROLE_FAMILY_CRITERIA): "Judging only from `job_title` and `company`, what is the main type of work in this job? If the title could reasonably fit one of ai_ml_engineering, data_science, data_engineering and also another type (such as "Backend AI Engineer" or "Data Scientist/Analyst"), choose unclear."
  (unclear is neither wanted nor unwanted → the JD stage decides. The rule names the wanted types on purpose: a
  title between two UNWANTED types, e.g. "QA / DevOps Engineer", gets real answers and its summed p_unwanted rejects
  it here instead of paying for a JD call.)

JD stage — state: `{"job_title", "company", "job_description" (cleaned, max 6000 chars)}` ; questions:
- `role_family` (choice): "According to the responsibilities in `job_description`, what is the main day-to-day work in this job? Judge by what the person will actually do, not by the job title or the keywords listed: teaching Python or ML to students is teaching_training; building LLM apps, RAG pipelines or AI agents is ai_ml_engineering, but a web or backend app that only calls an AI API is backend_software; a "data scientist" job that is mostly reports, dashboards and SQL queries is data_analytics."
- `skills_match` (score, 6 levels low→high) with instructions object `{"question": "How well do the skills in `candidate_skills` cover the core technical skills that `job_description` requires?", "candidate_skills": [...from profile]}`:
  0 "Almost none of the required core skills are in the candidate's list"
  1 "One or two minor skills overlap, but the core skills are missing"
  2 "Some overlap, but most core skills are missing"
  3 "About half of the core skills are in the candidate's list"
  4 "Most core skills are in the candidate's list; one or two important ones are missing"
  5 "Nearly all core skills are in the candidate's list"
  → skills_score (0–5) = the level, rounded half up (see 2.5)
- `min_years` (choice) — ONLY asked when experience.py could not parse years from experience_text or the JD:
  "What is the minimum number of years of work experience that `job_description` requires? For a range like 2-5 years, choose the lower number." options: `y0` "Freshers welcome, or 0 years", `y1`…`y7` "N years", `y8_plus` "8 or more years", `not_stated` "No number of years is stated".
- `work_mode` (choice): remote / hybrid / onsite / not_stated — "Where does `job_description` say the work is done?"

JD cleaning (`clean_jd(jd, company)`, before the JD goes into the state): collapse whitespace; drop SENTENCES (split
at ". " "! " "? " inside each line) that are pure boilerplate — EEO / equal-opportunity statements, site buttons
("Apply now", "Easy Apply", "Share this job", "Read more", a bare "Privacy Policy" link, ...), cookie / privacy / terms
NOTICES (the notice wording: "we use cookies", "cookie settings", "accept our privacy policy" — not the topic, so "join
cookie data" or "follow our privacy policy" in a duty stays), recruitment-fraud warnings; drop the employer blurb
from its heading to the end when the heading is in the second half and nothing after it talks about the job —
headings: "About us / the company / our company / the organisation", "Who we are", "Company overview / profile /
description", "Our company", or "About <name>" when <name> is the job's company (`dedupe.company_name`, suffixes
stripped); any other "About ..." ("About your work", "About the project") is job content and stays. Cap at 6000
chars. Safety: a sentence that mentions responsibilities, requirements, qualifications, skills, "N years",
"experience in/with/of", a degree, "you will" or duties is never dropped; a "sentence" > 500 chars (text without full
stops) is never dropped; if the result is < 200 chars the uncleaned (whitespace-collapsed) text is used.

### 2.5 Decisions (`decide.py`, profile.yaml values)
```yaml
experience_years: 1            # YOUR years of experience  ← user must set
experience_tolerance: 2        # allow jobs asking up to experience_years + tolerance
target_role_families: [ai_ml_engineering, data_science, data_engineering]   # the ONLY wanted role types
reject_confidence: 0.6         # reject on the role only when p_unwanted >= this
skills: [Machine Learning, Deep Learning, ..., Python, PyTorch, LangChain, FastAPI, MLOps, Git]
# allowed_seniority: [entry, mid]   # OPTIONAL seniority filter (regex below); absent (the shipped profile) or [] = off
```
config.py validates at startup: `target_role_families` non-empty and only known families (not "unclear" — it is
neither wanted nor unwanted); `allowed_seniority` optional (default `[]`), when given ⊆ {entry, mid, senior, lead_plus};
unknown keys fail; the removed keys `avoid_role_families` / `min_match_score` fail with a message saying what replaced
them.

**Seniority is off by default** (2026-10-16, the user's call: "Senior / Lead / Manager" titles are skipped by hand when
applying, not hidden). Without `allowed_seniority` (or with `[]`) no job is ever rejected for its seniority and the
regex is not run; years of experience still reject (card, JD). Cached `seniority: <level>` rejects from before are
screened again when such a job comes back (2.2 step 1); a repost of one (other job id) stays hidden as a repost until
that repost list is cleared.

Role probabilities (both stages): p_wanted = Σ role_family probabilities over target families; p_unwanted = Σ over
every family that is neither a target nor "unclear" (so "backend 0.40 + data_analytics 0.25" = 0.65 rejects although
no single family reaches 0.6). No probabilities from the provider → {choice: confidence}.
Seniority (only when `allowed_seniority` is set; title stage, regex on the title, checked top-down; whole words with
"not a letter" on both sides instead of `\b`, so "IN_Senior Associate_Data Science" counts): lead_plus = lead|leader|
principal|staff|architect|manager(s)|head|director|vp|avp|svp|evp|vice president|chief; senior = senior|sr(.)|iii|iv
(grades: "Data Scientist III"; not "L3"/"L4", which mean different levels at different companies); entry = junior|jr|
fresher(s)|graduate|trainee|associate|entry level; else mid. ("Senior Associate" → senior, "Associate Director" →
lead_plus.)

Title decision, in this order:
1. Before the AI (`check_title_words`, free): only when `allowed_seniority` is set, reject if seniority ∉
   allowed_seniority → `seniority: <level>` (confidence 1.0); else reject if experience_text parses and min_years >
   experience_years + tolerance → `needs <min>+ yrs` (1.0). These rejects have role_family null.
2. After the AI (`decide_title`): reject if p_unwanted ≥ reject_confidence → reason
   `role: <most likely unwanted family> (<p_unwanted>)`, confidence p_unwanted; else pass
   `title ok: <choice> (wanted <p_wanted>)`, confidence = role confidence.
So with the filter on, a job that is both too senior and an unwanted type is rejected as `seniority: ...` (a reject
either way); with it off (default), "Senior Data Scientist" / "Lead AI Engineer" go to the role question like any title.
JD decision (in this order): p_unwanted ≥ reject_confidence → reject `role: ...`; min_years (parsed, or AI when
confident) > exp + tol → reject; max_years parsed and max_years < experience_years - tolerance → reject `overqualified`;
else pass `position <p>/5, skills <s>/5`. **No skills reject.**
position_score = round_half_up(5 × p_wanted) (0–5); skills_score = skills level (0–5); match_score = position + skills
(0–10, set on JD rejects too). Overall confidence = min(role_family.confidence, skills_match.confidence).

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
title, company, location, link, provider, model, created_at, position_score, skills_score, PRIMARY KEY(site, job_id))` —
upsert; JD stage overwrites title stage.
SQLite table `seen_keys(grp, key, site, job_id, first_seen, PRIMARY KEY(grp, key))` — the repost lists (2.2).
Migration at startup (an older data/jobs.db): `CREATE TABLE IF NOT EXISTS` for both tables, then `ALTER TABLE jobs ADD
COLUMN` for position_score / skills_score when missing (old rows: NULL). Nothing is dropped or rewritten; seen_keys starts
empty (old verdicts are not back-filled into it — they were made under the old rules).
CSV (UTF-8 with BOM so Excel opens it; header written once):
`<site>_matches.csv`: `time, site, job_id, title, company, location, match_score, position_score, skills_score, confidence, role_family, min_years, work_mode, link, provider`
`<site>_rejected.csv`: `time, site, job_id, stage, title, company, reason, confidence, link, provider`
Date folder = local date when the row is written: `OUTPUT_DIR/YYYY-MM-DD/`.
Header change: before appending, an existing non-empty file whose header differs from these columns is renamed to
`<site>_<kind>.before-HHMMSS.csv` (`-2`, `-3` if taken) and a fresh file is started — rows never go under a
mismatched header. jobs.xlsx and /stats still read the renamed files.

`OUTPUT_DIR/YYYY-MM-DD/jobs.xlsx` (`excel.py`) — what the user opens; the CSVs stay the source of truth (raw log):
- Reads EVERY `<site>_matches*.csv` / `<site>_rejected*.csv` of the day (incl. `.before-HHMMSS`) by column NAME;
  a column a file doesn't have is an empty cell.
- Sheet `Matches`: all sites' matches rows, sorted match_score desc, then position_score desc. Columns:
  `match_score, position_score, skills_score, confidence, title, company, site, location, min_years, work_mode, role_family, link, time, job_id`.
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
  icons/ (none required; default icon is fine; the notification icon is an inline data: PNG in background.js)
```

### 3.1 manifest.json (exact)
- `"manifest_version": 3`, name "Job Filter v2", version "2.1.0"
- `"permissions": ["storage", "tabs", "scripting", "sidePanel", "notifications"]` (notifications: scraper pause / finish, 3.5)
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
  glassdoor: { hideSaved: true, markProcessed: "all", maxPages: 10, jdParallel: 3 },   // markProcessed: "all" | "rejected" | "none"
  naukri:    { hideSaved: true, hidePromoted: true, markProcessed: "all", maxPages: 10, jdTabs: 2 },
  indeed:    { hideSaved: true, markProcessed: "all", maxPages: 10, jdParallel: 3 }
}
```
`jdParallel` (Glassdoor / Indeed) and `jdTabs` (Naukri, one worker tab each) = how many job pages are read at the same
time ("lanes", 3.5); the engine clamps them to 1–4.
Other storage keys (chrome.storage.local):
- `"li_partial"`: `{ items: ["<normTitle>|<company lower>", ...] }` — LinkedIn partial-hide list (no auto-expiry; user keeps/clears)
- `"li_verdicts"`: `{ "<jobId>": {decision, stage, reason, confidence, match_score, t} }` — cap 3000 newest
- `"li_current"`: `{ jobId, title, company, status: "reading"|"scoring"|"done"|"error", verdict?, t }` — side panel renders this
- `"scrape_state"`: `{ running, site, tabId, page, pagesDone, maxPages, startedAt, counts: {seen, ruleHidden, titleRejected, jdRejected, matched, duplicates, errors}, paused, pauseReason, waitReason, waitUntil, pageKey, handoffAt }`
  (`tabId` is stamped by background from the message sender — content scripts can't know it; `handoffAt` = time of the last
  "Next page" navigation: the next page's script takes the run over only while it is < 60 s old; `duplicates` = reposts
  hidden; `waitReason` = e.g. `"waiting 60s (site rate limit)"` and `waitUntil` = its end (ms) while all lanes back off,
  else null — cleared by pause / stop / end / Resume)
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
| `scrapeProgress` | scrapers; popup (Stop when the scraping page can't be reached: state with `running:false, pauseReason:"stopped by user"`) | `{state}` | — (background mirrors to storage `scrape_state` + badge text = matched count, green; red `!` while `paused`) |
| `health` | popup/sidepanel | `{}` | backend `/health` or `{error}` |
| `stats` | sidepanel | `{}` | backend `/stats` or `{error}` |
| `dedupeClear` | popup | `{group: "naukri" \| "glassdoor_indeed"}` | backend `POST /dedupe/clear` → `{cleared}`, or `{error}` (other groups refused without a request; works with AI off) |
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
  fetchJd(job): Promise<{jd, blocked}>,      // jd = full JD text ('' if unavailable); blocked = null, or the pause
                                             //   message when the job page was a rate limit / check page (403/429/503/challenge)
  nextPage(): Promise<"same-page"|"navigating"|"none">,   // load more on same page, or navigate to next URL
  detectBlock(): string|null }               // captcha / login wall / cloudflare text ON THE RESULTS PAGE → pause reason
```
Engine loop (state persisted in `scrape_state` so it resumes after page navigation): wait for cards → for each new card:
rules → hide; collect remaining → `screenTitle` in batches of ≤20 →
- `duplicate: true` (a repost, 2.2) → hide the card at once, `counts.duplicates` +1, `data-jf-state="duplicate"`; NO JD,
  NO markProcessed (it is not a job we judged);
- rejects and already-final cached jobs → highlight / hide + markProcessed(if markProcessed in {all,rejected} / "all");
- passes (not `final`) → the JD stage in **lanes**: `jdParallel` (Glassdoor / Indeed, default 3) or `jdTabs` (Naukri,
  default 2), clamped 1–4. The lanes share one queue (`shift()`, so no job is read twice); each lane reads one job at a
  time: polite random gap **300–900 ms** → `fetchJd` → `screenJd` → hide card, highlight, markProcessed(if "all", or
  "rejected" and rejected; then **150–400 ms** gap) → counts → `scrapeProgress`.
After the page: random delay **1–2 s** → `nextPage()`; stop at `maxPages`, "none", user stop, or `detectBlock()` → `paused`
with reason (user solves captcha/login themselves, then presses Resume). Never try to solve or bypass a captcha/challenge.
On page load each site file calls `JFScraper.resumeIfRunning(adapter)` which continues when `scrape_state.running && site matches && tabId matches`.

Rate-limit back-off (a job page answered 403 / 429 / 503 / a check page = `fetchJd` returned `blocked`): do NOT pause yet.
A NEW block sets `waitReason "waiting 30s (site rate limit)"` + `waitUntil` and EVERY lane waits (also lanes that were in
their gap) before its next job page; the blocked lane then retries the SAME job. Still blocked → 60 s, then 120 s; blocked
after the third wait → pause with `"Still blocked after waiting 30, 60, 120 seconds. <adapter message>"`. A job page that
answers normally resets the level to 30 s. "New" = the request started after the last block was handled: blocks and
successes of requests that were already under way then belong to that burst (they join the wait; they don't escalate or
reset). Waits poll every 0.2 s, so Stop / Pause end even a 120 s wait at once. A blocked job is never finished, hidden
or counted as an error; after a pause, Resume starts the waits from 30 s again and retries it. A captcha / login wall on
the RESULTS page still pauses at once (`detectBlock`). Errors: 3 errors in a row (title / JD AI errors, unreadable JD;
counted across all lanes in completion order) → pause; the first pause reason wins and the other lanes stop.

Notifications (background, `chrome.notifications`, one id `"jf-scrape"` so a new one replaces the last): when
`scrape_state` of glassdoor / naukri / indeed becomes `paused` → "Job Filter: <Site> paused" + the reason; when `running`
goes true → false for any reason except "stopped by user" → "Job Filter: <Site> finished" + `"<reason> · N pages. X
matched, Y rejected by AI, Z reposts hidden, R hidden by rules[, E errors]."`. Never for LinkedIn. Clicking it focuses
the scraping tab. The toolbar badge of the scraping tab shows a red `!` while paused.

Site specifics (verified live 2026-10-14 unless noted):
- **Naukri list** (`www.naukri.com/<keyword>-jobs[-N]`): card `.srp-jobtuple-wrapper[data-job-id]`; title `a.title` (attr `title`, href = job page);
  company `a.comp-name`; experience `.expwdth` (e.g. "3-8 Yrs"); location `.locWdth`; saved = `.ni-job-tuple-icon-srpSaveFilled` exists;
  save button `span.save-job-tag` (unsaved has class `un-saved`); promoted wrapper `.cust-job-tuple.srp-tuple.checkbox` (hide its `section`);
  next page = pagination `a` whose text is "Next" (href like `/ai-engineer-jobs-2`) → `location.href` = that path WITH the
  current query string (`naukriNextUrl`: the bare link drops the search filters); disabled/missing → "none".
  JD: the job page is an app shell; its JD API requires reCAPTCHA (do NOT call it). So `fetchJd` sends `naukriFetchJd` → background
  opens the job URL in a dedicated **minimized worker window** (create once, `focused:false, state:"minimized"`; up to `jdTabs` tabs (max 4), reuse them),
  naukri-job.js on that page waits for the JD, replies `naukriJdReady`, background resolves and navigates the tab to the next URL (or about:blank).
  Timeout 25 s → `{error:"timeout"}`; a captcha / "Access Denied" job page → `{error:"blocked"}` → `fetchJd` returns `blocked`
  (back-off above). Close the worker window when scraping stops.
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
  (seen, rules hid, title rejected, JD rejected, matched, reposts (= `duplicates`), errors; Start only enabled when the
  active tab is that site's search page); status line "Running · waiting 60s (site rate limit), retry at <time> · …"
  during a back-off; "Job pages read at once" (`jdParallel`, 1–4) on Glassdoor / Indeed ("Job pages open at once" =
  `jdTabs` on Naukri); a **Reposts** box with "Clear repost list" → `dedupeClear` (Naukri: `naukri`; Glassdoor and
  Indeed: the shared `glassdoor_indeed`), result in the footer. LinkedIn tab: NO scrape button at all; "Open side panel" button
  (`chrome.sidePanel.open({tabId})` from the click handler), partial list count + Clear.
- AI tab: backend URL, AI on/off, backend health + provider/model (via `health` message), a note that the wanted roles
  (`target_role_families`), skills and years of experience are set in `backend/profile.yaml`, and the text
  "Results (jobs.xlsx + CSV files) are in AI-Based-Job-Filter/backend/output/<today>/".
- Save writes `settings`; content scripts react via `chrome.storage.onChanged`.
