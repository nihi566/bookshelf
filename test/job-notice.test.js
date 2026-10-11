// NIH-227: 分析が失敗・中断で終わったとき、知識の画面（JOB_PATHS）以外にいても通知で気づけるようにする。
// 成功のトーストと、知識の画面での表示（jobPanel にエラーが出る）は今のまま
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyJobEnd } from '../web/js/job-notice.js';

function spy() {
  const calls = [];
  const gone = [];
  return { calls, gone, toast: (message, ms, action) => calls.push({ message, ms, action }), go: (hash) => gone.push(hash) };
}

const running = { running: true, where: 'pc', stage: 'line', message: '線を作っています', error: '' };

test('失敗で終わったら、知識の画面以外では理由つきで失敗を知らせ、知識の画面へ行ける', async () => {
  const s = spy();
  notifyJobEnd({ prev: running, job: { ...running, running: false, stage: 'error', error: 'LLM に接続できません', message: '' }, path: '/books', toast: s.toast, go: s.go });
  assert.equal(s.calls.length, 1);
  assert.match(s.calls[0].message, /分析が失敗しました/);
  assert.match(s.calls[0].message, /LLM に接続できません/);
  assert.ok(s.calls[0].ms > 2600, '理由を読めるよう、ふつうの通知より長く出す');
  assert.equal(s.calls[0].action.label, '知識の画面へ');
  await s.calls[0].action.run();
  assert.deepEqual(s.gone, ['#/knowledge']);
});

test('中断で終わったら、中断したと知らせる', () => {
  const s = spy();
  notifyJobEnd({ prev: running, job: { ...running, running: false, stage: 'interrupted', error: 'PC の分析が途中で止まりました。' }, path: '/', toast: s.toast, go: s.go });
  assert.equal(s.calls.length, 1);
  assert.match(s.calls[0].message, /分析が中断しました/);
  assert.match(s.calls[0].message, /PC の分析が途中で止まりました/);
});

test('理由が空でも、失敗したことは知らせる', () => {
  const s = spy();
  notifyJobEnd({ prev: running, job: { ...running, running: false, stage: 'error', error: '' }, path: '/lines', toast: s.toast, go: s.go });
  assert.equal(s.calls.length, 1);
  assert.match(s.calls[0].message, /分析が失敗しました/);
});

test('知識の画面（JOB_PATHS）では通知しない（画面に理由が出る）', () => {
  for (const path of ['/knowledge', '/knowledge/pending']) {
    const s = spy();
    notifyJobEnd({ prev: running, job: { ...running, running: false, stage: 'error', error: 'x' }, path, toast: s.toast, go: s.go });
    assert.equal(s.calls.length, 0, path);
  }
});

test('PC のサーバが再起動したとき（初期状態に戻った job → 中断）の 2 段の更新でも、中断を 1 回だけ知らせる', () => {
  const s = spy();
  const reset = { ...running, running: false, stage: '', error: '' };
  notifyJobEnd({ prev: running, job: reset, path: '/', toast: s.toast, go: s.go });
  const interrupted = { ...reset, stage: 'interrupted', error: 'PC の分析が途中で止まりました。' };
  notifyJobEnd({ prev: reset, job: interrupted, path: '/', toast: s.toast, go: s.go });
  notifyJobEnd({ prev: interrupted, job: interrupted, path: '/', toast: s.toast, go: s.go });
  assert.equal(s.calls.length, 1);
  assert.match(s.calls[0].message, /分析が中断しました/);
});

test('自分で中止した分析（cancelling の印）は失敗として知らせない', () => {
  const s = spy();
  notifyJobEnd({ prev: { ...running, cancelling: true }, job: { ...running, cancelling: true, running: false, stage: 'error', error: '分析を中止しました' }, path: '/', toast: s.toast, go: s.go });
  assert.equal(s.calls.length, 0);
});

test('成功・走ったまま・状況不明（lost）・もともと止まっていたときは通知しない', () => {
  const cases = [
    { prev: running, job: { ...running, running: false, stage: 'done', message: '完了しました' } },
    { prev: running, job: { ...running, stage: 'plane' } },
    { prev: running, job: { ...running, running: false, lost: true, error: '' } },
    { prev: { running: false, stage: 'error', error: 'x' }, job: { running: false, stage: 'error', error: 'x' } },
    { prev: undefined, job: { running: false, stage: 'error', error: 'x' } },
  ];
  for (const c of cases) {
    const s = spy();
    notifyJobEnd({ ...c, path: '/', toast: s.toast, go: s.go });
    assert.equal(s.calls.length, 0, JSON.stringify(c.job));
  }
});
