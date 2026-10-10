// NIH-57: 起動したときに PC に届かなかった画面（Tailscale がまだつながっていない等）でも、
// あとで PC に届けば PC が配信している画面だと分かり直し、スマホで書いたメモが PC へ同期される
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

const st = () => ({ settings: { ai: { mode: 'companion', companionUrl: '', token: '' } }, servedByCompanion: false, companionOriginChecked: false });

test('届かなかったときは「まだ分からない」とし、届いて PC だと分かったら判定し直す', async () => {
  const { detectCompanion } = await import('../web/js/services.js');
  const s = st();
  const answers = [null, true];
  let calls = 0;
  const probe = async () => answers[calls++];
  assert.equal(await detectCompanion(s, probe), false, '1 回目は届かない');
  assert.equal(s.servedByCompanion, false);
  assert.equal(await detectCompanion(s, probe), true, '2 回目で PC だと分かる（今回はじめて分かった）');
  assert.equal(s.servedByCompanion, true);
  assert.equal(await detectCompanion(s, probe), false, '分かった後は問い合わせない');
  assert.equal(calls, 2);
});

test('届いて PC ではないと分かった（GitHub Pages など）ら、もう問い合わせない', async () => {
  const { detectCompanion } = await import('../web/js/services.js');
  const s = st();
  let calls = 0;
  const probe = async () => (calls++, false);
  assert.equal(await detectCompanion(s, probe), false);
  assert.equal(await detectCompanion(s, probe), false);
  assert.equal(calls, 1);
  assert.equal(s.servedByCompanion, false);
});

test('PC の URL を設定しているとき・PC を使わない設定のときは問い合わせない', async () => {
  const { detectCompanion } = await import('../web/js/services.js');
  let calls = 0;
  const probe = async () => (calls++, true);
  const withUrl = st();
  withUrl.settings.ai.companionUrl = 'https://pc.example.ts.net';
  assert.equal(await detectCompanion(withUrl, probe), false);
  const direct = st();
  direct.settings.ai.mode = 'direct';
  assert.equal(await detectCompanion(direct, probe), false);
  assert.equal(calls, 0);
});

test('同じオリジンへの問い合わせ: 通信できなければ null（まだ分からない）、返事があれば PC かどうか', async (t) => {
  const { probeCompanionOrigin } = await import('../web/js/services.js');
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  const s = st();
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  assert.equal(await probeCompanionOrigin(s), null);
  globalThis.fetch = async () => new Response('bad gateway', { status: 502 });
  assert.equal(await probeCompanionOrigin(s), null, 'PC の bh serve が再起動中（Tailscale が 502）はまだ分からない');
  // 返事が来ないままなら、待つ長さで切り上げて「まだ分からない」（探し直しを止めない）
  globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  assert.equal(await probeCompanionOrigin(s, 20), null);
  globalThis.fetch = async () => new Response('not found', { status: 404 });
  assert.equal(await probeCompanionOrigin(s), false, 'GitHub Pages など: PC ではない');
  globalThis.fetch = async () => new Response(JSON.stringify({ app: 'book-highlights' }), { status: 200 });
  assert.equal(await probeCompanionOrigin(s), true);
  globalThis.fetch = async () => new Response('{"error":"token"}', { status: 401 });
  assert.equal(await probeCompanionOrigin(s), true, '鍵が要る PC も PC');
});

test('画面: 1 分ごと・画面に戻ったとき・オンラインに戻ったときに PC を探し直し、見つけたら同期する', () => {
  const app = readFileSync(join(WEB, 'js/app.js'), 'utf8');
  const pull = app.match(/async function pullIfNewer\(\) \{([\s\S]*?)\n\}/)[1];
  assert.match(pull, /if \(await detectCompanion\(\)\) \{[\s\S]*?if \(typing\(\)\) await syncWithPc\(\);\s*else await sync\(\{ quiet: true \}\);[\s\S]*?return;/, '見つけたらその場で同期する（端末に残っていたメモを PC へ送る）。入力中は描き直さない');
  assert.ok(pull.indexOf('detectCompanion()') < pull.indexOf('canAutoSync()'), 'PC を探し直してから、同期できるかを判定する');
  assert.match(app, /window\.addEventListener\('online', pullIfNewer\)/);
  assert.match(app, /setInterval\(pullIfNewer, PULL_INTERVAL_MS\)/);
  const start = app.match(/async function start\(\) \{([\s\S]*?)\n\}/)[1];
  assert.match(start, /await detectCompanion\(\);/);
});
