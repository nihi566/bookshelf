"""
src/book_kind.py
-----------------
書籍タイトルから「マンガ」か「本」かを推定する。

Kindle ストアのマンガはタイトル末尾にレーベル名（「(ジャンプコミックスDIGITAL)」
「(モーニングKC)」「(ハルタコミックス)」等）が付くことが多いため、その表記だけを手がかりにする。
「マンガ」「漫画」という語はマンガ論・マンガ入門のような活字の本にも現れるため判定に使わない
（例: 「マンガの原理」は本）。レーベル表記の無いマンガは、公開ページのカードで種別を
切り替えて書き出し、`run.py import-marks` で取り込むと book_marks.kind として上書きされる。
"""

import re

KIND_MANGA = "manga"
KIND_BOOK = "book"
KINDS = (KIND_MANGA, KIND_BOOK)

# KC / MFC は英単語の一部（"backend" 等）に誤反応しないよう、前後が英字でないときだけ一致させる。
_MANGA_LABEL_PATTERN = re.compile(
    r"コミック|コミカライズ|comic|(?<![a-z])kc(?![a-z])|ｋｃ|(?<![a-z])mfc(?![a-z])|ｍｆｃ|タテヨミ|webtoon",
    re.IGNORECASE,
)


def classify_kind(title: str) -> str:
    """タイトルのレーベル表記からマンガ（"manga"）か本（"book"）かを返す。判定できなければ本。"""
    if title and _MANGA_LABEL_PATTERN.search(title):
        return KIND_MANGA
    return KIND_BOOK


def is_manga(title: str, kind_override: str = None) -> bool:
    """マンガか。手で切り替えた種別（book_marks.kind）があればそれを、無ければタイトルからの判定を使う。

    Amazon への取得（本編 ASIN の解決・価格のクロール）からマンガを外すために使う（NIH-309）。
    """
    kind = kind_override if kind_override in KINDS else classify_kind(title)
    return kind == KIND_MANGA
