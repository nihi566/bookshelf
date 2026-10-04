"""
test_edge_cases.py
-------------------
純粋なロジック（book_kind / title_resolver / resolver / recommender / bookmeter / crawler の整形関数 /
repository / report / anti_ban / main・run の補助関数）の境界値テスト。

空・None・空白・全角半角・壊れた HTML・空の DB・重複・同時刻・0 除算になりうる値などを入れて、
落ちないこと・契約どおりの値を返すことを確かめる。実ネットワークには一切つながない。

実行:
    python -m pytest -q test/test_edge_cases.py
"""

import asyncio
import io
import json
import os
import random
import shutil
import sys
import tempfile
import unittest
import unittest.mock

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)

from src import anti_ban, book_kind, bookmeter, crawler, recommender, repository, resolver, title_resolver
from src.book_kind import KIND_BOOK, KIND_MANGA

import report


# ─── book_kind ───────────────────────────────────────────────────────────────

class ClassifyKindEdgeTest(unittest.TestCase):
    def test_empty_and_none_are_book(self):
        self.assertEqual(book_kind.classify_kind(""), KIND_BOOK)
        self.assertEqual(book_kind.classify_kind(None), KIND_BOOK)
        self.assertEqual(book_kind.classify_kind("   "), KIND_BOOK)

    def test_label_case_and_width_variants(self):
        for title in (
            "進撃の巨人(1) (講談社コミックス)",
            "ワンピース 1 (ジャンプ COMICS DIGITAL)",
            "作品 (モーニングKC)",
            "作品 (モーニングｋｃ)",
            "作品 (モーニングＫＣ)",
            "作品 (MFC)",
            "作品 (ＭＦＣ)",
            "作品【タテヨミ】",
            "作品 WEBTOON",
        ):
            with self.subTest(title=title):
                self.assertEqual(book_kind.classify_kind(title), KIND_MANGA)

    def test_kc_inside_english_word_is_not_manga(self):
        for title in ("Backend入門", "KCAL計算の本", "mfcc音声処理"):
            with self.subTest(title=title):
                self.assertEqual(book_kind.classify_kind(title), KIND_BOOK)

    def test_manga_word_alone_is_book(self):
        self.assertEqual(book_kind.classify_kind("マンガの原理"), KIND_BOOK)


# ─── resolver / title_resolver ───────────────────────────────────────────────

class AsinHelpersEdgeTest(unittest.TestCase):
    def test_is_kindle_asin_boundaries(self):
        self.assertTrue(resolver.is_kindle_asin("B0ABCDEFGH"))
        self.assertFalse(resolver.is_kindle_asin(""))
        self.assertFalse(resolver.is_kindle_asin("b0abcdefgh"))
        self.assertFalse(resolver.is_kindle_asin("B0ABCDEFG"))
        self.assertFalse(resolver.is_kindle_asin("B0ABCDEFGHI"))
        self.assertFalse(resolver.is_kindle_asin("4845925230"))
        self.assertFalse(resolver.is_kindle_asin("B0ABCDEFGH\n"))

    def test_extract_asin_from_url(self):
        self.assertEqual(resolver.extract_asin_from_url("https://www.amazon.co.jp/dp/B0ABCDEFGH?ref=x"), "B0ABCDEFGH")
        self.assertEqual(resolver.extract_asin_from_url("/gp/product/B0ABCDEFGH/"), "B0ABCDEFGH")
        self.assertIsNone(resolver.extract_asin_from_url(""))
        self.assertIsNone(resolver.extract_asin_from_url("https://example.com/"))


class BuildKindleSearchUrlEdgeTest(unittest.TestCase):
    def test_special_characters_are_encoded(self):
        url = title_resolver.build_kindle_search_url("A&B=C #1 / ?", "著者")
        query = url.split("k=", 1)[1].split("&i=", 1)[0]
        for raw in ("&", "=", "#", "?", " "):
            self.assertNotIn(raw, query)
        self.assertTrue(url.endswith("&i=digital-text"))

    def test_blank_author_is_ignored(self):
        self.assertEqual(
            title_resolver.build_kindle_search_url("本", "   "),
            title_resolver.build_kindle_search_url("本"),
        )


def _search_page(inner: str, after: str = "") -> str:
    return f'<html><body><div class="s-main-slot">{inner}</div>{after}</body></html>'


class ParseKindleSearchResultsEdgeTest(unittest.TestCase):
    def test_empty_and_garbage_input(self):
        self.assertEqual(title_resolver.parse_kindle_search_results(""), [])
        self.assertEqual(title_resolver.parse_kindle_search_results("<<<>>>"), [])
        self.assertEqual(title_resolver.parse_kindle_search_results("<div data-asin='B0AAAAAAAA'>x</div>"), [])

    def test_lowercase_and_padded_asin_is_normalized_and_deduplicated(self):
        html = _search_page(
            '<div data-asin=" b0aaaaaaaa ">A</div>'
            '<div data-asin="B0AAAAAAAA">A again</div>'
            '<div data-asin="4800000000">paper</div>'
            '<div data-asin="">empty</div>'
        )
        self.assertEqual(title_resolver.parse_kindle_search_results(html), ["B0AAAAAAAA"])

    def test_unclosed_container_does_not_crash(self):
        html = '<div class="s-main-slot"><div data-asin="B0AAAAAAAA">A'
        self.assertEqual(title_resolver.parse_kindle_search_results(html), ["B0AAAAAAAA"])

    def test_unclosed_inline_tag_in_card_does_not_extend_container(self):
        # カード内の閉じ忘れ（<p> / <li> は終了タグが省略されがち）でスタックがずれると、
        # コンテナの外のカルーセルまで候補に入ってしまう
        html = _search_page(
            '<div data-asin="B0AAAAAAAA"><p>本の説明</div>',
            after='<div class="carousel"><div data-asin="B0ZZZZZZZZ">関連商品</div></div>',
        )
        self.assertEqual(title_resolver.parse_kindle_search_results(html), ["B0AAAAAAAA"])

    def test_stray_end_tag_does_not_close_container_early(self):
        html = _search_page(
            '<div data-asin="B0AAAAAAAA">A</span></div>'
            '<div data-asin="B0BBBBBBBB">B</div>'
        )
        self.assertEqual(title_resolver.parse_kindle_search_results(html), ["B0AAAAAAAA", "B0BBBBBBBB"])

    def test_sponsored_wrapper_and_text(self):
        html = _search_page(
            '<div class="AdHolder"><div data-asin="B0SSSSSSSS">ad</div></div>'
            '<div data-asin="B0TTTTTTTT"><span>スポンサー</span></div>'
            '<div data-asin="B0OKOKOKOK">ok</div>'
        )
        self.assertEqual(title_resolver.parse_kindle_search_results(html), ["B0OKOKOKOK"])

    def test_pick_asin_respects_ban_signal(self):
        html = _search_page('<div data-asin="B0AAAAAAAA">A</div>')
        self.assertIsNone(title_resolver._pick_asin_from_search(html, "captcha"))
        self.assertEqual(title_resolver._pick_asin_from_search(html, "ok"), "B0AAAAAAAA")
        self.assertIsNone(title_resolver._pick_asin_from_search("", "ok"))

    def test_blank_title_returns_none_without_browser(self):
        self.assertIsNone(asyncio.run(title_resolver.resolve_title_to_paid_asin("   ")))
        self.assertIsNone(asyncio.run(title_resolver.resolve_title_to_paid_asin("")))


# ─── crawler の整形関数 ──────────────────────────────────────────────────────

class CrawlerCleanersEdgeTest(unittest.TestCase):
    def test_clean_price(self):
        self.assertIsNone(crawler.clean_price(""))
        self.assertIsNone(crawler.clean_price(None))
        self.assertIsNone(crawler.clean_price("価格なし"))
        self.assertEqual(crawler.clean_price("￥0"), 0)
        self.assertEqual(crawler.clean_price("￥ 1,234"), 1234)
        self.assertEqual(crawler.clean_price("¥1,234,567"), 1234567)

    def test_clean_price_full_width_digits(self):
        self.assertEqual(crawler.clean_price("￥１，２３４"), 1234)

    def test_clean_points(self):
        self.assertEqual(crawler.clean_points(""), 0)
        self.assertEqual(crawler.clean_points(None), 0)
        self.assertEqual(crawler.clean_points("ポイントなし"), 0)
        self.assertEqual(crawler.clean_points("1,000ポイント"), 1000)
        self.assertEqual(crawler.clean_points("25pt (1%)"), 25)

    def test_clean_points_comma_before_digits_does_not_crash(self):
        self.assertEqual(crawler.clean_points("獲得, 25pt"), 25)
        self.assertEqual(crawler.clean_points(",25pt"), 25)

    def test_clean_points_full_width_digits(self):
        self.assertEqual(crawler.clean_points("１，０００ポイント"), 1000)

    def test_clean_campaign(self):
        self.assertEqual(crawler.clean_campaign(None), "")
        self.assertEqual(crawler.clean_campaign("  a\n\t b　c "), "a b c")

    def test_classify_unpriced(self):
        self.assertIsNone(crawler.classify_unpriced(0, 404))
        self.assertEqual(crawler.classify_unpriced(None, 404), "not_found")
        self.assertEqual(crawler.classify_unpriced(None, 503), "page_error")
        self.assertEqual(crawler.classify_unpriced(None, 400), "page_error")
        self.assertEqual(crawler.classify_unpriced(None, 200), "no_price")
        self.assertEqual(crawler.classify_unpriced(None, None), "no_price")


# ─── bookmeter ───────────────────────────────────────────────────────────────

class BookmeterParseEdgeTest(unittest.TestCase):
    def test_empty_html(self):
        self.assertEqual(bookmeter.parse_books(""), [])

    def test_missing_title_and_author(self):
        html = (
            '<li class="group__book"><div class="detail__title"></div></li>'
            '<li class="group__book"><div class="detail__title"><a href="/books/9">書名</a></div></li>'
        )
        self.assertEqual(bookmeter.parse_books(html), [{"title": "書名", "author": "", "bookmeter_id": "9"}])

    def test_multiple_authors_and_entities(self):
        html = (
            '<li class="group__book"><div class="detail__title"><a href="https://bookmeter.com/books/12">A &amp; B</a></div>'
            '<ul class="detail__authors"><li><a>著者1</a></li><li><a>著者2</a></li></ul></li>'
        )
        self.assertEqual(
            bookmeter.parse_books(html), [{"title": "A & B", "author": "著者1、著者2", "bookmeter_id": "12"}]
        )

    def test_bookmeter_id_rejects_other_hosts_and_queries(self):
        self.assertEqual(bookmeter._bookmeter_id(""), "")
        self.assertEqual(bookmeter._bookmeter_id(" /books/123 "), "123")
        self.assertEqual(bookmeter._bookmeter_id("https://evil.example/books/123"), "")
        self.assertEqual(bookmeter._bookmeter_id("/books/123?x=1"), "")
        self.assertEqual(bookmeter._bookmeter_id("/books/1234567890123"), "")

    def test_truncated_title_uses_alt_only_when_continuation(self):
        def item(link, alt):
            return (
                '<li class="group__book"><div class="thumbnail__cover"><img alt="%s"></div>'
                '<div class="detail__title"><a href="/books/1">%s</a></div></li>' % (alt, link)
            )
        self.assertEqual(bookmeter.parse_books(item("長い書名…", "長い書名の続き"))[0]["title"], "長い書名の続き")
        self.assertEqual(bookmeter.parse_books(item("長い書名…", "別の本"))[0]["title"], "長い書名…")
        self.assertEqual(bookmeter.parse_books(item("長い書名…", ""))[0]["title"], "長い書名…")
        self.assertEqual(bookmeter.parse_books(item("短い", "短い書名"))[0]["title"], "短い")

    def test_next_page_url(self):
        self.assertIsNone(bookmeter.get_next_page_url("", "https://bookmeter.com/x"))
        self.assertIsNone(bookmeter.get_next_page_url('<a rel="next">次</a>', "https://bookmeter.com/x"))
        self.assertEqual(
            bookmeter.get_next_page_url('<a rel="nofollow next" href="?page=2">次</a>', "https://bookmeter.com/x"),
            "https://bookmeter.com/x?page=2",
        )

    def test_fetch_stops_when_next_points_to_itself(self):
        page = '<li class="group__book"><div class="detail__title"><a href="/books/1">A</a></div></li><a rel="next" href="">次</a>'
        page_self = page.replace('href=""', 'href="https://bookmeter.com/w"')
        calls = []

        def fake_get(url, timeout=None):
            calls.append(url)
            resp = unittest.mock.MagicMock()
            resp.text = page_self
            resp.encoding = "utf-8"
            return resp

        with unittest.mock.patch("requests.Session.get", side_effect=fake_get), \
             unittest.mock.patch("time.sleep", return_value=None):
            books = bookmeter.fetch_wish_books("https://bookmeter.com/w", max_pages=5)
        self.assertEqual(len(calls), 1)
        self.assertEqual([b["title"] for b in books], ["A"])

    def test_fetch_max_pages_zero_does_not_request(self):
        with unittest.mock.patch("requests.Session.get") as get:
            self.assertEqual(bookmeter.fetch_wish_books("https://bookmeter.com/w", max_pages=0), [])
        get.assert_not_called()

    def test_builtin_self_test_passes(self):
        out = io.StringIO()
        with unittest.mock.patch("sys.stdout", out):
            try:
                bookmeter._run_builtin_test()
            except SystemExit as e:  # pragma: no cover - 失敗時の分かりやすい表示用
                self.fail(f"内蔵テストが失敗しました: {out.getvalue()} ({e})")
        self.assertIn("PASSED", out.getvalue())


# ─── recommender ─────────────────────────────────────────────────────────────

def _inputs(seen=(), unwanted=(), candidates=()):
    return {"seen": list(seen), "unwanted": list(unwanted), "candidates": list(candidates)}


class RecommenderEdgeTest(unittest.TestCase):
    def test_normalize_title(self):
        self.assertEqual(recommender._normalize_title(None), "")
        self.assertEqual(recommender._normalize_title(" a　b\tc "), "abc")

    def test_collect_inputs_empty(self):
        self.assertEqual(recommender.collect_inputs([], {}, KIND_BOOK), {"seen": [], "unwanted": [], "candidates": []})

    def test_collect_inputs_negative_max_candidates(self):
        books = [{"asin": "B0AAAAAAAA", "title": "本A"}]
        self.assertEqual(recommender.collect_inputs(books, {}, KIND_BOOK, max_candidates=-1)["candidates"], [])

    def test_collect_inputs_dedups_titles_differing_only_in_whitespace(self):
        books = [
            {"asin": "B0AAAAAAAA", "title": "同じ 本"},
            {"asin": "B0BBBBBBBB", "title": "同じ　本"},
            {"asin": None, "title": "ASINなし"},
            {"asin": "B0CCCCCCCC", "title": None},
        ]
        result = recommender.collect_inputs(books, {}, KIND_BOOK, rng=random.Random(0))
        self.assertEqual(len(result["candidates"]), 1)

    def test_collect_inputs_rating_ties_sorted_by_title(self):
        marks = {
            "B0AAAAAAAA": {"tag": "seen", "rating": 5, "title": "い", "updated_at": "2026-01-01"},
            "B0BBBBBBBB": {"tag": "seen", "rating": 5, "title": "あ", "updated_at": "2026-01-02"},
            "B0CCCCCCCC": {"tag": "seen", "rating": None, "title": "う", "updated_at": None},
        }
        seen = recommender.collect_inputs([], marks, KIND_BOOK)["seen"]
        self.assertEqual([s["title"] for s in seen], ["あ", "い", "う"])

    def test_summarize_seen_with_unknown_kind(self):
        marks = {"B0AAAAAAAA": {"tag": "seen", "rating": 3, "kind": "anime", "title": "作品 (KC)"}}
        summary = recommender.summarize_seen([], marks)
        self.assertEqual(summary[KIND_MANGA], {"seen": 1, "rated": 1})
        self.assertEqual(summary[KIND_BOOK], {"seen": 0, "rated": 0})

    def test_build_messages_with_zero_counts(self):
        inputs = _inputs(seen=[{"asin": "B0A", "title": "本", "rating": None}], candidates=[{"asin": "B0C", "title": "候補"}])
        content = recommender.build_messages(KIND_BOOK, inputs, count=0, new_count=0)[1]["content"]
        self.assertIn("from_list は空の配列にする", content)
        self.assertIn("new_titles は空の配列にする", content)
        self.assertNotIn("[B0C]", content)

    def test_load_llm_settings_defaults_and_trailing(self):
        settings = recommender.load_llm_settings({})
        self.assertEqual((settings["api"], settings["url"], settings["model"]), ("ollama", recommender.DEFAULT_LLM_URL, None))
        settings = recommender.load_llm_settings({"LOCAL_LLM_API": " OpenAI ", "LOCAL_LLM_URL": "http://h:1/v1/"})
        self.assertEqual((settings["api"], settings["url"]), ("openai", "http://h:1"))
        with self.assertRaises(recommender.LocalLlmError):
            recommender.load_llm_settings({"LOCAL_LLM_API": "claude"})

    def test_load_llm_settings_blank_values_use_defaults(self):
        settings = recommender.load_llm_settings({"LOCAL_LLM_API": "  ", "LOCAL_LLM_URL": "  ", "LOCAL_LLM_MODEL": " "})
        self.assertEqual(settings["api"], "ollama")
        self.assertEqual(settings["url"], recommender.DEFAULT_LLM_URL)
        self.assertIsNone(settings["model"])

    def test_extract_json_object_variants(self):
        self.assertIsNone(recommender._extract_json_object(""))
        self.assertIsNone(recommender._extract_json_object("[1, 2]"))
        self.assertEqual(recommender._extract_json_object('前置き ```json\n{"a": 1}\n``` 後置き'), {"a": 1})
        self.assertEqual(recommender._extract_json_object('はい: {"a": {"b": 2}} 以上'), {"a": {"b": 2}})

    def test_is_known_title_short_substring_is_not_known(self):
        known = {recommender._normalize_title("ワンピース")}
        self.assertTrue(recommender._is_known_title("ワンピース 100", known))
        self.assertFalse(recommender._is_known_title("ワン", known))

    def test_parse_recommendations_non_list_fields_do_not_crash(self):
        inputs = _inputs(candidates=[{"asin": "B0AAAAAAAA", "title": "候補"}])
        for payload in (
            {"taste": 1, "from_list": 5, "new_titles": 3},
            {"taste": None, "from_list": {"asin": "B0AAAAAAAA"}, "new_titles": "タイトル"},
            {"taste": "x", "from_list": True, "new_titles": 1.5},
        ):
            with self.subTest(payload=payload):
                result = recommender.parse_recommendations(json.dumps(payload), inputs, count=3, new_count=3)
                self.assertEqual(result["from_list"], [])
                self.assertEqual(result["new_titles"], [])

    def test_parse_recommendations_validates_and_dedups(self):
        inputs = _inputs(
            seen=[{"asin": "B0SEEN0000", "title": "既読の本", "rating": 5}],
            candidates=[{"asin": "B0AAAAAAAA", "title": "候補 本"}, {"asin": "B0BBBBBBBB", "title": "候補2"}],
        )
        text = json.dumps({
            "taste": " 好み\n傾向 ",
            "from_list": [
                {"asin": "[b0aaaaaaaa]", "reason": "r1"},
                {"asin": "B0AAAAAAAA", "reason": "dup"},
                {"asin": "B0NOTEXIST", "reason": "x"},
                {"asin": "", "title": "候補2", "reason": "by title"},
                "not a dict",
            ],
            "new_titles": [
                {"title": "既読の本"},
                {"title": "  新しい本 ", "author": None, "reason": 3},
                {"title": "新しい本"},
                {"title": ""},
            ],
        })
        result = recommender.parse_recommendations(text, inputs, count=5, new_count=5)
        self.assertEqual(result["taste"], "好み 傾向")
        self.assertEqual([i["asin"] for i in result["from_list"]], ["B0AAAAAAAA", "B0BBBBBBBB"])
        self.assertEqual(result["new_titles"], [{"title": "新しい本", "author": "", "reason": ""}])

    def test_parse_recommendations_empty_title_does_not_match_blank_candidate(self):
        inputs = _inputs(candidates=[{"asin": "B0AAAAAAAA", "title": "   "}])
        text = json.dumps({"taste": "", "from_list": [{"reason": "なし"}], "new_titles": []})
        self.assertEqual(recommender.parse_recommendations(text, inputs, count=3, new_count=0)["from_list"], [])

    def test_parse_recommendations_unparseable(self):
        result = recommender.parse_recommendations("  not json  ", _inputs(), count=1, new_count=1)
        self.assertEqual(result["raw"], "not json")

    def test_request_recommendations_rejects_malformed_responses(self):
        settings = {"api": "openai", "url": "http://x", "timeout": 1}
        for data in ({}, {"choices": []}, {"choices": [None]}, {"choices": [{"message": {"content": "  "}}]}):
            with self.subTest(data=data):
                http = unittest.mock.MagicMock()
                http.post.return_value.status_code = 200
                http.post.return_value.json.return_value = data
                with self.assertRaises(recommender.LocalLlmError):
                    recommender.request_recommendations([], settings, "m", http=http)

    def test_resolve_model_skips_embed_and_non_string_names(self):
        http = unittest.mock.MagicMock()
        http.get.return_value.status_code = 200
        http.get.return_value.json.return_value = {
            "models": [{"name": None}, {"name": "nomic-embed-text"}, "bad", {"model": "qwen2.5:7b"}]
        }
        settings = {"api": "ollama", "url": "http://x", "model": None, "timeout": 1}
        self.assertEqual(recommender.resolve_model(settings, http=http), "qwen2.5:7b")

    def test_resolve_model_null_models(self):
        http = unittest.mock.MagicMock()
        http.get.return_value.status_code = 200
        http.get.return_value.json.return_value = {"models": None}
        settings = {"api": "ollama", "url": "http://x", "model": None, "timeout": 1}
        with self.assertRaises(recommender.LocalLlmError):
            recommender.resolve_model(settings, http=http)

    def test_format_recommendations_empty_result(self):
        text = recommender.format_recommendations(
            KIND_BOOK, {"taste": "", "from_list": [], "new_titles": [], "raw": None}, model="m", inputs=_inputs()
        )
        self.assertIn("おすすめを取り出せませんでした", text)


# ─── anti_ban ────────────────────────────────────────────────────────────────

class _FakePage:
    def __init__(self, url="https://www.amazon.co.jp/dp/B0AAAAAAAA", title="商品", body_len=1000, raise_title=False):
        self.url = url
        self._title = title
        self._body_len = body_len
        self._raise_title = raise_title

    async def title(self):
        if self._raise_title:
            raise RuntimeError("closed")
        return self._title

    async def evaluate(self, script):
        return self._body_len


class AntiBanEdgeTest(unittest.TestCase):
    def test_get_profile_rotates_for_any_worker_id(self):
        n = len(anti_ban.BROWSER_PROFILES)
        for worker_id in (-1, 0, 1, n, n + 1, 10 ** 6):
            with self.subTest(worker_id=worker_id):
                self.assertIn(anti_ban.get_profile(worker_id), anti_ban.BROWSER_PROFILES)
        self.assertIs(anti_ban.get_profile(1), anti_ban.get_profile(n + 1))

    def test_backoff_unknown_signal(self):
        self.assertEqual(anti_ban.BanCoordinator._get_backoff("ok"), 0.0)
        self.assertEqual(anti_ban.BanCoordinator._get_backoff("weird"), 60.0)

    def test_check_ban_signals(self):
        run = lambda page: asyncio.run(anti_ban.check_ban_signals(page))
        self.assertEqual(run(_FakePage()), "ok")
        self.assertEqual(run(_FakePage(url="https://www.amazon.co.jp/errors/validateCaptcha")), "captcha")
        self.assertEqual(run(_FakePage(title="Robot Check")), "robot_check")
        self.assertEqual(run(_FakePage(body_len=0)), "suspicious")
        # 例外は ok 扱い（呼び出し側を止めない）
        self.assertEqual(run(_FakePage(raise_title=True)), "ok")

    def test_report_ban_keeps_longer_backoff(self):
        async def scenario():
            coordinator = anti_ban.BanCoordinator()
            with unittest.mock.patch("builtins.print"):
                await coordinator.report_ban("captcha")
                first = coordinator._ban_until
                await coordinator.report_ban("suspicious")
            return coordinator, first
        coordinator, first = asyncio.run(scenario())
        self.assertEqual(coordinator._ban_until, first)
        self.assertEqual(coordinator._ban_signal, "captcha")
        self.assertTrue(coordinator.is_banned)

    def test_wait_if_banned_returns_immediately_when_not_banned(self):
        asyncio.run(anti_ban.BanCoordinator().wait_if_banned())


# ─── repository（一時 DB） ─────────────────────────────────────────────────────

class _TempDbTestCase(unittest.TestCase):
    def setUp(self):
        from sqlmodel import SQLModel, create_engine
        import src.database as database_module

        self.tmpdir = tempfile.mkdtemp(prefix="edge_cases_db_")
        self.db_path = os.path.join(self.tmpdir, "edge.db")
        self._database_module = database_module
        self._original_db_path = database_module.DB_PATH
        self._original_engine = database_module.engine
        database_module.DB_PATH = self.db_path
        database_module.engine = create_engine(f"sqlite:///{self.db_path}", connect_args={"check_same_thread": False})
        if self.create_tables:
            SQLModel.metadata.create_all(database_module.engine)

    create_tables = True

    def tearDown(self):
        self._database_module.engine.dispose()
        self._database_module.DB_PATH = self._original_db_path
        self._database_module.engine = self._original_engine
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _add_mapping(self, **fields):
        from src.models import BookMapping
        with self._database_module.get_session() as session:
            session.add(BookMapping(**fields))
            session.commit()


class RepositoryEmptyDbTest(_TempDbTestCase):
    def test_reads_on_empty_db(self):
        self.assertEqual(repository.get_books("all"), [])
        self.assertEqual(repository.get_wanted_books(), [])
        self.assertEqual(repository.get_paid_price_points(), [])
        self.assertEqual(repository.get_all_price_points(), [])
        self.assertEqual(repository.get_price_history("B0AAAAAAAA"), [])
        self.assertEqual(repository.get_purchased_asins(), set())
        self.assertIsNone(repository.get_paid_asin("B0AAAAAAAA"))
        self.assertEqual(repository.get_book_marks(), {})
        self.assertEqual(repository.get_target_prices(), {})
        self.assertEqual(repository.get_unpriced_reasons(), {})
        self.assertEqual(repository.get_bookmeter_asin_overrides(), {})

    def test_get_books_invalid_filter(self):
        for value in ("", "ALL", None, "wanted; DROP TABLE x"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    repository.get_books(value)

    def test_set_flags_on_missing_or_empty_asin(self):
        for func in (repository.set_wanted, repository.set_purchased):
            self.assertFalse(func("", 1))
            self.assertFalse(func(None, 1))
            self.assertFalse(func("B0NOPENOPE", 1))
        self.assertFalse(repository.set_target_price("", 100))
        self.assertFalse(repository.set_target_price("B0NOPENOPE", 100))

    def test_empty_inputs_to_bookmeter_helpers(self):
        self.assertEqual(repository.attach_bookmeter_ids([]), 0)
        self.assertEqual(repository.fix_truncated_bookmeter_titles([]), 0)
        self.assertEqual(repository.fix_truncated_bookmeter_titles(["", None, "切れた…"]), 0)
        self.assertEqual(repository.import_marks([]), {"updated": 0, "deleted": 0, "skipped": []})


class RepositoryEdgeTest(_TempDbTestCase):
    def test_set_wanted_with_null_paid_asin_rows_does_not_touch_them(self):
        self._add_mapping(sample_asin="B0SAMPLE01", paid_asin=None, title="未解決")
        self.assertFalse(repository.set_wanted(None, 1))
        self.assertEqual(repository.get_books("wanted"), [])

    def test_save_price_history_zero_and_none(self):
        repository.save_price_history({"asin": "B0AAAAAAAA", "sell_price": 0})
        repository.save_price_history({"asin": "B0AAAAAAAA", "sell_price": None, "unpriced_reason": "bogus"})
        repository.save_price_history({"asin": "B0BBBBBBBB", "sell_price": None, "unpriced_reason": "no_price"})
        history = repository.get_price_history("B0AAAAAAAA")
        self.assertEqual([h["actual_price"] for h in history], [0, None])
        self.assertEqual(repository.get_unpriced_reasons()["B0BBBBBBBB"]["reason"], "no_price")
        self.assertNotIn("B0AAAAAAAA", repository.get_unpriced_reasons())

    def test_get_books_duplicate_paid_asin_and_latest_price(self):
        from src.models import PriceHistory
        self._add_mapping(paid_asin="B0AAAAAAAA", title="B", is_wanted=1)
        self._add_mapping(paid_asin="B0CCCCCCCC", title="A")
        with self._database_module.get_session() as session:
            session.add(PriceHistory(paid_asin="B0AAAAAAAA", sell_price=500, actual_price=500, timestamp="2026-01-01T00:00:00"))
            session.add(PriceHistory(paid_asin="B0AAAAAAAA", sell_price=400, actual_price=400, timestamp="2026-01-02T00:00:00"))
            session.commit()
        books = repository.get_books("all")
        self.assertEqual([b["title"] for b in books], ["A", "B"])
        self.assertIsNone(books[0]["actual_price"])
        self.assertEqual(books[1]["actual_price"], 400)
        self.assertEqual([b["asin"] for b in repository.get_books("wanted")], ["B0AAAAAAAA"])

    def test_is_fuller_title(self):
        f = repository._is_fuller_title
        self.assertTrue(f("長い書名…", "長い書名の続き"))
        self.assertFalse(f("長い書名…", "長い書名"))
        self.assertFalse(f("長い書名…", "長い書名の…"))
        self.assertFalse(f("完全な書名", "完全な書名の続き"))
        self.assertFalse(f(None, "x"))
        self.assertFalse(f("x…", None))
        self.assertTrue(f("…", "なんでも"))

    def test_valid_bookmeter_id(self):
        self.assertTrue(repository._valid_bookmeter_id("1"))
        for value in ("", None, 123, "12a", "1" * 13, "１２３", "1\n"):
            with self.subTest(value=value):
                self.assertFalse(repository._valid_bookmeter_id(value))

    def test_attach_bookmeter_ids_ambiguous_title(self):
        self._add_mapping(paid_asin="B0AAAAAAAA", title="同名", source="bookmeter")
        books = [{"title": "同名", "bookmeter_id": "1"}, {"title": "同名", "bookmeter_id": "2"}]
        self.assertEqual(repository.attach_bookmeter_ids(books), 0)
        books = [{"title": "同名", "bookmeter_id": "1"}, {"title": "同名", "bookmeter_id": "1"}]
        self.assertEqual(repository.attach_bookmeter_ids(books), 1)

    def test_fix_truncated_titles_ambiguous(self):
        self._add_mapping(paid_asin="B0AAAAAAAA", title="シリーズ…", source="bookmeter")
        self.assertEqual(repository.fix_truncated_bookmeter_titles(["シリーズ 1", "シリーズ 2"]), 0)
        self.assertEqual(repository.fix_truncated_bookmeter_titles(["シリーズ 1", "シリーズ 1"]), 1)

    def test_get_or_create_rejects_empty_asin(self):
        with self._database_module.get_session() as session:
            for value in ("", None):
                with self.assertRaises(ValueError):
                    repository.get_or_create_by_paid_asin(session, value)

    def test_set_bookmeter_asin_validation_and_strip(self):
        for title, asin in (("", "B0AAAAAAAA"), ("  ", "B0AAAAAAAA"), (None, "B0AAAAAAAA"), ("本", "b0aaaaaaaa"), ("本", None), ("本", "B0AAAAAAA")):
            with self.subTest(title=title, asin=asin):
                with self.assertRaises(ValueError):
                    repository.set_bookmeter_asin(title, asin)
        repository.set_bookmeter_asin("  本  ", "B0AAAAAAAA")
        repository.set_bookmeter_asin("本", "B0BBBBBBBB")
        self.assertEqual(repository.get_bookmeter_asin_overrides(), {"本": "B0BBBBBBBB"})

    def test_set_target_price_zero_and_clear(self):
        self._add_mapping(paid_asin="B0AAAAAAAA", title="本")
        self.assertTrue(repository.set_target_price("B0AAAAAAAA", 0))
        self.assertEqual(repository.get_target_prices(), {"B0AAAAAAAA": 0})
        self.assertTrue(repository.set_target_price("B0AAAAAAAA", None))
        self.assertEqual(repository.get_target_prices(), {})
        self.assertTrue(repository.set_target_price("B0AAAAAAAA", None))


class ImportMarksEdgeTest(_TempDbTestCase):
    def test_normalize_mark_item_rejections(self):
        bad = [
            None, [], "B0AAAAAAAA",
            {"asin": "b0aaaaaaaa", "tag": "seen"},
            {"asin": "B0AAAAAAAA "},
            {"asin": "B0AAAAAAAA"},
            {"asin": "B0AAAAAAAA", "tag": "liked"},
            {"asin": "B0AAAAAAAA", "tag": ["seen"]},
            {"asin": "B0AAAAAAAA", "tag": "seen", "rating": 0},
            {"asin": "B0AAAAAAAA", "tag": "seen", "rating": 6},
            {"asin": "B0AAAAAAAA", "tag": "seen", "rating": True},
            {"asin": "B0AAAAAAAA", "tag": "seen", "rating": 4.5},
            {"asin": "B0AAAAAAAA", "tag": "seen", "rating": "5"},
            {"asin": "B0AAAAAAAA", "kind": "anime"},
            {"asin": "B0AAAAAAAA", "kind": ["manga"]},
        ]
        for item in bad:
            with self.subTest(item=item):
                self.assertIsInstance(repository._normalize_mark_item(item), str)

    def test_normalize_mark_item_title_and_rating_handling(self):
        item = repository._normalize_mark_item(
            {"asin": "B0AAAAAAAA", "tag": "wanted", "rating": 5, "title": "  " + "あ" * 400}
        )
        self.assertIsNone(item["rating"])
        self.assertEqual(len(item["title"]), 300)
        item = repository._normalize_mark_item({"asin": "B0AAAAAAAA", "tag": None, "title": repository.UNKNOWN_TITLE})
        self.assertEqual(item["tag"], "")
        self.assertIsNone(item["title"])
        item = repository._normalize_mark_item({"asin": "B0AAAAAAAA", "tag": "seen", "title": 123})
        self.assertIsNone(item["title"])

    def test_import_marks_duplicates_last_wins_and_delete(self):
        result = repository.import_marks([
            {"asin": "B0AAAAAAAA", "tag": "seen", "rating": 2},
            {"asin": "B0AAAAAAAA", "tag": "seen", "rating": 5},
            {"asin": "bad"},
        ])
        self.assertEqual((result["updated"], len(result["skipped"])), (1, 1))
        self.assertEqual(repository.get_book_marks()["B0AAAAAAAA"]["rating"], 5)
        result = repository.import_marks([{"asin": "B0AAAAAAAA", "tag": ""}])
        self.assertEqual(result["deleted"], 1)
        self.assertEqual(repository.get_book_marks(), {})
        # 無い行を消そうとしても数えない
        self.assertEqual(repository.import_marks([{"asin": "B0AAAAAAAA", "tag": ""}])["deleted"], 0)

    def test_import_marks_kind_same_as_auto_is_not_stored(self):
        self._add_mapping(paid_asin="B0AAAAAAAA", title="作品 (KC)")
        result = repository.import_marks([{"asin": "B0AAAAAAAA", "kind": "manga"}])
        self.assertEqual(result["updated"], 0)
        repository.import_marks([{"asin": "B0AAAAAAAA", "kind": "book"}])
        self.assertEqual(repository.get_book_marks()["B0AAAAAAAA"]["kind"], "book")
        # kind だけの書き出しは tag を変えない / tag だけの書き出しは kind を変えない
        repository.import_marks([{"asin": "B0AAAAAAAA", "tag": "seen", "rating": 4}])
        mark = repository.get_book_marks()["B0AAAAAAAA"]
        self.assertEqual((mark["tag"], mark["rating"], mark["kind"]), ("seen", 4, "book"))


class RepositoryNoTablesTest(_TempDbTestCase):
    """create_all 前（DB ファイルはあるがテーブルが無い）でも読み取り専用の経路が落ちないこと。"""

    create_tables = False

    def test_optional_tables_missing(self):
        self.assertEqual(repository.get_book_marks(), {})
        self.assertEqual(repository.get_target_prices(), {})
        self.assertEqual(repository.get_unpriced_reasons(), {})
        self.assertEqual(repository.get_bookmeter_asin_overrides(), {})

    def test_migrate_on_missing_file_and_missing_table(self):
        repository.migrate_book_mappings_schema(os.path.join(self.tmpdir, "nope.db"))
        self.assertFalse(os.path.exists(os.path.join(self.tmpdir, "nope.db")))
        repository.migrate_book_mappings_schema(self.db_path)  # book_mappings 無し: 何もしない
        self.assertIsNone(repository.backup_database(os.path.join(self.tmpdir, "nope.db")))


# ─── report ──────────────────────────────────────────────────────────────────

class ReportEdgeTest(unittest.TestCase):
    def test_summarize_price_changes_empty_and_flat(self):
        self.assertEqual(report.summarize_price_changes([]), {})
        points = [{"paid_asin": "A", "actual_price": 500, "timestamp": f"2026-01-0{i}"} for i in (1, 2, 3)]
        self.assertEqual(
            report.summarize_price_changes(points)["A"], {"prev": None, "changed_at": None, "low": 500, "low_at": None}
        )

    def test_summarize_price_changes_tie_with_low_keeps_first_low_at(self):
        points = [
            {"paid_asin": "A", "actual_price": 500, "timestamp": "t1"},
            {"paid_asin": "A", "actual_price": 300, "timestamp": "t2"},
            {"paid_asin": "A", "actual_price": 400, "timestamp": "t3"},
            {"paid_asin": "A", "actual_price": 300, "timestamp": "t4"},
        ]
        s = report.summarize_price_changes(points)["A"]
        self.assertEqual(s, {"prev": 400, "changed_at": "t4", "low": 300, "low_at": "t2"})

    def test_summarize_price_changes_zero_price(self):
        points = [
            {"paid_asin": "A", "actual_price": 100, "timestamp": "t1"},
            {"paid_asin": "A", "actual_price": 0, "timestamp": "t2"},
        ]
        self.assertEqual(report.summarize_price_changes(points)["A"]["low"], 0)

    def test_summarize_price_history_limit(self):
        points = [
            {"paid_asin": "A", "actual_price": i, "is_unlimited": 0, "campaign_text": None, "timestamp": str(i)}
            for i in range(5)
        ]
        history = report.summarize_price_history(points, limit=2)["A"]
        self.assertEqual([r["at"] for r in history], ["3", "4"])
        self.assertNotIn("campaign", history[0])
        ku = report.summarize_price_history(
            [{"paid_asin": "A", "actual_price": 0, "is_unlimited": 1, "campaign_text": "読み放題", "timestamp": "t"}]
        )["A"][0]
        self.assertEqual(ku, {"at": "t", "price": None, "ku": True})

    def test_resolve_mark_invalid_values(self):
        for mark, expected in (
            (None, (KIND_BOOK, "", None)),
            ({"kind": "anime", "tag": "bogus", "rating": 5}, (KIND_BOOK, "", None)),
            ({"tag": "seen", "rating": True}, (KIND_BOOK, "seen", None)),
            ({"tag": "seen", "rating": 9}, (KIND_BOOK, "seen", None)),
            ({"tag": "wanted", "rating": 4}, (KIND_BOOK, "wanted", None)),
            ({"tag": "seen", "rating": 4, "kind": "manga"}, (KIND_MANGA, "seen", 4)),
        ):
            with self.subTest(mark=mark):
                self.assertEqual(report._resolve_mark({"title": "本", "mark": mark}), expected)

    def test_build_wishlist_empty_and_minimal(self):
        self.assertEqual(report.build_wishlist([])["books"], [])
        self.assertIsNone(report.build_wishlist([])["last_scraped"])
        item = report.build_wishlist([{}])["books"][0]
        self.assertEqual(item["title"], repository.UNKNOWN_TITLE)
        self.assertIsNone(item["price"])
        self.assertEqual(item["price_reason"], "not_scraped")
        self.assertEqual(item["sources"], [])
        self.assertEqual(item["points"], 0)

    def test_build_wishlist_zero_price_and_ku(self):
        books = [
            {"asin": "B0AAAAAAAA", "actual_price": 0, "timestamp": "2026-01-01", "is_unlimited": 0, "point_value": None},
            {"asin": "B0BBBBBBBB", "actual_price": 0, "timestamp": "2026-01-02", "is_unlimited": 1, "campaign_text": "KU"},
        ]
        free, ku = report.build_wishlist(books)["books"]
        self.assertEqual((free["price"], free["price_reason"], free["points"]), (0, None, 0))
        self.assertEqual((ku["price"], ku["price_reason"], ku["campaign"]), (None, "ku", ""))

    def test_price_reason_requires_same_timestamp(self):
        book = {"timestamp": "2026-01-02", "unpriced_reason": {"reason": "blocked", "at": "2026-01-01"}}
        self.assertEqual(report._price_reason(book, None, False), "unknown")
        book["unpriced_reason"]["at"] = "2026-01-02"
        self.assertEqual(report._price_reason(book, None, False), "blocked")
        book["unpriced_reason"]["reason"] = "made_up"
        self.assertEqual(report._price_reason(book, None, False), "unknown")

    def test_bookmeter_id_filter(self):
        self.assertEqual(report._bookmeter_id("123"), "123")
        for value in (None, "", 123, "12x", "1" * 13, "１２"):
            with self.subTest(value=value):
                self.assertIsNone(report._bookmeter_id(value))

    def test_atom_time_fallback(self):
        for value in ("", None, "not a date"):
            with self.subTest(value=value):
                self.assertEqual(report._atom_time(value), "1970-01-01T00:00:00+00:00")

    def test_transition_helpers_on_empty_and_single(self):
        for func in (report._joined_ku_at, report._left_ku_at, report._campaign_started_at):
            self.assertIsNone(func([]))
            self.assertIsNone(func([{"at": "t", "price": None, "ku": False}]))
        self.assertIsNone(report._target_reached_at([], 100))
        self.assertIsNone(report._target_reached_at([{"at": "t", "price": 50, "ku": False}], 100))
        self.assertIsNone(report._target_reached_at([{"at": "t", "price": 50}], None))
        self.assertIsNone(report._target_reached_at([{"at": "t", "price": 50}], True))

    def test_target_reached_boundary_equal(self):
        history = [{"at": "t1", "price": 101, "ku": False}, {"at": "t2", "price": 100, "ku": False}]
        self.assertEqual(report._target_reached_at(history, 100), "t2")
        self.assertIsNone(report._target_reached_at(history, 99))

    def test_joined_ku_skips_failed_rows(self):
        history = [
            {"at": "t1", "price": 500, "ku": False},
            {"at": "t2", "price": None, "ku": False},
            {"at": "t3", "price": None, "ku": True},
            {"at": "t4", "price": None, "ku": True},
        ]
        self.assertEqual(report._joined_ku_at(history), "t3")
        self.assertIsNone(report._left_ku_at(history))

    def test_feed_events_sorting_ties_and_limit(self):
        books = []
        for i in range(report.MAX_FEED_ENTRIES + 5):
            books.append({
                "asin": f"B0{i:08d}", "title": f"本{i}", "price": 100, "price_prev": 200,
                "price_changed_at": "2026-01-01T00:00:00", "price_history": [], "purchased": False,
            })
        events = report._feed_events({"books": books})
        self.assertEqual(len(events), report.MAX_FEED_ENTRIES)
        ids = [e["id"] for e in events]
        self.assertEqual(ids, sorted(ids, reverse=True))

    def test_feed_events_skip_purchased_and_price_rise(self):
        books = [
            {"asin": "B0AAAAAAAA", "price": 100, "price_prev": 200, "price_changed_at": "t", "purchased": True},
            {"asin": "B0BBBBBBBB", "price": 300, "price_prev": 200, "price_changed_at": "t"},
            {"asin": "B0CCCCCCCC", "price": 100, "price_prev": 100, "price_changed_at": "t"},
        ]
        self.assertEqual(report._feed_events({"books": books}), [])

    def test_is_picked_big_drop_boundary(self):
        book = {"wanted": False, "price_prev": 1000, "price": 1000 - report.BIG_DROP_YEN}
        self.assertTrue(report._is_picked(book, "drop:x"))
        book["price"] += 1
        self.assertFalse(report._is_picked(book, "drop:x"))
        self.assertFalse(report._is_picked(book, "ku:x"))

    def test_build_feed_empty_and_invalid_asin(self):
        xml = report.build_feed({"books": [], "last_scraped": None}, "https://example.com/site")
        self.assertIn("<updated>1970-01-01T00:00:00+00:00</updated>", xml)
        self.assertIn('href="https://example.com/site/feed.xml"', xml)
        wishlist = {"books": [{"asin": "<bad>", "title": "<&>", "price": 1, "price_prev": 2, "price_changed_at": "2026-01-01T00:00:00"}]}
        xml = report.build_feed(wishlist, "https://example.com/")
        self.assertIn("&lt;&amp;&gt;", xml)
        self.assertNotIn("dp/<bad>", xml)

    def test_shrink_error(self):
        self.assertEqual(report._shrink_error(0, None), "本が 0 冊です")
        self.assertEqual(report._shrink_error(1, None), "")
        self.assertEqual(report._shrink_error(1, 0), "")
        self.assertEqual(report._shrink_error(5, 10), "")
        self.assertNotEqual(report._shrink_error(4, 9), "")

    def test_published_book_count_variants(self):
        tmpdir = tempfile.mkdtemp(prefix="edge_report_")
        try:
            path = os.path.join(tmpdir, "w.json")
            self.assertIsNone(report._published_book_count(path))
            for content, expected in (("[]", None), ("{}", None), ('{"books": 3}', None), ("{bad", None), ('{"books": [1, 2]}', 2)):
                with self.subTest(content=content):
                    with open(path, "w", encoding="utf-8") as f:
                        f.write(content)
                    self.assertEqual(report._published_book_count(path), expected)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_load_env_file_handles_bom_comments_and_existing(self):
        tmpdir = tempfile.mkdtemp(prefix="edge_env_")
        try:
            path = os.path.join(tmpdir, ".env")
            with open(path, "w", encoding="utf-8-sig") as f:
                f.write("EDGE_FIRST_KEY=a=b\n# comment\nnot a pair\n =novalue\nEDGE_EXISTING=new\nEDGE_SPACED = v \n")
            with unittest.mock.patch.dict(os.environ, {"EDGE_EXISTING": "old"}):
                report._load_env_file(path)
                self.assertEqual(os.environ.get("EDGE_FIRST_KEY"), "a=b")
                self.assertEqual(os.environ["EDGE_EXISTING"], "old")
                self.assertEqual(os.environ.get("EDGE_SPACED"), "v")
                self.assertNotIn("﻿EDGE_FIRST_KEY", os.environ)
            for key in ("EDGE_FIRST_KEY", "EDGE_SPACED", "﻿EDGE_FIRST_KEY"):
                os.environ.pop(key, None)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


# ─── main.py / run.py の補助関数 ─────────────────────────────────────────────

class MainHelpersEdgeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import main
        cls.main = main

    def test_format_price_summary_zero_and_none(self):
        self.assertEqual(self.main.format_price_summary({"sell_price": 0, "point_value": None}), "価格=¥0 ポイント=0pt")
        self.assertEqual(self.main.format_price_summary({}), "価格=取得不可 ポイント=0pt")

    def test_classify_crawl_result_zero_price_is_success(self):
        self.assertEqual(self.main.classify_crawl_result({"sell_price": 0})[0], self.main.RESULT_SUCCESS)
        self.assertEqual(self.main.classify_crawl_result({})[0], self.main.RESULT_FAILURE)

    def test_format_summary_line_empty(self):
        self.assertEqual(self.main.format_summary_line({}), "集計: 成功 0 件 / 失敗 0 件 / スキップ 0 件")

    def _ask(self, typed, total=10):
        stdin = unittest.mock.MagicMock()
        stdin.isatty.return_value = True
        with unittest.mock.patch.object(self.main.sys, "stdin", stdin), \
             unittest.mock.patch("builtins.input", return_value=typed), \
             unittest.mock.patch("builtins.print"):
            return self.main.ask_start_index(total)

    def test_ask_start_index_boundaries(self):
        self.assertEqual(self._ask("1"), 1)
        self.assertEqual(self._ask("10"), 10)
        self.assertEqual(self._ask(" 3 "), 3)
        self.assertEqual(self._ask("３"), 3)  # 全角数字（日本語入力のまま）
        self.assertIsNone(self._ask("0"))
        self.assertIsNone(self._ask("11"))
        self.assertIsNone(self._ask("-1"))
        self.assertIsNone(self._ask(""))
        self.assertIsNone(self._ask("1", total=0))

    def test_ask_start_index_non_decimal_digits_do_not_crash(self):
        for typed in ("①", "²", "٣x"):
            with self.subTest(typed=typed):
                self.assertIsNone(self._ask(typed))


class RunHelpersEdgeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import argparse
        import run
        cls.run_module = run
        cls.argparse = argparse

    def test_parse_asin(self):
        self.assertEqual(self.run_module._parse_asin("B0AAAAAAAA"), "B0AAAAAAAA")
        for value in ("", "b0aaaaaaaa", "B0AAAAAAA", "B0AAAAAAAAA", " B0AAAAAAAA"):
            with self.subTest(value=value):
                with self.assertRaises(self.argparse.ArgumentTypeError):
                    self.run_module._parse_asin(value)

    def test_parse_asin_list(self):
        self.assertEqual(self.run_module._parse_asin_list("B0AAAAAAAA,B0AAAAAAAA"), {"B0AAAAAAAA"})
        for value in ("", ",", "B0AAAAAAAA,", "B0AAAAAAAA,,B0BBBBBBBB"):
            with self.subTest(value=value):
                with self.assertRaises(self.argparse.ArgumentTypeError):
                    self.run_module._parse_asin_list(value)

    def test_positive_and_non_negative_int(self):
        self.assertEqual(self.run_module._positive_int("1"), 1)
        for value in ("0", "-5", "abc", "1.5", ""):
            with self.subTest(value=value):
                with self.assertRaises(self.argparse.ArgumentTypeError):
                    self.run_module._positive_int(value)
        self.assertEqual(self.run_module._non_negative_int("0"), 0)
        with self.assertRaises(self.argparse.ArgumentTypeError):
            self.run_module._non_negative_int("-1")

    def test_find_latest_marks_file_empty_dir(self):
        tmpdir = tempfile.mkdtemp(prefix="edge_marks_")
        try:
            self.assertIsNone(self.run_module._find_latest_marks_file(tmpdir))
            self.assertIsNone(self.run_module._find_latest_marks_file(os.path.join(tmpdir, "missing")))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
