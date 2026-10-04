// 文の整え方・エスケープ・エラー文の伏せ字（同期やほかの端末から届いた壊れた値で、サーバや画面を止めない）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, maskSecrets } from '../web/core/text.js';
import { esc } from '../web/js/html.js';

test('空白だけの長い文が届いても、文を整える処理は長さに比例する時間で終わる（前と同じ整え方）', () => {
  // 前の整え方（/[ \t]+\n/）は、改行の無い長い空白の並びで時間が長さの 2 乗に増えた（8 万字で約 3 秒）
  const long = ' '.repeat(200_000);
  const t = performance.now();
  assert.equal(cleanText(`a${long}b`), `a${long}b`);
  assert.ok(performance.now() - t < 1000, `${Math.round(performance.now() - t)} ms`);
  // 行末の空白・連続する空行・前後の空白の扱いは変えない
  assert.equal(cleanText(' \ufeff本文  \r\n\r\n\r\n 2 行目\t \n\n\n\n末尾 \u3000 '), '本文\n\n 2 行目\n\n末尾');
  assert.equal(cleanText('a \t\nb'), 'a\nb');
  assert.equal(cleanText('行末の全角空白\u3000\n次'), '行末の全角空白\u3000\n次', '全角空白は行末でも残す（前と同じ）');
  assert.equal(cleanText(null), '');
});

test('エスケープ: 文字にできない値は空にする（壊れたデータで画面全体が描けなくならない）', () => {
  assert.equal(esc({ toString: 1 }), '');
  assert.equal(esc(Object.create(null)), '');
  assert.equal(esc(0), '0');
  assert.equal(esc(null), '');
  assert.equal(esc(`<a href="x">'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&lt;/a&gt;');
});

test('エラー文から、URL に書いた利用者名・パスワードを伏せる', () => {
  assert.equal(maskSecrets('接続できません (http://user:secret@127.0.0.1:9): x'), '接続できません (http://***@127.0.0.1:9): x');
  assert.equal(maskSecrets('http://127.0.0.1:9 と https://a.example/b@c'), 'http://127.0.0.1:9 と https://a.example/b@c');
  assert.equal(maskSecrets(undefined), '');
});
