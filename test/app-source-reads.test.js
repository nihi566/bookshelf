// NIH-86 web/js/app.js を文字列として読んで正規表現で確かめるテストを増やさない。
// ルート表は routes.js、操作は app-actions.js にあり、どちらも Node から import して呼べる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST = dirname(fileURLToPath(import.meta.url));
const SELF = 'app-source-reads.test.js';

// app.js に残る配線（PC の探し直し・取り込みと描き直し・自動同期の条件）と、全ファイルの文言の確認だけ。
// 新しいルート・操作のテストは routes.js / app-actions.js（helpers/app-actions.js）から呼んで書く
const ALLOWED = ['companion-detect.test.js', 'import-result.test.js', 'line-group-name.test.js', 'notes.test.js'];

// 'js/app.js'・"web/js/app.js"・`../web/js/app.js`、join(WEB, 'js', 'app.js') のような、app.js を指す文字列
const APP_PATH = /['"`](?:[./]*web\/)?js\/app\.js['"`]|['"`]app\.js['"`]/;

test('app.js を文字列で読むテストは、決めたファイルから増えない', () => {
  const readers = readdirSync(TEST)
    .filter((f) => f.endsWith('.test.js') && f !== SELF)
    .filter((f) => APP_PATH.test(readFileSync(join(TEST, f), 'utf8')));
  assert.deepEqual(readers.filter((f) => !ALLOWED.includes(f)), [], 'routes.js / app-actions.js を import して確かめる');
});

test('ルート表と操作は、DOM の無い Node で import して呼べる', async () => {
  assert.equal(typeof globalThis.document, 'undefined');
  const { matchRoute, parseHash } = await import('../web/js/routes.js');
  const { appActions } = await import('../web/js/app-actions.js');
  const { path, query } = parseHash('#/book/b-1?q=x');
  assert.deepEqual([path, query.get('q'), matchRoute(path).params.id, matchRoute(path).tab], ['/book/b-1', 'x', 'b-1', 'books']);
  assert.equal(parseHash('').path, '/');
  assert.equal(matchRoute('/no-such-page').tab, 'home', '知らない URL はホーム（案内つき。NIH-123）');
  assert.equal(typeof appActions({ state: {} }).actions.fav, 'function');
});
