"""
test_marks_inbox.py
-------------------
bookshelf の bh serve が受け箱（data/marks-inbox/）に置いた印（kindle-marks v1）を、
run.py sync の冒頭で取り込む処理（NIH-367）の単体テスト。DB への書き込み（import_marks）はモックする。

使い方:
    python3 -m unittest test.test_marks_inbox -v
"""

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

from sqlalchemy.exc import OperationalError

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)

import run


def _write(directory, name, items, fmt="kindle-marks"):
    with open(os.path.join(directory, name), "w", encoding="utf-8") as f:
        json.dump({"format": fmt, "version": 1, "exported_at": "2026-10-26T00:00:00Z", "items": items}, f)


class ImportMarksInboxTest(unittest.TestCase):
    def setUp(self):
        self.inbox = tempfile.mkdtemp(prefix="marks_inbox_test_")

    def tearDown(self):
        shutil.rmtree(self.inbox, ignore_errors=True)

    def _run(self, **kwargs):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            result = run.import_marks_inbox(self.inbox, **kwargs)
        return result, out.getvalue()

    @patch("run.import_marks")
    def test_imports_files_oldest_first_and_removes_them(self, mock_import):
        mock_import.return_value = {"updated": 1, "deleted": 0, "skipped": []}
        _write(self.inbox, "kindle-marks-0000000000002-b.json", [{"asin": "B000000002", "tag": "seen", "rating": None}])
        _write(self.inbox, "kindle-marks-0000000000001-a.json", [{"asin": "B000000001", "tag": "seen", "rating": 3}])

        result, _ = self._run()

        self.assertEqual(result, {"files": 2, "updated": 2, "deleted": 0, "failed": 0})
        asins = [call.args[0][0]["asin"] for call in mock_import.call_args_list]
        self.assertEqual(asins, ["B000000001", "B000000002"])
        self.assertEqual(os.listdir(self.inbox), [])

    @patch("run.import_marks")
    def test_missing_inbox_does_nothing(self, mock_import):
        shutil.rmtree(self.inbox)
        result, _ = self._run()
        self.assertEqual(result, {"files": 0, "updated": 0, "deleted": 0, "failed": 0})
        mock_import.assert_not_called()

    @patch("run.import_marks")
    def test_ignores_temporary_files_being_written(self, mock_import):
        # bh serve が書いている途中の一時ファイル（.tmp）は読まない
        with open(os.path.join(self.inbox, "kindle-marks-0000000000001-a.json.tmp"), "w", encoding="utf-8") as f:
            f.write("{")
        result, _ = self._run()
        self.assertEqual(result["files"], 0)
        mock_import.assert_not_called()
        self.assertEqual(os.listdir(self.inbox), ["kindle-marks-0000000000001-a.json.tmp"])

    @patch("run.import_marks")
    def test_broken_file_is_moved_aside_and_others_continue(self, mock_import):
        mock_import.return_value = {"updated": 1, "deleted": 0, "skipped": []}
        with open(os.path.join(self.inbox, "kindle-marks-0000000000001-a.json"), "w", encoding="utf-8") as f:
            f.write("{ broken")
        _write(self.inbox, "kindle-marks-0000000000002-b.json", [{"asin": "B000000002", "tag": "seen"}])

        result, output = self._run()

        self.assertEqual(result["files"], 1)
        self.assertEqual(result["failed"], 1)
        self.assertIn("kindle-marks-0000000000001-a.json", output)
        # 読めないファイルは毎回失敗しないよう脇へ退けて残す（中身を確かめられるように消さない）
        self.assertEqual(sorted(os.listdir(self.inbox)), ["kindle-marks-0000000000001-a.json.broken"])

    @patch("run.import_marks")
    def test_data_error_is_moved_aside_and_others_continue(self, mock_import):
        # 中身が原因の失敗（壊れた文字で DB に書けない等）は、受け箱を詰まらせないよう脇へ退ける
        mock_import.side_effect = [UnicodeEncodeError("utf-8", "\ud83d", 0, 1, "surrogates not allowed"), {"updated": 1, "deleted": 0, "skipped": []}]
        _write(self.inbox, "kindle-marks-0000000000001-a.json", [{"asin": "B000000001", "tag": "seen"}])
        _write(self.inbox, "kindle-marks-0000000000002-b.json", [{"asin": "B000000002", "tag": "seen"}])

        result, _ = self._run()

        self.assertEqual(result["files"], 1)
        self.assertEqual(result["failed"], 1)
        self.assertEqual(os.listdir(self.inbox), ["kindle-marks-0000000000001-a.json.broken"])

    @patch("run.import_marks")
    def test_db_error_keeps_the_file_for_next_time_and_stops(self, mock_import):
        mock_import.side_effect = OperationalError("UPDATE book_marks", {}, Exception("database is locked"))
        _write(self.inbox, "kindle-marks-0000000000001-a.json", [{"asin": "B000000001", "tag": "seen"}])
        _write(self.inbox, "kindle-marks-0000000000002-b.json", [{"asin": "B000000002", "tag": "seen"}])

        result, _ = self._run()

        self.assertEqual(result["failed"], 1)
        self.assertEqual(mock_import.call_count, 1)  # 古い方で止め、新しい方を先に入れない（後から付けた印が古い印で上書きされないように）
        self.assertEqual(
            sorted(os.listdir(self.inbox)),
            ["kindle-marks-0000000000001-a.json", "kindle-marks-0000000000002-b.json"],
        )


class SyncImportsInboxFirstTest(unittest.TestCase):
    """sync はクロールを始める前に受け箱を取り込む（「読んだ」を付けた本の価格を取りに行かない）。"""

    @patch("run.publish")
    @patch("run.sync_bookmeter_wishlist")
    @patch("run.main_module.run_integration")
    @patch("run.import_marks_inbox")
    @patch("run._prepare_publish")
    def test_inbox_is_imported_before_crawling(self, _prep, mock_inbox, mock_integration, _bm, _publish):
        order = []
        mock_inbox.side_effect = lambda *a, **k: order.append("inbox") or {"files": 0, "updated": 0, "deleted": 0, "failed": 0}

        async def crawl(**kwargs):
            order.append("crawl")
            return True

        mock_integration.side_effect = crawl
        import asyncio

        with contextlib.redirect_stdout(io.StringIO()):
            asyncio.run(run._run_sync(xml_path="x", limit=0, start=0, workers=1, target="kindle"))
        self.assertEqual(order, ["inbox", "crawl"])


if __name__ == "__main__":
    unittest.main()
