// 前回の分析の線・面を引き継いで、点の増減だけを反映して組み直す（線・面の ID を保つ）
//
// 点が少し増えただけで線を最初から作り直すと、ほとんどの線の顔ぶれが変わり、AI を線の数だけ呼び直すことになる。
// そこで、前回の線は残っている点ごと引き継ぎ、増えた点は近い線に加え、どこにも近くない点どうしだけで新しい線を作る。

import { centroid, dot, groupLines, groupPoints, l2normalize } from './vectors.js';

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
const sd = (xs) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

/** ベクトルの和（線の中心を、点を足し引きしながら作り直すため） */
function sumOf(vs) {
  const s = new Float32Array(vs[0].length);
  for (const v of vs) for (let i = 0; i < s.length; i++) s[i] += v[i];
  return s;
}

/** 点 v と、v を除いた線の中心との近さ（線の点は自分が中心に入っているので近く出る。増えた点と同じ条件で比べるため除く） */
function leaveOneOut(v, sum) {
  const rest = new Float32Array(sum.length);
  let any = false;
  for (let i = 0; i < sum.length; i++) {
    rest[i] = sum[i] - v[i];
    if (Math.abs(rest[i]) > 1e-9) any = true;
  }
  return any ? dot(v, l2normalize(rest)) : 1;
}

/**
 * 点を線に割り当てる。前回の線（previousLines）があれば引き継ぐ。
 * - 前回の線: 今も残っている点だけを残す（2 点未満になった線はほどく）。ID はそのまま
 * - 増えた点（前回の線にも「まだつながらない点」にも無い点）: いちばん近い線の中心に十分近ければ、その線に加える。
 *   「十分近い」= 引き継いだ点が「自分を除いた線の中心」にどれだけ近いかの平均 − 1.5σ 以上
 *   （自分を含めた中心で測ると線の点だけが近く出て、増えた点が入りにくくなるため）。
 *   点の数が上限（maxSize）に達した線には加えない（線を大きくしすぎない）
 * - 前回から線に入っていない点: 今回点が加わった線（中心が動いた線）に十分近ければ、その線に加える
 * - 残った点で新しい線を作る。ただし増えた点を 1 つ以上含み、十分近い点だけでできる組に限る
 *   （何も増えていなければ何も変えない。遠い点どうしを無理に束ねない）。線の数は maxGroups まで
 * 前回の線が無ければ、すべての点を新しく束ねる（groupPoints と同じ）
 * @param {object} p
 * @param {string[]} p.ids             今の点の ID（vectors と同じ並び）
 * @param {Float32Array[]} p.vectors
 * @param {{ id: string, highlightIds: string[] }[]} [p.previousLines]
 * @param {string[]} [p.previousIsolated] 前回の「まだつながらない点」（増えた点と見分けるため）
 * @returns {{ lines: { id: string|null, members: number[] }[], isolated: number[] }} id が null の線は新しい線
 */
export function carryLines({ ids, vectors, previousLines = [], previousIsolated = [], targetSize, maxSize, maxGroups, minSize = 2 }) {
  const index = new Map(ids.map((id, i) => [id, i]));
  const known = new Set([...previousLines.flatMap((l) => l.highlightIds || []), ...previousIsolated]);
  const isNew = (i) => !known.has(ids[i]);
  const taken = new Set();
  const kept = [];
  for (const l of previousLines) {
    const members = (l.highlightIds || []).map((id) => index.get(id)).filter((i) => i !== undefined && !taken.has(i));
    if (members.length < minSize) continue;
    members.forEach((i) => taken.add(i));
    kept.push({ id: l.id, members });
  }
  const sums = kept.map((l) => sumOf(l.members.map((i) => vectors[i])));
  const centers = sums.map((s) => l2normalize(s));
  const loo = kept.flatMap((l, li) => l.members.map((i) => leaveOneOut(vectors[i], sums[li])));
  const threshold = loo.length ? mean(loo) - 1.5 * sd(loo) : null;
  /** 点 i をいちばん近い線（only に含まれる線だけ・上限に達していない線）に加えられれば加える */
  const changed = new Set();
  const tryJoin = (i, only = null) => {
    if (threshold === null) return false;
    let best = -1;
    let bestSim = -Infinity;
    for (let li = 0; li < kept.length; li++) {
      if ((only && !only.has(li)) || kept[li].members.length >= maxSize) continue;
      const s = dot(vectors[i], centers[li]);
      if (s > bestSim) {
        bestSim = s;
        best = li;
      }
    }
    // まったく似ていない点（近さ 0 以下）は、線がどれだけゆるくても加えない
    if (best < 0 || bestSim < threshold || bestSim <= 0) return false;
    kept[best].members.push(i);
    changed.add(best);
    return true;
  };
  const unplaced = [];
  for (let i = 0; i < ids.length; i++) if (!taken.has(i) && !(isNew(i) && tryJoin(i))) unplaced.push(i);
  // 点が加わった線は中心が動くので、前回から線に入っていない点をもう一度確かめる（増えた点のそばの点がつながる）
  for (const li of changed) centers[li] = centroid(kept[li].members.map((i) => vectors[i]));
  const rest = changed.size ? unplaced.filter((i) => isNew(i) || !tryJoin(i, changed)) : unplaced;
  const fresh = [];
  const isolated = [];
  const room = maxGroups - kept.length;
  if (room > 0 && rest.length >= minSize && rest.some(isNew)) {
    const sub = groupPoints(rest.map((i) => vectors[i]), { targetSize, maxGroups: room, minSize });
    for (const g of sub.groups) {
      const members = g.map((j) => rest[j]);
      // 引き継いだ線があるときは、同じ近さの基準（自分を除いた中心への近さ）を満たす点だけで、増えた点を含む組だけを新しい線にする
      const sum = sumOf(members.map((i) => vectors[i]));
      const close = threshold === null ? members : members.filter((i) => leaveOneOut(vectors[i], sum) >= threshold);
      if (close.length >= minSize && close.some(isNew)) fresh.push({ id: null, members: close });
      else isolated.push(...close);
      isolated.push(...members.filter((i) => !close.includes(i)));
    }
    isolated.push(...sub.isolated.map((j) => rest[j]));
  } else isolated.push(...rest);
  fresh.sort((a, b) => b.members.length - a.members.length);
  return { lines: [...kept, ...fresh], isolated: isolated.sort((a, b) => a - b) };
}

/**
 * 線を面に割り当てる。前回の面（previousPlanes）があれば引き継ぐ。
 * - 前回の面: 今もある線だけを残す（線が無くなった面はなくす）。ID はそのまま
 * - 新しい線・面がなくなった線: いちばん近い面に加える
 * - 線 1 本だけになった面は、いちばん近い他の面にまとめる（線 1 本ではテーマにならない）
 * 前回の面が無ければ、すべての線を新しく束ねる（groupLines と同じ）
 * @param {object} p
 * @param {string[]} p.lineIds        今の線の ID（vectors と同じ並び）
 * @param {Float32Array[]} p.vectors  線のベクトル
 * @param {{ id: string, lineIds: string[] }[]} [p.previousPlanes]
 * @returns {{ id: string|null, members: number[] }[]} id が null の面は新しい面
 */
export function carryPlanes({ lineIds, vectors, previousPlanes = [], maxPlanes }) {
  const index = new Map(lineIds.map((id, i) => [id, i]));
  const taken = new Set();
  const kept = [];
  for (const p of previousPlanes) {
    const members = (p.lineIds || []).map((id) => index.get(id)).filter((i) => i !== undefined && !taken.has(i));
    if (!members.length) continue;
    members.forEach((i) => taken.add(i));
    kept.push({ id: p.id, members });
  }
  if (!kept.length) return groupLines(vectors, { maxPlanes }).map((members) => ({ id: null, members }));
  const centers = kept.map((p) => centroid(p.members.map((i) => vectors[i])));
  for (let i = 0; i < lineIds.length; i++) {
    if (taken.has(i)) continue;
    let best = 0;
    for (let pi = 1; pi < kept.length; pi++) if (dot(vectors[i], centers[pi]) > dot(vectors[i], centers[best])) best = pi;
    kept[best].members.push(i);
  }
  for (let lone = kept.find((p) => p.members.length === 1); lone && kept.length > 1; lone = kept.find((p) => p.members.length === 1)) {
    kept.splice(kept.indexOf(lone), 1);
    const v = vectors[lone.members[0]];
    const closeness = (p) => dot(v, centroid(p.members.map((i) => vectors[i])));
    kept.reduce((best, p) => (closeness(p) > closeness(best) ? p : best)).members.push(lone.members[0]);
  }
  return kept;
}
