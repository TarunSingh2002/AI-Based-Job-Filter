# AI-Based Job Filter — Full Documentation

## What this project does

This is a personal job search automation system. It has three parts that work together:

1. A **Chrome extension** that scrapes job listings from Glassdoor and LinkedIn while you browse, and filters out irrelevant jobs in real time.
2. A **Python backend** (FastAPI + MongoDB) that receives scraped jobs, stores them, and runs LLM scoring in the background.
3. A **Streamlit dashboard** where you view, filter, sort, and manage jobs that have been scored by the LLM.

The key design goal is that scraping and LLM scoring run **simultaneously and independently**. The moment a batch of jobs is scraped, it is pushed to the backend and LLM scoring begins — while the scraper keeps going on the next batch.

---

## Project structure

```
project/
│
├── chrome-extension/
│   ├── manifest.json            ← Chrome extension config
│   ├── content.js               ← LinkedIn: filter + scraper
│   ├── glassdoor-content.js     ← Glassdoor: filter + scraper
│   ├── popup.html               ← Extension popup UI
│   ├── popup.js                 ← Popup logic (tab switching, scraper controls)
│   └── styles.css               ← Popup styles
│
└── backend/
    ├── .env                     ← Your secrets (never commit this)
    ├── .env.example             ← Template showing all required keys
    ├── requirements.txt         ← Python dependencies
    ├── config.py                ← Reads .env via Pydantic Settings
    ├── db.py                    ← All MongoDB operations
    ├── posted_parser.py         ← Converts "24h" / "3 days ago" to datetime
    ├── llm_processor.py         ← LangGraph workflow + LLM provider rotation
    ├── api.py                   ← FastAPI server (receives jobs from extension)
    └── app.py                   ← Streamlit dashboard
```

---

## How to run

```bash
# 1. First-time setup
cd backend
pip install -r requirements.txt
cp .env.example .env
# → Open .env and fill in your keys (see .env section below)

# 2. Start MongoDB (separate terminal or system service)
mongod

# 3. Start the API server (Terminal 1, inside backend/)
cd backend
uvicorn api:app --port 8000 --reload
# Verify: open http://localhost:8000/health in browser

# 4. Start the dashboard (Terminal 2, inside backend/)
cd backend
streamlit run app.py
# Opens at http://localhost:8501

# 5. Load the Chrome extension
# Chrome → chrome://extensions → Developer mode ON → Load unpacked → select chrome-extension/
# Go to Glassdoor or LinkedIn Jobs, open the extension popup, configure filters, click Start Scraping
```

---

## The `.env` file

All secrets go in `backend/.env`. Never commit this file.

```env
# MongoDB connection
MONGO_URI=mongodb://localhost:27017
DB_NAME=job_scraper
COLLECTION_NAME=Jobs

# Free LLM API keys — comma-separated, multiple allowed
# Groq: https://console.groq.com → Create API Key
GROQ_API_KEYS=gsk_key1,gsk_key2

# Gemini: https://aistudio.google.com → Get API Key (up to 3 recommended)
GEMINI_API_KEYS=AIzaSy_key1,AIzaSy_key2,AIzaSy_key3

# Paid model: xAI Grok — only used when you approve it in the dashboard
# https://console.x.ai
XAI_API_KEY=xai_your_key_here

# LangSmith — optional, for tracing/debugging LLM calls
# https://smith.langchain.com
LANGCHAIN_API_KEY=ls__your_key
LANGCHAIN_TRACING_V2=true
LANGCHAIN_PROJECT=job-scraper

# Candidate skills — used by LLM to score how well each job matches you
MY_SKILLS=Python, Machine Learning, Deep Learning, NLP, LLM, RAG, LangChain, GenAI, Data Science, TensorFlow, PyTorch, Pandas, NumPy, SQL, Generative AI

API_PORT=8000
```

---

## Chrome Extension — Feature 1: Real-time Job Filtering

### What it does

As you browse LinkedIn or Glassdoor job search results, the extension hides irrelevant job cards from the page instantly — before you ever scroll to them. This is purely client-side: no backend needed for filtering.

### How to configure (popup)

Open the extension popup. Each platform has its own tab:

| Setting | What it does |
|---|---|
| Required Title Keywords (whitelist) | Only show jobs whose titles contain at least one of these words. Leave empty to show all titles. |
| Blocked Title Keywords (blacklist) | Hide any job whose title contains any of these words (e.g. "intern", "teacher", "data entry"). |
| Blocked Company Names | Hide all jobs from specific companies (exact match, case-insensitive). |
| Hide Applied Jobs | Hides jobs marked "Applied" on LinkedIn. |
| Hide Dismissed Jobs | Hides jobs you already dismissed on LinkedIn. |
| Hide Saved Jobs (Glassdoor) | Hides jobs you saved on Glassdoor (used as the "already scraped" marker). |
| Promoted Jobs (LinkedIn) | Show all / hide all / hide only ones you've previously clicked ("Partial hide"). |

### How filtering works technically

**LinkedIn (`content.js`):**
- A `MutationObserver` watches `.scaffold-layout__list` for new job cards added by LinkedIn's infinite scroll.
- For each `.scaffold-layout__list-item` card:
  - Extracts title from `.job-card-list__title--link`
  - Extracts company from `.artdeco-entity-lockup__subtitle span`
  - Checks all filter conditions (whitelist, blacklist, company, applied, promoted)
  - Sets `card.style.display = 'none'` or `'block'`
- Re-runs on every DOM change and on every settings save.

**Glassdoor (`glassdoor-content.js`):**
- Same MutationObserver pattern watching `ul.JobsList_jobsList__lqjTr`.
- Cards are `li[data-test="jobListing"]`.
- Title from `a[data-test="job-title"]`, company from `span.EmployerProfile_compactEmployerName__9MGcV`.
- Save button state (`aria-label="Saved"`) is used to track already-scraped jobs.

---

## Chrome Extension — Feature 2: Job Scraping

### LinkedIn scraping flow

1. You click "Start Scraping" in the popup.
2. The popup sends `chrome.tabs.sendMessage({ action: 'startScraping' })` to the content script.
3. `startScraping()` calls `scrapeAllPages()` which loops through all pagination pages.
4. For each page, `scrapeCurrentPage()` runs:
   - Re-queries the DOM on every iteration (not a snapshot) — catches lazily-loaded cards.
   - For each unscraped card: scrolls into view (triggers lazy-loading), clicks the title link, waits for `waitForDetailPane()` to confirm the right job's detail panel loaded (polls for `aria-current="page"` matching the job ID, plus `#job-details` having content).
   - Extracts: title, company, location, posted, work_type (list), easy_apply, job_id, link, full JD text.
   - Dismisses the card (hides it from future scrapes in this session).
5. **After each page is fully scraped**, calls `postPageBatch(jobs)` — a `fetch POST` to `localhost:8000/jobs`. This means LLM scoring starts on page 1 while page 2 is being scraped.
6. At the end, any jobs that failed to POST mid-scrape are sent in a final `sendToBackend()` call with a JSON download fallback.

**Key LinkedIn selectors:**
```
Cards:          li.scaffold-layout__list-item[data-occludable-job-id]
Title:          .job-card-list__title--link
Company:        .artdeco-entity-lockup__subtitle span
Detail title:   .job-details-jobs-unified-top-card__job-title h1
Detail company: .job-details-jobs-unified-top-card__company-name
JD:             #job-details
Work type:      .job-details-fit-level-preferences button (list)
Posted:         .tvm__text--positive strong span
Pagination:     .jobs-search-pagination__page-state  (text: "Page N of M")
Next page:      button.jobs-search-pagination__button--next
```

### Glassdoor scraping flow

1. Same popup trigger mechanism.
2. `gdStartScraping()` loops collecting cards in batches of 4.
3. For each batch of 4 cards:
   - All 4 are highlighted yellow.
   - All 4 are fetched in **parallel** using `Promise.all()` — each card's title `<a>` has a real URL like `glassdoor.co.in/job-listing/...`. We `fetch()` that URL with `credentials: 'include'` (sends session cookies so Glassdoor sees you as logged in) and parse the HTML with `DOMParser` to extract `.JobDetails_jobDescription__uW_fK`.
   - Why fetch instead of clicking: Glassdoor is a React 17+ app. React attaches all event listeners to the root element — any `click()` dispatched from a content script is silently ignored by React's synthetic event system.
   - The card is then "saved" (bookmark button clicked) — this marks it as scraped. The `hideSaved` filter hides it on the next visit.
4. **After each batch**, calls `gdPostBatch(jobs)` — immediate POST to backend. LLM starts on batch 1 while batch 2 is being fetched.
5. `gdGetNextCard()` skips: already-scraped IDs, hidden cards (filtered out), saved cards.
6. When no visible cards remain, clicks `button[data-test="load-more"]` and waits for new cards.
7. When load-more button disappears — scraping is complete.

**Key Glassdoor selectors:**
```
Cards:      li[data-test="jobListing"][data-jobid]
Title:      a[data-test="job-title"]
Company:    span.EmployerProfile_compactEmployerName__9MGcV
Location:   [data-test="emp-location"]
Salary:     [data-test="detailSalary"]
Age:        [data-test="job-age"]
Save btn:   button[data-test="save-job"]  (aria-label: "Save" / "Saved")
Load more:  button[data-test="load-more"]
JD (fetched page): .JobDetails_jobDescription__uW_fK
```

### JSON output format (both scrapers)

```json
{
  "scraped_date": "2026-04-19",
  "source": "glassdoor",
  "total": 4,
  "jobs": [
    {
      "job_id": "1010086115005",
      "title": "Senior AI Engineer",
      "company": "InfoBay.AI",
      "location": "Lucknow",
      "salary": "₹60K – ₹80K",
      "posted": "18d",
      "easy_apply": true,
      "link": "https://www.glassdoor.co.in/job-listing/...",
      "jd": "Full job description text...",
      "source": "glassdoor",
      "scraped_at": "2026-04-19T03:38:00.000Z"
    }
  ]
}
```

LinkedIn additionally includes `"work_type": ["Remote", "Full-time"]` (a list).
Glassdoor additionally includes `"salary": "₹60K – ₹80K"`.

---

## Backend — Data Flow

```
Chrome Extension
  │
  │  POST /jobs  (each batch of 4 GD jobs, or each LinkedIn page)
  ▼
api.py (FastAPI, port 8000)
  │
  ├─► insert_jobs()  in db.py
  │     - upsert by job_id (duplicates silently skipped)
  │     - converts scraped_at string to datetime
  │     - calls posted_parser.py to convert "24h"/"3 days ago" to datetime
  │     - stores with llm_processed=False, llm_status="pending"
  │     - returns list of new MongoDB _ids
  │
  └─► BackgroundTasks.add_task(run_llm_for_inserted_jobs, inserted_ids)
        (returns response to extension IMMEDIATELY — scraper continues)
        │
        ▼
      run_llm_for_inserted_jobs()  [background, non-blocking]
        │
        for each new _id:
          ├─► fetch document from MongoDB
          ├─► call process_one_job(mongo_id, title, company, jd)
          │     │
          │     ▼  (llm_processor.py)
          │     LangGraph: START → process_job_node → END
          │       └─► try Groq key 1 → key 2 → ...
          │           try Gemini key 1 → key 2 → ...
          │           if all fail → return output=None
          │
          ├─► if done:    update_job_with_llm_output()  → llm_processed=True
          ├─► if needs_paid: mark_job_needs_paid()      → llm_status="needs_paid", STOP
          └─► if error:   STOP
```

---

## Backend — MongoDB Document Structure

Each job document in the `Jobs` collection looks like this after full processing:

```json
{
  "_id": "ObjectId(...)",
  "job_id": "1010086115005",
  "title": "Senior AI Engineer",
  "company": "InfoBay.AI",
  "location": "Lucknow",
  "salary": "₹60K – ₹80K",
  "posted": "18d",
  "posted_at": "2026-04-01T00:00:00+00:00",
  "work_type": [],
  "easy_apply": true,
  "link": "https://...",
  "jd": "Full JD text...",
  "source": "glassdoor",
  "scraped_at": "2026-04-19T03:38:00+00:00",

  "llm_processed": true,
  "llm_name": "groq/llama-3.3-70b",
  "llm_status": "done",
  "skills_match_score": 8,
  "work_type_llm": "Onsite",
  "experience_start": 2,
  "experience_end": 5,
  "company_rating": 1,

  "filled": false
}
```

`llm_status` values:
- `"pending"` — not yet processed
- `"done"` — LLM scored it successfully
- `"needs_paid"` — all free LLM keys exhausted, needs paid Grok approval

---

## Backend — LLM Workflow (llm_processor.py)

### LangGraph state

```python
class JobState(TypedDict):
    job_title:    str
    company_name: str
    jd:           str
    output:       Optional[dict]  # filled by the node
    llm_name:     Optional[str]   # which model succeeded
```

### Workflow

```
START → process_job_node → END
```

Single node. No branches. No parallelization.

### Provider rotation inside the node

```
for each Groq API key:
    try → call LLM → if success: return {output, llm_name}
    except → log warning → try next key

for each Gemini API key:
    try → call LLM → if success: return {output, llm_name}
    except → log warning → try next key

if all fail:
    return {output: None, llm_name: None}
    → caller marks job as needs_paid and STOPS the batch
```

### The prompt

```
SYSTEM:
You are a job evaluator helping a candidate decide which jobs to apply to.

Candidate skills: {MY_SKILLS from .env}

You will read a job posting and extract 5 specific pieces of information.
Be accurate. Do not guess. If something is not mentioned in the JD, say so explicitly.

1. skills_match_score (integer 1-10):
   - Read the JD carefully. List the technical skills it asks for.
   - Count how many of those skills the candidate has.
   - 10 = almost all required skills match perfectly.
   - 7-9 = good match, candidate has most key skills.
   - 4-6 = partial match.
   - 1-3 = poor match.

2. work_type: "Remote" | "Hybrid" | "Onsite" | "Unknown"

3. experience_start: minimum years required. -1 if not mentioned.

4. experience_end: maximum years required. -1 if no upper limit or not mentioned.

5. company_rating (0-5):
   - 5 = Google/Amazon/Microsoft/Meta/Apple/Netflix/OpenAI
   - 4 = Wipro/Infosys/TCS/Zomato/Flipkart/Paytm/HDFC
   - 3 = recognizable mid-size company
   - 2 = small company
   - 1 = startup or obscure
   - 0 = never heard of it

HUMAN:
Job Title: {title}
Company: {company}

Job Description:
{jd}

Extract the 5 fields. Be precise and conservative.
```

### Structured output

LangChain's `with_structured_output(JobAnalysis)` forces the LLM to return exactly the Pydantic schema defined. If the LLM returns malformed output, it raises an exception and the next provider key is tried.

```python
class JobAnalysis(BaseModel):
    skills_match_score: int    # 1-10
    work_type:          str    # Remote/Hybrid/Onsite/Unknown
    experience_start:   int    # years, -1 if unknown
    experience_end:     int    # years, -1 if unknown
    company_rating:     int    # 0-5
```

### LangSmith tracing

If `LANGCHAIN_API_KEY` is set in `.env`, every LLM call is automatically traced on https://smith.langchain.com — you can see the exact prompt sent, the model response, latency, and token counts for every job processed.

---

## Backend — posted_parser.py

Converts human-readable posted strings to Python `datetime` objects. Uses `scraped_at` as the reference point since we don't know the exact post time.

| Input | Output |
|---|---|
| `"24h"` | scraped_at − 24 hours |
| `"15d"` | scraped_at − 15 days |
| `"30d+"` | scraped_at − 30 days |
| `"3 days ago"` | scraped_at − 3 days |
| `"1 week ago"` | scraped_at − 7 days |
| `"2 months ago"` | scraped_at − 60 days |
| anything else | scraped_at (fallback) |

---

## Dashboard — app.py (Streamlit)

### Sidebar controls

**Date selector** — all unique dates that have jobs in MongoDB (newest first).

**Session selector** — scraping sessions on that date. Sessions are automatically detected: if consecutive jobs have a gap of more than 5 hours between them, they belong to different sessions. For example, scraping 10am–12pm and 7pm–9pm gives two sessions labeled "10:00 AM" and "07:00 PM".

**Sort section** — two dropdowns:
- Sort by: `Skill Match` / `Company Rating` / `Posted Date`
- Order: `Desc ↓` (best/newest first) or `Asc ↑` (lowest/oldest first)

**Filters** (applied on top of sort):
- Experience range (min/max years) — jobs whose LLM-determined required experience completely falls outside this range are hidden
- Min company rating (slider 0–5)
- Min skill match (slider 1–10)
- Work type (All / Remote / Hybrid / Onsite / Unknown)
- Source (All / linkedin / glassdoor)
- Easy Apply (All / Yes / No)

**Refresh button** — forces a fresh DB fetch (useful when LLM processing is running in the background and new scores are arriving).

### Two pages

**LLM Processed** — jobs that have been scored. Sortable and filterable. Shows skill match, work type, experience range, company rating as inline badges. "Scored by: groq/llama-3.3-70b" shown per card.

**Not Processed** — jobs still pending. Two action buttons:
- **Process X jobs (Free Tier)** — runs `process_one_job()` sequentially right in the browser tab. Shows a progress bar. Stops if free keys are exhausted.
- **Process X jobs (Paid Grok)** — shown only when some jobs have `llm_status="needs_paid"`. You manually approve this. Calls `process_one_job_paid()` using your `XAI_API_KEY`.

### Instant "Mark as Filled"

Each job card is wrapped in `@st.fragment`. When you click "✓ Filled":
1. The job's `_id` is added to `st.session_state.filled_ids` (in-memory, instant)
2. `mark_job_filled()` writes `filled: true` to MongoDB
3. `st.rerun(scope="fragment")` — **only that one card's fragment reruns**, not the full page. The card checks `if mongo_id in filled_ids: return` at the top and renders nothing. The card disappears in under 100ms.

### Jobs cache

All jobs for the current session are fetched from MongoDB **once** and stored in `st.session_state.jobs_cache`. The cache is only invalidated when you change the date, session, or click Refresh. This prevents a DB round-trip on every filter/sort interaction.

---

## Paid API human-in-the-loop

There is no popup or notification during scraping. The system works like this:

1. While scraping: free LLMs process jobs in the background. If all free keys are exhausted, the LLM worker stops quietly. Jobs stay in MongoDB as `llm_status: "needs_paid"`.
2. The scraper in Chrome continues completely unaffected.
3. Whenever you open the Streamlit dashboard (could be hours later), go to "Not Processed".
4. If any jobs have `needs_paid` status, a warning appears: "⚠️ N jobs need paid Grok API."
5. Click "💳 Process N jobs (Paid Grok)" — that is your approval. Processing runs immediately.

---

## Rate limiting (Groq 429 handling)

Groq's free tier rate-limits requests. When a 429 is returned, the `langchain-groq` library automatically retries with exponential backoff (visible in logs as "Retrying request to /openai/v1/chat/completions in N seconds"). This is handled entirely by the library — no custom retry code needed. The job is successfully processed after the retry.

---

## Adding a new job board

To add scraping for a new site (e.g. Naukri, Indeed):

1. Add the site's URL pattern to `manifest.json` under `content_scripts.matches`.
2. Create a new content script file (e.g. `naukri-content.js`) following the same pattern as `glassdoor-content.js`.
3. Add the script to `manifest.json` under `content_scripts.js`.
4. Update `popup.html` to add a new tab for the site's filter settings.
5. Update `popup.js` to handle save/load for the new site's settings.
6. The backend requires no changes — it accepts any `source` string.

---

## Common issues

**`ValueError: Invalid isoformat string: 'NoneT00:00:00+00:00'`**
Streamlit's selectbox briefly returns `None` on first load before the dates are fetched. Fixed in `db.py` with an early `if not date_str: return []` guard.

**`llm_name` shows "unknown"**
LangGraph's `StateGraph` silently drops any dict key returned from a node that is not declared in the `TypedDict` state. The `llm_name` field must be declared in `JobState`. Fixed in `llm_processor.py`.

**Scraper shows few results on LinkedIn**
LinkedIn throttles results for new/empty accounts. Fix: add Location and Headline to the scraping account's profile. The account trust score controls how many results are shown.

**Glassdoor JD all jobs same text**
The old click-based approach failed silently (React 17+ ignores synthetic clicks). Fixed by using `fetch()` to load each job's individual URL and parsing the JD from the server-rendered HTML.

**"Mark as Filled" slow**
Fixed by using `@st.fragment` — only the individual card's fragment reruns, not the full page. The local `filled_ids` set provides instant UI feedback before the DB write completes.
