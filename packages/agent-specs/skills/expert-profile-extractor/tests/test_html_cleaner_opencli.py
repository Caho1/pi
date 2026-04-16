import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import html_cleaner_opencli  # type: ignore


class OpenCliHtmlCleanerTests(unittest.TestCase):
    def test_prefers_article_and_removes_navigation_noise(self):
        html = """
        <html>
          <head>
            <title>Prof. Alice Zhang | Example University</title>
            <meta name="author" content="Example University" />
          </head>
          <body>
            <nav>Home About Contact Admissions Faculty Directory</nav>
            <article id="profile-article">
              <h1>Prof. Alice Zhang</h1>
              <p>Professor, School of Computer Science</p>
              <p>Email: alice@example.edu</p>
              <p>Research focuses on multimodal learning and trustworthy AI systems.</p>
            </article>
            <footer>Privacy Policy</footer>
          </body>
        </html>
        """

        result = html_cleaner_opencli.extract(html)

        self.assertEqual(result.strategy, "article")
        self.assertIn("标题: Prof. Alice Zhang", result.text)
        self.assertIn("Email: alice@example.edu", result.text)
        self.assertNotIn("Admissions", result.text)
        self.assertNotIn("Privacy Policy", result.text)

    def test_falls_back_to_dense_candidate_for_profile_layout(self):
        html = """
        <html>
          <body>
            <div class="layout">
              <div class="left-nav">Faculty Search Teaching Research Students Alumni</div>
              <div class="teacher-profile-content">
                <div class="hero">Dr. Bob Li</div>
                <div>Associate Professor</div>
                <div>Department of Biomedical Engineering</div>
                <div>Email: bob@example.edu</div>
                <div>Phone: +86-21-12345678</div>
                <div>Research interests include rehabilitation robotics, biomechanics, and wearable sensors.</div>
              </div>
            </div>
          </body>
        </html>
        """

        result = html_cleaner_opencli.extract(html)

        self.assertEqual(result.strategy, "dense-candidate")
        self.assertIn("Dr. Bob Li", result.text)
        self.assertIn("Phone: +86-21-12345678", result.text)
        self.assertNotIn("Faculty Search Teaching Research Students Alumni", result.text)

    def test_deduplicates_repeated_long_blocks_but_keeps_short_fields(self):
        html = """
        <html>
          <body>
            <main>
              <p>Email: carol@example.edu</p>
              <p>Email: carol@example.edu</p>
              <p>Carol studies human-computer interaction in healthcare settings with a focus on aging populations.</p>
              <p>Carol studies human-computer interaction in healthcare settings with a focus on aging populations.</p>
            </main>
          </body>
        </html>
        """

        result = html_cleaner_opencli.extract(html)

        self.assertEqual(result.text.count("Carol studies human-computer interaction"), 1)
        self.assertEqual(result.text.count("Email: carol@example.edu"), 1)


if __name__ == "__main__":
    unittest.main()
