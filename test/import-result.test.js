// NIH-77 取り込みの結果: 失敗したファイルがあれば通知と結果欄で成功と区別し、自動同期の描き直しのあとも結果欄を残す
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyLibrary } from '../web/core/model.js';
import { importHelpTargets, importOutcome, importResultBlock, importView } from '../web/js/views/settings.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

const OK = { name: 'My Clippings.txt', formatLabel: 'Kindle My Clippings', books: 2, highlights: 5, images: 0 };
const BAD = { name: 'photo.png', error: '対応していない形式です' };
const STATS = { added: 5, updated: 0, unchanged: 0, backups: 0 };
const NONE = { added: 0, updated: 0, unchanged: 0, backups: 0 };

function ctx(lastImport, refresh) {
  return { state: { library: emptyLibrary(), analysis: null, settings: { ai: { mode: 'direct', companionUrl: '' } }, pcInfo: null, lastImport }, refresh, params: {}, query: new URLSearchParams() };
}
const resultBox = (out) => out.match(/<div id="import-result">([\s\S]*?)<\/div>\s*<div class="section">/)[1];

test('全部読めたときは「取り込みました」と緑の欄', () => {
  const o = importOutcome([OK], STATS);
  assert.equal(o.failed, 0);
  assert.equal(o.message, '取り込みました: 新しい点 5 件');
  const box = String(importResultBlock({ results: [OK], stats: STATS }));
  assert.match(box, /<p class="notice ok">新しい点 5 件<\/p>/);
  assert.match(box, /✓ <b>My Clippings.txt<\/b>/);
});

test('一部が読めないときは、通知と欄の両方に読めなかった件数が出て、成功の色にしない', () => {
  const o = importOutcome([OK, BAD], STATS);
  assert.equal(o.failed, 1);
  assert.match(o.message, /^取り込みました（1 件のファイルは読めませんでした）: 新しい点 5 件$/);
  const box = String(importResultBlock({ results: [OK, BAD], stats: STATS }));
  assert.match(box, /<p class="notice">新しい点 5 件。2 件のうち 1 件のファイルは読めませんでした（理由は下）<\/p>/, '注意の色（ok でも err でもない）');
  assert.match(box, /✗ <b>photo.png<\/b><br><span class="small muted">対応していない形式です<\/span>/);
});

test('全部読めないときは「取り込めませんでした」と赤の欄', () => {
  const o = importOutcome([BAD, { ...BAD, name: 'b.pdf' }], NONE);
  assert.equal(o.failed, 2);
  assert.equal(o.message, '取り込めませんでした: 2 件のファイルがすべて読めません');
  const box = String(importResultBlock({ results: [BAD, { ...BAD, name: 'b.pdf' }], stats: NONE }));
  assert.match(box, /<p class="notice err">2 件のファイルがすべて読めませんでした（理由は下）<\/p>/);
  assert.doesNotMatch(box, /notice ok/);
});

test('読み込みそのものが失敗したときも赤の欄で理由を出す', () => {
  const box = String(importResultBlock({ error: 'ファイルを読めませんでした' }));
  assert.equal(box.trim(), '<p class="notice err">ファイルを読めませんでした</p>');
});

test('同じ画面の描き直し（自動同期のあと）では取り込み結果が残り、別の画面から来たときは出さない', () => {
  const lastImport = { results: [OK, BAD], stats: STATS };
  const kept = resultBox(String(importView.render(ctx(lastImport, true))));
  assert.match(kept, /✗ <b>photo.png<\/b>/);
  assert.equal(resultBox(String(importView.render(ctx(lastImport, false)))).trim(), '');
  assert.equal(resultBox(String(importView.render(ctx(null, true)))).trim(), '');
});

test('app.js: 取り込み結果を覚えてから同期し、別の画面に移ったら忘れる。通知は失敗を区別した文言', () => {
  const app = readFileSync(join(WEB, 'js/app.js'), 'utf8');
  const fn = app.match(/async function importFiles\(files\) \{([\s\S]*?)\n\}/)[1];
  assert.match(fn, /state\.lastImport = null;/, '次に取り込むときは前の結果を消す');
  assert.match(fn, /state\.lastImport = \{ results, stats[^}]*\};[\s\S]*?toast\(outcome\.message[^)]*\);[\s\S]*?autoSyncAfterChange\(\);/);
  assert.match(fn, /catch \(e\) \{[\s\S]*?state\.lastImport = \{ error: e\.message \};/);
  assert.match(fn, /const showResult = \(content\) => \{\s*const out = view\.querySelector\('#import-result'\);/,'読み込み中に描き直されても書けるよう、結果欄は書くたびに取り直す');
  assert.doesNotMatch(fn, /toast\(`取り込みました/, '失敗があっても必ず「取り込みました」と出す通知を残さない');
  const render = app.match(/function render\(\{ keepScroll = false \} = \{\}\) \{([\s\S]*?)\n\}/)[1];
  assert.match(render, /if \(!ctx\.refresh\) state\.lastImport = null;[\s\S]*?match\.view\.render\(ctx\)/, '画面を離れたら（別の画面から来たら）結果を消す');
});

// NIH-98 読めなかったファイルの行に、取り込み方の説明（同じ画面の details）を開く案内を出す
test('読めなかったファイルの行には取り出し方の案内が出て、読めたファイルの行には出ない', () => {
  const box = String(importResultBlock({ results: [OK, { name: 'notes.txt', error: 'My Clippings.txt の形式ではありません' }], stats: STATS }));
  const [okRow, badRow] = box.match(/<li>[\s\S]*?<\/li>/g);
  assert.doesNotMatch(okRow, /open-import-help/, '読めたファイルの行には出ない');
  assert.match(badRow, /取り出し方: <button[^>]*data-action="open-import-help" data-target="help-kindle-device"[^>]*>Kindle 端末<\/button>/);
});

test('案内の宛先はファイルの拡張子で決まり、分からない形式は主な取り出し方を並べる', () => {
  const ids = (name) => importHelpTargets(name).map((t) => t.id);
  assert.deepEqual(ids('My Clippings.TXT'), ['help-kindle-device']);
  assert.deepEqual(ids('a.html'), ['help-kindle-export', 'help-playbooks']);
  assert.deepEqual(ids('a.htm'), ['help-kindle-export', 'help-playbooks']);
  assert.deepEqual(ids('a.docx'), ['help-playbooks']);
  assert.deepEqual(ids('a.zip'), ['help-playbooks']);
  assert.deepEqual(ids('kindle.json'), ['help-kindle-bookmarklet']);
  assert.deepEqual(ids('memo.md'), ['help-reading-notes']);
  assert.deepEqual(ids('photo.png'), ['help-kindle-device', 'help-kindle-export', 'help-playbooks']);
  assert.deepEqual(ids('拡張子なし'), ['help-kindle-device', 'help-kindle-export', 'help-playbooks']);
});

test('案内の宛先はすべて取り込み画面に実在し、ファイル名に入った記号で壊れない', () => {
  const page = String(importView.render(ctx(null, true)));
  for (const name of ['a.txt', 'a.html', 'a.docx', 'a.json', 'a.md', 'a.png']) {
    for (const t of importHelpTargets(name)) assert.match(page, new RegExp(`id="${t.id}"`), `${t.id} が画面にある`);
  }
  const box = String(importResultBlock({ results: [{ name: '"><img src=x>.txt', error: '対応していない形式です' }], stats: NONE }));
  assert.doesNotMatch(box, /<img src=x>/);
});

test('app.js: 案内を押すとその説明を開いて見える位置まで動かす', () => {
  const app = readFileSync(join(WEB, 'js/app.js'), 'utf8');
  const fn = app.match(/'open-import-help'\(el\) \{([\s\S]*?)\n  \},/)[1];
  assert.match(fn, /document\.getElementById\(el\.dataset\.target\)/);
  assert.match(fn, /\.open = true/);
  assert.match(fn, /scrollIntoView/);
});
