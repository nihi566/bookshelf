// 発見: 分析のたびに、前回の分析との差から「思いがけないつながり」を作る（アプリを開いた人にすぐ届けるため）
//
// Discovery = { id: 'd…', kind, lineId, lineName, reason, pointIds: [a, b], foundAt }
//   kind: 'cross'    … 既にある線に増えた点が、別の本の点とつながった
//         'line'     … 新しい線ができた（別の本の 2 点を見せる）
//         'isolated' … 前回「まだつながらない点」だった点が、線に入った
//         'far'      … 遠いつながり（far.js）が新しく見つかった。lineName は共通する考え、reason はなぜつながるか
// 最初の分析・作り直した分析では作らない（すべてが「新しい」になり、思いがけなさが無くなるため）。
// 遠いつながりは線の ID に依らず、1 回の分析で 10 組までしか判定しないので、作り直した分析でも作る

import { hash } from '../text.js';
import { dot } from './vectors.js';

// 1 回の分析で作る発見の数（一度に大量に届けても読まれない）と、残しておく数
export const DISCOVERIES_PER_ANALYSIS = 20;
export const DISCOVERIES_KEEP = 60;
// 発見の種類の並び（同じ回に見つかったものは、まだつながらなかった点 → 本をまたいだ点 → 新しい線 の順に見せる）
const KIND_ORDER = { isolated: 0, cross: 1, line: 2 };

export function discoveryId(kind, lineId, pointIds) {
  return 'd' + hash(`${kind}|${lineId}|${[...pointIds].sort().join('|')}`);
}

/**
 * 今回の分析で見つかった発見（新しい順に並べる前の、同じ回のもの）
 * @param {object} p
 * @param {object} p.previous      前回の分析（線・まだつながらない点）
 * @param {object[]} p.lines        今回の線（highlightIds は中心に近い順）
 * @param {(id: string) => string} p.sourceOf  点の出どころ（本の ID。思いつきは 1 つずつ別の出どころ）
 * @param {(id: string) => Float32Array|undefined} p.vectorOf  点のベクトル（いちばん近い相手を選ぶため）
 * @param {(id: string) => string[]} [p.formerIdsOf]  その点に置き換わる前の点の ID（Kindle で伸ばしたハイライト）。
 *   伸ばしただけの点を「新しくつながった」と数えないため
 * @param {string} p.now
 */
export function findDiscoveries({ previous, lines, sourceOf, vectorOf, formerIdsOf = () => [], now }) {
  const prevLineOf = new Map();
  for (const l of previous.lines || []) for (const id of l.highlightIds || []) prevLineOf.set(id, l.id);
  const prevLines = new Set((previous.lines || []).map((l) => l.id));
  const prevIsolated = new Set(previous.isolated || []);
  const aliases = (id) => [id, ...formerIdsOf(id)];
  const wasInLine = (id, lineId) => aliases(id).some((x) => prevLineOf.get(x) === lineId);
  const wasIsolated = (id) => aliases(id).some((x) => prevIsolated.has(x));
  // いちばん近い相手（ベクトルが無ければ、線の中心に近い順の最初）
  const closest = (p, candidates) => {
    const v = vectorOf(p);
    if (!candidates.length) return null;
    if (!v) return candidates[0];
    const sim = (q) => (vectorOf(q) ? dot(v, vectorOf(q)) : -Infinity);
    return candidates.reduce((best, q) => (sim(q) > sim(best) ? q : best));
  };
  const out = [];
  const add = (kind, line, pointIds) => out.push({ id: discoveryId(kind, line.id, pointIds), kind, lineId: line.id, lineName: line.name, reason: line.summary || line.insight || '', pointIds, foundAt: now });
  for (const l of lines) {
    const ids = l.highlightIds;
    if (!prevLines.has(l.id)) {
      // 新しい線: 中心にいちばん近い点と、それと別の本の点。1 冊だけでできた線は発見にしない（変化の一覧には出る）
      const a = ids[0];
      const b = ids.find((id) => sourceOf(id) !== sourceOf(a));
      if (a && b) add('line', l, [a, b]);
      continue;
    }
    for (const p of ids) {
      if (wasInLine(p, l.id)) continue;
      const others = ids.filter((q) => q !== p && sourceOf(q) !== sourceOf(p));
      if (wasIsolated(p)) {
        const q = closest(p, others.length ? others : ids.filter((x) => x !== p));
        if (q) add('isolated', l, [p, q]);
      } else if (others.length) add('cross', l, [p, closest(p, others)]);
    }
  }
  // 同じ線の同じ 2 点は 1 つに（まだつながらなかった点と増えた点が、互いにいちばん近い相手になったときなど）
  const seen = new Set();
  return out
    .sort((x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind])
    .filter((d) => {
      const key = `${d.lineId}|${[...d.pointIds].sort().join('|')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, DISCOVERIES_PER_ANALYSIS);
}

/** 新しく見つかった遠いつながり（far.js の FarConnection）を発見にする */
export function farDiscovery(f) {
  return { id: discoveryId('far', '', [f.a, f.b]), kind: 'far', lineId: '', lineName: f.idea, reason: f.explanation, pointIds: [f.a, f.b], foundAt: f.foundAt };
}

/** 発見として使える形か（ほかの端末・バックアップから届いた分析の中の発見を、画面に出す前に確かめる） */
export function isDiscovery(d) {
  return Boolean(d && typeof d === 'object' && typeof d.id === 'string' && Array.isArray(d.pointIds) && d.pointIds.length === 2 && d.pointIds.every((x) => typeof x === 'string'));
}

/**
 * 今回の発見を前回までの発見の前に積む（同じものは 1 つに。点が消えた発見は外す。最大 DISCOVERIES_KEEP 件）
 * @param {(id: string) => boolean} alive 点が今もあるか
 */
export function mergeDiscoveries(fresh, previous = [], alive = () => true) {
  const seen = new Set();
  const out = [];
  for (const d of [...fresh, ...(Array.isArray(previous) ? previous : [])]) {
    if (!isDiscovery(d) || seen.has(d.id) || !d.pointIds.every(alive)) continue;
    seen.add(d.id);
    out.push(d);
  }
  return out.slice(0, DISCOVERIES_KEEP);
}
