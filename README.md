# Job Filter v2

Shows you only the jobs worth applying to on **LinkedIn, Glassdoor, Naukri and Indeed**.

```
job card → your rules (instant, free) → AI on title + company → AI on full job description → jobs.xlsx (+ CSV)
```

- **Glassdoor / Naukri / Indeed:** press **Start** and it goes through every page by itself. It hides bad jobs,
  marks every job it judged with the site's own **Save** button (so it's skipped next time), and writes good matches to
  `backend/output/<today>/jobs.xlsx` (title, company, match score 0-10, link; all sites, best first).
  Reposts (same title + company again, under a new job id) are hidden without asking the AI.
- **Automation:** one button runs all your saved Naukri, Indeed and Glassdoor searches one after another in a window
  of its own, while you work on something else (section 4).
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

1. Open `chrome://extensions` (in Opera: `opera://extensions`), turn on **Developer mode**.
2. **Load unpacked** → choose the `extension` folder of this repo (`AI-Based-Job-Filter/extension`).
   Opera may show a warning about `sidePanel` (Opera has no extension side panel); that is fine, everything else
   works. In Opera, also be logged in to Naukri / Indeed / Glassdoor there (Opera has its own cookies).
3. Remove the old "AI-Based-Job-Filter" (v1) extension from Chrome so the two don't both run. Its code is kept
   in git as the tag `v1-old-code`.
4. Click the extension icon → **Filters** tab: add your blacklist keywords, whitelist keywords and blacklisted
   companies (comma separated) → **Save**. A starter blacklist (teacher, trainer, tutor, intern, …) is already there.
5. After pulling a new version, press the reload arrow of "Job Filter v2" on `chrome://extensions` and reload the
   job-site tabs. (Version 2.1 also uses desktop notifications; if Windows hides them, allow notifications for
   Chrome / Opera in Windows Settings → System → Notifications. Version 2.2 adds the Automation tab, section 4.)

Never publish this extension to the Chrome Web Store: LinkedIn checks for known store extensions, and an unpacked
one isn't on any list.

## 3. Daily use

**Glassdoor / Naukri / Indeed**
1. Search jobs on the site (be logged in, so the Save button works). Keep only one results tab of that site open.
2. Extension icon → the site's tab → **Start**. Watch cards turn yellow (reading) → green (match) / red (hidden).
   Reposts vanish right away; the popup counts them under **reposts**.
3. It stops by itself after `maxPages` pages (default 10), or press **Stop**. A desktop notification tells you when a
   run finishes (with its counts) or pauses (with the reason), and the extension icon shows a red **!** while paused.
   - **Speed:** Glassdoor reads 3 job pages at the same time, Naukri 2 (popup: "Job pages read at once" /
     "Job pages open at once", 1-4). Lower it if a site keeps rate-limiting you. The automation (section 4) runs at
     exactly the same pace.
   - **Indeed** opens each job in its own right-hand panel (it clicks the job title, like you would) and reads the
     description there, about 1 s per job. You will see the panel change as it goes. Indeed blocked the older
     background method after a while, so this is always one job at a time.
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
1. Extension icon → LinkedIn tab → **Open side panel** (once per window). Opera has no side panel for extensions
   (the button is off there): use the icon's green score / red ✕.
2. Browse jobs normally. Bad matches vanish. Click a job: within a second or two the icon shows its score
   (green) or ✕ (red), and the side panel shows why.
3. Partial hide: every job you open is remembered (company + title). It stays visible while you're on it and
   disappears once you open another job; copies of it disappear everywhere. The side panel asks once per browser
   session whether to **Keep** or **Clear** that list.

## 4. Automation: all your saved searches in one go

For days when you work on something else on the laptop: it goes through all your saved searches by itself.

1. Start the backend (section 1c).
2. Open the browser (Opera with the shortcut from "Run while you work" below, or Chrome).
3. Extension icon → **Automation** tab → **Start automation**. (Backend not up yet? It keeps asking for 2 minutes;
   meanwhile the tab says "Starting…", also after you close and reopen the popup, and **Stop automation** cancels it.)

What happens:
- It opens **its own window** and runs your saved searches one after another: Naukri, then Indeed, then Glassdoor
  (each list from top to bottom), with each site tab's settings (max pages, hide saved, save processed, ...).
  Results go to `jobs.xlsx` as usual. Keep working in your other windows; don't minimize the automation window.
- **Pace:** exactly the same as pressing **Start** in a site's tab yourself (the settings in each site's tab).
- **Reloaded the extension during a run?** The open page's old copy of the scraper stops quietly; refresh the tab
  and start again (the backend remembers every job already judged, so nothing is done twice).
- **A captcha:** that site pauses and you get ONE notification "Indeed needs you". Click it (it brings the
  automation window to the front), solve the captcha there, then extension icon → that site's tab → **Resume**.
  Nobody there within 10 minutes ("Wait for me to solve a captcha", Automation tab)? That search is marked
  **paused** and the run goes on with the next one. The extension never solves a captcha itself.
- The site reloads the page by itself (a short "Just a moment…" check that clears on its own, a redirect)? The
  search simply goes on on the new page.
- A search that shows no progress for 15 minutes is given up (**stalled**) and the run goes on.
- **At the end:** one notification "Automation finished" with a line per search, e.g. `Naukri: 12 matches · Indeed:
  paused (captcha) · Glassdoor 1/3: 4 matches · ...`; the popup shows it as "Last run". The window stays open.
  Then do LinkedIn yourself.
- **Stop automation** stops the search that is running and skips the rest (pressed while it is still starting, it
  starts nothing: no list cleared after that moment, no window left open). Closing the automation window ends the
  run too. While the automation runs, the sites' own Start buttons are off.

Settings (Automation tab, then **Save**):
- **Saved searches**, one link per line per site. Your five searches are already there. To add one, search on the
  site, copy the address bar, paste it as a new line. A link on the wrong site is shown as an error and skipped.
- **Clear repost lists before every start** (off): judges reposts again on every run.
- **Start automatically when the browser opens (only if the backend is running)** (off): opening the browser starts
  the run by itself, but only once the internet is connected AND the backend answers (checked every 20 s for 10
  minutes; otherwise one notification "Automation not started" and nothing else). So someone who opens the browser
  without the backend starts nothing. It doesn't start again within 6 hours of the last run (reopening the browser
  later that day starts nothing). If the browser is closed in the middle of a run (or you reload the extension on
  its extensions page), that run just counts as ended: press **Start automation** again.
- The backend notes each run in `backend/output/<today>/automation-started.json` and `automation-finished.json`
  (see "Power Automate" below).

## Run while you work (Opera)

Browsers slow down a window that is minimized or covered by other apps (Windows tells them it is hidden), so the
automation window would crawl while you work. Start Opera with three switches that turn this off:

1. Close Opera completely (all windows; if it still shows in the taskbar's hidden icons, quit it there too).
   Switches only count when Opera starts fresh; a new window of an Opera that already runs ignores them.
2. Right-click the desktop → **New → Shortcut**. As the location, paste (one line):
   ```
   "%LOCALAPPDATA%\Programs\Opera\opera.exe" --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding
   ```
   Name it "Opera (Job Filter)". (Already have an Opera shortcut? Right-click it → **Properties** → in **Target**,
   after the closing quote, add a space and the three switches. If its Target ends in `launcher.exe` instead of
   `opera.exe`, add them there just the same; the check in step 3 shows whether they arrived.) Opera installed somewhere else? Right-click
   your Opera shortcut → **Properties** shows its path in **Target**.
3. Start Opera with that shortcut. Check: `opera://version` → "Command Line" lists the three switches.
4. **Don't minimize** the automation window. Covering it with other windows is fine with the switches.
5. Keep the laptop awake for the run: plugged in, and Windows Settings → System → Power → sleep "Never" while
   plugged in (sleep stops everything). If Opera's own Battery saver is on (Opera settings → search "battery"),
   switch it off for the run; it slows background pages down.

Power Automate's **Run application** later: application path = the full path
`C:\Users\tarun\AppData\Local\Programs\Opera\opera.exe` (in Power Automate, `%...%` means one of its own variables,
so don't write `%LOCALAPPDATA%` there), command line arguments = the three switches above.

## Power Automate (later): start and close everything

Windows Power Automate (Desktop) can start the backend and Opera after you switch the laptop on, and close both
when the automation run is done. To know when it is done, the backend writes two small files into today's results
folder (`<today>` = the date, like `2026-10-16`):

- `backend/output/<today>/automation-started.json`: a run has begun (`started_at`).
- `backend/output/<today>/automation-finished.json`: that run has ended (`finished_at`, a one-line `summary`, one
  entry per saved search with its status, matches and reason). Also written when you press **Stop automation**.

They can be trusted as signals: each file appears complete in one go (never half written), and an older file of the
same day is renamed `automation-finished.before-HHMMSS.json` when the backend starts and when a new run starts, so
"automation-finished.json is there" always means "THIS run has finished". A run that goes past midnight writes the
file into both days' folders. To see the last run: http://localhost:8765/automation/last.

The flow (names are Power Automate Desktop actions; `<repo>` = `C:\Users\tarun\OneDrive\Desktop\AI-Based-Job-Filter`):
1. **Get current date and time**, then **Convert datetime to text** with the custom format `yyyy-MM-dd` → `Today`.
2. Is a backend already running? **Invoke web service** `GET http://localhost:8765/health` (on error: continue).
   If it answers, you started one yourself (or the flow runs a second time), so you are at the laptop: leave
   everything as it is and **Stop flow**. (A second backend could not take the port anyway; it leaves the files of
   the running one alone and exits.)
3. **Run application** `<repo>\backend\.venv\Scripts\python.exe`, arguments `-m uvicorn app:app --port 8765`,
   working folder `<repo>\backend`. It gives you `AppProcessId`: keep it (e.g. `BackendPid`). This flow started
   that backend, so step 8 may end it.
4. Wait until the backend answers: a **Loop** that tries **Invoke web service** `GET http://localhost:8765/health`
   (on error: wait 2 s and try again), or simply **Wait** 30 seconds. (Only after this are the old files moved
   aside, so don't skip it.)
5. **Run application** Opera with the flags from "Run while you work". With "Start automatically when the browser
   opens" on, the extension starts the run itself once the internet and the backend are up.
6. **Wait for file** `<repo>\backend\output\%Today%\automation-started.json` to be created, with a timeout of about
   12 minutes. Timeout = the run never started (no internet, ...): go to step 8.
7. **Wait for file** `<repo>\backend\output\%Today%\automation-finished.json` to be created (timeout e.g. 8 hours),
   then **Wait** 10 seconds (jobs.xlsx gets its last rows a couple of seconds after the last job).
8. Close: **Terminate process** by name `opera`, and **Terminate process** by ID `%BackendPid%` (this also ends the
   Python process the venv starts; checked). If the backend ever stops before jobs.xlsx caught up, the next start
   catches it up; the CSV files always have every row.

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
  automation.py   the automation-started / automation-finished files (for Power Automate)
  providers/jev.py  the Jev client (OpenCode / TypeSafe)
  config.py       JEV_URL + JEV_MODEL (which Jev), paths
  profile.yaml    YOUR profile and thresholds
  output/YYYY-MM-DD/  your results: jobs.xlsx (open this) + the raw <site>_matches.csv / <site>_rejected.csv
                      (+ automation-started.json / automation-finished.json when you used "Start automation")
extension/
  sites/linkedin.js        read-only LinkedIn filter
  sites/scraper-core.js    the scraper engine for Glassdoor / Naukri / Indeed
  sites/<site>.js          site adapters (selectors live here)
  background.js            talks to the backend, hides LinkedIn cards, Naukri background window, notifications
  automation.js            "Start automation": runs the saved searches one after another (part of background.js)
  popup/, sidepanel/       the UI
```
