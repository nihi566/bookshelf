import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapElements, mapPeek, mapPositions, mapStyle } from '../web/core/knowledge-map.js';
import { farId } from '../web/core/analysis/far.js';
import { addLink, removeLink, linkId } from '../web/core/links.js';
import cytoscape from '../web/vendor/cytoscape.esm.min.js';

const far = (a, b) => ({ id: farId(a, b), a, b, idea: '根っこ', explanation: '', foundAt: '2026-10-01T00:00:00.000Z' });

const analysis = () => ({
  lines: [
    { id: 'l1', name: '線1', highlightIds: ['ha', 'hb'], relatedIds: ['hd'] },
    { id: 'l2', name: '線2', highlightIds: ['hc'] },
    { id: 'l3', name: '線3', highlightIds: ['hd', 'ha'] },
    { id: 'l4', name: '面の無い線', highlightIds: ['he'] },
  ],
  planes: [
    { id: 'p1', name: '面1', lineIds: ['l1', 'l2', 'lX'] },
    { id: 'p2', name: '面2', lineIds: ['l3'] },
    { id: 'p3', name: '面3', lineIds: [] },
  ],
  isolated: ['hx', 'hy', 'hz'],
  farConnections: [far('ha', 'hd'), far('hc', 'hx'), far('hb', 'hq')],
  solid: { title: '核', relations: [{ from: 'p1', to: 'p2', type: '支える' }, { from: 'p1', to: 'pX', type: 'x' }] },
});

const ids = (els) => els.map((e) => e.id);
const pairs = (edges, kind) => edges.filter((e) => e.kind === kind).map((e) => [e.source, e.target]);

test('mapElements: 核は置かず、面 → 線 → 点の 3 段で置く', () => {
  const { nodes, edges } = mapElements(analysis());
  assert.ok(!nodes.some((n) => n.kind === 'core'));
  assert.deepEqual(nodes.filter((n) => n.kind === 'plane').map((n) => [n.id, n.ref, n.label, n.weight]), [['p:p1', 'p1', '面1', 2], ['p:p2', 'p2', '面2', 1], ['p:p3', 'p3', '面3', 0]], '存在しない線 ID は数えない');
  assert.deepEqual(nodes.filter((n) => n.kind === 'line').map((n) => [n.id, n.ref, n.weight]), [['l:l1', 'l1', 2], ['l:l2', 'l2', 1], ['l:l3', 'l3', 2], ['l:l4', 'l4', 1]]);
  assert.deepEqual(pairs(edges, 'plane'), [['p:p1', 'l:l1'], ['p:p1', 'l:l2'], ['p:p2', 'l:l3']], '面の無い線は面につながない');
  assert.deepEqual(pairs(edges, 'member'), [['l:l1', 'pt:ha'], ['l:l1', 'pt:hb'], ['l:l2', 'pt:hc'], ['l:l3', 'pt:hd'], ['l:l4', 'pt:he']], '2 つの線に入った点は先の線にぶら下げる');
  const points = nodes.filter((n) => n.kind === 'point');
  assert.deepEqual(points.map((n) => n.ref), ['ha', 'hb', 'hc', 'hd', 'he', 'hx', 'hy', 'hz']);
  assert.ok(points.every((n) => n.label === ''), '点には名前を描かない（数が多いので）');
  assert.equal(new Set(ids(nodes)).size, nodes.length, '要素の ID は重ならない');
  assert.equal(new Set(ids(edges)).size, edges.length, '辺の ID は重ならない');
});

test('mapElements: 塊の間に、遠いつながり・自分のリンク・関わる点・面どうしの関係を引く', () => {
  const a = analysis();
  const library = { highlights: {}, links: {} };
  addLink(library, 'hb', 'hc', '似ている', '2026-10-01T00:00:00.000Z');
  addLink(library, 'hc', 'n1abc', 'ノートへ', '2026-10-01T00:00:00.000Z');
  addLink(library, 'ha', 'he', '外した', '2026-10-01T00:00:00.000Z');
  removeLink(library, linkId('ha', 'he'), '2026-10-02T00:00:00.000Z');
  library.farReactions = { [farId('ha', 'hd')]: { ...far('ha', 'hd'), status: 'wrong', updatedAt: '2026-10-02T00:00:00.000Z' } };
  const { edges } = mapElements(a, { library });
  assert.deepEqual(pairs(edges, 'far'), [['pt:hc', 'pt:hx']], '「ちがう」とした組と、図に無い点の組は引かない');
  assert.deepEqual(pairs(edges, 'link'), [['pt:hb', 'pt:hc']], '外したリンクと、永久ノートへのリンクは引かない');
  assert.deepEqual(pairs(edges, 'related'), [['l:l1', 'pt:hd'], ['l:l3', 'pt:ha']], '関わる点と、2 つ目の線に入った点');
  assert.deepEqual(edges.filter((e) => e.kind === 'relation').map((e) => [e.source, e.target, e.label]), [['p:p1', 'p:p2', '支える']], '面にない関係は飛ばす');
});

test('mapElements: 置き換わった点（Kindle で伸ばした線）へのリンクは、図の点につなぐ', () => {
  const library = { highlights: { hb: { id: 'hb', deleted: true, supersededBy: 'hb2' }, hb2: { id: 'hb2' } }, links: {} };
  addLink(library, 'hb2', 'hc', '', '2026-10-01T00:00:00.000Z');
  assert.deepEqual(pairs(mapElements(analysis(), { library }).edges, 'link'), [['pt:hb', 'pt:hc']]);
});

test('mapElements: まだつながらない点は、橋が無ければ辺を 1 本も持たない', () => {
  const { nodes, edges } = mapElements(analysis(), { library: {} });
  const touching = (id) => edges.filter((e) => e.source === id || e.target === id);
  assert.deepEqual(nodes.filter((n) => n.isolated).map((n) => n.ref), ['hx', 'hy', 'hz']);
  assert.deepEqual(touching('pt:hy'), []);
  assert.deepEqual(touching('pt:hz'), []);
  assert.deepEqual(touching('pt:hx').map((e) => e.kind), ['far'], '遠いつながりがある浮いた点は、その橋だけ');
});

test('mapElements: ★の線は starred が載り、名前の前に ★ が付く。★の無い線は今のまま（NIH-58 を塊の図に引き継ぐ）', () => {
  const lines = (opts) => mapElements(analysis(), opts).nodes.filter((n) => n.kind === 'line');
  assert.deepEqual(lines({ isStarred: (id) => id === 'l2' }).map((n) => [n.ref, n.starred, n.label]), [['l1', false, '線1'], ['l2', true, '★ 線2'], ['l3', false, '線3'], ['l4', false, '面の無い線']]);
  assert.ok(lines({}).every((n) => n.starred === false && !n.label.startsWith('★')), '判定を渡さなければ★は無し');
  assert.ok(mapElements(analysis(), { isStarred: () => true }).nodes.filter((n) => n.kind !== 'line').every((n) => n.starred === undefined), '面・点には載せない');
});

test('mapStyle: ★の線だけに枠線を付ける（★の無い線の見た目は変えない）', () => {
  const colors = { solid: '#7a4bb0', plane: '#b0781a', line: '#1f6f5c', ink: '#23211d', point: '#8b877d', surface: '#fffdf8', font: 'sans-serif' };
  const { nodes } = mapElements(analysis(), { isStarred: (id) => id === 'l2' });
  const cy = cytoscape({ headless: true, styleEnabled: true, elements: nodes.map((data) => ({ group: 'nodes', data })), style: mapStyle(colors) });
  try {
    assert.equal(cy.$id('l:l1').numericStyle('border-width'), 0);
    assert.ok(cy.$id('l:l2').numericStyle('border-width') > 0);
  } finally {
    cy.destroy();
  }
});

test('mapElements: 分析が空でも壊れず、渡した分析・ライブラリを書き換えない', () => {
  assert.deepEqual(mapElements({}), { nodes: [], edges: [] });
  assert.deepEqual(mapElements(null), { nodes: [], edges: [] });
  const a = analysis();
  const library = { highlights: {}, links: {} };
  addLink(library, 'hb', 'hc', '', '2026-10-01T00:00:00.000Z');
  const before = structuredClone([a, library]);
  mapElements(a, { library });
  assert.deepEqual([a, library], before);
});

/** 1,800 点・220 線・12 面・浮いた点 90 の架空の分析 */
function bigAnalysis() {
  const lines = [];
  let k = 0;
  for (let i = 0; i < 220; i++) {
    const n = 3 + (i * 7) % 9; // 3〜11 点（平均 7 点・合わせて 1,540 点）。残りは下で 1,710 点まで足す
    lines.push({ id: `L${i}`, name: `線${i}`, highlightIds: Array.from({ length: n }, () => `h${(k++).toString(36)}`) });
  }
  while (k < 1710) lines[k % 220].highlightIds.push(`h${(k++).toString(36)}`);
  const planes = Array.from({ length: 12 }, (_, i) => ({ id: `P${i}`, name: `面${i}`, lineIds: lines.filter((_, j) => j % 12 === i).map((l) => l.id) }));
  const isolated = Array.from({ length: 90 }, () => `h${(k++).toString(36)}`);
  return { lines, planes, isolated, solid: {} };
}

test('mapPositions: 点・線・面の座標がすべて有限で、面の塊どうしは重ならず、浮いた点は塊の外にある', () => {
  const a = bigAnalysis();
  const els = mapElements(a);
  const t0 = performance.now();
  const pos = mapPositions(els);
  const ms = performance.now() - t0;
  assert.equal(els.nodes.length, 12 + 220 + 1800);
  assert.ok(ms < 1000, `座標の計算は 1 秒未満（${Math.round(ms)}ms）`);
  for (const n of els.nodes) assert.ok(Number.isFinite(pos[n.id]?.x) && Number.isFinite(pos[n.id]?.y), n.id);
  assert.equal(new Set(Object.values(pos).map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`)).size, els.nodes.length, '同じ場所に 2 つ置かない');
  // 面ごとの塊（面・線・点）を囲む円
  const parentOf = new Map(els.edges.filter((e) => e.kind === 'plane' || e.kind === 'member').map((e) => [e.target, e.source]));
  const planeOf = (id) => {
    let cur = id;
    while (parentOf.has(cur)) cur = parentOf.get(cur);
    return cur.startsWith('p:') ? cur : null;
  };
  const circles = a.planes.map((p) => {
    const c = pos[`p:${p.id}`];
    const members = els.nodes.filter((n) => planeOf(n.id) === `p:${p.id}`);
    return { c, r: Math.max(...members.map((n) => Math.hypot(pos[n.id].x - c.x, pos[n.id].y - c.y))) };
  });
  for (let i = 0; i < circles.length; i++) {
    for (let j = i + 1; j < circles.length; j++) {
      const d = Math.hypot(circles[i].c.x - circles[j].c.x, circles[i].c.y - circles[j].c.y);
      assert.ok(d > circles[i].r + circles[j].r, `面 ${i} と面 ${j} の塊が重なる`);
    }
  }
  const all = els.nodes.filter((n) => !n.isolated).map((n) => pos[n.id]);
  const cx = all.reduce((s, p) => s + p.x, 0) / all.length;
  const cy = all.reduce((s, p) => s + p.y, 0) / all.length;
  const inner = Math.max(...circles.map(({ c, r }) => Math.hypot(c.x - cx, c.y - cy) + r));
  for (const n of els.nodes.filter((x) => x.isolated)) assert.ok(Math.hypot(pos[n.id].x - cx, pos[n.id].y - cy) > inner, `${n.id} が塊の中にある`);
});

test('mapPositions: 同じ分析からは毎回同じ形になる', () => {
  const els = mapElements(analysis());
  assert.deepEqual(mapPositions(els), mapPositions(mapElements(analysis())));
});

test('知識マップ: 同梱した Cytoscape.js に座標ごと渡すと、そのまま置ける（並べ直さない）', () => {
  const colors = { solid: '#7a4bb0', plane: '#b0781a', line: '#1f6f5c', ink: '#23211d', point: '#8b877d', surface: '#fffdf8', font: 'sans-serif' };
  const els = mapElements(bigAnalysis());
  const pos = mapPositions(els);
  const cy = cytoscape({
    headless: true,
    styleEnabled: true,
    elements: [...els.nodes.map((data) => ({ group: 'nodes', data, position: pos[data.id] })), ...els.edges.map((data) => ({ group: 'edges', data }))],
    style: mapStyle(colors),
  });
  assert.equal(cy.nodes().length, els.nodes.length);
  assert.equal(cy.edges().length, els.edges.length);
  const n = cy.$id('pt:h0');
  assert.deepEqual(n.position(), pos['pt:h0']);
  cy.destroy();
});

test('mapPeek: 点は文の冒頭と書名、線は名前と点の数を返す。面は札を出さない（NIH-68）', () => {
  const library = {
    books: { b1: { id: 'b1', title: '本の名前' } },
    highlights: {
      ha: { id: 'ha', bookId: 'b1', text: '  一行目\n\n二行目  ' },
      hb: { id: 'hb', bookId: 'b1', text: 'あ'.repeat(200) },
      hc: { id: 'hc', deleted: true, supersededBy: 'hc2' },
      hc2: { id: 'hc2', bookId: 'b1', text: '伸ばした線' },
      hd: { id: 'hd', deleted: true },
    },
    thoughts: { t1: { id: 't1', text: '思いついたこと' } },
  };
  const { nodes } = mapElements(analysis());
  const node = (id) => nodes.find((n) => n.id === id);
  // 橋を渡さないときは、相手も添える言葉も無い（NIH-88）
  const none = { peers: [], counts: { far: 0, link: 0 }, why: null };
  assert.deepEqual(mapPeek({ kind: 'point', ref: 'ha' }, library), { kind: 'point', title: '一行目 二行目', sub: '本の名前', ...none }, '空白・改行は 1 つの空白にまとめる');
  const cut = mapPeek({ kind: 'point', ref: 'hb' }, library);
  assert.ok(cut.title.endsWith('…') && [...cut.title].length <= 81, '長い文は冒頭だけ');
  assert.deepEqual(mapPeek({ kind: 'point', ref: 'hc' }, library), { kind: 'point', title: '伸ばした線', sub: '本の名前', ...none }, '置き換わった点は今の点を見せる');
  assert.deepEqual(mapPeek({ kind: 'point', ref: 't1' }, library), { kind: 'point', title: '思いついたこと', sub: '思いつき', ...none });
  assert.equal(mapPeek({ kind: 'point', ref: 'hd' }, library).sub, '消えた点');
  assert.equal(mapPeek({ kind: 'point', ref: 'hzz' }, library).sub, 'この端末にまだ届いていない点');
  assert.deepEqual(mapPeek(node('l:l1'), library), { kind: 'line', title: '線1', sub: '点 2 件' });
  assert.equal(mapPeek(mapElements(analysis(), { isStarred: () => true }).nodes.find((n) => n.id === 'l:l1'), library).title, '★ 線1');
  assert.equal(mapPeek(node('p:p1'), library), null);
  assert.equal(mapPeek(null, library), null);
});

test('mapStyle: 札を出したノードとつながる辺に印（peek）を付けると強まる（NIH-68）', () => {
  const colors = { solid: '#7a4bb0', plane: '#b0781a', line: '#1f6f5c', ink: '#23211d', point: '#8b877d', surface: '#fffdf8', font: 'sans-serif' };
  const els = mapElements(analysis());
  const cy = cytoscape({ headless: true, styleEnabled: true, elements: [...els.nodes.map((data) => ({ group: 'nodes', data })), ...els.edges.map((data) => ({ group: 'edges', data }))], style: mapStyle(colors) });
  try {
    const e = cy.$id('member:l:l1|pt:ha');
    const before = e.numericStyle('opacity');
    e.addClass('peek');
    assert.ok(e.numericStyle('opacity') > before);
    const n = cy.$id('pt:ha');
    assert.equal(n.numericStyle('border-width'), 0);
    n.addClass('peek');
    assert.ok(n.numericStyle('border-width') > 0);
  } finally {
    cy.destroy();
  }
});

test('mapElements: 遠いつながりの辺には共通する考え、リンクの辺には理由が載る（札でたどるため。NIH-88）', () => {
  const library = { highlights: {}, links: {} };
  addLink(library, 'hb', 'hc', '似ている', '2026-10-01T00:00:00.000Z');
  const { edges } = mapElements(analysis(), { library });
  const farEdge = edges.find((e) => e.kind === 'far' && e.source === 'pt:ha');
  assert.equal(farEdge.idea, '根っこ');
  assert.equal(edges.find((e) => e.kind === 'link').reason, '似ている');
  assert.ok(edges.filter((e) => e.kind !== 'far' && e.kind !== 'link').every((e) => !('idea' in e) && !('reason' in e)), 'ほかの辺には載せない');
});

test('mapPeek: 点の札に、遠いつながり・リンクの相手（遠いつながりが先）と件数を出す。たどってきた辺の共通する考え・理由を添える（NIH-88）', () => {
  const library = {
    books: { b1: { id: 'b1', title: '本の名前' } },
    highlights: {
      ha: { id: 'ha', bookId: 'b1', text: 'ああ' },
      hb: { id: 'hb', bookId: 'b1', text: 'い'.repeat(100) },
      hc: { id: 'hc', deleted: true, supersededBy: 'hc2' },
      hc2: { id: 'hc2', bookId: 'b1', text: '伸ばした線' },
    },
    links: {},
  };
  const farEdge = { id: 'far:pt:ha|pt:hd', source: 'pt:ha', target: 'pt:hd', kind: 'far', idea: '<b>根っこ</b>' };
  const linkEdge = { id: 'link:pt:hb|pt:ha', source: 'pt:hb', target: 'pt:ha', kind: 'link', reason: '似ている' };
  const member = { id: 'member:l:l1|pt:ha', source: 'l:l1', target: 'pt:ha', kind: 'member' };
  const info = mapPeek({ id: 'pt:ha', kind: 'point', ref: 'ha' }, library, { bridges: [linkEdge, member, farEdge] });
  assert.deepEqual(info.counts, { far: 1, link: 1 });
  assert.deepEqual(info.peers.map((p) => [p.id, p.kind, p.edge]), [['pt:hd', 'far', farEdge.id], ['pt:hb', 'link', linkEdge.id]], '遠いつながりが先。線への所属の辺は相手にしない');
  assert.equal(info.peers[0].title, 'この端末にまだ届いていない点', '文の無い相手はそう示す');
  assert.ok(info.peers[1].title.endsWith('…') && [...info.peers[1].title].length <= 31, '相手の文は短く');
  assert.equal(info.why, null, '直接押したときは、たどってきた辺が無い');

  const viaFar = mapPeek({ id: 'pt:hd', kind: 'point', ref: 'hd' }, library, { bridges: [farEdge], via: farEdge });
  assert.deepEqual(viaFar.why, { kind: 'far', text: '<b>根っこ</b>' }, '共通する考えは文字のまま返す（エスケープは画面側）');
  assert.deepEqual(viaFar.peers.map((p) => p.id), ['pt:ha'], '来た相手にも戻れる');
  assert.equal(viaFar.peers[0].title, 'ああ');
  assert.deepEqual(mapPeek({ id: 'pt:hb', kind: 'point', ref: 'hb' }, library, { bridges: [linkEdge], via: linkEdge }).why, { kind: 'link', text: '似ている' });
  assert.equal(mapPeek({ id: 'pt:hb', kind: 'point', ref: 'hb' }, library, { bridges: [linkEdge], via: { ...linkEdge, reason: '' } }).why, null, '理由の無いリンクは添えない');
  assert.equal(mapPeek({ id: 'pt:hb', kind: 'point', ref: 'hb' }, library, { bridges: [linkEdge], via: member }).why, null, '橋でない辺は添えない');

  const replaced = mapPeek({ id: 'pt:hx', kind: 'point', ref: 'hx' }, library, { bridges: [{ id: 'link:pt:hx|pt:hc', source: 'pt:hx', target: 'pt:hc', kind: 'link' }] });
  assert.equal(replaced.peers[0].title, '伸ばした線', '置き換わった相手は今の点の文');
  const alone = mapPeek({ id: 'pt:ha', kind: 'point', ref: 'ha' }, library);
  assert.deepEqual([alone.peers, alone.counts, alone.why], [[], { far: 0, link: 0 }, null], '橋が無ければ相手は空');
  assert.equal(mapPeek({ id: 'l:l1', kind: 'line', label: '線1', weight: 2 }, library, { bridges: [member] }).peers, undefined, '線の札には相手を出さない');
});
