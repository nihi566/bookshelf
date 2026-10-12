// NIH-53: PC の分析が続けて失敗した回数を数える（NIH-307 でホームの警告は外した。失敗の理由は知識の画面に出る）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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

test('NIH-307: 分析が続けて失敗していても、ホームの警告欄には出さない（手動で分析するので。理由は知識の画面に出る）', async () => {
  const ui = await import('../web/js/ui.js');
  assert.equal(ui.autoAnalysisAlert, undefined, 'ホームの分析の警告の文言を作る関数は無い');
  assert.equal(String(ui.homeAlertBlock(st(failing))), '');
  // Kindle の取り込みの警告は同じ欄に残る
  const both = String(ui.homeAlertBlock({ ...st(failing), pcInfo: { autoAnalysis: failing, kindleSync: { enabled: true, lastCheck: { at: '2026-10-10T03:00:00.000Z', ok: false, needLogin: true } } } }));
  assert.match(both, /href="#\/import"/);
  assert.doesNotMatch(both, /href="#\/knowledge"|PC の分析/);
});

test('NIH-307: ホームの先頭の警告欄は残し、分析の失敗では中身が空のまま', async () => {
  const { home } = await import('../web/js/views/library.js');
  const library = emptyLibrary();
  mergeParsed(library, SAMPLE_BOOKS);
  const out = String(home.render({ state: st(failing, { library }) }));
  assert.match(out, /^\s*<div id="home-alert"><\/div>/);
  assert.doesNotMatch(out, /PC の分析が/);
  const { PC_INFO_BOXES } = await import('../web/js/routes.js');
  const { homeAlertBlock } = await import('../web/js/ui.js');
  assert.deepEqual(PC_INFO_BOXES['/'], [['#home-alert', homeAlertBlock]]);
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
