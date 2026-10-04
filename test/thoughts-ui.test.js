// G1 思いつきメモの画面: どの画面からも書ける入口・ホームの受け箱・メモの一覧・検索・線の画面
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyLibrary, mergeParsed } from '../web/core/model.js';
import { addThought, updateThought } from '../web/core/thoughts.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const T1 = '2026-10-01T00:00:00.000Z';

function state(library = emptyLibrary(), analysis = null) {
  return { library, analysis, settings: { ai: { mode: 'direct', companionUrl: '' } }, servedByCompanion: false, pcInfo: null };
}

test('G1-1: 上のバー（どの画面にも出る）に「メモ」の入口があり、押す → 書く → 保存 の 2 回で書ける', async () => {
  const index = readFileSync(join(WEB, 'index.html'), 'utf8');
  const header = index.match(/<header class="topbar">([\s\S]*?)<\/header>/)[1];
  assert.match(header, /<button type="button" class="topbar-memo" data-action="new-thought" aria-label="思いつきをメモする">/, '画面ごとに描き直す #view の外（上のバー）にある');
  const { newThoughtSheet } = await import('../web/js/views/thoughts.js');
  const sheet = String(newThoughtSheet());
  assert.equal((sheet.match(/<textarea /g) || []).length, 1);
  assert.match(sheet, /<textarea name="text"[^>]* autofocus/, '開いたらすぐ書ける');
  assert.equal((sheet.match(/value="save"/g) || []).length, 1, '保存は 1 回押すだけ');
  assert.doesNotMatch(sheet, /<select|type="radio"|type="checkbox"/, '書く前に選ばせる欄が無い');
  // ボタンの動き（app.js の actions['new-thought']）がつながっている: シートを開き、書いたメモを端末に保存してから同期する
  const app = readFileSync(join(WEB, 'js/app.js'), 'utf8');
  const action = app.match(/'new-thought'\(\) \{([\s\S]*?)\n  \},/)[1];
  assert.match(action, /openSheet\(newThoughtSheet\(\)/);
  assert.match(action, /addThought\(state\.library, \{ text: data\.get\('text'\) \}[^)]*\);[\s\S]*?await persistLibrary\(\);[\s\S]*?autoSyncAfterChange\(\);/);
  assert.match(action, /const id = randomId\('t'\);[\s\S]*?openSheet/, 'ID はシートを開くときに 1 回だけ作る（押し直しで 2 件にしない）');
});

test('読み込みが終わる前は、端末のライブラリを保存しない（空のライブラリで上書きしない）', async () => {
  const { save, state: appState } = await import('../web/js/state.js');
  assert.equal(appState.loaded, false);
  await assert.rejects(save.library(), /まだ端末のデータを読み込んでいます/);
});

test('G1-3: ホームの受け箱に未整理のメモが件数付きで出て、「整理済みにする」「捨てる」を押せる', async () => {
  const { home } = await import('../web/js/views/library.js');
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  const a = addThought(lib, { text: '一つ目の思いつき' }, '2026-10-01T00:00:00.000Z');
  const b = addThought(lib, { text: '整理した思いつき' }, '2026-10-02T00:00:00.000Z');
  for (let i = 0; i < 4; i++) addThought(lib, { text: `受け箱 ${i}` }, `2026-10-0${3 + i}T00:00:00.000Z`);
  updateThought(lib, b.id, { status: 'done' });
  const out = String(home.render({ state: state(lib), shuffle: 0 }));
  assert.match(out, /<h2 id="inbox-title">受け箱 <span class="count">5<\/span><\/h2>/);
  const inbox = out.match(/<section class="inbox"[\s\S]*?<\/section>/)[0];
  assert.equal((inbox.match(/<article class="hl thought"/g) || []).length, 3, '新しい 3 件だけ並べ、残りは一覧へ');
  assert.match(inbox, /ほか 2 件を見る/);
  assert.match(inbox, /data-action="thought-status" data-id="t[^"]+" data-status="done">整理済みにする</);
  assert.match(inbox, /data-action="thought-status" data-id="t[^"]+" data-status="discarded">捨てる</);
  assert.doesNotMatch(inbox, /整理した思いつき/, '整理済みは受け箱に出ない');
  assert.ok(!inbox.includes(a.id), '古い未整理は 4 件目以降');
  // 本が 1 冊も無くても、メモがあれば受け箱を出す
  const only = emptyLibrary();
  addThought(only, { text: 'メモだけ' });
  assert.match(String(home.render({ state: state(only), shuffle: 0 })), /受け箱 <span class="count">1<\/span>/);
});

test('G1-6: メモの一覧で状態ごとに見て、探して、直せる（削除はシートから）', async () => {
  const { thoughtsView, editThoughtSheet } = await import('../web/js/views/thoughts.js');
  const lib = emptyLibrary();
  addThought(lib, { text: '朝の散歩の思いつき' }, T1);
  const d = addThought(lib, { text: '捨てたもの' }, T1);
  updateThought(lib, d.id, { status: 'discarded' });
  const inbox = String(thoughtsView.render({ state: state(lib), query: new URLSearchParams('q=散歩') }));
  assert.match(inbox, /<form class="search-box" data-form="thought-filter" role="search"><input type="search" name="q" value="散歩"/);
  assert.match(inbox, /<a class="chip on" href="#\/thoughts\?q=%E6%95%A3%E6%AD%A9&amp;status=inbox" aria-current="true">未整理 1<\/a>/);
  assert.match(inbox, /朝の<mark>散歩<\/mark>の思いつき/);
  assert.match(inbox, /data-action="edit-thought" data-id="t[^"]+" aria-label="メモを編集"/);
  const discarded = String(thoughtsView.render({ state: state(lib), query: new URLSearchParams('status=discarded') }));
  assert.match(discarded, /捨てたもの/);
  assert.match(discarded, /data-status="inbox">未整理に戻す</);
  const sheet = String(editThoughtSheet(lib.thoughts[d.id]));
  assert.match(sheet, /<button class="btn danger" value="delete">このメモを削除<\/button>/);
});

test('検索: 思いつきも点として出る（「思いつき」で絞れる）・捨てたものは出ない', async () => {
  const { search } = await import('../web/js/views/library.js');
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  addThought(lib, { text: '集中は散歩で戻る' });
  const gone = addThought(lib, { text: '集中の捨てたメモ' });
  updateThought(lib, gone.id, { status: 'discarded' });
  const boxes = {};
  const root = {
    querySelector(sel) {
      if (sel === 'input[name="q"]') return { value: '集中', addEventListener() {} };
      boxes[sel] ||= { innerHTML: '', isConnected: true };
      return boxes[sel];
    },
  };
  search.mount(root, { state: state(lib), query: new URLSearchParams('q=集中') });
  const results = boxes['#search-results'].innerHTML;
  assert.match(results, /<article class="hl thought"[\s\S]*?<mark>集中<\/mark>は散歩で戻る/);
  assert.doesNotMatch(results, /捨てたメモ/);
  assert.match(boxes['#search-filters'].innerHTML, /source=thought"\s*>思いつき<\/a>/);
});

test('線の画面: 思いつきの点も並び、「N 冊の本と思いつき M 件をつなぐ」と出る', async () => {
  const { lineView } = await import('../web/js/views/knowledge.js');
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  const t = addThought(lib, { text: '線に入った思いつき' });
  const [h] = Object.values(lib.highlights);
  const analysis = { lines: [{ id: 'l1', name: '線の名前', summary: '要約', insight: '', keywords: [], highlightIds: [h.id, t.id], bookIds: [h.bookId] }], planes: [], solid: { relations: [] } };
  const out = String(lineView.render({ state: state(lib, analysis), params: { id: 'l1' } }));
  assert.match(out, /線 ・ 1 冊の本と思いつき 1 件をつなぐ/);
  assert.match(out, /<article class="hl thought" data-hl="t[^"]+">\s*<p class="hl-text">線に入った思いつき<\/p>/);
});

test('G1-5: 前の分析で線に入っていても、あとで捨てた思いつきは線の画面・まだつながらない点に出さない', async () => {
  const { lineView, isolatedView } = await import('../web/js/views/knowledge.js');
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  const t = addThought(lib, { text: '捨てる前に線に入った思いつき' });
  const u = addThought(lib, { text: '捨てる前につながらなかった思いつき' });
  const [h] = Object.values(lib.highlights);
  const analysis = { lines: [{ id: 'l1', name: '線', summary: '', insight: '', keywords: [], highlightIds: [h.id, t.id], bookIds: [h.bookId] }], planes: [], solid: { relations: [] }, isolated: [u.id] };
  updateThought(lib, t.id, { status: 'discarded' });
  updateThought(lib, u.id, { status: 'discarded' });
  assert.doesNotMatch(String(lineView.render({ state: state(lib, analysis), params: { id: 'l1' } })), /捨てる前に線に入った/);
  assert.doesNotMatch(String(isolatedView.render({ state: state(lib, analysis) })), /捨てる前につながらなかった/);
});

test('C8: メモの文はエスケープして出す（受け箱・一覧・カード）', async () => {
  const { home } = await import('../web/js/views/library.js');
  const { thoughtsView } = await import('../web/js/views/thoughts.js');
  const lib = emptyLibrary();
  addThought(lib, { text: '<img src=x onerror=alert(1)> & "引用"' });
  for (const out of [String(home.render({ state: state(lib), shuffle: 0 })), String(thoughtsView.render({ state: state(lib), query: new URLSearchParams() }))]) {
    assert.doesNotMatch(out, /<img src=x/);
    assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;引用&quot;/);
  }
});
