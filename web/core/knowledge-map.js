// 立体（知識の全体像）を図にするための要素・見た目・座標。描くのは同梱の Cytoscape.js（web/vendor/）
// 面を塊の中心にして、面 → 線 → 点の 3 段で置く。塊の間には遠いつながり・自分のリンク・関わる点の橋を引き、
// まだつながらない点は周りに散らす（Obsidian のグラフビューのような見え方。核は置かない）
// 点は 2,000 近くになるので、座標は力学的な並べ方（重い・毎回形が変わる）を使わずにここで計算する

import { currentPointId } from './point-ids.js';
import { liveLinks } from './links.js';
import { visibleFarConnections } from './far-reactions.js';

const pointNode = (id) => `pt:${id}`;

/**
 * 図に置く要素（ノード）と辺。library を渡すと、自分のリンクと遠いつながりへの反応（「ちがう」は出さない）を使う
 * ノード: { id, kind: 'plane'|'line'|'point', label, ref, weight, isolated? }
 * 辺: kind = plane（面 → 線）/ member（線 → 点）/ related（関わる点）/ far（遠いつながり）/ link（自分のリンク）/ relation（面どうしの関係）
 */
export function mapElements(analysis, { library = null } = {}) {
  const planes = analysis?.planes || [];
  const lines = analysis?.lines || [];
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const nodes = [];
  const edges = [];
  const edgeIds = new Set();
  const edge = (kind, source, target, label = '') => {
    const id = `${kind}:${source}|${target}`;
    if (source === target || edgeIds.has(id) || edgeIds.has(`${kind}:${target}|${source}`)) return;
    edgeIds.add(id);
    edges.push({ id, source, target, kind, ...(label ? { label } : {}) });
  };

  const planeOfLine = new Map();
  for (const p of planes) for (const id of p.lineIds || []) if (lineById.has(id) && !planeOfLine.has(id)) planeOfLine.set(id, p.id);
  for (const p of planes) {
    const count = (p.lineIds || []).filter((id) => planeOfLine.get(id) === p.id).length;
    nodes.push({ id: `p:${p.id}`, kind: 'plane', label: p.name || '', ref: p.id, weight: count });
  }
  // 面に入った線を面の順に、面の無い線をその後に
  const ordered = [...planes.flatMap((p) => (p.lineIds || []).filter((id) => planeOfLine.get(id) === p.id)), ...lines.filter((l) => !planeOfLine.has(l.id)).map((l) => l.id)];
  const points = new Set();
  const later = [];
  for (const id of ordered) {
    const l = lineById.get(id);
    nodes.push({ id: `l:${l.id}`, kind: 'line', label: l.name || '', ref: l.id, weight: (l.highlightIds || []).length });
    if (planeOfLine.has(l.id)) edge('plane', `p:${planeOfLine.get(l.id)}`, `l:${l.id}`);
    for (const h of l.highlightIds || []) {
      // 2 つの線に入った点は先の線にぶら下げ、後の線からは関わる点として橋を引く
      if (points.has(h)) later.push([l.id, h]);
      else {
        points.add(h);
        nodes.push({ id: pointNode(h), kind: 'point', label: '', ref: h, weight: 0 });
        edge('member', `l:${l.id}`, pointNode(h));
      }
    }
  }
  for (const h of analysis?.isolated || []) {
    if (points.has(h)) continue;
    points.add(h);
    nodes.push({ id: pointNode(h), kind: 'point', label: '', ref: h, weight: 0, isolated: true });
  }

  // 塊の間の橋。リンク・遠いつながりの端は今の点の ID なので、図の点（分析したときの ID）を今の ID で引く
  const onMap = new Map([...points].map((h) => [currentPointId(library, h), h]));
  const bridge = (kind, a, b) => {
    const [x, y] = [onMap.get(currentPointId(library, a)), onMap.get(currentPointId(library, b))];
    if (x && y) edge(kind, pointNode(x), pointNode(y));
  };
  for (const id of ordered) for (const h of lineById.get(id).relatedIds || []) if (points.has(h)) edge('related', `l:${id}`, pointNode(h));
  for (const [lineId, h] of later) edge('related', `l:${lineId}`, pointNode(h));
  for (const f of visibleFarConnections(analysis, library)) bridge('far', f.a, f.b);
  for (const l of liveLinks(library)) bridge('link', l.a, l.b);
  const planeIds = new Set(planes.map((p) => p.id));
  for (const r of analysis?.solid?.relations || []) if (planeIds.has(r.from) && planeIds.has(r.to)) edge('relation', `p:${r.from}`, `p:${r.to}`, r.type || '');
  return { nodes, edges };
}

// ---- 座標 ----

// 点どうしの間隔（ひまわりの種のように詰める）・線と面の中心の円の大きさ・塊どうしの隙間（橋が見えるように空ける）
const POINT_SPACING = 9;
const LINE_CORE = 14;
const PLANE_CORE = 34;
const LINE_GAP = 8;
const CLUSTER_GAP = 60;
const ISOLATED_GAP = 70;
const ISOLATED_SPACING = 26;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** 中心のまわりに、黄金角で回しながら外へ広げて置く（i 番目。r0 は中心の円の半径） */
const sunflower = (i, r0, spacing) => {
  const r = r0 + spacing * Math.sqrt(i + 0.5);
  return { x: r * Math.cos(i * GOLDEN_ANGLE), y: r * Math.sin(i * GOLDEN_ANGLE) };
};

/**
 * 円を、中心から近い順に重ならないように詰める（大きい順に。最初の円は真ん中）。reserved は真ん中に空けておく円の半径
 * @param {number[]} radii @returns {{ x: number, y: number }[]} radii と同じ順の中心
 */
function packCircles(radii, { reserved = 0, gap = 0 } = {}) {
  const order = radii.map((r, i) => i).sort((a, b) => radii[b] - radii[a] || a - b);
  const placed = [];
  const out = new Array(radii.length);
  const fits = (x, y, r) => Math.hypot(x, y) >= (reserved ? reserved + r + gap : 0) && placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + r + gap);
  for (const i of order) {
    // 数でない半径は 0 として扱う（NaN だと空いた場所が見つからず、下の輪の探索が止まらない）
    const r = Number.isFinite(radii[i]) ? radii[i] : 0;
    let at = null;
    if (!reserved && !placed.length) at = { x: 0, y: 0 };
    // 半径を少しずつ広げた輪の上を回り、最初に空いていた場所に置く
    const step = Math.max(gap, r / 2, 4);
    for (let d = reserved ? reserved + r + gap : step; !at; d += step) {
      const n = Math.max(6, Math.ceil((2 * Math.PI * d) / step));
      for (let k = 0; k < n && !at; k++) {
        const t = (2 * Math.PI * k) / n + d * 0.01;
        const [x, y] = [d * Math.cos(t), d * Math.sin(t)];
        if (fits(x, y, r)) at = { x, y };
      }
    }
    placed.push({ ...at, r });
    out[i] = at;
  }
  return out;
}

/**
 * mapElements の要素に座標を付ける（id → { x, y }）。毎回同じ形になる（乱数を使わない）
 * 点は線のまわりに、線は面のまわりに詰め、面の塊（と面の無い線）を重ならないように並べ、浮いた点はいちばん外の輪に散らす
 */
export function mapPositions({ nodes, edges }) {
  const children = new Map();
  for (const e of edges) {
    if (e.kind !== 'plane' && e.kind !== 'member') continue;
    if (!children.has(e.source)) children.set(e.source, []);
    children.get(e.source).push(e.target);
  }
  const kids = (id) => children.get(id) || [];
  // 線の塊: 線のまわりに点（相対座標と半径）
  const lineCluster = (id) => {
    const pts = kids(id).map((p, i) => [p, sunflower(i, LINE_CORE, POINT_SPACING)]);
    const r = pts.reduce((m, [, q]) => Math.max(m, Math.hypot(q.x, q.y)), LINE_CORE) + POINT_SPACING / 2;
    return { r, items: [[id, { x: 0, y: 0 }], ...pts] };
  };
  // 面の塊: 面のまわりに線の塊
  const planeCluster = (id) => {
    const subs = kids(id).map(lineCluster);
    const centers = packCircles(subs.map((s) => s.r), { reserved: PLANE_CORE, gap: LINE_GAP });
    const items = [[id, { x: 0, y: 0 }]];
    let r = PLANE_CORE;
    subs.forEach((s, i) => {
      for (const [nid, q] of s.items) items.push([nid, { x: q.x + centers[i].x, y: q.y + centers[i].y }]);
      r = Math.max(r, Math.hypot(centers[i].x, centers[i].y) + s.r);
    });
    return { r, items };
  };
  const hasParent = new Set(edges.filter((e) => e.kind === 'plane' || e.kind === 'member').map((e) => e.target));
  const clusters = [
    ...nodes.filter((n) => n.kind === 'plane').map((n) => planeCluster(n.id)),
    ...nodes.filter((n) => n.kind === 'line' && !hasParent.has(n.id)).map((n) => lineCluster(n.id)),
  ];
  const centers = packCircles(clusters.map((c) => c.r), { gap: CLUSTER_GAP });
  const pos = {};
  let outer = 0;
  clusters.forEach((c, i) => {
    for (const [id, q] of c.items) pos[id] = { x: q.x + centers[i].x, y: q.y + centers[i].y };
    outer = Math.max(outer, Math.hypot(centers[i].x, centers[i].y) + c.r);
  });
  // 塊の重心のまわりに、浮いた点（どこにもぶら下がっていない点）を散らす
  const placed = Object.values(pos);
  const cx = placed.length ? placed.reduce((s, p) => s + p.x, 0) / placed.length : 0;
  const cy = placed.length ? placed.reduce((s, p) => s + p.y, 0) / placed.length : 0;
  const inner = placed.reduce((m, p) => Math.max(m, Math.hypot(p.x - cx, p.y - cy)), Math.max(0, outer - Math.hypot(cx, cy))) + ISOLATED_GAP;
  nodes
    .filter((n) => !(n.id in pos))
    .forEach((n, i) => {
      const r = Math.sqrt(inner * inner + (i + 0.5) * ISOLATED_SPACING * ISOLATED_SPACING * 2);
      pos[n.id] = { x: cx + r * Math.cos(i * GOLDEN_ANGLE), y: cy + r * Math.sin(i * GOLDEN_ANGLE) };
    });
  return pos;
}

// ---- 見た目 ----

/** 見た目。colors は画面の色（CSS 変数から読んだ値。明るい・暗いの切り替えに合わせる） */
export function mapStyle(colors) {
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'font-family': colors.font,
        'font-size': 12,
        color: colors.ink,
        'text-valign': 'bottom',
        'text-margin-y': 3,
        'text-wrap': 'wrap',
        'text-overflow-wrap': 'anywhere',
        'text-max-width': 110,
        'text-outline-color': colors.surface,
        'text-outline-width': 3,
        'min-zoomed-font-size': 8, // 縮めて読めない大きさの文字は描かない（拡大すると線の名前が出る）
      },
    },
    {
      selector: 'node[kind = "plane"]',
      style: { 'background-color': colors.plane, width: 'mapData(weight, 0, 40, 30, 60)', height: 'mapData(weight, 0, 40, 30, 60)', 'font-size': 16, 'font-weight': 'bold', 'text-max-width': 160, 'z-index': 3 },
    },
    { selector: 'node[kind = "line"]', style: { 'background-color': colors.line, width: 'mapData(weight, 0, 20, 10, 22)', height: 'mapData(weight, 0, 20, 10, 22)', 'z-index': 2 } },
    { selector: 'node[kind = "point"]', style: { 'background-color': colors.line, 'background-opacity': 0.55, width: 5, height: 5, 'z-index': 1 } },
    { selector: 'node[?isolated]', style: { 'background-color': colors.point, 'background-opacity': 0.8, width: 6, height: 6 } },
    { selector: 'edge', style: { width: 0.6, 'line-color': colors.line, opacity: 0.35, 'curve-style': 'straight' } },
    { selector: 'edge[kind = "plane"]', style: { width: 1.5, 'line-color': colors.plane, opacity: 0.5 } },
    { selector: 'edge[kind = "related"]', style: { width: 0.8, 'line-color': colors.line, opacity: 0.45, 'line-style': 'dashed' } },
    { selector: 'edge[kind = "far"]', style: { width: 2, 'line-color': colors.solid, opacity: 0.85 } },
    { selector: 'edge[kind = "link"]', style: { width: 1.5, 'line-color': colors.ink, opacity: 0.45 } },
    {
      selector: 'edge[kind = "relation"]',
      style: {
        width: 2,
        'line-color': colors.solid,
        opacity: 0.6,
        'line-style': 'dashed',
        label: 'data(label)',
        'font-size': 12,
        color: colors.solid,
        'text-outline-color': colors.surface,
        'text-outline-width': 3,
        'min-zoomed-font-size': 8,
      },
    },
  ];
}
