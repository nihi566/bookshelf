// NIH-286 「読書メモ」と「価格」の 2 軸を上のバーで切り替え、★を下のタブから 1 回で開く
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyLibrary } from '../web/core/model.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const index = readFileSync(join(WEB, 'index.html'), 'utf8');

test('NIH-286: 価格チェックの画面は価格の軸、それ以外（知らない URL を含む）は読書メモの軸', async () => {
  const { matchRoute } = await import('../web/js/routes.js');
  assert.equal(matchRoute('/wishlist').axis, 'price');
  for (const p of ['/', '/books', '/book/b-1', '/stars', '/knowledge', '/records', '/settings', '/no-such-page']) {
    assert.equal(matchRoute(p).axis, 'memo', p);
  }
});

test('NIH-286: ★の画面は下のタブの★が選ばれた状態になる', async () => {
  const { matchRoute } = await import('../web/js/routes.js');
  assert.equal(matchRoute('/stars').tab, 'stars');
});

test('NIH-286: 軸ごとに最後に開いた画面を覚え、まだ開いていない軸は軸の入口へ', async () => {
  const { AXIS_HOME, matchRoute, rememberAxisHash } = await import('../web/js/routes.js');
  assert.deepEqual(AXIS_HOME, { memo: '#/', price: '#/wishlist' });
  const a = rememberAxisHash(AXIS_HOME, matchRoute('/book/b-1'), '#/book/b-1');
  assert.deepEqual(a, { memo: '#/book/b-1', price: '#/wishlist' });
  const b = rememberAxisHash(a, matchRoute('/wishlist'), '#/wishlist?ku=1');
  assert.deepEqual(b, { memo: '#/book/b-1', price: '#/wishlist?ku=1' }, '価格へ移っても読書メモで見ていた画面は残る');
  assert.deepEqual(a, { memo: '#/book/b-1', price: '#/wishlist' }, '元の値は書き換えない');
  assert.equal(rememberAxisHash(AXIS_HOME, matchRoute('/'), '').memo, '#/', '空の hash はホーム');
});

test('NIH-286: どのルートにも合わない URL は覚えず、読書メモへ戻すと前の画面に戻る', async () => {
  const { AXIS_HOME, matchRoute, rememberAxisHash } = await import('../web/js/routes.js');
  const a = rememberAxisHash(AXIS_HOME, matchRoute('/stars'), '#/stars');
  assert.equal(rememberAxisHash(a, matchRoute('/typo'), '#/typo'), a);
});

test('NIH-286: 上のバーに「読書メモ」「価格」の切り替えがあり、メモの入口も残る', () => {
  const header = index.match(/<header class="topbar">([\s\S]*?)<\/header>/)[1];
  const axis = header.match(/<nav class="axis-switch" aria-label="([^"]+)">([\s\S]*?)<\/nav>/);
  assert.ok(axis, '上のバー（どの画面にも出る）にある');
  assert.match(axis[2], /<a href="#\/" data-axis="memo">[\s\S]*?読書メモ[\s\S]*?<\/a>/);
  assert.match(axis[2], /<a href="#\/wishlist" data-axis="price">[\s\S]*?価格[\s\S]*?<\/a>/);
  assert.match(header, /data-action="new-thought"/);
});

test('NIH-286: 下のタブは読書メモの軸の 6 つ（ホーム / 読んだ本 / ★ / 知識 / 読書記録 / 設定）で、価格は上の切り替えへ移す', () => {
  const tabbar = index.match(/<nav class="tabbar"[^>]*>([\s\S]*?)<\/nav>/)[1];
  const tabs = [...tabbar.matchAll(/<a href="([^"]+)" data-tab="([^"]+)">[\s\S]*?<span>([^<]+)<\/span><\/a>/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(tabs, [
    ['#/', 'home', 'ホーム'],
    ['#/books', 'books', '読んだ本'],
    ['#/stars', 'stars', '★'],
    ['#/knowledge', 'knowledge', '知識'],
    ['#/records', 'records', '読書記録'],
    ['#/settings', 'settings', '設定'],
  ]);
});

test('NIH-286: ★の画面はタブから開くので「‹ ホーム」の戻るリンクを出さない', async () => {
  const { starsView } = await import('../web/js/views/stars.js');
  const out = String(starsView.render({ state: { library: emptyLibrary(), analysis: null } }));
  assert.doesNotMatch(out, /class="back"/);
  assert.match(out, /<h1>★<\/h1>/);
});
