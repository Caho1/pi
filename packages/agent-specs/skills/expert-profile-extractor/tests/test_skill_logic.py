import sys
import unittest
import os
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import extract  # type: ignore
import llm_client  # type: ignore
import rules  # type: ignore
import webofscience  # type: ignore


class ExpertProfileSkillLogicTests(unittest.TestCase):
    def test_rejects_generic_site_title_as_name(self):
        html = """
        <html>
          <head><title>Web of Science</title></head>
          <body><div id="root"></div></body>
        </html>
        """
        self.assertIsNone(rules.extract_name(html))

    def test_avatar_prefers_name_specific_image_over_generic_og_image(self):
        html = """
        <html>
          <head>
            <meta property="og:image" content="/assets/about-1-1.webp" />
            <title>Mohsen Guizani</title>
          </head>
          <body>
            <main>
              <img src="/people/Mohsen-Guizani.jpg" alt="thumbnail" />
            </main>
          </body>
        </html>
        """
        avatar = rules.extract_avatar(html, "https://example.edu/faculty/mohsen")
        self.assertEqual(avatar, "https://example.edu/people/Mohsen-Guizani.jpg")

    @patch("extract._request_with_optional_direct_retry")
    def test_fetch_retries_with_no_proxy_on_tls_error(self, mock_request):
        response = MagicMock()
        response.encoding = "utf-8"
        response.text = "<html>ok</html>"
        response.url = "https://example.edu/profile"
        mock_request.side_effect = [
            extract.requests.exceptions.SSLError("SSL handshake failed"),
            response,
        ]

        html, final_url = extract.fetch("https://example.edu/profile")

        self.assertEqual(html, "<html>ok</html>")
        self.assertEqual(final_url, "https://example.edu/profile")
        self.assertEqual(mock_request.call_count, 2)
        self.assertEqual(mock_request.call_args_list[1].kwargs, {"force_no_proxy": True})

    @patch("webofscience._request_search")
    def test_webofscience_script_extracts_author_record(self, mock_request_search):
        mock_request_search.return_value = {
            "QueryResult": {"RecordsFound": 1},
            "Data": {
                "Records": [
                    {
                        "publishingName": "Anh Tuan Hoang",
                        "primaryAffiliationLocation": "DONG NAI, VIETNAM",
                        "primaryInstitutionAffiliation": {
                            "institution": "Dong Nai Technology University",
                            "department": "unknown",
                        },
                        "primaryAffiliationDepartment": [
                            "Energy Fuel Technol & Appl Mat Res Grp",
                            "Fac Engn",
                        ],
                        "categories": ["Energy & Fuels", "Engineering"],
                        "topics": [
                            {"value": "Diesel engine"},
                            {"value": "Renewable energy"},
                        ],
                        "summary": "Research focuses on sustainable energy systems.",
                        "photoUrlLarge": "https://example.com/photo.png",
                    }
                ]
            },
        }

        result = webofscience.extract_profile("https://www.webofscience.com/wos/author/record/917221")

        assert result is not None
        self.assertEqual(result["name"], "Anh Tuan Hoang")
        self.assertEqual(result["country_region"], "越南")
        self.assertEqual(result["institution"], "Dong Nai Technology University")
        self.assertEqual(result["college_department"], "Energy Fuel Technol & Appl Mat Res Grp / Fac Engn")
        self.assertEqual(result["research_areas"], ["Energy & Fuels", "Engineering"])
        self.assertEqual(result["research_directions"], ["Diesel engine", "Renewable energy"])
        self.assertEqual(result["avatar_url"], "https://example.com/photo.png")

    @patch("webofscience._request_search")
    def test_webofscience_requires_active_session_for_server_side(self, mock_request_search):
        response = MagicMock()
        response.json.return_value = {
            "code": "Server.sessionNotActive",
            "message": "Loaded session required",
        }
        error = extract.requests.exceptions.HTTPError("401")
        error.response = response
        mock_request_search.side_effect = error

        with self.assertRaisesRegex(RuntimeError, "requires an active session"):
            webofscience.extract_profile("https://www.webofscience.com/wos/author/record/917221")

    @patch("llm_client.OpenAI")
    def test_llm_client_sets_explicit_timeout_and_disables_retries(self, mock_openai):
        with patch.dict(
            os.environ,
            {
                "EXPERT_EXTRACTOR_API_KEY": "test-key",
                "EXPERT_EXTRACTOR_BASE_URL": "https://example.com/v1",
                "EXPERT_EXTRACTOR_TIMEOUT_SECONDS": "20",
            },
            clear=False,
        ):
            llm_client._client()

        mock_openai.assert_called_once_with(
            base_url="https://example.com/v1",
            api_key="test-key",
            timeout=20.0,
            max_retries=0,
        )


if __name__ == "__main__":
    unittest.main()
