// 点・線・面・立体の専用ページ（#64）、面は短く・押すと全文（#65）、全ての点の一覧への入口（#70）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, mergeParsed } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';

const LONG = '線が束になったテーマの長い説明。'.repeat(20);

function sample() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  return lib;
}

function analysisOf(lib) {
  const [a, b, c, d, e] = Object.keys(lib.highlights);
  return {
    version: 2,
    createdAt: '2026-10-04T10:00:00.000Z',
    model: { chat: 'fake', embed: 'fake-embed' },
    stats: { points: 48, lines: 3, planes: 2, isolated: 0 },
    lines: [
      { id: 'l1', name: '仕組みの線', summary: '仕組みの要約', insight: '', keywords: [], highlightIds: [a, b], bookIds: [] },
      { id: 'l2', name: '注意の線', summary: '注意の要約', insight: '', keywords: [], highlightIds: [c, d, e], bookIds: [] },
      { id: 'l3', name: 'ひとりの線', summary: '面に入らない線', insight: '', keywords: [], highlightIds: [a], bookIds: [] },
    ],
    planes: [
      { id: 'p1', name: '続ける面', summary: LONG, lineIds: ['l1', 'l2'] },
      { id: 'p2', name: '別の面', summary: '短い', lineIds: [] },
    ],
    solid: { title: '知識の核', core: '核の文', relations: [], principles: ['原則その一'], questions: [] },
    isolated: [],
    recommendations: [],
  };
}

function st(library, analysis) {
  return { library, analysis, settings: { ai: { mode: 'direct', companionUrl: '', chatModel: '' } }, servedByCompanion: false, pcInfo: null, job: null };
}

test('#64: 点・線・面・立体の専用ページの URL がある（点は既存の #/search）', async () => {
  const { matchRoute } = await import('../web/js/routes.js');
  const { linesView, planesView, solidView } = await import('../web/js/views/layers.js');
  const { search } = await import('../web/js/views/library.js');
  const { lineView, planeView } = await import('../web/js/views/knowledge.js');
  const { pointView } = await import('../web/js/views/point.js');
  for (const [path, view] of [['/lines', linesView], ['/planes', planesView], ['/solid', solidView], ['/search', search]]) {
    assert.equal(matchRoute(path).view, view, path);
  }
  // 1 件の詳細ページ（URL を開き直しても同じ詳細）
  for (const [path, view] of [['/knowledge/line/l1', lineView], ['/knowledge/plane/p1', planeView], ['/point/h-1', pointView]]) {
    const m = matchRoute(path);
    assert.equal(m.view, view, path);
    assert.equal(m.params.id, path.split('/').pop());
  }
});

test('#64: 線のページは線の一覧だけ。1 件を押すとその線の詳細へ', async () => {
  const { linesView } = await import('../web/js/views/layers.js');
  const lib = sample();
  const out = String(linesView.render({ state: st(lib, analysisOf(lib)) }));
  assert.match(out, /<h1>線\(グループ\)<\/h1>/);
  for (const id of ['l1', 'l2', 'l3']) assert.match(out, new RegExp(`href="#/knowledge/line/${id}"`));
  assert.doesNotMatch(out, /plane-card|solid-card|knowledge-map|<article class="hl/, 'ほかの階層の一覧が混ざらない');
  // 点の多い順
  assert.ok(out.indexOf('注意の線') < out.indexOf('仕組みの線'));
});

test('#64 #65: 面のページは面の一覧だけで、1 件は名前と短い要約。押すと全文の詳細へ', async () => {
  const { planesView } = await import('../web/js/views/layers.js');
  const lib = sample();
  const out = String(planesView.render({ state: st(lib, analysisOf(lib)) }));
  assert.match(out, /<h1>面<\/h1>/);
  assert.match(out, /href="#\/knowledge\/plane\/p1"/);
  assert.match(out, /href="#\/knowledge\/plane\/p2"/);
  assert.ok(!out.includes(LONG), '長い要約はそのまま出さない');
  assert.match(out, /線が束になったテーマの長い説明。[^<]*…/, '短く切って … を付ける');
  assert.doesNotMatch(out, /lines-of-plane|line-row|solid-card|knowledge-map/, '線の一覧・立体は混ざらない');
  // 詳細では全文と含まれる線が見え、面の一覧へ戻れる
  const { planeView } = await import('../web/js/views/knowledge.js');
  const detail = String(planeView.render({ state: st(lib, analysisOf(lib)), params: { id: 'p1' } }));
  assert.ok(detail.includes(LONG));
  assert.match(detail, /href="#\/knowledge\/line\/l1"/);
  assert.match(detail, /<a class="back" href="#\/planes">‹ 面<\/a>/);
});

test('#64: 立体のページは核・行動の原則・知識マップ。面の一覧は混ざらない', async () => {
  const { solidView } = await import('../web/js/views/layers.js');
  const lib = sample();
  const out = String(solidView.render({ state: st(lib, analysisOf(lib)) }));
  assert.match(out, /<h1>立体<\/h1>/);
  assert.match(out, /知識の核/);
  assert.match(out, /原則その一/);
  assert.match(out, /id="knowledge-map"/);
  assert.match(out, /data-map="fit">全体</, '拡大したあと全体へ戻すボタン（面を開く操作は無くし、押すとその画面へ移る。NIH-61）');
  assert.doesNotMatch(out, /data-map="back"/);
  assert.match(out, /class="map-peek" aria-live="polite" hidden/, '点・線を押したときの札の置き場（最初は隠す。NIH-68）');
  assert.equal(typeof solidView.mount, 'function', '図は画面を出したあとに描く');
  assert.doesNotMatch(out, /plane-card|line-row/);
});

test('#64: 線・面・立体のページの上で、点・線・面・立体を行き来できる（今のページに印）', async () => {
  const { linesView, planesView, solidView } = await import('../web/js/views/layers.js');
  const lib = sample();
  for (const [v, key] of [[linesView, 'line'], [planesView, 'plane'], [solidView, 'solid']]) {
    const out = String(v.render({ state: st(lib, analysisOf(lib)) }));
    for (const href of ['#/search', '#/lines', '#/planes', '#/solid']) assert.match(out, new RegExp(`href="${href}"`));
    assert.match(out, new RegExp(`<a class="stat ${key}" href="[^"]+" aria-current="page">`));
  }
});

test('#64: 分析が無いときの線・面・立体のページは、知識の画面で分析するよう案内する', async () => {
  const { linesView, planesView, solidView } = await import('../web/js/views/layers.js');
  for (const v of [linesView, planesView, solidView]) {
    const out = String(v.render({ state: st(sample(), null) }));
    assert.match(out, /まだ分析していません/);
    assert.match(out, /href="#\/knowledge"/);
  }
});

test('#64 #65: 知識の画面には面・立体の長いブロックを出さず、4 つのページへの入口と分析の操作を残す', async () => {
  const { knowledge } = await import('../web/js/views/knowledge.js');
  const lib = sample();
  const out = String(knowledge.render({ state: st(lib, analysisOf(lib)) }));
  assert.doesNotMatch(out, /plane-card|lines-of-plane|knowledge-map/, '面の全文・知識マップは専用ページへ');
  assert.ok(!out.includes(LONG));
  for (const href of ['#/search', '#/lines', '#/planes', '#/solid']) assert.match(out, new RegExp(`href="${href}"`), href);
  assert.match(out, /data-action="run-analysis"/);
  assert.match(out, /data-action="rerun-recommend"/);
  assert.match(out, /data-action="run-analysis-full"/);
});

test('#64: ホームの点・線・面・立体の数から、それぞれの専用ページへ移れる', async () => {
  const { home } = await import('../web/js/views/library.js');
  const lib = sample();
  const out = String(home.render({ state: st(lib, analysisOf(lib)), shuffle: 0 }));
  assert.match(out, /<a class="stat point" href="#\/search">/);
  assert.match(out, /<a class="stat line" href="#\/lines">/);
  assert.match(out, /<a class="stat plane" href="#\/planes">/);
  assert.match(out, /<a class="stat solid" href="#\/solid">/);
});

test('#70: 全ての点の一覧へ、ホーム以外（読んだ本・知識）からも 1 回で行ける。名前で全ての点の一覧と分かる', async () => {
  const { books, search } = await import('../web/js/views/library.js');
  const { knowledge } = await import('../web/js/views/knowledge.js');
  const lib = sample();
  const entry = /<a [^>]*href="#\/search"[^>]*>[^<]*全ての点の一覧/;
  assert.match(String(books.render({ state: st(lib, null), query: new URLSearchParams() })), entry);
  assert.match(String(knowledge.render({ state: st(lib, analysisOf(lib)) })), /href="#\/search"[\s\S]{0,200}全ての点/);
  assert.match(String(search.render({ query: new URLSearchParams() })), /<h1>全ての点<\/h1>/);
});
