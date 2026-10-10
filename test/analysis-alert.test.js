// NIH-53: PC の分析が続けて失敗しているとき、ホームの先頭（Kindle の警告と同じ欄）に 1 行の警告を出す
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createStore } from '../cli/store.js';
import { emptyLibrary, mergeParsed } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';
import { startFakeLlm } from './helpers/fake-llm.js';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');

const failing = {
  enabled: true,
  minPoints: 10,
  maxHours: 24,
  pending: 12,
  lastSuccessAt: '2026-10-04T01:02:00.000Z',
  lastError: 'LLM サーバに接続できません (http://127.0.0.1:11434) <script>',
  lastErrorAt: '2026-10-10T03:04:00.000Z',
  failureCount: 3,
  lastTrigger: 'auto',
};
const st = (autoAnalysis, { mode = 'companion', library = emptyLibrary() } = {}) => ({
  library,
  analysis: null,
  settings: { ai: { mode, companionUrl: '' } },
  servedByCompanion: true,
  job: null,
  pcInfo: autoAnalysis === undefined ? null : { autoAnalysis },
});

test('NIH-53: 分析の失敗が最後の成功より新しいとき、続けて失敗した回数と理由を 1 行で出す', async () => {
  const { autoAnalysisAlert } = await import('../web/js/ui.js');
  assert.equal(autoAnalysisAlert(failing), 'PC の分析が 3 回続けて失敗しています（LLM サーバに接続できません (http://127.0.0.1:11434) <script>）');
  assert.equal(autoAnalysisAlert({ ...failing, failureCount: 1 }), 'PC の分析に失敗しています（LLM サーバに接続できません (http://127.0.0.1:11434) <script>）');
  // 回数を数える前の記録（failureCount が無い）でも、失敗していれば出す
  assert.match(autoAnalysisAlert({ ...failing, failureCount: undefined }), /^PC の分析に失敗しています（/);
  // 長い理由は切って 1 行に収める
  const long = autoAnalysisAlert({ ...failing, lastError: 'あ'.repeat(500) });
  assert.ok(long.length < 200, long);
  assert.match(long, /…）$/);
});

test('NIH-53: 成功したら消える・自動の分析がオフ・失敗していないときは出さない', async () => {
  const { autoAnalysisAlert } = await import('../web/js/ui.js');
  assert.equal(autoAnalysisAlert({ ...failing, lastError: '', lastErrorAt: null, failureCount: 0, lastSuccessAt: '2026-10-10T04:00:00.000Z' }), '');
  assert.equal(autoAnalysisAlert({ ...failing, lastSuccessAt: '2026-10-10T04:00:00.000Z' }), '', '最後の成功が失敗より新しい');
  assert.equal(autoAnalysisAlert({ ...failing, enabled: false }), '');
  assert.equal(autoAnalysisAlert(null), '');
  assert.equal(autoAnalysisAlert(undefined), '');
});

test('NIH-53: ホームの警告欄に出し、押すと知識の画面へ移る。PC を使わないとき・PC の情報が無いときは出さない', async () => {
  const { homeAlertBlock } = await import('../web/js/ui.js');
  const out = String(homeAlertBlock(st(failing)));
  assert.match(out, /<a class="notice err" href="#\/knowledge"[^>]*>PC の分析が 3 回続けて失敗しています（LLM サーバに接続できません \(http:\/\/127\.0\.0\.1:11434\) &lt;script&gt;）（詳しく）<\/a>/);
  assert.equal(String(homeAlertBlock(st(failing, { mode: 'direct' }))), '');
  assert.equal(String(homeAlertBlock(st(undefined))), '');
  assert.equal(String(homeAlertBlock(st({ ...failing, enabled: false }))), '');
  // Kindle の取り込みの警告と同じ欄に並ぶ
  const both = String(homeAlertBlock({ ...st(failing), pcInfo: { autoAnalysis: failing, kindleSync: { enabled: true, lastCheck: { at: '2026-10-10T03:00:00.000Z', ok: false, needLogin: true } } } }));
  assert.match(both, /href="#\/import"[\s\S]*href="#\/knowledge"/);
});

test('NIH-53: ホームの先頭に警告欄があり、PC の情報を取り直したらこの欄だけ差し替える', async () => {
  const { home } = await import('../web/js/views/library.js');
  const library = emptyLibrary();
  mergeParsed(library, SAMPLE_BOOKS);
  const out = String(home.render({ state: st(failing, { library }) }));
  assert.match(out, /^\s*<div id="home-alert"><a class="notice err" href="#\/knowledge"/);
  const empty = String(home.render({ state: st(failing) }));
  assert.match(empty, /^\s*<div id="home-alert"><a class="notice err" href="#\/knowledge"/, '本が 0 冊のときも出す');
  assert.match(readFileSync(join(WEB, 'js/app.js'), 'utf8'), /'\/': \[\['#home-alert', homeAlertBlock\]\]/);
});

test('NIH-53: bh analyze で成功したときも、続けて失敗した回数を 0 に戻す（次の失敗を「4 回続けて」と数えない）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bh-alert-'));
  const env = { ...process.env, BH_DATA: dataDir };
  const bh = (...a) => run('node', [join(ROOT, 'cli/bh.js'), ...a], { env });
  const fake = await startFakeLlm();
  try {
    const store = createStore(dataDir);
    await bh('import', join(ROOT, 'test/fixtures/My Clippings.txt'), join(ROOT, 'test/fixtures/playbooks-ja.html'));
    await store.saveConfig({ llm: { baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' } });
    await store.saveState({ autoAnalysis: { lastError: 'LLM サーバに接続できません', lastErrorAt: '2026-10-10T03:04:00.000Z', failureCount: 3 } });
    // おすすめの本は書誌 DB に問い合わせるので選ばない（テストがネットワークに依存しないように）
    await bh('analyze', '--no-recommend');
    const au = (await store.state()).autoAnalysis;
    assert.equal(au.lastError, '');
    assert.equal(au.failureCount, 0);
  } finally {
    await fake.close();
  }
});
