// 「点」の共通の形: 本に引いた線（ハイライト）と、本に属さない思いつき
//
// 分析・画面は、点がどちらかを気にせずに扱えるよう、ここを通して読む。
// 点の ID はハイライトが 'h'、思いつきが 't' で始まる（分析結果の highlightIds にはどちらも入る）。

import { pointHighlights, searchHighlights } from './model.js';
import { THOUGHT_LABEL, isThoughtId, pointThoughts, searchThoughts, thoughtsOf } from './thoughts.js';

// Kindle で伸ばしたハイライトの置き換え先をたどる（永久ノートの根拠・リンクに書いた点を見失わない）
export { currentPointId } from './point-ids.js';

/** 分析の点（技術書の線・捨てた思いつきを除く）。ID 順 */
export function analysisPoints(library) {
  return [...pointHighlights(library), ...pointThoughts(library)].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * この端末に届いている点か（消した点は墓標があるので届いている）。PC で取り込んだ直後の点はまだ無いことがある。
 * 引くことのできない点を「消えた」と「まだ無い（同期すると出る）」に分けるために使う
 */
export function pointArrived(library, id) {
  const all = isThoughtId(id) ? thoughtsOf(library) : library.highlights || {};
  return Object.hasOwn(all, id);
}

/** ID から点を引く（消したもの・無いものは null。捨てた思いつきは返す: コピー・戻すなどの操作のため） */
export function pointById(library, id) {
  const all = isThoughtId(id) ? thoughtsOf(library) : library.highlights || {};
  const p = Object.hasOwn(all, id) ? all[id] : null;
  return p && !p.deleted ? p : null;
}

/** 分析結果の画面（線・まだつながらない点）に出す点。前の分析に入っていても、あとで捨てた思いつきは出さない */
export function analysisPointById(library, id) {
  const p = pointById(library, id);
  return p && !(isThought(p) && p.status === 'discarded') ? p : null;
}

export function isThought(p) {
  return isThoughtId(p?.id);
}

/** 書名の代わりに出す名前（思いつきは「思いつき」） */
export function pointLabel(library, p) {
  return isThought(p) ? THOUGHT_LABEL : library.books?.[p.bookId]?.title || '';
}

/**
 * 埋め込み（文の意味を数値の並びにする）に使う文。線を引いた文に、取り込んだメモ・自分のメモ・タグを足す。
 * 自分のメモ・タグを書き換えると文が変わり、次の分析で埋め込み直す。
 * 印（「読者自身の言葉」など）は付けない（どの点にも同じ語が入り、文字 n-gram で似て見えるため）
 */
export function embedText(p) {
  if (isThought(p)) return p.text;
  const tags = (p.tags || []).map((t) => '#' + t).join(' ');
  return [p.text, p.note, p.userNote, tags].filter(Boolean).join('\n');
}

/** この形になる前の埋め込みの文（線を引いた文と取り込んだメモだけ）。前の版のキャッシュを使い続けるために比べる */
export function legacyEmbedText(p) {
  return p.note ? `${p.text}\n${p.note}` : p.text;
}

/**
 * 点を探す（ハイライト + 思いつき）。新しい順。
 * source が本の読み方（kindle など）・お気に入り・文を直した点の絞り込みのときは思いつきを出さず、'thought' のときは思いつきだけ
 */
export function searchPoints(library, query = '', { source = '', favorite = false, edited = false } = {}) {
  const hs = source === 'thought' ? [] : searchHighlights(library, query, { source, favorite, edited });
  const ts = (source && source !== 'thought') || favorite || edited ? [] : searchThoughts(library, query);
  const at = (p) => String(p.createdAt || p.importedAt || '');
  return [...hs, ...ts].sort((a, b) => at(b).localeCompare(at(a)));
}
