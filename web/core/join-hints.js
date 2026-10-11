// 本の中で、文の途中で切れていそうな点（ハイライトするときに 2 つに分かれてしまったかもしれない点）を見つける。
// 見つけた点には、本の画面で「次の点とくっつける?」の印を出す（くっつけるかどうかは人が決める）

// 文の終わりに来る記号（閉じかっこ・引用符で終わる文も、そこで終わっているとみなす）
const SENTENCE_END = /[。．.！!？?」』）)\]］}｝】》〉〕"”'’…‥]$/;
// 終わりの位置が無い点（Kindle のノートブックから取り込んだ点など）は、文の長さから終わりの位置を見積もる。
// 1 位置に入る文字の数を少なめに見て、長い点の終わりを先に置く（続いている点を見逃さない側に倒す）
const CHARS_PER_LOCATION = 30;
// 終わりの位置の次の位置までに始まる点を「続いている」とみなす
const LOCATION_GAP = 1;

const isPoint = (h) => h && h.kind !== 'note' && typeof h.text === 'string' && h.text.trim() !== '';
// 同期で文字列の位置が届いても数として読む（空・数でない値は位置なし）
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function locationEnd(h, start) {
  const end = num(h.locationEnd);
  if (end != null) return Math.max(start, end);
  return start + Math.floor(Array.from(h.text).length / CHARS_PER_LOCATION);
}

function continues(a, b) {
  if (a.chapter && b.chapter && a.chapter !== b.chapter) return false;
  const [la, lb] = [num(a.location), num(b.location)];
  if (la != null && lb != null) return lb <= locationEnd(a, la) + LOCATION_GAP;
  return Boolean(a.page) && String(a.page) === String(b.page);
}

/**
 * 「次の点とくっつける?」の印を出す点の ID。
 * 文の終わりの記号で終わらず、次の点と位置が続いている（位置が無ければ同じページの）点だけを選ぶ
 * 「次の点」は編集シートのくっつける相手（highlightNeighbors）と同じく並びのすぐ隣で、単独のメモが間にあれば印は出さない
 * @param {object[]} highlights 1 冊の本の点。本の画面と同じ並び（bookHighlights）で渡す
 * @returns {Set<string>}
 */
export function joinCandidateIds(highlights) {
  const out = new Set();
  for (let i = 0; i < highlights.length - 1; i++) {
    const a = highlights[i];
    const b = highlights[i + 1];
    if (!isPoint(a) || !isPoint(b)) continue;
    if (SENTENCE_END.test(a.text.trimEnd())) continue;
    if (continues(a, b)) out.add(a.id);
  }
  return out;
}
