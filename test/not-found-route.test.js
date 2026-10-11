// NIH-123 どのルートにも合わない URL は、黙ってホームを出さず「このページはありません」と知らせる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, mergeParsed } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';

function state(library) {
  return { library, analysis: null, settings: { ai: { mode: 'direct', companionUrl: '' } }, servedByCompanion: false, pcInfo: null };
}

test('NIH-123: 知らない URL は notFound に開いたパスを載せ、タブはホーム', async () => {
  const { matchRoute } = await import('../web/js/routes.js');
  const m = matchRoute('/no-such-page');
  assert.deepEqual([m.notFound, m.tab], ['/no-such-page', 'home']);
  assert.equal(matchRoute('/').notFound, undefined, 'ホームそのものは案内しない');
  assert.equal(matchRoute('/book/b-1').notFound, undefined);
});

test('NIH-123: 知らない URL では、ホームの先頭に案内と URL が出て、続けてホームの中身が出る', async () => {
  const { matchRoute } = await import('../web/js/routes.js');
  const { home } = await import('../web/js/views/library.js');
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  const ctx = { state: state(lib), shuffle: 0 };
  const out = String(matchRoute('/old/bookmark').view.render(ctx));
  assert.match(out, /^<p class="notice err" role="alert"[^>]*>このページはありません（URL: #\/old\/bookmark）/);
  assert.ok(out.endsWith(String(home.render(ctx))), 'ホームはそのまま使える');
  assert.doesNotMatch(String(matchRoute('/').view.render(ctx)), /このページはありません/);
});

test('NIH-123: 案内に出す URL はエスケープする', async () => {
  const { matchRoute } = await import('../web/js/routes.js');
  const out = String(matchRoute('/<img src=x onerror=alert(1)>').view.render({ state: state(emptyLibrary()) }));
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
