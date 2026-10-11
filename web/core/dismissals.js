// 消した線(グループ)・面（NIH-193）。端末の間で同期する
//
// library.dismissals = { [線・面の ID]: { id, kind: 'line'|'plane', name, pointIds, dismissed, updatedAt } }
// - 消すのは AI が作った束ね方だけで、点（ハイライト・メモ）は消さない。線の点は「まだつながらない点」になり、
//   面の線はそのまま残る（次の分析でほかの面に入る）
// - 次の分析でも同じものを作らない。増分の分析では ID で前回から外し、最初から作り直して ID が変わっても
//   点の半分以上が消したときの点と重なる線・面は作らない（pointIds はそのための、消したときの点）
// - 元に戻すと dismissed: false で残す（戻したことも同期で届くように）

import { mergeCollections } from './collections.js';
import { currentPointId, isPointId } from './point-ids.js';
import { centroid, dot } from './analysis/vectors.js';
import { cleanText, isoStamp, truncate } from './text.js';

const ID = /^[\w-]{1,80}$/;
const KINDS = new Set(['line', 'plane']);
const NAME_MAX = 200;
// 消したときの点として覚える数（面は線の点をすべて持つので、大きな面でも同期を重くしない）
export const DISMISSED_POINTS_MAX = 2000;
// 消した線・面と「同じ」とみなす重なり（新しく作る線・面の点のうち、消したときの点が占める割合）
export const RESEMBLE_SHARE = 0.5;
// 「同じ」とみなすのに要る、消したときの点との重なりの最小の数
export const RESEMBLE_MIN = 2;

export function dismissalsOf(library) {
  const d = library?.dismissals;
  return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
}

/** 外から来た記録の形を整える（同期・バックアップ用）。壊れていれば null */
export function normalizeDismissal(d, now = new Date().toISOString()) {
  if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !ID.test(d.id) || !KINDS.has(d.kind) || typeof d.dismissed !== 'boolean') return null;
  const pointIds = [...new Set((Array.isArray(d.pointIds) ? d.pointIds.slice(0, DISMISSED_POINTS_MAX * 2) : []).filter(isPointId))].slice(0, DISMISSED_POINTS_MAX);
  return { id: d.id, kind: d.kind, name: truncate(cleanText(String(d.name || '')), NAME_MAX), pointIds, dismissed: d.dismissed, updatedAt: isoStamp(d.updatedAt, now) };
}

/** 2 つの端末の記録をまとめる（消した・戻した時刻が新しい方。向きに依らない） */
export function mergeDismissals(a, b, now = new Date().toISOString()) {
  return mergeCollections(a, b, { normalize: (x) => normalizeDismissal(x, now) });
}

/**
 * 線・面を消す。点は消さない。消した記録を返す
 * @param {'line'|'plane'} kind
 */
export function dismiss(library, analysis, kind, id, now = new Date().toISOString()) {
  const lines = analysis?.lines || [];
  const target = kind === 'line' ? lines.find((l) => l.id === id) : kind === 'plane' ? (analysis?.planes || []).find((p) => p.id === id) : null;
  if (!target || !ID.test(id)) throw new Error(kind === 'plane' ? '面が見つかりません' : '線(グループ)が見つかりません');
  const pointIds = kind === 'line' ? target.highlightIds : (target.lineIds || []).flatMap((lid) => lines.find((l) => l.id === lid)?.highlightIds || []);
  const record = normalizeDismissal({ id, kind, name: target.name, pointIds, dismissed: true, updatedAt: now }, now);
  library.dismissals = { ...dismissalsOf(library), [id]: record };
  library.updatedAt = now;
  return record;
}

/** 消したのを取り消す（次の分析から、また作ってよい） */
export function undoDismiss(library, id, now = new Date().toISOString()) {
  const all = dismissalsOf(library);
  if (!Object.hasOwn(all, id)) return;
  // 戻したものの点は使わないので持たない（同期を重くしない）
  library.dismissals = { ...all, [id]: { ...all[id], pointIds: [], dismissed: false, updatedAt: now } };
  library.updatedAt = now;
}

/** 消している線・面の記録（kind ごと） */
function dismissedOf(library, kind) {
  return Object.values(dismissalsOf(library)).filter((d) => d?.dismissed === true && d.kind === kind);
}

/**
 * 分析の結果から、消した線・面を外したものを返す（引数は変えない。外すものが無ければ同じ物を返す）。
 * 消した線の点は「まだつながらない点」に移し、消した面の線は面に入っていない線として残す
 */
export function withoutDismissed(analysis, library) {
  if (!analysis || !Array.isArray(analysis.lines) || !Array.isArray(analysis.planes)) return analysis;
  const lineIds = new Set(dismissedOf(library, 'line').map((d) => d.id));
  const planeIds = new Set(dismissedOf(library, 'plane').map((d) => d.id));
  const gone = new Set(analysis.lines.filter((l) => lineIds.has(l.id)).map((l) => l.id));
  if (!gone.size && !analysis.planes.some((p) => planeIds.has(p.id))) return analysis;
  const lines = analysis.lines.filter((l) => !gone.has(l.id));
  const inLine = new Set(lines.flatMap((l) => l.highlightIds));
  const loose = analysis.lines.filter((l) => gone.has(l.id)).flatMap((l) => l.highlightIds).filter((id) => !inLine.has(id));
  const isolated = [...new Set([...(Array.isArray(analysis.isolated) ? analysis.isolated : []), ...loose])];
  const planes = analysis.planes
    .filter((p) => !planeIds.has(p.id))
    .map((p) => ({ ...p, lineIds: p.lineIds.filter((id) => !gone.has(id)) }))
    .filter((p) => p.lineIds.length);
  const livePlanes = new Set(planes.map((p) => p.id));
  const liveLines = new Set(lines.map((l) => l.id));
  const out = { ...analysis, lines, planes, isolated };
  if (analysis.stats) out.stats = { ...analysis.stats, lines: lines.length, planes: planes.length, isolated: isolated.length };
  // ほかの端末・バックアップから届いた分析は、中の要素まで形が確かめられていない（壊れた要素で同期を止めない）
  const list = (v) => (Array.isArray(v) ? v : []);
  if (analysis.solid && Array.isArray(analysis.solid.relations)) out.solid = { ...analysis.solid, relations: analysis.solid.relations.filter((r) => livePlanes.has(r?.from) && livePlanes.has(r?.to)) };
  if (Array.isArray(analysis.recommendations)) out.recommendations = analysis.recommendations.map((r) => (r?.planeId && !livePlanes.has(r.planeId) ? { ...r, planeId: null } : r));
  if (Array.isArray(analysis.discoveries)) out.discoveries = analysis.discoveries.filter((d) => !(d?.lineId && gone.has(d.lineId)));
  const c = analysis.changes;
  if (c && Array.isArray(c.addedLines)) {
    out.changes = {
      ...c,
      addedLines: c.addedLines.filter((x) => liveLines.has(x?.id)),
      grownLines: list(c.grownLines).filter((x) => liveLines.has(x?.id)),
      connectedPoints: list(c.connectedPoints).filter((x) => liveLines.has(x?.lineId)),
    };
  }
  return out;
}

/** 消した線・面ごとの、消したときの点（Kindle で伸ばしたハイライトは置き換わった先）の集まり */
export function dismissedPointSets(library, kind) {
  return dismissedOf(library, kind)
    .map((d) => new Set((Array.isArray(d.pointIds) ? d.pointIds : []).map((id) => currentPointId(library, id))))
    .filter((s) => s.size);
}

/**
 * 点の集まりが、消した線・面のどれかと同じとみなせるか（点の半分以上が、消したときの点。
 * 重なりが 1 点だけなら別のもの: 消した線の点 1 つと新しい点 1 つの線まで作れなくならないように）
 */
export function resemblesDismissed(pointIds, sets) {
  if (!pointIds.length || !sets.length) return false;
  return sets.some((s) => {
    const shared = pointIds.filter((id) => s.has(id)).length;
    return shared >= RESEMBLE_MIN && shared >= pointIds.length * RESEMBLE_SHARE;
  });
}

/**
 * 新しく作る線（id が null）のうち、消した線と同じとみなせるものを作らず、その点を「まだつながらない点」にする
 * @param {{ groups: { id: string|null, members: number[] }[], isolated: number[] }} carried
 * @param {string[]} ids  点の番号 → 点の ID
 */
export function skipDismissedLines({ groups, isolated }, ids, sets) {
  if (!sets.length) return { groups, isolated };
  const skip = (g) => !g.id && resemblesDismissed(g.members.map((i) => ids[i]), sets);
  if (!groups.some(skip)) return { groups, isolated };
  return { groups: groups.filter((g) => !skip(g)), isolated: [...isolated, ...groups.filter(skip).flatMap((g) => g.members)].sort((a, b) => a - b) };
}

/**
 * 新しく作る面（id が null）のうち、消した面と同じとみなせるものを作らず、その線をいちばん近いほかの面に入れる。
 * ほかに入れる面が無いとき（すべての面が消した面に似ている）は、線の置き場が無くなるのでそのまま残す
 * @param {{ id: string|null, members: number[] }[]} planeGroups  carryPlanes の面
 * @param {{ highlightIds: string[] }[]} lines
 * @param {Float32Array[]} vectors  線のベクトル
 */
export function skipDismissedPlanes(planeGroups, lines, vectors, sets) {
  if (!sets.length) return planeGroups;
  const skip = (g) => !g.id && resemblesDismissed(g.members.flatMap((i) => lines[i].highlightIds), sets);
  const kept = planeGroups.filter((g) => !skip(g)).map((g) => ({ ...g, members: [...g.members] }));
  if (!kept.length || kept.length === planeGroups.length) return planeGroups;
  const centers = kept.map((g) => centroid(g.members.map((i) => vectors[i])));
  for (const i of planeGroups.filter(skip).flatMap((g) => g.members)) {
    let best = 0;
    for (let k = 1; k < kept.length; k++) if (dot(vectors[i], centers[k]) > dot(vectors[i], centers[best])) best = k;
    kept[best].members.push(i);
  }
  return kept;
}
