import pytest

from experience import parse_experience, parse_job_years


@pytest.mark.parametrize(
    "text, expected",
    [
        ("3-8 Yrs", (3, 8)),
        ("0-1 Yrs", (0, 1)),
        ("2+ years", (2, None)),
        ("minimum 3 years", (3, None)),
        ("minimum 3 years of experience", (3, None)),
        ("5 to 7 years", (5, 7)),
        ("at least 2 yrs", (2, None)),
        ("freshers", (0, None)),
        ("Fresher", (0, None)),
        ("10+ yrs", (10, None)),
        ("3 - 5 Years", (3, 5)),
        ("3–5 yrs", (3, 5)),
        ("between 2 and 4 years", (2, 4)),
        ("1.5 - 3 years", (1, 3)),
        ("Experience: 4 years", (4, None)),
        ("Experience: 1+ years", (1, None)),
        ("Experience Required: 3+ Years", (3, None)),
        ("Exp: 3+ yrs", (3, None)),
        ("4 years of hands-on industry experience", (4, None)),
        ("more than 6 years of experience in backend roles", (6, None)),
        ("5 Yrs", (5, None)),
        ("up to 3 years of experience", (0, 3)),
        # "not less than" is a minimum, not a ceiling
        ("Not less than 3 years of experience in Python", (3, None)),
        ("No less than 2 years of experience", (2, None)),
        ("We are looking for candidates with 2-4 years of experience.", (2, 4)),
        # the same requirement twice is still one requirement
        ("3+ years of experience in ML. Apply if you have 3+ years of experience.", (3, None)),
        # "fresher" is only a fallback when no number is found, and "not for freshers" doesn't count
        ("Not for freshers. 2-4 years required.", (2, 4)),
        # a bond is not experience, so only "freshers" is left
        ("Freshers welcome! Selected candidates must sign a service agreement for a minimum 3 years.", (0, None)),
        ("Freshers can apply. Bond of at least 2 years applicable.", (0, None)),
        # the company's own years are skipped, the real requirement is kept
        ("Founded in 2012, Acme Analytics has 12+ years of experience in data solutions for banks. "
         "We are hiring an AI Engineer. Experience: 1+ years. Freshers with strong projects can also apply.",
         (1, None)),
        ("We have 12 years of experience in IT services. We are looking for 1-3 years experience.", (1, 3)),
    ],
)
def test_reads_experience(text, expected):
    assert parse_experience(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "Python 3.10",
        "team of 50",
        "2026",
        "Python 3.10, team of 50, hiring for 2026",
        "Founded 20 years ago",
        "Over 10 years in business",  # "over N years" needs experience wording
        "more than 6 years in backend roles",  # ... which also means this one is left to the AI
        # company boilerplate, not a requirement
        "We bring 25 years of experience in retail",
        "We are a 10+ years old company with experience in AI.",
        "Our experience spanning 14 years in fintech",
        "With over 12 years of experience in staffing, XYZ hires engineers.",
        "Acme Analytics has 12+ years of experience in data solutions.",
        # bonds, contracts and degrees
        "Selected candidates must sign a service agreement for a minimum 3 years.",
        "This 2 year contract role needs experience in SQL",
        "4 years bachelors degree and experience in Python",
        "A 2 year contract",
        "Not for freshers. Strong Python and ML skills needed.",  # says no number at all
        "Age 18-25 years",
        "2.5 GHz CPU",
        "Not disclosed",
        "",
        None,
    ],
)
def test_ignores_text_without_experience(text):
    assert parse_experience(text) is None


@pytest.mark.parametrize(
    "text",
    [
        "Must have 3+ years of experience in Python and 1+ year of experience with LangChain.",
        "Must have 3+ years of experience in Python and 1+ year with LangChain.",
    ],
)
def test_two_different_requirements_are_left_to_the_ai(text):
    """We can't tell which number is the real requirement, so None: the AI's min_years question is asked."""
    assert parse_experience(text) is None


def test_card_text_beats_jd():
    assert parse_job_years("3-8 Yrs", "We need 10+ years of experience") == (3, 8)


def test_falls_back_to_jd():
    assert parse_job_years("", "You bring 2+ years of experience with Python.") == (2, None)
    assert parse_job_years("Not disclosed", "No numbers here") is None
