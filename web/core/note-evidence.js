// 永久ノートの根拠の点をたどる（点・線・面の画面から、それを根拠にしている永久ノートへ行くため）

import { liveNotes } from './notes.js';
import { currentPointId, pointById } from './points.js';

/**
 * 根拠の点を今の点にたどる（Kindle で伸ばしたハイライトは置き換わった先の点）。消えた点は point: null
 * @returns {{ id: string, point: object|null }[]}
 */
export function noteEvidence(library, note) {
  return (note?.pointIds || []).map((id) => {
    const cur = currentPointId(library, id);
    return { id: cur, point: pointById(library, cur) };
  });
}

/** 根拠の点のうち、消えた点の数 */
export function missingEvidence(library, note) {
  return noteEvidence(library, note).filter((e) => !e.point).length;
}

/**
 * その点（ID の集まり）のどれかを根拠にしている永久ノート（直した順）。
 * 伸ばす前の点の ID で書いた根拠も、伸ばしたあとの点で数える（探す側の ID も、古い分析に残る伸ばす前の ID なら直してから比べる）
 */
export function notesCiting(library, ids) {
  const given = [...ids];
  if (!given.length) return [];
  const set = new Set(given.flatMap((id) => [id, currentPointId(library, id)]));
  return liveNotes(library).filter((n) => n.pointIds.some((id) => set.has(id) || set.has(currentPointId(library, id))));
}

/** 根拠の点が 1 つでも重なる、ほかの永久ノート（直した順。ノートの画面から似たノートへ行くため） */
export function notesSharingEvidence(library, note) {
  if (!note) return [];
  return notesCiting(library, note.pointIds || []).filter((n) => n.id !== note.id);
}

/**
 * その点（ID の集まり）のすべてを根拠にしている永久ノート（直した順。リンクの両端の点から、もう書いたノートを引くため）。
 * 伸ばす前・伸ばしたあとの点の ID は、どちらも今の点で比べる
 */
export function notesCitingAll(library, ids) {
  const wanted = [...new Set([...ids].map((id) => currentPointId(library, id)))];
  if (!wanted.length) return [];
  return liveNotes(library).filter((n) => {
    const cited = new Set(n.pointIds.map((id) => currentPointId(library, id)));
    return wanted.every((id) => cited.has(id));
  });
}
