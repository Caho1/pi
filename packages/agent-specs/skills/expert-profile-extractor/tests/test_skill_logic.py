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

    @patch("extract._request_with_optional_direct_retry")
    def test_fetch_retries_with_no_proxy_when_proxy_path_times_out(self, mock_request):
        response = MagicMock()
        response.encoding = "utf-8"
        response.text = "<html>ok</html>"
        response.url = "https://example.edu/profile"
        mock_request.side_effect = [
            extract.requests.exceptions.ProxyError("proxy connect timeout"),
            response,
        ]

        html, final_url = extract.fetch("https://example.edu/profile")

        self.assertEqual(html, "<html>ok</html>")
        self.assertEqual(final_url, "https://example.edu/profile")
        self.assertEqual(mock_request.call_args_list[0].kwargs, {"force_no_proxy": False})
        self.assertEqual(mock_request.call_args_list[1].kwargs, {"force_no_proxy": True})

    @patch("extract._request_with_optional_direct_retry")
    def test_fetch_uses_force_direct_domains_override(self, mock_request):
        response = MagicMock()
        response.encoding = "utf-8"
        response.text = "<html>direct</html>"
        response.url = "https://faculty.example.edu/profile"
        mock_request.return_value = response

        with patch.dict(
            os.environ,
            {
                "EXPERT_EXTRACTOR_PROXY_MODE": "proxy-only",
                "EXPERT_EXTRACTOR_FORCE_DIRECT_DOMAINS": "example.edu",
            },
            clear=False,
        ):
            html, final_url = extract.fetch("https://faculty.example.edu/profile")

        self.assertEqual(html, "<html>direct</html>")
        self.assertEqual(final_url, "https://faculty.example.edu/profile")
        mock_request.assert_called_once_with("https://faculty.example.edu/profile", force_no_proxy=True)

    @patch("extract._request_with_optional_direct_retry")
    def test_fetch_retries_on_block_page_even_when_http_status_is_200(self, mock_request):
        blocked = MagicMock()
        blocked.encoding = "utf-8"
        blocked.text = "<html><title>Just a moment...</title></html>"
        blocked.headers = {"server": "cloudflare", "cf-mitigated": "challenge"}
        blocked.url = "https://blocked.example.edu/profile"

        response = MagicMock()
        response.encoding = "utf-8"
        response.text = "<html>real profile</html>"
        response.headers = {}
        response.url = "https://blocked.example.edu/profile"

        mock_request.side_effect = [blocked, response]

        html, final_url = extract.fetch("https://blocked.example.edu/profile")

        self.assertEqual(html, "<html>real profile</html>")
        self.assertEqual(final_url, "https://blocked.example.edu/profile")
        self.assertEqual(mock_request.call_args_list[0].kwargs, {"force_no_proxy": False})
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
        self.assertEqual(result["status"], 200)
        data = result["data"]
        self.assertEqual(data["surname"], "Anh Tuan Hoang")
        self.assertEqual(data["organization"], "Dong Nai Technology University")
        self.assertEqual(data["department"], "Energy Fuel Technol & Appl Mat Res Grp / Fac Engn")
        self.assertEqual(data["direction"], "Diesel engine,Renewable energy")
        self.assertEqual(data["avatar"], "https://example.com/photo.png")
        self.assertGreater(data["country"], 0)
        self.assertGreater(data["domain"], 0)

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

    @patch("llm_client._client")
    @patch("llm_client._model", return_value="glm-5")
    def test_llm_client_uses_json_mode_and_disables_thinking_for_glm5(self, mock_model, mock_client_factory):
        response = MagicMock()
        response.choices = [MagicMock(message=MagicMock(content='{"ok": true}'))]

        client = MagicMock()
        client.chat.completions.create.return_value = response
        mock_client_factory.return_value = client

        result = llm_client.call_llm(
            cleaned_text="Professor profile",
            known={"institution": "某大学"},
            source_url="https://example.edu/profile",
        )

        self.assertEqual(result, {"ok": True})
        client.chat.completions.create.assert_called_once()
        kwargs = client.chat.completions.create.call_args.kwargs
        self.assertEqual(kwargs["model"], "glm-5")
        self.assertEqual(kwargs["response_format"], {"type": "json_object"})
        self.assertEqual(kwargs["extra_body"], {"enable_thinking": False})
        self.assertEqual(kwargs["temperature"], 0)
        self.assertEqual(kwargs["messages"][0]["role"], "system")
        self.assertEqual(kwargs["messages"][1]["role"], "user")

    def test_llm_client_completion_options_keep_json_mode_for_other_models(self):
        self.assertEqual(
            llm_client._completion_options("MiniMax-M2.5"),
            {"response_format": {"type": "json_object"}},
        )

    @patch("extract.fetch")
    @patch("llm_client.call_llm")
    def test_extract_profile_passes_prefill_fields_to_llm_and_uses_prefill_as_fallback(
        self,
        mock_call_llm,
        mock_fetch,
    ):
        html = """
        <html>
          <head>
            <title>Prof Jane Doe | Example University</title>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "Person",
                "name": "Jane Doe",
                "jobTitle": "Professor",
                "worksFor": {"@type": "Organization", "name": "Example University"},
                "description": "Jane Doe works on robotics and embodied intelligence."
              }
            </script>
          </head>
          <body>
            <main>
              <div>Department of Computer Science</div>
              <div>Research interests: robotics; trustworthy AI</div>
            </main>
          </body>
        </html>
        """
        mock_fetch.return_value = (html, "https://example.edu/profile")
        mock_call_llm.return_value = {
            "surname": None,
            "sex": 0,
            "birthday": None,
            "country": None,
            "province": None,
            "organization": None,
            "department": None,
            "domain": None,
            "direction": None,
            "professional": None,
            "position": None,
            "content": None,
            "contact": None,
            "academic": None,
            "journal": None,
            "title": None,
            "tags": None,
        }

        result = extract.extract_profile("https://example.edu/profile")
        data = result["data"]

        known = mock_call_llm.call_args.args[1]
        self.assertEqual(known["organization"], "Example University")
        self.assertEqual(known["professional"], "教授")
        self.assertEqual(known["department"], "Department of Computer Science")
        self.assertEqual(known["domain"], ["robotics", "trustworthy AI"])
        self.assertEqual(known["direction"], ["robotics", "trustworthy AI"])

        self.assertEqual(data["organization"], "Example University")
        self.assertEqual(data["professional"], 1)
        self.assertEqual(data["department"], "Department of Computer Science")
        self.assertEqual(data["direction"], "robotics,trustworthy AI")
        self.assertGreater(data["domain"], 0)

    @patch("extract.fetch")
    @patch("llm_client.call_llm")
    def test_extract_profile_keeps_llm_value_when_prefill_exists(
        self,
        mock_call_llm,
        mock_fetch,
    ):
        html = """
        <html>
          <head>
            <title>Prof Jane Doe | Example University</title>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "Person",
                "name": "Jane Doe",
                "jobTitle": "Professor",
                "worksFor": {"@type": "Organization", "name": "Example University"}
              }
            </script>
          </head>
          <body><main><div>Department of Computer Science</div></main></body>
        </html>
        """
        mock_fetch.return_value = (html, "https://example.edu/profile")
        mock_call_llm.return_value = {
            "surname": None,
            "sex": 0,
            "birthday": None,
            "country": None,
            "province": None,
            "organization": "示例大学",
            "department": "计算机科学系",
            "domain": None,
            "direction": None,
            "professional": "教授",
            "position": None,
            "content": None,
            "contact": None,
            "academic": None,
            "journal": None,
            "title": None,
            "tags": None,
        }

        result = extract.extract_profile("https://example.edu/profile")
        data = result["data"]

        self.assertEqual(data["organization"], "示例大学")
        self.assertEqual(data["department"], "计算机科学系")
        self.assertEqual(data["professional"], 1)

    @patch("extract.fetch")
    @patch("llm_client.call_llm")
    def test_extract_profile_normalizes_new_api_fields_to_ids_and_bitmasks(
        self,
        mock_call_llm,
        mock_fetch,
    ):
        html = """
        <html>
          <head><title>杨建涛</title></head>
          <body><main><div>示例专家主页</div></main></body>
        </html>
        """
        mock_fetch.return_value = (html, "https://jiankang.usst.edu.cn/profile")
        mock_call_llm.return_value = {
            "surname": "杨建涛",
            "sex": 1,
            "birthday": None,
            "country": "中国",
            "province": "上海市",
            "organization": "上海理工大学",
            "department": "健康科学与工程学院 / 康复工程与技术研究所",
            "domain": "人工智能",
            "direction": "康复机器人,可穿戴监测设备,机器人学,人机系统智能感知与控制",
            "professional": "副教授",
            "position": "硕士研究生导师",
            "contact": "Google Scholar,ORCID",
            "content": "杨建涛，机器人学博士，现任上海理工大学副教授。",
            "academic": "自动化学会机器人智能专委会委员",
            "journal": "IEEE Transactions审稿人",
            "title": "IEEE Senior Member",
            "tags": "双一流高校,导师师资",
        }

        result = extract.extract_profile("https://jiankang.usst.edu.cn/profile")
        data = result["data"]

        self.assertEqual(result["status"], 200)
        self.assertEqual(data["surname"], "杨建涛")
        self.assertEqual(data["sex"], 1)
        self.assertEqual(data["country"], 1)
        self.assertEqual(data["province"], 9)
        self.assertEqual(data["domain"], 8)
        self.assertEqual(data["professional"], 2)
        self.assertEqual(data["title"], 32)
        self.assertEqual(data["tags"], "8,21")


if __name__ == "__main__":
    unittest.main()
