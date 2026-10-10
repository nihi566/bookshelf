import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapElements, mapLayout, mapStyle } from '../web/core/knowledge-map.js';
import cytoscape from '../web/vendor/cytoscape.esm.min.js';

const analysis = () => ({
  lines: [
    { id: 'l1', name: '線1', highlightIds: ['h1', 'h2'] },
    { id: 'l2', name: '線2', highlightIds: ['h3'] },
    { id: 'l3', name: '線3', highlightIds: [] },
  ],
  planes: [
    { id: 'p1', name: '面1', lineIds: ['l1', 'l2', 'lX'] },
    { id: 'p2', name: '面2', lineIds: ['l3'] },
    { id: 'p3', name: '面3', lineIds: [] },
  ],
  solid: { title: '核', relations: [{ from: 'p1', to: 'p2', type: '支える' }, { from: 'p1', to: 'pX', type: 'x' }] },
});

const ids = (els) => els.map((e) => e.id);

test('mapElements: 最初は核と面だけ。線は出さず、面の大きさは線の数', () => {
  const { nodes, edges, focus } = mapElements(analysis());
  assert.equal(focus, null);
  assert.deepEqual(ids(nodes), ['core', 'p:p1', 'p:p2', 'p:p3']);
  assert.equal(nodes[0].label, '核');
  assert.deepEqual(nodes.slice(1).map((n) => n.weight), [2, 1, 0], '存在しない線 ID は数えない');
  assert.deepEqual(nodes.slice(1).map((n) => n.ref), ['p1', 'p2', 'p3']);
  assert.ok(nodes.every((n) => n.kind !== 'line'));
  assert.deepEqual(edges.filter((e) => e.kind === 'core').map((e) => [e.source, e.target]), [['core', 'p:p1'], ['core', 'p:p2'], ['core', 'p:p3']]);
  assert.deepEqual(edges.filter((e) => e.kind === 'relation').map((e) => [e.source, e.target, e.label]), [['p:p1', 'p:p2', '支える']], '面にない関係は飛ばす');
  assert.equal(new Set(ids(edges)).size, edges.length, '辺の ID は重ならない');
});

test('mapElements: 面を選ぶと、その面と面の線だけを出す（線の大きさは点の数）', () => {
  const { nodes, edges, focus } = mapElements(analysis(), { focus: 'p1' });
  assert.equal(focus, 'p1');
  assert.deepEqual(ids(nodes), ['p:p1', 'l:l1', 'l:l2']);
  assert.deepEqual(nodes.slice(1).map((n) => [n.kind, n.ref, n.weight, n.label]), [['line', 'l1', 2, '線1'], ['line', 'l2', 1, '線2']]);
  assert.deepEqual(edges.map((e) => [e.source, e.target, e.kind]), [['p:p1', 'l:l1', 'plane'], ['p:p1', 'l:l2', 'plane']]);
});

test('mapElements: 無くなった面を選んでいたら全体に戻す。分析が空でも核だけ出す', () => {
  assert.equal(mapElements(analysis(), { focus: 'pX' }).focus, null);
  assert.deepEqual(ids(mapElements({ planes: [], lines: [], solid: {} }).nodes), ['core']);
  assert.equal(mapElements({}).nodes[0].label, '知識の核');
});

test('mapElements: 渡した分析を書き換えない', () => {
  const a = analysis();
  const before = structuredClone(a);
  mapElements(a);
  mapElements(a, { focus: 'p1' });
  assert.deepEqual(a, before);
});

test('知識マップ: 同梱した Cytoscape.js で並べると、全体も面を開いたときも座標がすべて有限', () => {
  const colors = { solid: '#7a4bb0', plane: '#b0781a', line: '#1f6f5c', ink: '#23211d', surface: '#fffdf8', font: 'sans-serif' };
  for (const focus of [null, 'p1']) {
    const { nodes, edges } = mapElements(analysis(), { focus });
    const cy = cytoscape({
      headless: true,
      styleEnabled: true,
      elements: [...nodes.map((data) => ({ group: 'nodes', data })), ...edges.map((data) => ({ group: 'edges', data }))],
      style: mapStyle(colors),
    });
    cy.layout(mapLayout({ focus })).run();
    assert.equal(cy.nodes().length, nodes.length);
    for (const n of cy.nodes()) assert.ok(Number.isFinite(n.position('x')) && Number.isFinite(n.position('y')), n.id());
    cy.destroy();
  }
});
