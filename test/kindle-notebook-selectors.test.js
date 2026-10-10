import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Kindle ノートブックの読み取りは、自動取り込みの拡張機能とブックマークレットに同じものを複製している（ビルド工程を作らないため）。
// Amazon の画面が変わって片方だけ直すと、もう片方が黙って 0 件になる。使っているセレクタの集合が一致することで、直し忘れに気づく。

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = 'extension/offscreen.js';
const BOOKMARKLET = 'web/bookmarklet/kindle-notebook.js';

// 拡張機能だけが使ってよいもの: ログイン画面・ロボット確認の画面を「0 件で読み終えた」としないための検出。
// ブックマークレットはノートブック画面の上で人が実行するので、この検出が要らない
const EXTENSION_ONLY = ['#kp-notebook-library', '#kp-notebook-annotations'];

/** ファイルの中の Kindle ノートブックのセレクタ（正規表現の中のクラス名の前置きも含む）。行頭のコメントは見ない */
function selectors(file) {
  const code = readFileSync(path.join(ROOT, file), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  return new Set(code.match(/[#.]?kp-notebook-[\w-]*|#annotation\w*|#kp-annotation-location/g) || []);
}

test('Kindle ノートブック: 拡張機能とブックマークレットが同じセレクタで読む', () => {
  const ext = selectors(EXTENSION);
  const bm = selectors(BOOKMARKLET);
  const extReading = [...ext].filter((s) => !EXTENSION_ONLY.includes(s)).sort();
  assert.deepEqual(extReading, [...bm].sort(), `${EXTENSION} と ${BOOKMARKLET} のセレクタがずれている。Amazon の画面が変わったら両方を直す`);
});

test('Kindle ノートブック: 拡張機能だけの検出用セレクタは、本当に拡張機能にだけある', () => {
  const ext = selectors(EXTENSION);
  const bm = selectors(BOOKMARKLET);
  for (const s of EXTENSION_ONLY) {
    assert.ok(ext.has(s), `${s} は ${EXTENSION} で使われていない。EXTENSION_ONLY から外す`);
    assert.ok(!bm.has(s), `${s} は ${BOOKMARKLET} でも使われている。EXTENSION_ONLY から外す`);
  }
});

test('Kindle ノートブック: セレクタの抜き出しが空振りしていない', () => {
  // 抜き出しの正規表現が壊れて両方とも空になると、比較は通ってしまう
  for (const file of [EXTENSION, BOOKMARKLET]) {
    const found = selectors(file);
    for (const s of ['.kp-notebook-library-each-book', '#annotationHighlightHeader', '#kp-annotation-location', 'kp-notebook-highlight-']) {
      assert.ok(found.has(s), `${file} から ${s} を抜き出せていない`);
    }
  }
});
