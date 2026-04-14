"""Strip chrome from HTML so only profile content reaches the LLM.

The LLM does not need navigation, footers, scripts, or styles. Removing them
trims the prompt by 80%+ on real pages and reduces distraction from things
like 'Contact the university' emails in the footer.
"""
from __future__ import annotations

import re
from bs4 import BeautifulSoup

REMOVE_TAGS = [
    "script", "style", "noscript", "svg", "iframe",
    "header", "footer", "nav", "aside", "form",
    "button", "link", "meta",
]

REMOVE_SELECTORS = [
    ".breadcrumb", ".breadcrumbs", ".menu", ".sidebar", ".footer", ".header",
    ".nav", ".navbar", ".navigation", ".share", ".social",
    ".comment", ".comments", ".cookie", ".banner",
    "[role=navigation]", "[role=banner]", "[role=contentinfo]",
    "#header", "#footer", "#nav", "#sidebar", "#menu",
]

MAX_CHARS = 20000


def clean(html: str) -> str:
    """Return whitespace-collapsed plain text of the body, noise stripped."""
    soup = BeautifulSoup(html, "lxml")

    # Drop tags entirely
    for tag in REMOVE_TAGS:
        for el in soup.find_all(tag):
            el.decompose()

    # Drop by common selectors
    for sel in REMOVE_SELECTORS:
        try:
            for el in soup.select(sel):
                el.decompose()
        except Exception:
            # Some selectors may fail on malformed HTML; skip them
            continue

    body = soup.body or soup

    # Preserve line breaks but kill long runs
    text = body.get_text(separator="\n", strip=True)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text[:MAX_CHARS]
