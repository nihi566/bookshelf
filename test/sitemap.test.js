// NIH-296 設定の「すべての画面」から、タブに無い画面へも 1 か所から行ける。ルート表から作るので画面を足すと自動で出る
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary } from '../web/core/model.js';

const st = (library) => ({ library, analysis: null, settings: { ai: { mode: 'companion', companionUrl: '', token: '', baseUrl: '', chatModel: '', embedModel: '' }, autoSync: false }, servedByCompanion: false, lastSync: null });

test('NIH-296: URL に値を含まない画面は、どれも画面名を持つ（名前を書き忘れた画面はここで落ちる）', async () => {
  const { ROUTES, fixedPath } = await import('../web/js/routes.js');
  const fixed = ROUTES.filter(([re]) => fixedPath(re) !== null);
  assert.ok(fixed.length >= 20);
  for (const [re, , , name] of fixed) assert.ok(typeof name === 'string' && name, `${re} に画面名が無い`);
});

test('NIH-296: fixedPath はルートの正規表現から開ける URL を取り出し、値を含むルートは null', async () => {
  const { fixedPath } = await import('../web/js/routes.js');
  assert.equal(fixedPath(/^\/$/), '/');
  assert.equal(fixedPath(/^\/knowledge\/far$/), '/knowledge/far');
  assert.equal(fixedPath(/^\/book\/(?<id>[\w-]+)$/), null);
  assert.equal(fixedPath(/^\/knowledge\/history\/(?<id>[0-9TZ]+)$/), null);
});

test('NIH-296: siteMap は読書メモ（下のタブの順）と価格に分け、値を含まない画面をすべて並べる', async () => {
  const { ROUTES, fixedPath, siteMap } = await import('../web/js/routes.js');
  const map = siteMap();
  assert.deepEqual(map.map((g) => g.axis), ['memo', 'memo', 'memo', 'memo', 'memo', 'memo', 'price']);
  assert.deepEqual(map.map((g) => g.title), ['ホーム', '読んだ本', '★', '知識', '読書記録', '設定', '価格']);
  const hrefs = map.flatMap((g) => g.pages.map((p) => p.href));
  const expected = ROUTES.map(([re]) => fixedPath(re)).filter((p) => p !== null).map((p) => `#${p}`);
  assert.deepEqual([...hrefs].sort(), [...expected].sort(), 'すべての固定の画面が 1 回ずつ出る');
  const knowledge = map.find((g) => g.title === '知識').pages.map((p) => p.name);
  for (const n of ['線(グループ)', '面', '立体', '永久ノート', '遠いつながり', '問いかける', '文章の骨組み']) assert.ok(knowledge.includes(n), n);
  assert.deepEqual(map.find((g) => g.axis === 'price').pages, [{ href: '#/wishlist', name: '価格チェック' }]);
});

test('NIH-296: 「すべての画面」は #/sitemap で開け、設定のタブに属し、読書メモと価格の見出しでリンクを並べる', async () => {
  const { matchRoute } = await import('../web/js/routes.js');
  const m = matchRoute('/sitemap');
  assert.equal(m.notFound, undefined);
  assert.equal(m.tab, 'settings');
  const out = String(m.view.render({ state: st(emptyLibrary()) }));
  assert.match(out, /<h1>すべての画面<\/h1>/);
  assert.match(out, /<h2>読書メモ<\/h2>/);
  assert.match(out, /<h2>価格<\/h2>/);
  assert.match(out, /<a class="row spread" href="#\/knowledge\/far"><b>遠いつながり<\/b>/);
  assert.match(out, /<a class="row spread" href="#\/trash"><b>削除した点<\/b>/);
  assert.doesNotMatch(out, /href="#\/book\//, '値を含む画面は並べない');
});

test('NIH-296: 設定の画面の先頭に「すべての画面」への入口がある', async (t) => {
  globalThis.location = { origin: 'http://localhost:8787' };
  t.after(() => delete globalThis.location);
  const { settingsView } = await import('../web/js/views/settings.js');
  const out = String(settingsView.render({ state: st(emptyLibrary()) }));
  assert.match(out, /<a class="row spread" href="#\/sitemap"><b>すべての画面<\/b>/);
  assert.ok(out.indexOf('#/sitemap') < out.indexOf('AI（ローカル LLM）'), '先頭のカードに置く');
});
