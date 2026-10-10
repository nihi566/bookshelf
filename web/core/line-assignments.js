// 思いつきを、自分で選んだ線(グループ)に入れる（AI の分析を待たずに整理する）。端末の間で同期する
//
// library.lineAssignments = { [思いつきの ID]: { id, lineId, lineName, updatedAt } }
// - lineId が '' のものは「外した」記録（外したことも同期で届くよう、消さずに残す）
// - AI の分析（analysis.lines）とは別に持つので、分析し直しても消えない。
//   最初から作り直して線(グループ)の ID が変わったら、lineName で「無くなった」と出す

import { mergeCollections } from './collections.js';
import { cleanText, isoStamp, truncate } from './text.js';
import { isThoughtId, thoughtsOf } from './thoughts.js';

const LINE_ID = /^[\w-]{1,40}$/;
const NAME_MAX = 200;

export function lineAssignmentsOf(library) {
  const a = library?.lineAssignments;
  return a && typeof a === 'object' && !Array.isArray(a) ? a : {};
}

/** 外から来た記録の形を整える（同期・バックアップ用）。壊れていれば null */
export function normalizeLineAssignment(a, now = new Date().toISOString()) {
  if (!a || typeof a !== 'object' || !isThoughtId(a.id)) return null;
  if (typeof a.lineId !== 'string' || (a.lineId && !LINE_ID.test(a.lineId))) return null;
  return { id: a.id, lineId: a.lineId, lineName: a.lineId ? truncate(cleanText(String(a.lineName || '')), NAME_MAX) : '', updatedAt: isoStamp(a.updatedAt, now) };
}

function liveThought(library, id) {
  const t = Object.hasOwn(thoughtsOf(library), id) ? thoughtsOf(library)[id] : null;
  return t && !t.deleted ? t : null;
}

function put(library, id, lineId, lineName, now) {
  library.lineAssignments = { ...lineAssignmentsOf(library), [id]: { id, lineId, lineName, updatedAt: now } };
  library.updatedAt = now;
}

/** 思いつきを線(グループ)に入れる（入っていた線(グループ)からは移る） */
export function assignThoughtToLine(library, thoughtId, line, now = new Date().toISOString()) {
  if (!liveThought(library, thoughtId)) throw new Error('メモが見つかりません');
  if (!line || typeof line.id !== 'string' || !LINE_ID.test(line.id)) throw new Error('線(グループ)が見つかりません');
  put(library, thoughtId, line.id, truncate(cleanText(String(line.name || '')), NAME_MAX), now);
}

/** 線(グループ)から外す */
export function unassignThought(library, thoughtId, now = new Date().toISOString()) {
  if (!lineAssignmentOf(library, thoughtId)) return;
  put(library, thoughtId, '', '', now);
}

/** その思いつきを入れた線(グループ)（入れていなければ null） */
export function lineAssignmentOf(library, thoughtId) {
  const all = lineAssignmentsOf(library);
  const a = Object.hasOwn(all, thoughtId) ? all[thoughtId] : null;
  return a?.lineId ? { lineId: a.lineId, lineName: a.lineName || '' } : null;
}

/** その線(グループ)に自分で入れた思いつきの ID（消した・捨てたメモは除く） */
export function assignedThoughtIds(library, lineId) {
  return Object.values(lineAssignmentsOf(library))
    .filter((a) => {
      const t = a?.lineId === lineId ? liveThought(library, a.id) : null;
      return t && t.status !== 'discarded';
    })
    .map((a) => a.id);
}

/** 2 つの端末の記録をまとめる（入れた・外した時刻が新しい方。向きに依らない） */
export function mergeLineAssignments(a, b, now = new Date().toISOString()) {
  return mergeCollections(a, b, { normalize: (x) => normalizeLineAssignment(x, now) });
}
