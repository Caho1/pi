import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import html_cleaner_opencli  # type: ignore


class OpenCliHtmlCleanerStructuredTests(unittest.TestCase):
    def test_uses_jsonld_person_when_dom_is_sparse(self):
        html = """
        <html>
          <head>
            <title>Prof Jane Doe | Example</title>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "Person",
                "name": "Jane Doe",
                "jobTitle": "Professor",
                "email": "jane@example.edu",
                "description": "Jane Doe works on robotics and embodied intelligence."
              }
            </script>
          </head>
          <body>
            <article id="profile-content-area"></article>
          </body>
        </html>
        """

        result = html_cleaner_opencli.extract(html)

        self.assertEqual(result.strategy, "article+structured")
        self.assertIn("姓名: Jane Doe", result.text)
        self.assertIn("职称: Professor", result.text)
        self.assertIn("邮箱: jane@example.edu", result.text)
        self.assertIn("简介: Jane Doe works on robotics and embodied intelligence.", result.text)

    def test_extract_prefill_uses_structured_and_labeled_blocks(self):
        html = """
        <html>
          <head>
            <title>Dr Jane Doe | Example University</title>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "Person",
                "name": "Jane Doe",
                "jobTitle": "Associate Professor",
                "worksFor": {"@type": "Organization", "name": "Example University"},
                "description": "Jane Doe works on robotics and trustworthy AI."
              }
            </script>
          </head>
          <body>
            <main>
              <div>Department of Computer Science</div>
              <div>Research interests: robotics; trustworthy AI; machine learning</div>
              <div>Google Scholar: https://scholar.example.com/jane</div>
            </main>
          </body>
        </html>
        """

        prefill = html_cleaner_opencli.extract_prefill(html)

        self.assertEqual(prefill["surname"], "Jane Doe")
        self.assertEqual(prefill["organization"], "Example University")
        self.assertEqual(prefill["professional"], "副教授")
        self.assertEqual(prefill["department"], "Department of Computer Science")
        self.assertEqual(
            prefill["domain"],
            ["robotics", "trustworthy AI", "machine learning"],
        )
        self.assertEqual(
            prefill["direction"],
            ["robotics", "trustworthy AI", "machine learning"],
        )
        self.assertIn("Google Scholar", prefill["contact"])
        self.assertIn("Jane Doe works on robotics and trustworthy AI.", prefill["content"])


if __name__ == "__main__":
    unittest.main()
