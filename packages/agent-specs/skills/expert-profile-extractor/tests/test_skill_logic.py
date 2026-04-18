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


class ExpertProfileSkillLogicTests(unittest.TestCase):
    def test_rejects_generic_site_title_as_name(self):
        html = """
        <html>
          <head><title>Web of Science</title></head>
          <body><div id="root"></div></body>
        </html>
        """
        self.assertIsNone(rules.extract_name(html))

    def test_rejects_scopus_preview_as_name(self):
        html = """
        <html>
          <head><title>Scopus preview - Scopus - Author details</title></head>
          <body><div id="root"></div></body>
        </html>
        """
        self.assertIsNone(rules.extract_name(html))

    def test_rejects_login_wall_title_as_name(self):
        for title in (
            "Sign in to continue",
            "Just a moment...",
            "Attention Required! | Cloudflare",
            "Access Denied",
        ):
            html = f"<html><head><title>{title}</title></head><body></body></html>"
            self.assertIsNone(
                rules.extract_name(html),
                f"expected {title!r} to be rejected as a person name",
            )

    def test_block_page_markers_catch_cloudflare_challenge_variants(self):
        for body in (
            "<html><head><title>Attention Required!</title></head><body>Please wait</body></html>",
            "<html><body><script src=\"/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1\"></script></body></html>",
            "<html><body><script>window._cf_chl_opt={}</script></body></html>",
            "<html><head><title>Verifying you are human</title></head><body></body></html>",
        ):
            response = MagicMock()
            response.text = body
            response.headers = {}
            self.assertTrue(
                extract._looks_like_block_page(response),
                f"expected block detection to catch: {body[:80]}...",
            )

    def test_block_page_markers_catch_scopus_preview(self):
        response = MagicMock()
        response.text = "<html><head><title>Scopus preview - Author details</title></head><body>Sign in to view full profile</body></html>"
        response.headers = {}
        self.assertTrue(extract._looks_like_block_page(response))

    def test_unsupported_domain_raises_before_network(self):
        for url in (
            "https://www.scopus.com/authid/detail.uri?authorId=7004212771",
            "https://scopus.com/record/display.uri?eid=123",
            "https://www.webofscience.com/wos/author/record/917221",
        ):
            with self.assertRaisesRegex(RuntimeError, "auth-wall"):
                extract.fetch(url)

    def test_rejects_form_labels_as_name(self):
        for label in ("Email address", "E-Mail", "Password", "Username", "Sign in"):
            html = f"<html><head><title>{label}</title></head><body></body></html>"
            self.assertIsNone(
                rules.extract_name(html),
                f"expected {label!r} to be rejected as a person name",
            )

    def test_rejects_warning_placeholder_avatar(self):
        html = """
        <html>
          <body>
            <img src="/static/images/warning_small.gif" alt="avatar" />
            <img src="/static/images/no-photo.png" alt="portrait" />
          </body>
        </html>
        """
        self.assertIsNone(rules.extract_avatar(html, "https://www.scopus.com/foo"))

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

    def test_extract_phone_numbers_separates_mobile_and_landline(self):
        html = """
        <html>
          <body>
            <div>手机：138 0000 0000</div>
            <div>办公电话：021-55270127</div>
          </body>
        </html>
        """

        numbers = rules.extract_phone_numbers(html)

        self.assertEqual(numbers["phone"], "138 0000 0000")
        self.assertEqual(numbers["tel"], "021-55270127")

    def test_extract_phone_numbers_ignores_year_and_page_ranges(self):
        html = """
        <html>
          <body>
            <div>2014-2023</div>
            <div>16080-16095</div>
            <div>12991-13005 15</div>
          </body>
        </html>
        """

        numbers = rules.extract_phone_numbers(html)

        self.assertIsNone(numbers["phone"])
        self.assertIsNone(numbers["tel"])

    def test_extract_phone_numbers_ignores_embedded_codes_and_encrypted_fragments(self):
        html = """
        <html>
          <body>
            <div>项目编号 DP190103660</div>
            <div>63bd6f98022566ff065613408ba95e6591d0</div>
            <div>电话：021-55270127</div>
          </body>
        </html>
        """

        numbers = rules.extract_phone_numbers(html)

        self.assertIsNone(numbers["phone"])
        self.assertEqual(numbers["tel"], "021-55270127")

    def test_extract_email_ignores_asset_version_like_fake_email(self):
        html = """
        <html>
          <body>
            <div>fontawesome-free@6.7.1</div>
            <div>Email: real.person@example.edu</div>
          </body>
        </html>
        """

        self.assertEqual(rules.extract_email(html), "real.person@example.edu")

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
    @patch("llm_client._model", return_value="qwen-plus")
    def test_llm_client_uses_json_mode_and_disables_thinking_for_qwen(self, mock_model, mock_client_factory):
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
        self.assertEqual(kwargs["model"], "qwen-plus")
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
        self.assertEqual(data["countryCode"], 86)
        self.assertEqual(data["province"], 9)
        self.assertEqual(data["domain"], 8)
        self.assertEqual(data["professional"], 2)
        self.assertEqual(data["title"], 32)
        self.assertEqual(data["tags"], "8,21")

    @patch("extract.fetch")
    @patch("llm_client.call_llm")
    def test_extract_profile_splits_mobile_and_landline_into_phone_and_tel(
        self,
        mock_call_llm,
        mock_fetch,
    ):
        html = """
        <html>
          <head><title>张三</title></head>
          <body>
            <main>
              <div>手机：13800000000</div>
              <div>办公电话：021-55270127</div>
            </main>
          </body>
        </html>
        """
        mock_fetch.return_value = (html, "https://example.cn/profile")
        mock_call_llm.return_value = {
            "surname": "张三",
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
            "contact": None,
            "content": None,
            "academic": None,
            "journal": None,
            "title": None,
            "tags": None,
        }

        result = extract.extract_profile("https://example.cn/profile")
        data = result["data"]

        self.assertEqual(data["country"], 1)
        self.assertEqual(data["countryCode"], 86)
        self.assertEqual(data["phone"], "13800000000")
        self.assertEqual(data["tel"], "021-55270127")

    @patch("extract.fetch")
    @patch("llm_client.call_llm")
    def test_extract_profile_rejects_non_profile_pages_with_only_noise_identity_signals(
        self,
        mock_call_llm,
        mock_fetch,
    ):
        html = """
        <html>
          <head><title>百度一下，你就知道</title></head>
          <body>
            <img src="https://pss.bdstatic.com/static/superman/img/topnav/newfanyi-da0cea8f7e.png" />
            <div>营销推广</div>
            <div>66666667</div>
            <div>3785693112</div>
          </body>
        </html>
        """
        mock_fetch.return_value = (html, "http://baidu.com")
        mock_call_llm.return_value = {
            "surname": "营销推广",
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
            "contact": None,
            "content": None,
            "academic": None,
            "journal": None,
            "title": None,
            "tags": None,
        }

        with self.assertRaisesRegex(ValueError, "Insufficient expert-profile evidence"):
            extract.extract_profile("http://baidu.com")

    @patch("extract.fetch")
    @patch("llm_client.call_llm")
    def test_extract_profile_rejects_completely_empty_payload(
        self,
        mock_call_llm,
        mock_fetch,
    ):
        html = """
        <html>
          <head><title>Empty page</title></head>
          <body><main><div>No profile here</div></main></body>
        </html>
        """
        mock_fetch.return_value = (html, "https://example.com")
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
            "contact": None,
            "content": None,
            "academic": None,
            "journal": None,
            "title": None,
            "tags": None,
        }

        with self.assertRaisesRegex(ValueError, "Insufficient expert-profile evidence"):
            extract.extract_profile("https://example.com")


if __name__ == "__main__":
    unittest.main()
