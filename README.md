# Job Filter v2

Shows you only the jobs worth applying to on **LinkedIn, Glassdoor, Naukri and Indeed**.

```
job card → your rules (instant, free) → AI on title + company → AI on full job description → jobs.xlsx (+ CSV)
```

- **Glassdoor / Naukri / Indeed:** press **Start** and it goes through every page by itself. It hides bad jobs,
  marks every job it judged with the site's own **Save** button (so it's skipped next time), and writes good matches to
  `backend/output/<today>/jobs.xlsx` (title, company, match score 1-10, confidence, link; all sites, best first).
- **LinkedIn:** read-only. You scroll and click as usual; bad jobs disappear and the verdict for the job you open shows
  on the extension icon (green score / red ✕) and in the side panel. Nothing is ever clicked, scrolled or
  downloaded on LinkedIn, and nothing is drawn inside LinkedIn's page. There is no scrape button for LinkedIn.

How it works in detail: [DESIGN.md](DESIGN.md).

---

## 1. Backend (one-time setup)

The Python environment is already created in `backend/.venv`. If you ever need to recreate it:

```bash
cd backend && python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt
```

**a) Your profile:** open [backend/profile.yaml](backend/profile.yaml) and set `experience_years` (it's 1 now),
check `skills`, and the role types you never want (`avoid_role_families`).

**b) Your Jev key:** open `backend/.env` (it has one line) and paste your OpenCode key after `JEV_API_KEY=`.
That's the only setting in `.env`. The app uses Jev only, on OpenCode's paid model `jev-1.13` ($0.042 per 1M input
tokens, output free), billed to your OpenCode balance. Which model is used is set at the top of
[backend/config.py](backend/config.py) (`JEV_MODEL`).

**c) Start it** (keep this terminal open while you job-hunt):

```bash
cd backend && .venv/Scripts/python -m uvicorn app:app --port 8765
```

Check: http://localhost:8765/health should show your provider and model.

## 2. Extension (one-time setup)

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → choose the `extension` folder of this repo (`AI-Based-Job-Filter/extension`).
3. Remove the old "AI-Based-Job-Filter" (v1) extension from Chrome so the two don't both run. Its code is kept
   in git as the tag `v1-old-code`.
4. Click the extension icon → **Filters** tab: add your blacklist keywords, whitelist keywords and blacklisted
   companies (comma separated) → **Save**. A starter blacklist (teacher, trainer, tutor, intern, …) is already there.

Never publish this extension to the Chrome Web Store: LinkedIn checks for known store extensions, and an unpacked
one isn't on any list.

## 3. Daily use

**Glassdoor / Naukri / Indeed**
1. Search jobs on the site (be logged in, so the Save button works). Keep only one results tab of that site open.
2. Extension icon → the site's tab → **Start**. Watch cards turn yellow (reading) → green (match) / red (hidden).
3. It stops by itself after `maxPages` pages (default 10), or press **Stop**. If the site shows a captcha or a login
   wall, the run pauses: solve it yourself, then press **Resume**.
4. Open `backend/output/<today>/jobs.xlsx` in Excel and apply. Sheet **Matches**: every site's matches, best
   match score first (click a header arrow to sort or filter; "open" is the job link). Sheet **Rejected**: every
   rejected job and why, newest first, which is useful if you think the AI is getting something wrong.
   - jobs.xlsx is rebuilt from the CSV files next to it (`<site>_matches.csv`, `<site>_rejected.csv`, the raw log)
     a couple of seconds after each new row. **Don't edit it**: your changes are overwritten by the next
     rebuild. For your own notes (applied, interview, ...) use File → Save As and keep a copy under another name.
   - While Excel has jobs.xlsx open it can't be replaced; it catches up within 15 seconds after you close it,
     and the CSVs keep every row meanwhile. Reopen it to see the new rows.

Naukri opens each shortlisted job in a **minimized background window** (Naukri doesn't allow reading the
description any other way without its own page). Leave that window alone; it closes when the run ends.

**LinkedIn**
1. Extension icon → LinkedIn tab → **Open side panel** (once per window).
2. Browse jobs normally. Bad matches vanish. Click a job: within a second or two the icon shows its score
   (green) or ✕ (red), and the side panel shows why.
3. Partial hide: every job you open is remembered (company + title). It stays visible while you're on it and
   disappears once you open another job; copies of it disappear everywhere. The side panel asks once per browser
   session whether to **Keep** or **Clear** that list.

## Files

```
backend/
  app.py          HTTP API for the extension
  graph.py        the whole AI flow (LangGraph) - start reading here
  questions.py    THE PROMPT: the questions the AI answers
  decide.py       plain-code decisions (thresholds, experience comparison)
  experience.py   reads "3-8 Yrs", "2+ years", ... with regexes (the AI never does maths)
  store.py        SQLite cache (a job is never sent to the AI twice) + CSV writer, keeps jobs.xlsx up to date
  excel.py        builds jobs.xlsx from the day's CSVs
  providers/jev.py  the Jev client (OpenCode / TypeSafe)
  config.py       JEV_URL + JEV_MODEL (which Jev), paths
  profile.yaml    YOUR profile and thresholds
  output/YYYY-MM-DD/  your results: jobs.xlsx (open this) + the raw <site>_matches.csv / <site>_rejected.csv
extension/
  sites/linkedin.js        read-only LinkedIn filter
  sites/scraper-core.js    the scraper engine for Glassdoor / Naukri / Indeed
  sites/<site>.js          site adapters (selectors live here)
  background.js            talks to the backend, hides LinkedIn cards, Naukri background window
  popup/, sidepanel/       the UI
```
