"""
test_main_start_prompt.py
-------------------------
main.run_integration の開始番号の問い合わせ（--start を付けずに起動したとき）の単体テスト。

タスクスケジューラの毎日の自動同期（scripts/scheduled_sync.ps1 → run.py sync）は --start を付けず、
標準入力に人がいない。そこで input() が開始番号を待つと、誰も入力できないまま 3 時間で打ち切られる
（backlog 20261004-scheduled-sync-waits-for-input）。端末でないときは聞かずに最初から始めることを確かめる。

ASIN 解決・クロール・DB 保存はすべてモックし、実クロールや実 DB へは一切接続しない。

使い方:
    python -m unittest discover -s test -p "test_main_start_prompt.py" -v
"""

import asyncio
import contextlib
import io
import os
import sys
import unittest
from unittest.mock import AsyncMock, Mock, patch

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)

import main


class FakeStdin(io.StringIO):
    """isatty() の結果を決められる標準入力。"""

    def __init__(self, text="", tty=False):
        super().__init__(text)
        self._tty = tty

    def isatty(self):
        return self._tty


class RunIntegrationStartPromptTest(unittest.TestCase):
    SAMPLES = [{"asin": f"S{i}", "title": f"本{i}"} for i in range(1, 4)]

    def _run(self, stdin, typed=None):
        crawled = []

        async def fake_crawl(paid_asin, **kwargs):
            crawled.append(paid_asin)
            return {"asin": paid_asin, "sell_price": 100, "point_value": 1}

        real_sleep = asyncio.sleep

        async def fast_sleep(_seconds):
            await real_sleep(0)

        prompt = Mock(return_value=typed) if typed is not None else Mock(side_effect=EOFError)
        buf = io.StringIO()
        with patch.object(main, "init_db"), \
             patch.object(main, "get_or_create_session_start", return_value="2026-01-01T00:00:00"), \
             patch.object(main, "get_session_processed_asins", return_value=set()), \
             patch.object(main, "extract_samples", return_value=list(self.SAMPLES)), \
             patch.object(main, "get_purchased_asins", return_value=set()), \
             patch.object(main, "get_paid_asin", side_effect=lambda s: "P" + s[1:]), \
             patch.object(main, "crawl_price_info", new=AsyncMock(side_effect=fake_crawl)), \
             patch.object(main, "save_price_history"), \
             patch.object(main, "clear_session"), \
             patch.object(main.asyncio, "sleep", new=fast_sleep), \
             patch.object(main.sys, "stdin", stdin), \
             patch("builtins.input", prompt), \
             contextlib.redirect_stdout(buf):
            asyncio.run(main.run_integration(xml_path="dummy.xml", workers=1))
        return buf.getvalue(), sorted(crawled), prompt

    def test_does_not_wait_for_input_when_stdin_is_not_a_terminal(self):
        output, crawled, prompt = self._run(FakeStdin(tty=False))

        prompt.assert_not_called()
        self.assertEqual(crawled, ["P1", "P2", "P3"], "最初から全件を処理する")
        self.assertIn("最初から", output)

    def test_does_not_wait_when_stdin_is_missing(self):
        # pythonw やサービス実行では sys.stdin が None になる
        _, crawled, prompt = self._run(None)

        prompt.assert_not_called()
        self.assertEqual(crawled, ["P1", "P2", "P3"])

    def test_asks_start_index_on_a_terminal(self):
        _, crawled, prompt = self._run(FakeStdin(tty=True), typed="2")

        prompt.assert_called_once()
        self.assertEqual(crawled, ["P2", "P3"])

    def test_end_of_input_starts_from_the_first_book(self):
        # Windows では `< NUL` も isatty() が True になる。そのときは input() がすぐ EOF になり、待たずに最初から始める
        _, crawled, prompt = self._run(FakeStdin(tty=True))

        prompt.assert_called_once()
        self.assertEqual(crawled, ["P1", "P2", "P3"])

    def test_enter_on_a_terminal_starts_from_the_first_book(self):
        _, crawled, _ = self._run(FakeStdin(tty=True), typed="")

        self.assertEqual(crawled, ["P1", "P2", "P3"])

    def test_invalid_input_on_a_terminal_says_it_starts_from_the_first_book(self):
        for typed in ("abc", "0", "4"):
            with self.subTest(typed=typed):
                output, crawled, _ = self._run(FakeStdin(tty=True), typed=typed)

                self.assertEqual(crawled, ["P1", "P2", "P3"])
                self.assertIn(f"開始番号「{typed}」", output, "入力ミスで黙って全件にしない")


if __name__ == "__main__":
    unittest.main()
