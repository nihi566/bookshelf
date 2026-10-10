// #68 「線」を「線(グループ)」と呼ぶ。見出し・数・ページ名・説明文の初出は「線(グループ)」、
// 件数の単位と狭いボタンは「線」のまま。本に引いた線（ハイライト）の意味の「線」は変えない
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyLibrary, mergeParsed, registerBook } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const G = '線(グループ)';

function sample() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  return lib;
}

function analysisOf(lib) {
  const [a, b] = Object.keys(lib.highlights);
  return {
    version: 2,
    createdAt: '2026-10-04T10:00:00.000Z',
    model: { chat: 'fake', embed: 'fake-embed' },
    stats: { points: 48 },
    lines: [{ id: 'l1', name: '仕組み', summary: '要約', insight: '', keywords: [], highlightIds: [a, b], bookIds: [] }],
    planes: [{ id: 'p1', name: '面', summary: '要約', lineIds: ['l1'] }],
    solid: { title: '核', core: '核の文', relations: [], principles: [], questions: [] },
    isolated: [],
    recommendations: [],
  };
}

const st = (library, analysis) => ({ library, analysis, settings: { ai: { mode: 'direct', companionUrl: '' } }, servedByCompanion: false, pcInfo: null, job: null });

test('#68: ホームの数・線のページの見出し・線の画面の種別・知識の画面の見出しは「線(グループ)」', async () => {
  const { home } = await import('../web/js/views/library.js');
  const { linesView } = await import('../web/js/views/layers.js');
  const { knowledge, lineView } = await import('../web/js/views/knowledge.js');
  const lib = sample();
  const a = analysisOf(lib);
  assert.match(String(home.render({ state: st(lib, a), shuffle: 0 })), new RegExp(`<a class="stat line" href="#/lines"><b>1</b><span>${G.replace(/[()]/g, '\\$&')}</span></a>`));
  assert.ok(String(linesView.render({ state: st(lib, a) })).includes(`<h1>${G}</h1>`));
  assert.ok(String(lineView.render({ state: st(lib, a), params: { id: 'l1' } })).includes(`<div class="layer-label line">${G} ・`));
  assert.ok(String(knowledge.render({ state: st(lib, a) })).includes(`<h2>点・${G}・面・立体</h2>`));
});

test('#68: 狭いボタンは「線」のまま（見出しで分かる）', async () => {
  const { lineView } = await import('../web/js/views/knowledge.js');
  const lib = sample();
  const out = String(lineView.render({ state: st(lib, analysisOf(lib)), params: { id: 'l1' } }));
  assert.match(out, />この線を永久ノートにする<\/button>/);
});

test('#68: 本に引いた線（ハイライト）の意味の「線」は変えない', async () => {
  const { book } = await import('../web/js/views/library.js');
  const lib = emptyLibrary();
  const b = registerBook(lib, { title: '紙の本' });
  const out = String(book.render({ state: st(lib, null), params: { id: b.id } }));
  assert.match(out, /線を引いた文を足す/);
  assert.doesNotMatch(out, /線\(グループ\)を引/);
  const app = readFileSync(join(WEB, 'js/app.js'), 'utf8');
  const all = ['js/views/settings.js', 'js/views/wishlist.js', 'js/views/library.js', 'js/app.js', 'js/app-actions.js'].map((f) => readFileSync(join(WEB, f), 'utf8')).join('\n') + app;
  assert.doesNotMatch(all, /線\(グループ\)を引|引いた線\(グループ\)|線\(グループ\)を足す|まだ線\(グループ\)/);
});
