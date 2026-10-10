// 線(グループ)の★。点の★（ハイライトの favorite）と同じく、端末の間で同期する
//
// library.lineStars = { [線(グループ)の ID]: { id, name, starred, updatedAt } }
// - 外したものも starred: false で残す（外したことも同期で届くように）
// - 線(グループ)の ID は増分の分析では変わらないので、★は残る。最初から作り直して ID が変わったら引き継がず、
//   ★のページに「分析し直して無くなった線(グループ)」として name で出す（外せる）

import { mergeCollections } from './collections.js';
import { cleanText, isoStamp, truncate } from './text.js';

const LINE_ID = /^[\w-]{1,40}$/;
const NAME_MAX = 200;

export function lineStarsOf(library) {
  const s = library?.lineStars;
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

/** 外から来た記録の形を整える（同期・バックアップ用）。壊れていれば null */
export function normalizeLineStar(s, now = new Date().toISOString()) {
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !LINE_ID.test(s.id) || typeof s.starred !== 'boolean') return null;
  return { id: s.id, name: truncate(cleanText(String(s.name || '')), NAME_MAX), starred: s.starred, updatedAt: isoStamp(s.updatedAt, now) };
}

export function isLineStarred(library, lineId) {
  const all = lineStarsOf(library);
  return Boolean(Object.hasOwn(all, lineId) && all[lineId]?.starred);
}

/** ★をつける・外す（押すたびに入れ替わる）。つけたら true */
export function toggleLineStar(library, line, now = new Date().toISOString()) {
  if (!line || typeof line.id !== 'string' || !LINE_ID.test(line.id)) throw new Error('線(グループ)が見つかりません');
  const starred = !isLineStarred(library, line.id);
  const cur = Object.hasOwn(lineStarsOf(library), line.id) ? lineStarsOf(library)[line.id] : null;
  const name = truncate(cleanText(String(line.name || cur?.name || '')), NAME_MAX);
  library.lineStars = { ...lineStarsOf(library), [line.id]: { id: line.id, name, starred, updatedAt: now } };
  library.updatedAt = now;
  return starred;
}

/**
 * ★をつけた線(グループ)。present: 今の分析にある線（今の名前・中身）、missing: 分析し直して無くなったもの（★をつけたときの名前）
 * 分析がまだ無い端末では、無くなったとは言えないので missing にしない
 */
export function starredLines(library, analysis) {
  const stars = Object.values(lineStarsOf(library)).filter((s) => s?.starred);
  // waiting: 分析がまだ届いていないので出せない★の数
  if (!analysis) return { present: [], missing: [], waiting: stars.length };
  const byId = new Map((analysis.lines || []).map((l) => [l.id, l]));
  return {
    present: stars.filter((s) => byId.has(s.id)).map((s) => byId.get(s.id)),
    missing: stars.filter((s) => !byId.has(s.id)).map((s) => ({ id: s.id, name: s.name })),
    waiting: 0,
  };
}

/** 2 つの端末の記録をまとめる（つけた・外した時刻が新しい方。向きに依らない） */
export function mergeLineStars(a, b, now = new Date().toISOString()) {
  return mergeCollections(a, b, { normalize: (x) => normalizeLineStar(x, now) });
}
