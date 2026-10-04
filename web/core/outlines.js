// 文章の骨組み（G9）: 面・線・永久ノートから作った、人に読ませる文章の見出し・各節の要点・使う引用。アプリの中で直して持ち出す
//
// Outline = { id: 'o…', title, sources: [{ kind: 'plane'|'line'|'note', id, name }], sections: [{ heading, points: [要点], quotes: [点の ID] }], createdAt, updatedAt }
//   引用は点の ID で持つ（文は持たない）。画面と Markdown では、点の今の文をそのまま出す（AI に書き換えさせない。G9-2）
//   消したものは墓標 { id, deleted: true, createdAt, updatedAt } だけを残す（同期で戻らないように）
// 材料を集める・依頼文・答えの読み取り・Markdown は outline-draft.js（model.js がここを読むので、点の処理を読むと読み込みが輪になる）

import { isoStamp, randomId } from './text.js';
import { isPointId } from './point-ids.js';
import { farText } from './analysis/far.js';

// 長さと数の上限（同期で大きな値が届いても重くしない）
export const OUTLINE_TITLE_MAX = 100;
export const OUTLINE_SECTIONS_MAX = 12;
export const HEADING_MAX = 80;
export const SECTION_POINTS_MAX = 8;
export const SECTION_POINT_MAX = 200;
export const SECTION_QUOTES_MAX = 8;
const SOURCES_MAX = 20;
const SOURCE_KINDS = ['plane', 'line', 'note'];
const OUTLINE_ID = /^o[0-9a-z]{1,40}$/;

/** 骨組みの ID か（randomId('o') の形） */
export const isOutlineId = (v) => typeof v === 'string' && OUTLINE_ID.test(v);

export function outlinesOf(library) {
  const o = library?.outlines;
  return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
}

// 1 行に整えて短く切る（制御文字・幅の無い文字を落とす）
const oneLine = (v, max) => farText(v, max);
// 配列を先に切ってから整える（同期で届いた長い配列で時間を使わない）
const head = (v, n) => (Array.isArray(v) ? v.slice(0, n * 4) : []);

/** 節 1 つを整える（見出し・要点・引用がどれも無ければ null） */
function cleanSection(s) {
  if (!s || typeof s !== 'object') return null;
  const heading = oneLine(s.heading, HEADING_MAX);
  const points = head(s.points, SECTION_POINTS_MAX).map((p) => oneLine(p, SECTION_POINT_MAX)).filter(Boolean).slice(0, SECTION_POINTS_MAX);
  const quotes = [...new Set(head(s.quotes, SECTION_QUOTES_MAX).filter(isPointId))].slice(0, SECTION_QUOTES_MAX);
  return heading || points.length || quotes.length ? { heading, points, quotes } : null;
}

/** 何から作ったか（面・線・永久ノート） */
function cleanSources(list) {
  return head(list, SOURCES_MAX)
    .filter((s) => s && SOURCE_KINDS.includes(s.kind) && typeof s.id === 'string' && /^[a-z0-9]{1,80}$/i.test(s.id))
    .map((s) => ({ kind: s.kind, id: s.id, name: oneLine(s.name, 60) }))
    .slice(0, SOURCES_MAX);
}

/** 外から来た骨組みの形を整える（同期・バックアップ用）。壊れていれば null。now は 1 回の統合で同じ値 */
export function normalizeOutline(o, now = new Date().toISOString()) {
  if (!o || typeof o !== 'object' || !isOutlineId(o.id)) return null;
  if (o.deleted) return { id: o.id, deleted: true, createdAt: isoStamp(o.createdAt, now), updatedAt: isoStamp(o.updatedAt, now) };
  const title = oneLine(o.title, OUTLINE_TITLE_MAX);
  const sections = head(o.sections, OUTLINE_SECTIONS_MAX).map(cleanSection).filter(Boolean).slice(0, OUTLINE_SECTIONS_MAX);
  if (!title && !sections.length) return null;
  return { id: o.id, title, sources: cleanSources(o.sources), sections, createdAt: isoStamp(o.createdAt, now), updatedAt: isoStamp(o.updatedAt, now) };
}

/**
 * 骨組みを保存する。id は下書きが届いたときに 1 回だけ作って渡す（保存を押し直しても 2 件にならないように）
 * @param {{ title: string, sources?: object[], sections: object[] }} draft
 */
export function addOutline(library, draft, now = new Date().toISOString(), id = randomId('o')) {
  if (!isOutlineId(id)) throw new Error('骨組みの ID の形が違います');
  const all = outlinesOf(library);
  if (Object.hasOwn(all, id) && !all[id].deleted) return all[id];
  const o = normalizeOutline({ ...draft, id, createdAt: now, updatedAt: now }, now);
  if (!o || o.deleted) throw new Error('骨組みに題も節もありません');
  library.outlines = { ...all, [id]: o };
  library.updatedAt = now;
  return o;
}

// 長さを数えるときの形（1 行にして前後の空白を落とし、1 文字ずつ数える。整えるとき〔farText・truncate〕と同じ数え方）
const size = (v) => Array.from(String(v ?? '').replace(/\s+/g, ' ').trim()).length;

/** 直した題・節が上限に収まっているか。収まらなければ、黙って切らずに理由を返す（直すシートに出る） */
function checkEdit(title, sections) {
  if (title !== undefined && size(title) > OUTLINE_TITLE_MAX) throw new Error(`題は ${OUTLINE_TITLE_MAX} 字までにしてください`);
  if (sections === undefined) return;
  if (!Array.isArray(sections)) throw new Error('節の形が違います');
  if (sections.length > OUTLINE_SECTIONS_MAX) throw new Error(`節は ${OUTLINE_SECTIONS_MAX} までにしてください`);
  sections.forEach((s, i) => {
    if (size(s?.heading) > HEADING_MAX) throw new Error(`節 ${i + 1} の見出しは ${HEADING_MAX} 字までにしてください`);
    const points = (Array.isArray(s?.points) ? s.points : []).filter((p) => size(p));
    if (points.length > SECTION_POINTS_MAX) throw new Error(`節 ${i + 1} の要点は ${SECTION_POINTS_MAX} つまでにしてください`);
    if (points.some((p) => size(p) > SECTION_POINT_MAX)) throw new Error(`節 ${i + 1} の要点は 1 つ ${SECTION_POINT_MAX} 字までにしてください`);
  });
}

/** 題・節を直す。上限を超えたら理由を返す（黙って切らない）。何も変わらなければ時刻を進めない（別の端末の新しい編集を負かさない） */
export function updateOutline(library, id, { title, sections } = {}, now = new Date().toISOString()) {
  const all = outlinesOf(library);
  const cur = Object.hasOwn(all, id) ? all[id] : null;
  if (!cur || cur.deleted) throw new Error('骨組みが見つかりません');
  checkEdit(title, sections);
  const next = normalizeOutline({ ...cur, ...(title !== undefined ? { title } : {}), ...(sections !== undefined ? { sections } : {}), updatedAt: now }, now);
  if (!next) throw new Error('題か節を残してください');
  if (next.title === cur.title && JSON.stringify(next.sections) === JSON.stringify(cur.sections)) return cur;
  library.outlines = { ...all, [id]: next };
  library.updatedAt = now;
  return next;
}

/** 消す。中身は残さず、墓標だけを残す */
export function deleteOutline(library, id, now = new Date().toISOString()) {
  const all = outlinesOf(library);
  const cur = Object.hasOwn(all, id) ? all[id] : null;
  if (!cur || cur.deleted) return null;
  const next = { id, deleted: true, createdAt: cur.createdAt, updatedAt: now };
  library.outlines = { ...all, [id]: next };
  library.updatedAt = now;
  return next;
}

// 並べるときの比べ方（端末の言語設定に依らない）
const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

/** 消していない骨組み（直した順） */
export function liveOutlines(library) {
  return Object.values(outlinesOf(library))
    .filter((o) => o && !o.deleted && isOutlineId(o.id))
    .sort((a, b) => cmp(String(b.updatedAt), String(a.updatedAt)) || cmp(a.id, b.id));
}
