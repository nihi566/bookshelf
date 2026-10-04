// 文の整え方・エスケープ・エラー文の伏せ字（同期やほかの端末から届いた壊れた値で、サーバや画面を止めない）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, isoStamp, maskSecrets, sliceChars, truncate } from '../web/core/text.js';
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

test('同期で届いた時刻: 実在する ISO 形式の時刻だけを通し、壊れた時刻は空文字、未来すぎる時刻は今の時刻に直す', () => {
  const now = '2026-10-04T12:00:00.000Z';
  assert.equal(isoStamp('2026-10-04T10:00:00.000Z', now), '2026-10-04T10:00:00.000Z');
  assert.equal(isoStamp('2026-10-04T10:00:00Z', now), '2026-10-04T10:00:00Z');
  assert.equal(isoStamp('2026-10-05T11:00:00.000Z', now), '2026-10-05T11:00:00.000Z', '24 時間までは端末の時計のずれとして受け入れる');
  for (const bad of ['zzzz', '9999-99-99T99:99:99Z', '2026-02-30T10:00:00.000Z', '2026-10-04 10:00', 5, null, 'x'.repeat(50)]) assert.equal(isoStamp(bad, now), '', String(bad).slice(0, 20));
  assert.equal(isoStamp('9999-12-31T23:59:59.999Z', now), now, '未来すぎる時刻は今の時刻に直す（勝ち続けない）');
});

test('文字数で切る: 2 つで 1 文字の文字（絵文字・一部の漢字）を半分にしない。truncate は長い文を先に切ってから 1 文字ずつに分ける', () => {
  assert.equal(sliceChars('ab𠮟', 3), 'ab', '𠮟 の途中では切らない');
  assert.equal(sliceChars('abc', 5), 'abc');
  assert.equal(truncate('𠮟'.repeat(5), 3), '𠮟𠮟…');
  // 1 文字ずつに分ける長さが、切る長さに見合っているか（文の長さに比例して時間・メモリを使わない）
  const orig = Array.from;
  let longest = 0;
  Array.from = function (x, ...rest) {
    if (typeof x === 'string') longest = Math.max(longest, x.length);
    return orig.call(this, x, ...rest);
  };
  try {
    assert.equal(truncate('あ'.repeat(1_000_000), 10), `${'あ'.repeat(9)}…`);
  } finally {
    Array.from = orig;
  }
  assert.ok(longest <= 22, `1 文字ずつに分けた長さ ${longest}`);
});

test('エラー文から、URL に書いた利用者名・パスワードを伏せる', () => {
  assert.equal(maskSecrets('接続できません (http://user:secret@127.0.0.1:9): x'), '接続できません (http://***@127.0.0.1:9): x');
  assert.equal(maskSecrets('http://127.0.0.1:9 と https://a.example/b@c'), 'http://127.0.0.1:9 と https://a.example/b@c');
  assert.equal(maskSecrets(undefined), '');
});
