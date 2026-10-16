# Job Filter v2

Shows you only the jobs worth applying to on **LinkedIn, Glassdoor, Naukri and Indeed**.

```
job card → your rules (instant, free) → AI on title + company → AI on full job description → jobs.xlsx (+ CSV)
```

- **Glassdoor / Naukri / Indeed:** press **Start** and it goes through every page by itself. It hides bad jobs,
  marks every job it judged with the site's own **Save** button (so it's skipped next time), and writes good matches to
  `backend/output/<today>/jobs.xlsx` (title, company, match score 0-10, link; all sites, best first).
  Reposts (same title + company again, under a new job id) are hidden without asking the AI.
- **Position first:** only the role types you want (AI/ML engineer, data scientist, data engineer by default) get
  through. A backend developer, data analyst or QA job is hidden however well its skills match; a wanted role is
  never hidden for missing skills (skills can be learned), it just gets a lower match score.
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
check `skills`, and the ONLY role types you want (`target_role_families`, now
`[ai_ml_engineering, data_science, data_engineering]`; every other type is hidden). A typo in a role type name stops
the backend at startup with the list of valid names, so nothing is silently ignored. Restart the backend after editing.
**Seniority is not filtered:** a "Senior", "Lead" or "Manager" title is NOT hidden (you skip those yourself when
applying); a job asking for too many years still is. A job an older version hid for seniority is judged again if it
comes back (one it already saved on the site stays skipped while "hide saved" is on). To bring the seniority filter
back, uncomment `allowed_seniority` in profile.yaml.

**b) Your Jev key:** open `backend/.env` (it has one line) and paste your OpenCode key after `JEV_API_KEY=`.
That's the only setting in `.env`. The app uses Jev only, on OpenCode's paid model `jev-1.13` ($0.042 per 1M input
tokens, output free), billed to your OpenCode balance. Which model is used is set at the top of
[backend/config.py](backend/config.py) (`JEV_MODEL`). To keep the bill small, a card asking for too many years is
hidden by plain code without asking Jev, and so is a repost.

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
5. After pulling a new version, press the reload arrow of "Job Filter v2" on `chrome://extensions` and reload the
   job-site tabs. (Version 2.1 also uses desktop notifications; if Windows hides them, allow notifications for
   Chrome in Windows Settings → System → Notifications.)

Never publish this extension to the Chrome Web Store: LinkedIn checks for known store extensions, and an unpacked
one isn't on any list.

## 3. Daily use

**Glassdoor / Naukri / Indeed**
1. Search jobs on the site (be logged in, so the Save button works). Keep only one results tab of that site open.
2. Extension icon → the site's tab → **Start**. Watch cards turn yellow (reading) → green (match) / red (hidden).
   Reposts vanish right away; the popup counts them under **reposts**.
3. It stops by itself after `maxPages` pages (default 10), or press **Stop**. A desktop notification tells you when a
   run finishes (with its counts) or pauses (with the reason), and the extension icon shows a red **!** while paused.
   - **Speed:** Glassdoor and Indeed read 3 job pages at the same time, Naukri 2 (popup: "Job pages read at once" /
     "Job pages open at once", 1-4). Lower it if a site keeps rate-limiting you.
   - **Rate limits:** reading job pages quickly sometimes gets a "security check" / 403 / 429 answer. The run then
     waits by itself (30 s, then 60 s, then 120 s; the popup shows "waiting 60s (site rate limit), retry at …") and
     retries the same job. You don't need to do anything; only if the site still blocks after the 120 s wait does
     the run pause. Then open any job of that site in a new tab, pass the check if one shows, and press **Resume**.
   - If the results page itself shows a captcha or a login wall, the run pauses at once: solve it yourself, then
     press **Resume**. The extension never tries to solve or get around a captcha.
4. Open `backend/output/<today>/jobs.xlsx` in Excel and apply. Sheet **Matches**: every site's matches, best
   match score first (click a header arrow to sort or filter; "open" is the job link). Sheet **Rejected**: every
   rejected job and why, newest first, which is useful if you think the AI is getting something wrong.
   - **match_score (0-10) = position_score (0-5) + skills_score (0-5).** position = how surely the job is one of
     your wanted role types, skills = how well your `skills` cover the job's core skills. Rows from before this
     version only have the old match score (1-10, skills only) and empty position/skills columns.
   - jobs.xlsx is rebuilt from the CSV files next to it (`<site>_matches.csv`, `<site>_rejected.csv`, the raw log)
     a couple of seconds after each new row. **Don't edit it**: your changes are overwritten by the next
     rebuild. For your own notes (applied, interview, ...) use File → Save As and keep a copy under another name.
   - When a new version adds columns, that day's older CSV is renamed `<site>_matches.before-HHMMSS.csv` and a
     new one is started; jobs.xlsx still shows the rows of both.
   - While Excel has jobs.xlsx open it can't be replaced; it catches up within 15 seconds after you close it,
     and the CSVs keep every row meanwhile. Reopen it to see the new rows.
   - Reposts are not written anywhere (they are copies of a job already judged). Naukri has its own repost list;
     Glassdoor and Indeed share one (Glassdoor is part of Indeed now, many jobs appear on both). LinkedIn keeps its
     own partial-hide list as before. To judge reposts again, empty the list (the popup's "Clear repost list", or
     `POST http://localhost:8765/dedupe/clear` with `{"group": "naukri"}` or `{"group": "glassdoor_indeed"}`).

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
  decide.py       plain-code decisions (wanted role types, experience comparison, scores, optional seniority words)
  experience.py   reads "3-8 Yrs", "2+ years", ... with regexes (the AI never does maths)
  dedupe.py       repost detection: same title + company = same job
  store.py        SQLite cache (a job is never sent to the AI twice) + repost lists + CSV writer, keeps jobs.xlsx up to date
  excel.py        builds jobs.xlsx from the day's CSVs
  providers/jev.py  the Jev client (OpenCode / TypeSafe)
  config.py       JEV_URL + JEV_MODEL (which Jev), paths
  profile.yaml    YOUR profile and thresholds
  output/YYYY-MM-DD/  your results: jobs.xlsx (open this) + the raw <site>_matches.csv / <site>_rejected.csv
extension/
  sites/linkedin.js        read-only LinkedIn filter
  sites/scraper-core.js    the scraper engine for Glassdoor / Naukri / Indeed
  sites/<site>.js          site adapters (selectors live here)
  background.js            talks to the backend, hides LinkedIn cards, Naukri background window, notifications
  popup/, sidepanel/       the UI
```
