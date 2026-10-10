"""
test_publisher.py
-----------------
商品ページの「出版社」を読み（crawler）、本ごとに残し（repository）、wishlist.json の publisher に
載せる（report.build_wishlist）ことの単体テスト（NIH-104）。

実行:
    python -m unittest discover -s test -p test_publisher.py -v
"""

import asyncio
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)

import report
from src import crawler, repository


class FakePage:
    def __init__(self, value=None, error=None):
        self._value = value
        self._error = error

    async def evaluate(self, script):
        if self._error:
            raise self._error
        return self._value


class CleanPublisherTest(unittest.TestCase):
    """登録情報の 1 行・新しい表示の値から、出版社の名前だけを取り出す。"""

    def test_extracts_name_from_detail_bullets_line(self):
        cases = [
            ("出版社 \u200f : \u200e 光文社 (2020/10/14)", "光文社"),
            ("出版社\u200f:\u200eオライリージャパン; 第2版 (2019/6/1)", "オライリージャパン"),
            ("出版社 : 技術評論社", "技術評論社"),
            ("出版社 ‏ : ‎ ＫＡＤＯＫＡＷＡ (2021/3/1)", "KADOKAWA"),
            ("  日経ＢＰ  ", "日経BP"),
            ("翔泳社 (2018/4/16)", "翔泳社"),
            ("Publisher : O'Reilly Media (2020/1/1)", "O'Reilly Media"),
        ]
        for raw, name in cases:
            with self.subTest(raw=raw):
                self.assertEqual(crawler.clean_publisher(raw), name)

    def test_empty_or_unusable_values_become_empty(self):
        for raw in ["", None, "出版社 : ", "   ", "(2020/1/1)", 123]:
            with self.subTest(raw=raw):
                self.assertEqual(crawler.clean_publisher(raw), "")

    def test_too_long_values_are_cut(self):
        self.assertEqual(len(crawler.clean_publisher("あ" * 500)), crawler.MAX_PUBLISHER_LENGTH)


class ExtractPublisherTest(unittest.TestCase):
    """読み込み済みのページから出版社を読む。失敗しても例外にせず空文字（価格の取得を止めない）。"""

    def test_returns_cleaned_name(self):
        self.assertEqual(asyncio.run(crawler.extract_publisher(FakePage("出版社 \u200f : \u200e 光文社 (2020/10/14)"))), "光文社")

    def test_returns_empty_when_missing_or_failed(self):
        for page in [FakePage(""), FakePage(None), FakePage(["光文社"]), FakePage(error=RuntimeError("boom"))]:
            with self.subTest(page=page._value):
                self.assertEqual(asyncio.run(crawler.extract_publisher(page)), "")


class PublisherStorageTest(unittest.TestCase):
    """save_price_history が出版社を本ごとに残し、get_publishers で読めること。"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="publisher_test_")
        self.db_path = os.path.join(self.tmpdir, "p.db")
        from sqlmodel import SQLModel, create_engine
        self.engine = create_engine(f"sqlite:///{self.db_path}", connect_args={"check_same_thread": False})
        SQLModel.metadata.create_all(self.engine)
        import src.database as database_module
        self._original_engine = database_module.engine
        database_module.engine = self.engine

    def tearDown(self):
        import src.database as database_module
        database_module.engine = self._original_engine
        self.engine.dispose()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_publisher_is_saved_and_latest_wins(self):
        repository.save_price_history({"asin": "B0PUB00001", "sell_price": 900, "publisher": "光文社"})
        repository.save_price_history({"asin": "B0PUB00002", "sell_price": 1200, "publisher": "技術評論社"})
        repository.save_price_history({"asin": "B0PUB00001", "sell_price": 800, "publisher": "光文社 新書編集部"})
        self.assertEqual(repository.get_publishers(), {"B0PUB00001": "光文社 新書編集部", "B0PUB00002": "技術評論社"})

    def test_missing_publisher_keeps_the_previous_one(self):
        repository.save_price_history({"asin": "B0PUB00001", "sell_price": 900, "publisher": "光文社"})
        repository.save_price_history({"asin": "B0PUB00001", "sell_price": None, "unpriced_reason": "blocked", "publisher": ""})
        repository.save_price_history({"asin": "B0PUB00001", "sell_price": 900})
        self.assertEqual(repository.get_publishers(), {"B0PUB00001": "光文社"})

    def test_get_publishers_on_db_without_table_returns_empty_without_creating(self):
        """report.py（読み取り専用の経路）は古い DB でテーブルを作らない。"""
        from sqlmodel import SQLModel
        SQLModel.metadata.tables["book_publishers"].drop(self.engine)
        self.assertEqual(repository.get_publishers(), {})
        conn = sqlite3.connect(self.db_path)
        try:
            names = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        finally:
            conn.close()
        self.assertNotIn("book_publishers", names)

    def test_saving_creates_the_table_on_old_db(self):
        from sqlmodel import SQLModel
        SQLModel.metadata.tables["book_publishers"].drop(self.engine)
        repository.save_price_history({"asin": "B0PUB00003", "sell_price": 700, "publisher": "翔泳社"})
        self.assertEqual(repository.get_publishers(), {"B0PUB00003": "翔泳社"})


class WishlistPublisherTest(unittest.TestCase):
    """build_wishlist が各本に publisher を載せる（無ければ null）。"""

    def _book(self, **overrides):
        book = {"title": "ある技術書", "asin": "B0WISH001", "actual_price": 900, "timestamp": "2026-01-02T03:04:05", "is_unlimited": 0}
        book.update(overrides)
        return book

    def test_publisher_is_written(self):
        books = report.build_wishlist([self._book(publisher="技術評論社"), self._book(asin="B0WISH002")])["books"]
        self.assertEqual([b["publisher"] for b in books], ["技術評論社", None])

    def test_empty_or_non_string_publisher_is_null(self):
        for value in ["", "   ", 0, ["光文社"]]:
            with self.subTest(value=value):
                self.assertIsNone(report.build_wishlist([self._book(publisher=value)])["books"][0]["publisher"])


if __name__ == "__main__":
    unittest.main()
