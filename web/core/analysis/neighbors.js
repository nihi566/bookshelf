// 意味の近い点（G4-2）と、2 番目に近い線にも十分近い点（G4-3）
//
// - 意味の近い点: 点ごとに、別の出どころ（別の本。思いつきは 1 つずつ別）の点を近い順に 5 件。
//   すべての点どうしを比べると重い（点 2,000 件で 400 万組）ので、中心が近い線 8 本の点と、まだつながらない点だけを候補にする
// - 関わる点: 線に入っている点のうち、自分の線を除いていちばん近い線（2 番目に近い線）に、その線の点の中心への近さの
//   中央値以上に近い点。その線の「関わる点」にする（1 本に最大 12 件。近い順）。1 つの点が複数の線とつながる
// どちらも乱数を使わず、同じ近さなら ID の順（同じデータなら同じ結果）

import { dot } from './vectors.js';
import { isPointId } from '../point-ids.js';

export const NEIGHBORS_MAX = 5;
export const RELATED_MAX = 12;
// 意味の近い点の候補を探す線の数（点ごとに、中心が近い線から）
const NEIGHBOR_LINES = 8;

const byId = (ids) => (x, y) => (ids[x] < ids[y] ? -1 : ids[x] > ids[y] ? 1 : 0);

/** 線の点が、その線の中心にどれだけ近いかの中央値（「十分近い」の基準。点の数が偶数なら低い方） */
export function lineMedian(vectors, members, centroid) {
  const sims = members.map((i) => dot(vectors[i], centroid)).sort((a, b) => a - b);
  return sims.length ? sims[Math.floor((sims.length - 1) / 2)] : Infinity;
}

/**
 * @param {object} p
 * @param {string[]} p.ids 点の ID
 * @param {Float32Array[]} p.vectors 点のベクトル（ids と同じ並び）
 * @param {{ id: string, members: number[], centroid: Float32Array }[]} p.lines 線（members は点の番号）
 * @param {number[]} p.isolated まだつながらない点の番号
 * @param {(i: number) => string} p.sourceOf 点の出どころ
 * @returns {{ neighbors: Record<string, string[]>, related: Map<string, string[]> }}
 */
export function nearPoints({ ids, vectors, lines, isolated, sourceOf }) {
  const lineOf = new Int32Array(ids.length).fill(-1);
  lines.forEach((l, j) => l.members.forEach((i) => (lineOf[i] = j)));
  const median = lines.map((l) => lineMedian(vectors, l.members, l.centroid));
  const tieI = byId(ids);
  const neighbors = {};
  const related = lines.map(() => []);
  for (let i = 0; i < ids.length; i++) {
    const v = vectors[i];
    const order = lines.map((l, j) => ({ j, s: dot(v, l.centroid) })).sort((x, y) => y.s - x.s || x.j - y.j);
    // 2 番目に近い線（自分の線を除いていちばん近い線）にも、その線の点の中央値以上に近ければ「関わる点」
    if (lineOf[i] >= 0) {
      const second = order.find((o) => o.j !== lineOf[i]);
      if (second && second.s >= median[second.j]) related[second.j].push({ i, s: second.s });
    }
    // 意味の近い点: 中心が近い線の点と、まだつながらない点のうち、別の出どころの点
    const cand = new Set(isolated);
    for (const o of order.slice(0, NEIGHBOR_LINES)) for (const k of lines[o.j].members) cand.add(k);
    const src = sourceOf(i);
    const best = [];
    for (const k of cand) if (k !== i && sourceOf(k) !== src) best.push({ k, s: dot(v, vectors[k]) });
    best.sort((x, y) => y.s - x.s || tieI(x.k, y.k));
    // 鍵にするのは点の ID の形のものだけ（__proto__ などの名前で入れ物の継承元を書き換えない）
    if (best.length && isPointId(ids[i])) neighbors[ids[i]] = best.slice(0, NEIGHBORS_MAX).map((b) => ids[b.k]);
  }
  return {
    neighbors,
    related: new Map(lines.map((l, j) => [l.id, related[j].sort((x, y) => y.s - x.s || tieI(x.i, y.i)).slice(0, RELATED_MAX).map((r) => ids[r.i])])),
  };
}
