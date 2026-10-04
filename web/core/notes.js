// 永久ノート: 「1 ノート = 1 アイデア」を自分の言葉で持ち、育てる（AI の線は下書きにできる）
//
// Note = { id: 'n…', title, body, pointIds: [点の ID], from?: { kind: 'line'|'thought', id, name? }, createdAt, updatedAt }
//   pointIds: 根拠の点（0 件以上。ハイライトの 'h…' と思いつきの 't…'）。AI は書き換えない（分析し直しても変わらない）
//   from: 何から作ったか（線の下書き・受け箱のメモ）。作ったあとは自由に書き換えられる
// 消したものは墓標 { id, deleted: true, createdAt, updatedAt } だけを残す（同期で戻らないように）

// 根拠の点を画面に出す処理は note-evidence.js（model.js がここを読むので、点の処理を読むと読み込みが輪になる）
import { isoStamp, normalizeText, randomId, sliceChars, truncate } from './text.js';
import { currentPointId, isPointId } from './point-ids.js';
import { thoughtsOf, updateThought } from './thoughts.js';

// 題・本文・根拠の点の上限（1 ノート = 1 アイデア。長文の貼り付けで同期を重くしない）
export const NOTE_TITLE_MAX = 100;
export const NOTE_BODY_MAX = 10000;
export const NOTE_POINTS_MAX = 200;
// 何から作ったか（線の下書き・受け箱のメモ）
const FROM_KINDS = ['line', 'thought'];

/** 永久ノートの ID か（randomId('n') の形） */
export function isNoteId(id) {
  return typeof id === 'string' && /^n[0-9a-z]{1,40}$/.test(id);
}

const str = (v) => (typeof v === 'string' ? v : '');
// 幅の無い文字（見えないので、これだけの題・本文は空とみなす）
const ZERO_WIDTH = /[\u200b-\u200d\ufeff]/g;

export function notesOf(library) {
  const n = library?.notes;
  return n && typeof n === 'object' && !Array.isArray(n) ? n : {};
}

/** 題を整える（1 行にして前後の空白を落とす） */
const cleanTitle = (v) => truncate(str(v).replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim(), NOTE_TITLE_MAX);
/** 本文を整える（改行は残す）。長さの確かめにも使う */
const tidyBody = (v) => str(v).replace(ZERO_WIDTH, '').replace(/\r\n?/g, '\n').trim();
const cleanBody = (v) => sliceChars(tidyBody(v), NOTE_BODY_MAX);
/** 根拠の点の ID（形の正しいものだけ・重ねない・上限まで。届いた配列が長すぎても先に切る） */
const cleanPoints = (ids) => [...new Set((Array.isArray(ids) ? ids.slice(0, NOTE_POINTS_MAX * 5) : []).filter(isPointId))].slice(0, NOTE_POINTS_MAX);

function normalizeFrom(f) {
  if (!f || typeof f !== 'object' || !FROM_KINDS.includes(f.kind) || typeof f.id !== 'string' || !/^[a-z0-9]{1,80}$/i.test(f.id)) return null;
  const name = cleanTitle(f.name);
  return { kind: f.kind, id: f.id, ...(name ? { name } : {}) };
}

/**
 * 外から来た永久ノートの形を整える（同期・バックアップ用）。壊れていれば null。
 * 時刻は isoStamp で整える（now は 1 回の統合で同じ値。壊れた時刻・未来すぎる時刻が勝ち続けないように）
 */
export function normalizeNote(n, now = new Date().toISOString()) {
  if (!n || typeof n !== 'object' || !isNoteId(n.id)) return null;
  if (n.deleted) return { id: n.id, deleted: true, createdAt: isoStamp(n.createdAt, now), updatedAt: isoStamp(n.updatedAt, now) };
  const title = cleanTitle(n.title);
  const body = cleanBody(n.body);
  if (!title && !body) return null;
  const out = { id: n.id, title, body, pointIds: cleanPoints(n.pointIds), createdAt: isoStamp(n.createdAt, now), updatedAt: isoStamp(n.updatedAt, now) };
  const from = normalizeFrom(n.from);
  if (from) out.from = from;
  return out;
}

function checkContent(title, body) {
  const t = cleanTitle(title);
  const b = tidyBody(body);
  if (!t && !b) throw new Error('題か本文を入力してください');
  if (b.length > NOTE_BODY_MAX) throw new Error(`本文は ${NOTE_BODY_MAX} 字までにしてください`);
  return { title: t, body: b };
}

/**
 * 永久ノートを作る。id は書くシートを開いたときに 1 回だけ作って渡す（保存に失敗して押し直しても 2 件にならないように）
 * @param {{ title?: string, body?: string, pointIds?: string[], from?: object }} p
 */
export function addNote(library, { title = '', body = '', pointIds = [], from } = {}, now = new Date().toISOString(), id = randomId('n')) {
  if (!isNoteId(id)) throw new Error('ノートの ID の形が違います');
  const note = { id, ...checkContent(title, body), pointIds: cleanPoints(pointIds), createdAt: now, updatedAt: now };
  const f = normalizeFrom(from);
  if (f) note.from = f;
  library.notes = { ...notesOf(library), [id]: note };
  library.updatedAt = now;
  return note;
}

/** 題・本文・根拠の点を変える（patch に入れた欄だけ）。何も変わらなければ時刻も進めない（別の端末の新しい編集を負かさない） */
export function updateNote(library, id, patch, now = new Date().toISOString()) {
  const cur = Object.hasOwn(notesOf(library), id) ? notesOf(library)[id] : null;
  if (!cur || cur.deleted) throw new Error('ノートが見つかりません');
  const content = checkContent('title' in patch ? patch.title : cur.title, 'body' in patch ? patch.body : cur.body);
  const pointIds = 'pointIds' in patch ? cleanPoints(patch.pointIds) : cur.pointIds;
  const next = { ...cur, ...content, pointIds };
  if (next.title === cur.title && next.body === cur.body && next.pointIds.join('|') === cur.pointIds.join('|')) return cur;
  next.updatedAt = now;
  library.notes = { ...notesOf(library), [id]: next };
  library.updatedAt = now;
  return next;
}

/** その点（Kindle で伸ばしたハイライトは置き換わった先でも）をもう根拠にしているか */
export function citesPoint(library, note, pointId) {
  const target = currentPointId(library, pointId);
  return (note?.pointIds || []).some((x) => x === pointId || currentPointId(library, x) === target);
}

/** 根拠の点を足す（もう入っていれば何もしない。伸ばす前の点の ID で入っていても同じ点とみなす） */
export function addNotePoint(library, id, pointId, now = new Date().toISOString()) {
  const cur = Object.hasOwn(notesOf(library), id) ? notesOf(library)[id] : null;
  if (!cur || cur.deleted) throw new Error('ノートが見つかりません');
  if (!isPointId(pointId)) throw new Error('点が見つかりません');
  if (citesPoint(library, cur, pointId)) return cur;
  if (cur.pointIds.length >= NOTE_POINTS_MAX) throw new Error(`根拠の点は ${NOTE_POINTS_MAX} 件までです`);
  return updateNote(library, id, { pointIds: [...cur.pointIds, pointId] }, now);
}

/** 消す。中身は残さず、墓標だけを残す */
export function deleteNote(library, id, now = new Date().toISOString()) {
  const cur = Object.hasOwn(notesOf(library), id) ? notesOf(library)[id] : null;
  if (!cur) return null;
  const tomb = { id, deleted: true, createdAt: isoStamp(cur.createdAt, now) || now, updatedAt: now };
  library.notes = { ...notesOf(library), [id]: tomb };
  library.updatedAt = now;
  return tomb;
}

// 直した順（同じ時刻なら ID の順。端末の言語設定に依らない比べ方）
const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
const newestFirst = (a, b) => cmp(String(b.updatedAt), String(a.updatedAt)) || cmp(a.id, b.id);

/** 消していない永久ノート（直した順） */
export function liveNotes(library) {
  return Object.values(notesOf(library))
    .filter((n) => n && !n.deleted && isNoteId(n.id))
    .sort(newestFirst);
}

/**
 * 分析に渡す永久ノート（直した順）。線から作って一度も直していないノートは渡さない
 * （中身は AI の線のままなので、「人間がまとめた線」として AI に戻すと AI の考えを重ねて強めてしまう）
 */
export function notesForAnalysis(library) {
  return liveNotes(library).filter((n) => !(n.from?.kind === 'line' && n.updatedAt === n.createdAt));
}

/** 永久ノートを探す（題・本文。空白区切りの AND）。直した順 */
export function searchNotes(library, query = '') {
  const terms = normalizeText(query).split(' ').filter(Boolean);
  if (!terms.length) return liveNotes(library);
  return liveNotes(library).filter((n) => {
    const hay = normalizeText(`${n.title} ${n.body}`);
    return terms.every((w) => hay.includes(w));
  });
}

/**
 * 線を下書きにした永久ノート（線の名前を題に、説明と問いを本文に、線の点を根拠に写す）。
 * isLive: 今もある点か（古い分析に残る、消えた点を根拠に写さない）
 */
export function noteDraftFromLine(line, isLive = () => true) {
  const body = [line.summary, line.insight ? `問い: ${line.insight}` : ''].filter(Boolean).join('\n\n');
  return { title: line.name, body, pointIds: line.highlightIds.filter(isLive), from: { kind: 'line', id: line.id, name: line.name } };
}

/** 受け箱のメモを下書きにした永久ノート（メモの 1 行目を題に、メモを本文に、メモを根拠に写す） */
export function noteDraftFromThought(t) {
  const first = t.text.split('\n').find((s) => s.trim()) || t.text;
  return { title: truncate(first.trim(), 40), body: t.text, pointIds: [t.id], from: { kind: 'thought', id: t.id } };
}

/**
 * 受け箱のメモから永久ノートを作り、メモを整理済みにする（メモは根拠として残り、分析の点のまま）。
 * 受け箱にないメモ（もう整理した・捨てた）からは作らない（押し直しで同じノートが 2 件にならないように）
 */
export function noteFromThought(library, thoughtId, now = new Date().toISOString(), id = randomId('n')) {
  const all = thoughtsOf(library);
  const t = Object.hasOwn(all, thoughtId) ? all[thoughtId] : null;
  if (!t || t.deleted) throw new Error('メモが見つかりません');
  if (t.status !== 'inbox') throw new Error('このメモはもう整理しています（受け箱のメモから作れます）');
  const note = addNote(library, noteDraftFromThought(t), now, id);
  updateThought(library, t.id, { status: 'done' }, now);
  return note;
}
