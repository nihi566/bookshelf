// 立体（知識の全体像）を図にするための要素・見た目・並べ方。描くのは同梱の Cytoscape.js（web/vendor/）
// 線は数百本になるので一度に出さない。最初は核と面だけを見せ、面を選んだらその面の線だけを見せる

/**
 * 図に置く点（ノード）と辺。focus に面の ID を渡すと、その面と面の線だけを返す
 * （無くなった面なら全体に戻し、focus は null で返す）
 * isStarred(線の ID) が true の線は starred を立て、名前の前に ★ を付ける（線の一覧と同じ印）
 */
export function mapElements(analysis, { focus = null, isStarred = () => false } = {}) {
  const planes = analysis?.planes || [];
  const lineById = new Map((analysis?.lines || []).map((l) => [l.id, l]));
  const linesOf = (p) => (p.lineIds || []).map((id) => lineById.get(id)).filter(Boolean);
  const plane = focus ? planes.find((p) => p.id === focus) : null;
  if (plane) {
    const lines = linesOf(plane);
    return {
      focus: plane.id,
      nodes: [
        { id: `p:${plane.id}`, kind: 'plane', label: plane.name, ref: plane.id, weight: lines.length },
        ...lines.map((l) => {
          const starred = Boolean(isStarred(l.id));
          return { id: `l:${l.id}`, kind: 'line', label: starred ? `★ ${l.name}` : l.name, ref: l.id, weight: (l.highlightIds || []).length, starred };
        }),
      ],
      edges: lines.map((l) => ({ id: `e:${plane.id}:${l.id}`, source: `p:${plane.id}`, target: `l:${l.id}`, kind: 'plane' })),
    };
  }
  const planeIds = new Set(planes.map((p) => p.id));
  const relations = (analysis?.solid?.relations || []).filter((r) => planeIds.has(r.from) && planeIds.has(r.to));
  return {
    focus: null,
    nodes: [
      { id: 'core', kind: 'core', label: analysis?.solid?.title || '知識の核', ref: '', weight: 0 },
      ...planes.map((p) => ({ id: `p:${p.id}`, kind: 'plane', label: p.name, ref: p.id, weight: linesOf(p).length })),
    ],
    edges: [
      ...planes.map((p) => ({ id: `e:core:${p.id}`, source: 'core', target: `p:${p.id}`, kind: 'core' })),
      ...relations.map((r, i) => ({ id: `r:${i}`, source: `p:${r.from}`, target: `p:${r.to}`, kind: 'relation', label: r.type || '' })),
    ],
  };
}

/** 見た目。colors は画面の色（CSS 変数から読んだ値。明るい・暗いの切り替えに合わせる）。narrow は幅の狭い画面（名前を細く折り返して輪を小さくする） */
export function mapStyle(colors, { narrow = false } = {}) {
  const w = (wide, slim) => (narrow ? slim : wide);
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'font-family': colors.font,
        'font-size': 14,
        color: colors.ink,
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'text-wrap': 'wrap',
        'text-overflow-wrap': 'anywhere',
        'text-max-width': w(120, 72),
        'text-outline-color': colors.surface,
        'text-outline-width': 3,
        'min-zoomed-font-size': 7, // 縮めて読めない大きさの文字は描かない（重なった文字の塊を見せない）
      },
    },
    { selector: 'node[kind = "core"]', style: { 'background-color': colors.solid, width: 56, height: 56, 'font-size': 18, 'font-weight': 'bold', 'text-max-width': w(220, 110) } },
    {
      selector: 'node[kind = "plane"]',
      style: { 'background-color': colors.plane, width: 'mapData(weight, 0, 40, 26, 54)', height: 'mapData(weight, 0, 40, 26, 54)', 'font-size': 16, 'font-weight': 'bold', 'text-max-width': w(150, 80) },
    },
    { selector: 'node[kind = "line"]', style: { 'background-color': colors.line, width: 'mapData(weight, 0, 20, 12, 34)', height: 'mapData(weight, 0, 20, 12, 34)' } },
    // ★の線は輪の外に核の色の枠を付ける（★の無い線は枠なしのまま）
    { selector: 'node[kind = "line"][?starred]', style: { 'border-width': 3, 'border-color': colors.solid, 'font-weight': 'bold' } },
    { selector: 'edge', style: { width: 1.5, 'line-color': colors.plane, opacity: 0.4, 'curve-style': 'straight' } },
    { selector: 'edge[kind = "core"]', style: { width: 2.5, 'line-color': colors.solid, opacity: 0.35 } },
    {
      selector: 'edge[kind = "relation"]',
      style: {
        width: 2.5,
        'line-color': colors.solid,
        opacity: 0.9,
        'line-style': 'dashed',
        'curve-style': 'unbundled-bezier',
        'control-point-distances': 40,
        label: 'data(label)',
        'font-size': 11,
        color: colors.solid,
        'text-outline-color': colors.surface,
        'text-outline-width': 3,
        'min-zoomed-font-size': 7,
      },
    },
  ];
}

/** 並べ方。全体は核を中心に面を 1 周、面を開いたときは面を中心に、点の多い線ほど内側の輪へ */
export function mapLayout({ focus = null } = {}) {
  return {
    name: 'concentric',
    concentric: (n) => (n.data('kind') === 'line' ? n.data('weight') : n.data('kind') === 'plane' && !focus ? 1 : Number.MAX_SAFE_INTEGER),
    // 線の点の数を 3 段くらいの輪に分ける（1 段 1 輪だと点の数の種類だけ輪ができる）
    levelWidth: (nodes) => Math.max(1, Math.ceil(nodes.filter((n) => n.data('kind') === 'line').max((n) => n.data('weight')).value / 3)),
    nodeDimensionsIncludeLabels: true,
    avoidOverlap: true,
    minNodeSpacing: 8,
    padding: 16,
    animate: false,
  };
}
