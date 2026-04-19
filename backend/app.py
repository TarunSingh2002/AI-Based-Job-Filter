"""
Job Dashboard — compact, professional, instant UI
"""

import streamlit as st
from datetime import datetime
from bson import ObjectId
from db import (
    get_unique_dates, get_jobs_for_date, group_into_sessions,
    mark_job_filled, get_collection,
)
from llm_processor import process_one_job, process_one_job_paid

st.set_page_config(page_title="Job Dashboard", layout="wide", page_icon="🕷️")

# ── Global CSS ─────────────────────────────────────────────────────────────────
st.markdown("""
<style>
/* Remove default Streamlit top padding */
.block-container { padding-top: 1rem !important; }

/* Compact badge pills */
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  margin: 0 2px;
  vertical-align: middle;
}
.b-skill { background:#0a2e1a; color:#4ade80; border:1px solid #166534; }
.b-wt    { background:#0c1f3d; color:#93c5fd; border:1px solid #1e40af; }
.b-exp   { background:#2d1a05; color:#fbbf24; border:1px solid #92400e; }
.b-co    { background:#1e0d30; color:#c084fc; border:1px solid #7e22ce; }
.b-easy  { background:#0a1f2e; color:#38bdf8; border:1px solid #075985; }
.b-pend  { background:#1a1a1a; color:#9ca3af; border:1px solid #374151; }

/* Job card */
.jcard {
  border-left: 3px solid #3b82f6;
  padding: 10px 14px 6px;
  margin-bottom: 2px;
  background: rgba(255,255,255,0.02);
  border-radius: 0 6px 6px 0;
}
.jcard-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 3px;
}
.jtitle {
  font-size: 14px;
  font-weight: 600;
  color: inherit;
  line-height: 1.3;
  flex: 1;
  min-width: 200px;
}
.jmeta {
  font-size: 11px;
  color: #9ca3af;
  margin-top: 2px;
  line-height: 1.5;
}

/* Smaller buttons */
div[data-testid="stButton"] button {
  padding: 3px 10px !important;
  font-size: 12px !important;
  height: 28px !important;
}
div[data-testid="stLinkButton"] a {
  padding: 3px 10px !important;
  font-size: 12px !important;
  height: 28px !important;
}

/* Compact expander */
details summary { font-size: 12px !important; padding: 4px 8px !important; }
details > div { padding: 6px 8px !important; }

/* Thin horizontal divider */
hr { margin: 4px 0 !important; border-color: rgba(255,255,255,0.08) !important; }
</style>
""", unsafe_allow_html=True)


# ── Session state init ─────────────────────────────────────────────────────────
def _init():
    defaults = {
        "filter_exp_start":   0,
        "filter_exp_end":     15,
        "filter_comp_min":    0,
        "filter_skill_min":   1,
        "filter_work_type":   "All",
        "filter_source":      "All",
        "filter_easy_apply":  "All",
        "selected_date":      None,
        "selected_session":   0,
        "current_page":       "LLM Processed",
        "new_processed_flag": False,
        "jobs_cache":         None,
        "jobs_cache_key":     None,
        "filled_ids":         set(),
    }
    for k, v in defaults.items():
        if k not in st.session_state:
            st.session_state[k] = v

_init()


# ── Sidebar ────────────────────────────────────────────────────────────────────
with st.sidebar:
    st.title("🕷️ Job Dashboard")

    dates = get_unique_dates()
    if not dates:
        st.warning("No jobs yet. Run the scraper first.")
        st.stop()

    selected_date = st.selectbox("📅 Date", dates, key="selected_date")

    all_date_jobs = get_jobs_for_date(selected_date)
    sessions      = group_into_sessions(all_date_jobs, gap_hours=5)

    if not sessions:
        st.warning("No sessions for this date.")
        st.stop()

    session_labels = [s["label"] for s in sessions]
    session_idx    = st.selectbox(
        "⏰ Session",
        range(len(sessions)),
        format_func=lambda i: session_labels[i],
        key="selected_session",
    )
    session      = sessions[session_idx]
    session_jobs = session["jobs"]
    st.caption(
        f"{len(session_jobs)} jobs · "
        f"{session['start'].strftime('%H:%M')} – {session['end'].strftime('%H:%M')} UTC"
    )

    st.divider()
    st.subheader("🔍 Filters")

    c1, c2 = st.columns(2)
    with c1:
        st.session_state.filter_exp_start = st.number_input(
            "Exp min", 0, 30, st.session_state.filter_exp_start, key="_es")
    with c2:
        st.session_state.filter_exp_end = st.number_input(
            "Exp max", 0, 30, st.session_state.filter_exp_end, key="_ee")

    st.session_state.filter_comp_min  = st.slider("Co. rating ≥", 0, 5,  st.session_state.filter_comp_min,  key="_cr")
    st.session_state.filter_skill_min = st.slider("Skill match ≥", 1, 10, st.session_state.filter_skill_min, key="_sm")

    st.session_state.filter_work_type = st.selectbox(
        "Work type",
        ["All", "Remote", "Hybrid", "Onsite", "Unknown"],
        index=["All","Remote","Hybrid","Onsite","Unknown"].index(st.session_state.filter_work_type),
        key="_wt")
    st.session_state.filter_source = st.selectbox(
        "Source", ["All","linkedin","glassdoor"],
        index=["All","linkedin","glassdoor"].index(st.session_state.filter_source),
        key="_src")
    st.session_state.filter_easy_apply = st.selectbox(
        "Easy Apply", ["All","Yes","No"],
        index=["All","Yes","No"].index(st.session_state.filter_easy_apply),
        key="_ea")

    if st.button("🔄 Refresh jobs", use_container_width=True):
        st.session_state.jobs_cache = None
        st.session_state.new_processed_flag = False
        st.rerun()


# ── Jobs cache ─────────────────────────────────────────────────────────────────
cache_key = f"{selected_date}_{session_idx}"

if st.session_state.jobs_cache_key != cache_key or st.session_state.jobs_cache is None:
    col_obj = get_collection()
    ids     = [ObjectId(j["_id"]) for j in session_jobs]
    raw     = list(col_obj.find({"_id": {"$in": ids}}))
    for j in raw:
        j["_id"] = str(j["_id"])
    st.session_state.jobs_cache     = raw
    st.session_state.jobs_cache_key = cache_key
    st.session_state.filled_ids     = set()

# Exclude locally-filled jobs without DB round-trip
all_fresh = [
    j for j in st.session_state.jobs_cache
    if j["_id"] not in st.session_state.filled_ids
]


# ── Filter + sort ──────────────────────────────────────────────────────────────
def exp_str(es, ee):
    es = es if (es is not None and es != -1) else None
    ee = ee if (ee is not None and ee != -1) else None
    if es is None and ee is None: return "?"
    if es is None: return f"≤{ee}y"
    if ee is None: return f"{es}y+"
    return f"{es}–{ee}y"


def apply_filters(jobs, require_llm):
    out = []
    for j in jobs:
        if bool(j.get("llm_processed")) != require_llm: continue
        if j.get("filled"): continue
        if st.session_state.filter_source != "All" and j.get("source") != st.session_state.filter_source: continue
        if st.session_state.filter_easy_apply != "All":
            want = st.session_state.filter_easy_apply == "Yes"
            if j.get("easy_apply") != want: continue
        if require_llm:
            if st.session_state.filter_work_type != "All" and j.get("work_type_llm") != st.session_state.filter_work_type: continue
            cr = j.get("company_rating")
            if cr is not None and cr < st.session_state.filter_comp_min: continue
            sm = j.get("skills_match_score")
            if sm is not None and sm < st.session_state.filter_skill_min: continue
            # Experience: hide if job's min required >= user's max
            es = j.get("experience_start", -1) or -1
            ee = j.get("experience_end",   -1) or -1
            if es != -1 and es >= st.session_state.filter_exp_end: continue
            if ee != -1 and ee <  st.session_state.filter_exp_start: continue
        out.append(j)
    return out


def triple_sort(jobs):
    """Sort by: skill match DESC → company rating DESC → posted date DESC (all at once)."""
    def key(j):
        sm = j.get("skills_match_score") or 0
        cr = j.get("company_rating") or 0
        pt = j.get("posted_at") or j.get("scraped_at")
        ts = pt.timestamp() if pt and hasattr(pt, "timestamp") else 0
        return (-sm, -cr, -ts)
    return sorted(jobs, key=key)


# ── Compact job card (wrapped in @st.fragment for instant fill) ─────────────────

@st.fragment
def job_card(job: dict, show_llm: bool):
    mongo_id = job["_id"]

    # If filled this session → fragment reruns and renders nothing (instant removal)
    if mongo_id in st.session_state.get("filled_ids", set()):
        return

    title   = str(job.get("title", "Unknown")).replace("<","&lt;").replace(">","&gt;")
    company = job.get("company", "")
    loc     = job.get("location", "")
    source  = job.get("source", "").capitalize()
    salary  = job.get("salary", "")
    posted  = job.get("posted", "")
    link    = job.get("link", "")
    jd      = job.get("jd", "")

    # Build badges (right side of title)
    badges = []
    if show_llm:
        sm = job.get("skills_match_score")
        if sm is not None:
            badges.append(f'<span class="badge b-skill">★ {sm}/10</span>')
        wt = job.get("work_type_llm", "")
        if wt and wt != "Unknown":
            badges.append(f'<span class="badge b-wt">{wt}</span>')
        es = job.get("experience_start", -1)
        ee = job.get("experience_end", -1)
        exp = exp_str(es, ee)
        if exp != "?":
            badges.append(f'<span class="badge b-exp">📅 {exp}</span>')
        cr = job.get("company_rating")
        if cr is not None:
            badges.append(f'<span class="badge b-co">🏢 {cr}/5</span>')
    else:
        badges.append('<span class="badge b-pend">⏳ Pending</span>')

    if job.get("easy_apply"):
        badges.append('<span class="badge b-easy">⚡ Easy Apply</span>')

    badges_html = "".join(badges)

    # Meta line
    meta = []
    if company: meta.append(f"<b>{company}</b>")
    if loc:     meta.append(loc)
    if source:  meta.append(source)
    if salary:  meta.append(f"💰 {salary}")
    if posted:  meta.append(f"🕒 {posted}")
    if show_llm and job.get("llm_name"):
        meta.append(f"🤖 {job['llm_name']}")
    meta_str = " · ".join(meta)

    # Also show LinkedIn work_type list if available
    wt_li = job.get("work_type", [])
    if wt_li:
        wt_li_str = ", ".join(wt_li)
        meta_str += f" · 🏠 {wt_li_str}"

    st.markdown(f"""
<div class="jcard">
  <div class="jcard-header">
    <span class="jtitle">{title}</span>
    <span>{badges_html}</span>
  </div>
  <div class="jmeta">{meta_str}</div>
</div>""", unsafe_allow_html=True)

    # JD expander (collapsed by default)
    if jd:
        with st.expander("Job Description", expanded=False):
            st.text(jd[:2500] + ("..." if len(jd) > 2500 else ""))

    # Action buttons — compact row
    b1, b2 = st.columns([2, 1])
    with b1:
        if link:
            st.link_button("Open Job ↗", link, use_container_width=True)
    with b2:
        if st.button("✓ Filled", key=f"fill_{mongo_id}", use_container_width=True):
            # Step 1: track locally (instant — no DB round trip needed for UI)
            st.session_state.setdefault("filled_ids", set()).add(mongo_id)
            # Step 2: persist to DB (fast synchronous write)
            mark_job_filled(mongo_id)
            # Step 3: only THIS fragment reruns — other cards untouched
            st.rerun(scope="fragment")

    st.markdown("<hr/>", unsafe_allow_html=True)


# ── LLM trigger runner ─────────────────────────────────────────────────────────
def run_pending_jobs(jobs):
    col_db   = get_collection()
    progress = st.progress(0)
    status   = st.empty()
    n        = len(jobs)
    for i, job in enumerate(jobs):
        mid = job["_id"]
        doc = col_db.find_one({"_id": ObjectId(mid)})
        if not doc or doc.get("llm_processed") or doc.get("filled"):
            progress.progress((i + 1) / n)
            continue
        status.info(f"Processing {i+1}/{n}: {doc['title']}")
        result = process_one_job(mid, doc.get("title",""), doc.get("company",""), doc.get("jd",""))
        progress.progress((i + 1) / n)
        if result == "needs_paid":
            status.warning(f"⚠️ Free LLMs exhausted at {i+1}/{n}.")
            st.session_state.jobs_cache = None
            return
        if result == "error":
            status.error(f"Error at {i+1}. Stopping.")
            return
    status.success(f"✅ Processed {n} jobs.")
    st.session_state.jobs_cache = None


# ── Main page ──────────────────────────────────────────────────────────────────
page = st.radio("View", ["LLM Processed", "Not Processed"], horizontal=True, key="current_page")

if st.session_state.new_processed_flag:
    st.info("🔔 New jobs processed — click **Refresh jobs** in sidebar to see them.")

# ════════════════════════════════════════════════════════════════
if page == "LLM Processed":
    filtered = apply_filters(all_fresh, require_llm=True)
    filtered = triple_sort(filtered)
    st.subheader(f"LLM Processed — {len(filtered)} jobs · sorted by skill match → company → newest")

    if not filtered:
        st.info("No processed jobs match your filters.")
    else:
        for j in filtered:
            job_card(j, show_llm=True)

# ════════════════════════════════════════════════════════════════
elif page == "Not Processed":
    filtered   = apply_filters(all_fresh, require_llm=False)
    needs_paid = [j for j in filtered if j.get("llm_status") == "needs_paid"]
    pending    = [j for j in filtered if j.get("llm_status") != "needs_paid"]

    st.subheader(f"Not Processed — {len(filtered)} jobs")

    if pending:
        if st.button(f"▶ Process {len(pending)} jobs (Free Tier)"):
            run_pending_jobs(pending)
            st.rerun()

    if needs_paid:
        st.warning(f"⚠️ {len(needs_paid)} jobs need paid Grok API.")
        if st.button(f"💳 Process {len(needs_paid)} jobs (Paid Grok)"):
            col_db   = get_collection()
            progress = st.progress(0)
            for i, job in enumerate(needs_paid):
                doc = col_db.find_one({"_id": ObjectId(job["_id"])})
                if not doc: continue
                process_one_job_paid(job["_id"], doc.get("title",""), doc.get("company",""), doc.get("jd",""))
                progress.progress((i + 1) / len(needs_paid))
            st.success("Done!")
            st.session_state.jobs_cache = None
            st.rerun()

    st.divider()

    if not filtered:
        st.success("All jobs in this session are processed!")
    else:
        for j in filtered:
            job_card(j, show_llm=False)