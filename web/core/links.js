// リンク: 点・メモ（思いつき）・永久ノートのどれどうしでも結ぶ（理由を 1 行添えられる）。両側の画面に出る（逆向きも見える）
//
// Link = { id: 'k'+hash(2 つの端の ID), a, b, reason, createdAt, updatedAt, deleted? }
//   a・b: 点（'h…'・'t…'）か永久ノート（'n…'）の ID（a < b）。同じ 2 つは同じ ID になる（どの端末で張っても 1 つにまとまる）
//   外したものは deleted: true で残す（理由の文は消す）。もう一度張れば戻る（新しい方を採る。消したものが戻らない墓標とは違う）
// リンクを張るのは人間だけ（AI は候補の「意味の近い点」を出すまで）

import { hash, isoStamp } from './text.js';
import { farText } from './analysis/far.js';
import { currentPointId, isPointId } from './point-ids.js';
import { isNoteId } from './notes.js';
import { mergeCollections } from './collections.js';

// 理由の長さ（1 行）
export const LINK_REASON_MAX = 120;
// 持っておくリンクの数の上限（同期・バックアップで大量に届いても、統合と画面を重くしない。人が張る数には十分）
export const LINKS_MAX = 20000;
const LINK_ID = /^k[0-9a-z]{1,40}$/;

/** リンクの端になれる ID か（点・メモ・永久ノート） */
export const isLinkEnd = (v) => isPointId(v) || isNoteId(v);

/** 2 つの端のリンクの ID（並びに依らない） */
export function linkId(a, b) {
  return 'k' + hash([a, b].sort().join('|'));
}

export function linksOf(library) {
  const l = library?.links;
  return l && typeof l === 'object' && !Array.isArray(l) ? l : {};
}

// 理由は 1 行（制御文字・幅の無い文字を落とす。遠いつながりの「共通する考え」と同じ整え方。それもリンクの理由として出す）
const cleanReason = (v) => farText(v, LINK_REASON_MAX);
const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

/** 外から来たリンクの形を整える（同期・バックアップ用）。壊れていれば null。外したリンクは理由を持たない。now は 1 回の統合で同じ値 */
export function normalizeLink(l, now = new Date().toISOString()) {
  if (!l || typeof l !== 'object' || typeof l.id !== 'string' || !LINK_ID.test(l.id) || !isLinkEnd(l.a) || !isLinkEnd(l.b) || l.a === l.b || l.id !== linkId(l.a, l.b)) return null;
  const [a, b] = [l.a, l.b].sort();
  const deleted = l.deleted === true;
  return { id: l.id, a, b, reason: deleted ? '' : cleanReason(l.reason), createdAt: isoStamp(l.createdAt, now), updatedAt: isoStamp(l.updatedAt, now), ...(deleted ? { deleted: true } : {}) };
}

/**
 * 2 つの端末のリンクをまとめる（張った・外した・理由を直した時刻が新しい方。向きに依らない）。
 * 上限を超えたら、張っているリンクを先に、新しい順に残す（まとめた結果だけで決めるので、向きに依らない）
 */
export function mergeLinks(a, b, now = new Date().toISOString()) {
  const all = mergeCollections(a, b, { normalize: (l) => normalizeLink(l, now) });
  const list = Object.values(all);
  if (list.length <= LINKS_MAX) return all;
  list.sort((x, y) => Number(Boolean(x.deleted)) - Number(Boolean(y.deleted)) || cmp(y.updatedAt, x.updatedAt) || cmp(x.id, y.id));
  return Object.fromEntries(list.slice(0, LINKS_MAX).map((l) => [l.id, l]));
}

/**
 * リンクを張る（外していたリンクは戻す）。もう張っていれば、理由だけを直す（理由を渡したとき）
 * @param {string} from @param {string} to 点・メモ・永久ノートの ID
 */
export function addLink(library, from, to, reason = undefined, now = new Date().toISOString()) {
  if (!isLinkEnd(from) || !isLinkEnd(to)) throw new Error('リンクの相手が見つかりません');
  if (currentPointId(library, from) === currentPointId(library, to)) throw new Error('同じものどうしはリンクできません');
  const [a, b] = [from, to].sort();
  const id = linkId(a, b);
  const all = linksOf(library);
  const cur = Object.hasOwn(all, id) ? all[id] : null;
  const nextReason = reason === undefined ? cur?.reason || '' : cleanReason(reason);
  if (cur && !cur.deleted && cur.reason === nextReason) return cur;
  const next = { id, a, b, reason: nextReason, createdAt: cur?.createdAt || now, updatedAt: now };
  library.links = { ...all, [id]: next };
  library.updatedAt = now;
  return next;
}

/** リンクを外す（外したことを残す。理由の文は消す。もう一度張れば戻る） */
export function removeLink(library, id, now = new Date().toISOString()) {
  const all = linksOf(library);
  const cur = Object.hasOwn(all, id) ? all[id] : null;
  if (!cur || cur.deleted) return null;
  const next = { ...cur, reason: '', deleted: true, updatedAt: now };
  library.links = { ...all, [id]: next };
  library.updatedAt = now;
  return next;
}

/** 張っているリンク（形の正しいもの） */
export function liveLinks(library) {
  return Object.values(linksOf(library)).filter((l) => l && !l.deleted && LINK_ID.test(String(l.id)) && isLinkEnd(l.a) && isLinkEnd(l.b));
}

/** その点・メモ・ノートにつながる、張っているリンクと相手（今の ID）。並べる前（同じ相手のリンクも全部） */
function touching(library, self) {
  const out = [];
  for (const l of liveLinks(library)) {
    const [ca, cb] = [currentPointId(library, l.a), currentPointId(library, l.b)];
    const other = ca === self ? cb : cb === self ? ca : null;
    if (other && other !== self) out.push({ link: l, other });
  }
  return out;
}

/**
 * その点・メモ・ノートのリンク（どちら向きに張ったものも）。新しく張った・直した順。
 * Kindle で伸ばしたハイライトは、置き換わった先の点として数える（同じ相手は 1 つにまとめる）
 * @returns {{ link: object, other: string }[]} other は相手の ID（今の ID）
 */
export function linksFor(library, endId) {
  const sorted = touching(library, currentPointId(library, endId)).sort((x, y) => cmp(String(y.link.updatedAt), String(x.link.updatedAt)) || cmp(x.link.id, y.link.id));
  const seen = new Set();
  const out = [];
  for (const e of sorted) {
    if (seen.has(e.other)) continue;
    seen.add(e.other);
    out.push(e);
  }
  return out;
}

/** その 2 つの間に張っているリンク（無ければ null） */
export function linkBetween(library, x, y) {
  const cy = currentPointId(library, y);
  return linksFor(library, x).find((e) => e.other === cy)?.link || null;
}

/**
 * その 2 つの間に張っているリンクをすべて外す（別の端末で、Kindle で伸ばす前と後の点に張ったリンクもまとめて）。外した数を返す
 */
export function removeLinksBetween(library, x, y, now = new Date().toISOString()) {
  const cy = currentPointId(library, y);
  const ids = touching(library, currentPointId(library, x)).filter((e) => e.other === cy).map((e) => e.link.id);
  for (const id of ids) removeLink(library, id, now);
  return ids.length;
}
