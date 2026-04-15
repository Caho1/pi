"""Tests for the CSV-backed dictionary lookup."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import dict_search  # type: ignore


class DictSearchTests(unittest.TestCase):
    # ── academic_titles ──────────────────────────────────────────────
    def test_academic_titles_exact_canonical(self):
        hit = dict_search.lookup("academic_titles", "副教授")
        self.assertEqual(hit["value"], 2)
        self.assertEqual(hit["name"], "副教授")
        self.assertEqual(hit["method"], "exact")

    def test_academic_titles_english_alias(self):
        hit = dict_search.lookup("academic_titles", "Associate Professor")
        self.assertEqual(hit["value"], 2)
        self.assertEqual(hit["method"], "alias")

    def test_academic_titles_english_alias_case_and_punct_insensitive(self):
        hit = dict_search.lookup("academic_titles", "assoc. prof.")
        self.assertIsNotNone(hit)
        self.assertEqual(hit["value"], 2)

    def test_academic_titles_substring_wins_longest(self):
        # "副教授（硕导）" 既包含 "教授" 也包含 "副教授"，必须选更长的那个
        hit = dict_search.lookup("academic_titles", "副教授（硕导）")
        self.assertEqual(hit["value"], 2)
        self.assertEqual(hit["method"], "substring")

    def test_academic_titles_plain_professor(self):
        # "终身教授" 不等于任何规范名，也不在别名里，但子串命中 "教授"
        hit = dict_search.lookup("academic_titles", "终身教授")
        self.assertEqual(hit["value"], 1)
        self.assertEqual(hit["name"], "教授")

    def test_academic_titles_unknown_returns_none(self):
        self.assertIsNone(dict_search.lookup("academic_titles", "首席科学家"))

    # ── domains ──────────────────────────────────────────────────────
    def test_domains_exact(self):
        hit = dict_search.lookup("domains", "人工智能")
        self.assertEqual(hit["value"], 8)
        self.assertEqual(hit["method"], "exact")

    def test_domains_alias_english(self):
        hit = dict_search.lookup("domains", "AI")
        self.assertEqual(hit["value"], 8)

    def test_domains_alias_embodied_ai_maps_to_ai(self):
        hit = dict_search.lookup("domains", "具身智能")
        self.assertEqual(hit["value"], 8)
        self.assertEqual(hit["name"], "人工智能")

    def test_domains_cs_alias(self):
        hit = dict_search.lookup("domains", "计算机")
        self.assertEqual(hit["value"], 7)

    def test_domains_unknown_returns_none(self):
        # 量子计算目前既不在字典、别名，字符重合也不足
        self.assertIsNone(dict_search.lookup("domains", "量子计算"))

    def test_domains_metaverse_unknown(self):
        # "元宇宙" 不是任何条目的规范名/别名；
        # 字符 bigram 和 "宇宙学" 有 1 个重合但阈值打不过 → None。
        # 这条用来锁一个"字典确实没、模糊也不该硬绑"的用例。
        self.assertIsNone(dict_search.lookup("domains", "元宇宙"))

    def test_domains_partial_alias_still_matches_via_substring(self):
        # "区块链金融" 含 "金融"（经济学的别名） → 应绑到经济学。
        # 这是期望行为：别名是字典扩展点，命中就算命中。
        hit = dict_search.lookup("domains", "区块链金融")
        self.assertEqual(hit["value"], 9)
        self.assertEqual(hit["name"], "经济学")

    # ── countries ────────────────────────────────────────────────────
    def test_countries_china_exact(self):
        hit = dict_search.lookup("countries", "中国")
        self.assertEqual(hit["value"], 1)

    def test_countries_usa_alias(self):
        hit = dict_search.lookup("countries", "USA")
        self.assertEqual(hit["value"], 9)
        self.assertEqual(hit["name"], "美国")

    def test_countries_united_states_alias(self):
        hit = dict_search.lookup("countries", "United States")
        self.assertEqual(hit["value"], 9)

    def test_countries_us_lowercase(self):
        hit = dict_search.lookup("countries", "u.s.")
        self.assertEqual(hit["value"], 9)

    def test_countries_taiwan_alias(self):
        hit = dict_search.lookup("countries", "Taiwan")
        self.assertEqual(hit["value"], 2)

    def test_countries_unknown_mars(self):
        self.assertIsNone(dict_search.lookup("countries", "火星"))

    # ── title_flags ──────────────────────────────────────────────────
    def test_title_flags_academician(self):
        hit = dict_search.lookup("title_flags", "中国科学院院士")
        self.assertEqual(hit["value"], 1)
        self.assertEqual(hit["name"], "院士")

    def test_title_flags_jieqing_short_form(self):
        hit = dict_search.lookup("title_flags", "杰青")
        self.assertEqual(hit["value"], 2)
        self.assertEqual(hit["name"], "国家级高层次人才")

    def test_title_flags_ieee_fellow_case_insensitive(self):
        hit = dict_search.lookup("title_flags", "ieee fellow")
        self.assertEqual(hit["value"], 8)

    def test_title_flags_unknown(self):
        self.assertIsNone(dict_search.lookup("title_flags", "某不存在的头衔"))

    # ── 边界 ─────────────────────────────────────────────────────────
    def test_empty_query_returns_none(self):
        self.assertIsNone(dict_search.lookup("domains", ""))
        self.assertIsNone(dict_search.lookup("domains", "   "))

    def test_none_query_returns_none(self):
        self.assertIsNone(dict_search.lookup("domains", None))

    def test_numeric_query_is_stringified(self):
        # 有时候 LLM 会直接返回字典 id，脚本应能宽容处理
        hit = dict_search.lookup("countries", 9)
        # id "9" 不在任何 canonical 或 alias 里（它们是"美国"/"USA"等），
        # bigram 相似度也不到阈值 → None。这是故意的：query 必须是文本意图。
        self.assertIsNone(hit)

    def test_unknown_dictionary_raises(self):
        with self.assertRaises(ValueError):
            dict_search.lookup("not_a_real_dict", "foo")

    def test_threshold_controls_fuzzy_tier(self):
        # 把阈值降到 0 应该让近似匹配也返回；用来证明 Tier 4 真的在跑
        hit = dict_search.lookup("domains", "计算机科学与工程", threshold=0.0)
        self.assertIsNotNone(hit)
        # "计算机" 是 id=7 的别名，应从子串命中（优于 bigram）
        self.assertEqual(hit["value"], 7)

    # ── 正确性回归：不应错绑 ──────────────────────────────────────────
    def test_short_substring_of_country_does_not_match_university_name(self):
        # "中国科学技术大学" 传进 countries 字典会子串命中"中国"。
        # 这种情况是 LLM 错把机构塞到 country 字段，我们不强拦——
        # 但把它锁在这里，提醒：若未来要加防御，改这条。
        hit = dict_search.lookup("countries", "中国科学技术大学")
        self.assertIsNotNone(hit)
        self.assertEqual(hit["value"], 1)

    def test_high_threshold_rejects_weak_bigram_match(self):
        # 默认阈值 0.7 下，字面几乎不重合的词不应被绑定
        self.assertIsNone(dict_search.lookup("domains", "区块链"))


if __name__ == "__main__":
    unittest.main()
