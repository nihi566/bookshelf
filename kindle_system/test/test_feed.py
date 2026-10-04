"""
test_feed.py
-------------
report.build_feed()（値下がり・読み放題入りを知らせる Atom フィード feed.xml）の単体テスト。

実行:
    python -m unittest discover -s test -p test_feed.py -v
"""

import os
import sys
import unittest
import xml.etree.ElementTree as ET

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)

import report

ATOM = "{http://www.w3.org/2005/Atom}"
SITE = "https://example.invalid/kindle-wishlist-site/"


def _book(**overrides):
    book = {
        "asin": "B0FEED0001",
        "title": "欲しい本",
        "price": 900,
        "ku": False,
        "wanted": True,
        "purchased": False,
        "scraped_at": "2026-10-03T09:00:00",
        "price_prev": None,
        "price_changed_at": None,
        "price_low": None,
        "price_history": [],
    }
    book.update(overrides)
    return book


def _wishlist(*books):
    return {"format": "kindle-wishlist", "version": 1, "last_scraped": "2026-10-03T09:00:00", "books": list(books)}


def _entries(xml_text):
    root = ET.fromstring(xml_text)
    return [
        {
            "id": e.findtext(f"{ATOM}id"),
            "title": e.findtext(f"{ATOM}title"),
            "updated": e.findtext(f"{ATOM}updated"),
            "link": e.find(f"{ATOM}link").get("href"),
        }
        for e in root.findall(f"{ATOM}entry")
    ]


class BuildFeedTest(unittest.TestCase):
    def test_price_drop_becomes_an_entry(self):
        xml_text = report.build_feed(_wishlist(_book(price=700, price_prev=1000, price_changed_at="2026-10-02T08:00:00")), SITE)
        [entry] = _entries(xml_text)
        self.assertIn("値下がり", entry["title"])
        self.assertIn("¥1,000 → ¥700", entry["title"])
        self.assertIn("欲しい本", entry["title"])
        self.assertEqual(entry["link"], "https://www.amazon.co.jp/dp/B0FEED0001")
        self.assertTrue(entry["updated"].startswith("2026-10-02T08:00:00"))
        self.assertRegex(entry["updated"], r"[+-]\d\d:\d\d$|Z$", "Atom の日時はタイムゾーン付き")
        self.assertIn("B0FEED0001", entry["id"])

    def test_price_rise_purchased_and_unchanged_books_are_not_entries(self):
        books = [
            _book(asin="B0FEED0002", price=1200, price_prev=1000, price_changed_at="2026-10-02T08:00:00"),
            _book(asin="B0FEED0003", price=700, price_prev=1000, price_changed_at="2026-10-02T08:00:00", purchased=True),
            _book(asin="B0FEED0004"),
        ]
        self.assertEqual(_entries(report.build_feed(_wishlist(*books), SITE)), [])

    def test_joining_kindle_unlimited_becomes_an_entry(self):
        history = [
            {"at": "2026-09-30T09:00:00", "price": 1000, "ku": False},
            {"at": "2026-10-01T09:00:00", "price": None, "ku": False},
            {"at": "2026-10-02T09:00:00", "price": None, "ku": True},
            {"at": "2026-10-03T09:00:00", "price": None, "ku": True},
        ]
        [entry] = _entries(report.build_feed(_wishlist(_book(price=None, ku=True, price_history=history)), SITE))
        self.assertIn("読み放題", entry["title"])
        self.assertTrue(entry["updated"].startswith("2026-10-02T09:00:00"), "取得に失敗した回（価格なし・KU でない）は飛ばして、入った回の時刻")

    def test_book_that_was_always_ku_is_not_an_entry(self):
        always = [{"at": "2026-10-01T09:00:00", "price": None, "ku": True}, {"at": "2026-10-02T09:00:00", "price": None, "ku": True}]
        books = [_book(asin="B0FEED0005", price=None, ku=True, price_history=always)]
        self.assertEqual(_entries(report.build_feed(_wishlist(*books), SITE)), [])

    def test_leaving_kindle_unlimited_becomes_an_entry(self):
        history = [
            {"at": "2026-09-30T09:00:00", "price": None, "ku": True},
            {"at": "2026-10-01T09:00:00", "price": None, "ku": False},
            {"at": "2026-10-02T09:00:00", "price": 1000, "ku": False},
            {"at": "2026-10-03T09:00:00", "price": 1000, "ku": False},
        ]
        [entry] = _entries(report.build_feed(_wishlist(_book(price=1000, ku=False, price_history=history)), SITE))
        self.assertIn("読み放題が終わりました", entry["title"])
        self.assertIn("欲しい本", entry["title"])
        self.assertTrue(entry["updated"].startswith("2026-10-02T09:00:00"), "取得に失敗した回（価格なし・KU でない）は飛ばして、外れた回の時刻")
        self.assertIn("ku-ended:B0FEED0001:", entry["id"])

    def test_left_ku_entries_match_books_derived_from_history(self):
        """wishlist.json の履歴だけから「読み放題が終わった本」の集合を導き、フィードのエントリと一致すること。"""
        def h(*states):
            return [{"at": f"2026-10-0{i + 1}T09:00:00", "price": None if ku else 1000, "ku": ku} for i, ku in enumerate(states)]
        books = [
            _book(asin="B0FEED0011", price_history=h(True, False)),
            _book(asin="B0FEED0012", price_history=h(False, True, False)),
            _book(asin="B0FEED0013", price_history=h(False, False)),
            _book(asin="B0FEED0014", price=None, ku=True, price_history=h(True, False, True)),
            _book(asin="B0FEED0015", price_history=h(True, False), purchased=True),
        ]
        wl = _wishlist(*books)

        def left_ku(book):
            rows = [r for r in book["price_history"] if r["ku"] or r["price"] is not None]
            return any(a["ku"] and not b["ku"] for a, b in zip(rows, rows[1:])) and not rows[-1]["ku"]

        expected = {b["asin"] for b in wl["books"] if not b["purchased"] and left_ku(b)}
        got = {e["id"].split("#", 1)[1].split(":")[1] for e in _entries(report.build_feed(wl, SITE)) if "#ku-ended:" in e["id"]}
        self.assertEqual(got, expected)
        self.assertEqual(expected, {"B0FEED0011", "B0FEED0012"})

    def test_new_campaign_becomes_an_entry(self):
        history = [
            {"at": "2026-09-30T09:00:00", "price": 1000, "ku": False},
            {"at": "2026-10-01T09:00:00", "price": None, "ku": False},
            {"at": "2026-10-02T09:00:00", "price": 1000, "ku": False, "campaign": "期間限定キャンペーン"},
            {"at": "2026-10-03T09:00:00", "price": 1000, "ku": False, "campaign": "期間限定キャンペーン"},
        ]
        book = _book(price=1000, sell_price=1500, points=500, campaign="期間限定キャンペーン", price_history=history)
        [entry] = _entries(report.build_feed(_wishlist(book), SITE))
        self.assertIn("キャンペーン", entry["title"])
        self.assertIn("期間限定キャンペーン", entry["title"])
        self.assertIn("500 pt", entry["title"])
        self.assertIn("欲しい本", entry["title"])
        self.assertTrue(entry["updated"].startswith("2026-10-02T09:00:00"), "取得に失敗した回は飛ばして、キャンペーンが付いた回の時刻")
        self.assertIn("campaign:B0FEED0001:", entry["id"])

    def test_campaign_that_was_always_there_changed_text_ended_or_on_purchased_book_is_not_an_entry(self):
        always = [{"at": "2026-10-01T09:00:00", "price": 900, "ku": False, "campaign": "お得"}, {"at": "2026-10-02T09:00:00", "price": 900, "ku": False, "campaign": "お得"}]
        changed = [{"at": "2026-10-01T09:00:00", "price": 900, "ku": False, "campaign": "お得"}, {"at": "2026-10-02T09:00:00", "price": 900, "ku": False, "campaign": "期間限定キャンペーン"}]
        ended = [{"at": "2026-10-01T09:00:00", "price": 900, "ku": False}, {"at": "2026-10-02T09:00:00", "price": 900, "ku": False, "campaign": "お得"}, {"at": "2026-10-03T09:00:00", "price": 900, "ku": False}]
        started = [{"at": "2026-10-01T09:00:00", "price": 900, "ku": False}, {"at": "2026-10-02T09:00:00", "price": 900, "ku": False, "campaign": "お得"}]
        books = [
            _book(asin="B0FEED0007", campaign="お得", price_history=always),
            _book(asin="B0FEED0008", campaign="期間限定キャンペーン", price_history=changed),
            _book(asin="B0FEED0009", campaign="", price_history=ended),
            _book(asin="B0FEED0010", campaign="お得", price_history=started, purchased=True),
        ]
        self.assertEqual(_entries(report.build_feed(_wishlist(*books), SITE)), [])

    def test_reaching_target_price_becomes_an_entry(self):
        history = [
            {"at": "2026-09-30T09:00:00", "price": 700, "ku": False},
            {"at": "2026-10-01T09:00:00", "price": None, "ku": False},
            {"at": "2026-10-02T09:00:00", "price": 480, "ku": False},
            {"at": "2026-10-03T09:00:00", "price": 450, "ku": False},
        ]
        book = _book(price=450, price_prev=480, price_changed_at="2026-10-03T09:00:00", target_price=500, price_history=history)
        entries = [e for e in _entries(report.build_feed(_wishlist(book), SITE)) if "#target:" in e["id"]]
        self.assertEqual(len(entries), 1)
        self.assertIn("希望価格 ¥500 以下", entries[0]["title"])
        self.assertIn("¥480", entries[0]["title"])
        self.assertIn("欲しい本", entries[0]["title"])
        self.assertTrue(entries[0]["updated"].startswith("2026-10-02T09:00:00"), "取得に失敗した回は飛ばして、初めて希望価格以下になった回の時刻")

    def test_target_price_not_reached_already_below_or_unset_is_not_an_entry(self):
        above = [{"at": "2026-10-01T09:00:00", "price": 700, "ku": False}, {"at": "2026-10-02T09:00:00", "price": 600, "ku": False}]
        always = [{"at": "2026-10-01T09:00:00", "price": 400, "ku": False}, {"at": "2026-10-02T09:00:00", "price": 400, "ku": False}]
        reached = [{"at": "2026-10-01T09:00:00", "price": 700, "ku": False}, {"at": "2026-10-02T09:00:00", "price": 400, "ku": False}]
        books = [
            _book(asin="B0FEED0021", price=600, target_price=500, price_history=above),
            _book(asin="B0FEED0022", price=400, target_price=500, price_history=always),
            _book(asin="B0FEED0023", price=400, target_price=None, price_history=reached),
            _book(asin="B0FEED0024", price=400, target_price=500, price_history=reached, purchased=True),
        ]
        self.assertEqual([e for e in _entries(report.build_feed(_wishlist(*books), SITE)) if "#target:" in e["id"]], [])

    def test_drop_to_all_time_low_is_marked_in_the_entry(self):
        book = _book(price=700, price_prev=1000, price_changed_at="2026-10-02T08:00:00", price_low=700, price_low_at="2026-10-02T08:00:00")
        [entry] = _entries(report.build_feed(_wishlist(book), SITE))
        self.assertIn("過去最安値", entry["title"])
        self.assertIn("¥1,000 → ¥700", entry["title"])

    def test_drop_that_does_not_beat_the_low_is_not_marked(self):
        back_to_low = _book(price=700, price_prev=900, price_changed_at="2026-10-03T08:00:00", price_low=700, price_low_at="2026-10-01T08:00:00")
        above_low = _book(asin="B0FEED0025", price=800, price_prev=900, price_changed_at="2026-10-03T08:00:00", price_low=700, price_low_at="2026-10-01T08:00:00")
        for entry in _entries(report.build_feed(_wishlist(back_to_low, above_low), SITE)):
            self.assertNotIn("過去最安値", entry["title"])

    def test_picked_feed_has_its_own_address_and_title(self):
        root = ET.fromstring(report.build_feed(_wishlist(), SITE, picked_only=True))
        self.assertEqual(root.find(f"{ATOM}link[@rel='self']").get("href"), SITE + report.PICKED_FEED_FILE)
        self.assertEqual(root.findtext(f"{ATOM}id"), SITE + report.PICKED_FEED_FILE)
        self.assertIn("読みたい本", root.findtext(f"{ATOM}title"))

    def test_picked_feed_entries_match_the_set_derived_from_wishlist(self):
        """読みたい本の出来事・希望価格への到達・下げ幅が大きい値下がりだけが載る。wishlist.json の項目だけから集合を導いて照合する。"""
        big = report.BIG_DROP_YEN
        ku_history = [{"at": "2026-10-01T09:00:00", "price": 1000, "ku": False}, {"at": "2026-10-02T09:00:00", "price": None, "ku": True}]
        target_history = [{"at": "2026-10-01T09:00:00", "price": 700, "ku": False}, {"at": "2026-10-02T09:00:00", "price": 450, "ku": False}]
        books = [
            # 読みたい本: 小さな値下がりでも載る
            _book(asin="B0PICK0001", wanted=True, price=990, price_prev=1000, price_changed_at="2026-10-02T08:00:00"),
            # 読みたい本: 読み放題入りも載る
            _book(asin="B0PICK0002", wanted=True, price=None, ku=True, price_history=ku_history),
            # 読みたい本でない: 下げ幅がちょうど閾値なら載る
            _book(asin="B0PICK0003", wanted=False, price=1000, price_prev=1000 + big, price_changed_at="2026-10-02T08:00:00"),
            # 読みたい本でない: 下げ幅が閾値未満なら載らない
            _book(asin="B0PICK0004", wanted=False, price=1000, price_prev=1000 + big - 1, price_changed_at="2026-10-02T08:00:00"),
            # 読みたい本でない: 読み放題入りは載らない
            _book(asin="B0PICK0005", wanted=False, price=None, ku=True, price_history=ku_history),
            # 読みたい本でない: 希望価格への到達は載る（本人が決めた基準なので）。同じ回の小さな値下がりは載らない
            _book(asin="B0PICK0006", wanted=False, price=450, price_prev=700, price_changed_at="2026-10-02T09:00:00", target_price=500, price_history=target_history),
        ]
        wl = _wishlist(*books)
        all_ids = {e["id"].split("#", 1)[1] for e in _entries(report.build_feed(wl, SITE))}

        by_asin = {b["asin"]: b for b in wl["books"]}

        def picked(event_id):
            kind, asin = event_id.split(":")[:2]
            book = by_asin[asin]
            if book["wanted"] or kind == "target":
                return True
            return kind == "drop" and book["price_prev"] - book["price"] >= big

        expected = {i for i in all_ids if picked(i)}
        got = {e["id"].split("#", 1)[1] for e in _entries(report.build_feed(wl, SITE, picked_only=True))}
        self.assertEqual(got, expected)
        self.assertEqual({i.split(":")[0] + ":" + i.split(":")[1] for i in got}, {"drop:B0PICK0001", "ku:B0PICK0002", "drop:B0PICK0003", "target:B0PICK0006"})

    def test_picked_feed_is_capped_after_filtering(self):
        """全体の新しい 50 件から絞るのではなく、絞ってから新しい方の上限件数を載せる（細かい値下がりで押し出されない）。"""
        small = [
            _book(asin=f"B0SMAL{i:04d}", wanted=False, price=990, price_prev=1000, price_changed_at=f"2026-02-{1 + i % 28:02d}T00:00:00")
            for i in range(report.MAX_FEED_ENTRIES)
        ]
        old_wanted = _book(asin="B0WANT0001", wanted=True, price=990, price_prev=1000, price_changed_at="2026-01-01T00:00:00")
        entries = _entries(report.build_feed(_wishlist(*small, old_wanted), SITE, picked_only=True))
        self.assertEqual([e["link"] for e in entries], ["https://www.amazon.co.jp/dp/B0WANT0001"])

    def test_titles_are_escaped_and_bad_asin_links_to_the_site(self):
        book = _book(asin="", title="A & B <C>", price=700, price_prev=1000, price_changed_at="2026-10-02T08:00:00")
        xml_text = report.build_feed(_wishlist(book), SITE)
        [entry] = _entries(xml_text)
        self.assertIn("A & B <C>", entry["title"])
        self.assertNotIn("<C>", xml_text)
        self.assertEqual(entry["link"], SITE)

    def test_newest_first_and_capped(self):
        books = [
            _book(asin=f"B0FEED{i:04d}", price=500, price_prev=1000, price_changed_at=f"2026-0{1 + i // 28}-{1 + i % 28:02d}T00:00:00")
            for i in range(report.MAX_FEED_ENTRIES + 5)
        ]
        entries = _entries(report.build_feed(_wishlist(*books), SITE))
        self.assertEqual(len(entries), report.MAX_FEED_ENTRIES)
        self.assertEqual(entries, sorted(entries, key=lambda e: e["updated"], reverse=True))

    def test_feed_header_and_output_is_stable(self):
        wl = _wishlist(_book(price=700, price_prev=1000, price_changed_at="2026-10-02T08:00:00"))
        xml_text = report.build_feed(wl, SITE)
        self.assertEqual(xml_text, report.build_feed(wl, SITE), "同じデータなら同じ内容（自動公開で無駄な差分を出さない）")
        root = ET.fromstring(xml_text)
        self.assertEqual(root.tag, f"{ATOM}feed")
        self.assertEqual(root.find(f"{ATOM}link[@rel='self']").get("href"), SITE + "feed.xml")
        self.assertTrue(root.findtext(f"{ATOM}updated").startswith("2026-10-02T08:00:00"))

    def test_empty_feed_is_valid(self):
        root = ET.fromstring(report.build_feed(_wishlist(), SITE))
        self.assertEqual(root.findall(f"{ATOM}entry"), [])
        self.assertTrue(root.findtext(f"{ATOM}updated"))


if __name__ == "__main__":
    unittest.main()
