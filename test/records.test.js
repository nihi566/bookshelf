import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths,
  applyChange,
  decodeBase64Utf8,
  emptyRecordsFile,
  encodeBase64Utf8,
  isValidDate,
  newManualId,
  parsePagesInput,
  parseRecordsFile,
  summarizeMonth,
  summarizeYear,
  todayLocal,
  weekdayLabel,
} from '../web/core/records.js';
import { fetchRecords, recordsErrorMessage, saveChange } from '../web/core/records-github.js';

const read = (book_id, read_on, pages, title = book_id) => ({ type: 'read', book_id, title, read_on, pages });

function fileOf(...changes) {
  return changes.reduce((f, c) => applyChange(f, c, '2026-10-04T00:00:00Z'), emptyRecordsFile());
}

test('isValidDate: 実在する日付だけ通す', () => {
  assert.ok(isValidDate('2026-02-28'));
  assert.ok(!isValidDate('2026-02-30'));
  assert.ok(!isValidDate('2026-2-3'));
  assert.ok(!isValidDate(null));
});

test('applyChange: 記録の追加・上書き・削除。元のファイルは変えず、他の本と未知のキーは残す', () => {
  const base = { version: 1, extra: 'keep', records: { other: { title: '他', read_on: '2026-01-01', pages: 10 } } };
  const added = applyChange(base, { ...read('b1', '2026-10-04', 320, '深い集中'), asin: 'B0D8N5G9GT', volumeId: 'bad id!' }, 'now');
  assert.equal(base.records.b1, undefined, '元のファイルは変えない');
  assert.equal(added.extra, 'keep');
  assert.deepEqual(added.records.other, base.records.other);
  assert.deepEqual(added.records.b1, { title: '深い集中', author: '', asin: 'B0D8N5G9GT', volumeId: '', read_on: '2026-10-04', pages: 320, updated_at: 'now' });
  const removed = applyChange(added, { type: 'remove', book_id: 'b1' }, 'now');
  assert.equal(removed.records.b1, undefined);
  assert.throws(() => applyChange(base, read('b1', '2026-13-01', 1), 'now'), /読んだ日/);
  assert.throws(() => applyChange(base, read('b1', '2026-10-01', 0), 'now'), /ページ数/);
  assert.throws(() => applyChange(base, read('b1', '2026-10-01', 1.5), 'now'), /ページ数/);
  assert.throws(() => applyChange(base, read('b1', '2026-10-01', 10, ' '), 'now'), /書名/);
  assert.throws(() => applyChange(base, { type: 'x', book_id: 'b1' }, 'now'), /未知/);
});

test('parseRecordsFile: 読めない日付の項目は捨て、不正な値は既定値に倒す。形が不正なら例外', () => {
  const f = parseRecordsFile({ records: { a: { title: 'A', read_on: '2026-10-01', pages: -3, asin: '<x>' }, b: { title: 'B', read_on: 'いつか' }, c: 'x' } });
  assert.deepEqual(Object.keys(f.records), ['a']);
  assert.equal(f.records.a.pages, null);
  assert.equal(f.records.a.asin, '');
  assert.throws(() => parseRecordsFile([]), /形が不正/);
  assert.throws(() => parseRecordsFile({ records: [] }), /形が不正/);
});

test('parsePagesInput: 空は null、全角数字も読む、範囲外は例外', () => {
  assert.equal(parsePagesInput(''), null);
  assert.equal(parsePagesInput('３２０'), 320);
  assert.throws(() => parsePagesInput('abc'), /ページ数/);
  assert.throws(() => parsePagesInput('0'), /ページ数/);
});

test('summarizeMonth / summarizeYear: 日・月・年ごとの冊数とページ数。ページ数不明は合計に入れず数だけ数える', () => {
  const { records } = fileOf(
    read('a', '2026-10-04', 300, 'い'),
    read('b', '2026-10-04', 120, 'あ'),
    read('c', '2026-10-01', null, 'う'),
    read('d', '2026-09-30', 200),
    read('e', '2025-10-04', 50),
  );
  const oct = summarizeMonth(records, 2026, 10);
  assert.deepEqual([oct.count, oct.pages, oct.unknownCount], [3, 420, 1]);
  assert.deepEqual(oct.days.map((d) => [d.date, d.count, d.pages]), [['2026-10-04', 2, 420], ['2026-10-01', 1, 0]]);
  assert.deepEqual(oct.days[0].items.map((i) => i.title), ['あ', 'い'], '同じ日の中は書名順');
  const year = summarizeYear(records, 2026);
  assert.deepEqual([year.count, year.pages], [4, 620]);
  assert.deepEqual(year.months[8], { month: 9, count: 1, pages: 200 });
  assert.deepEqual(year.months[9], { month: 10, count: 3, pages: 420 });
  assert.equal(summarizeMonth(records, 2026, 11).count, 0);
});

test('日付の補助: 月の移動・曜日・今日・手入力の本の ID', () => {
  assert.deepEqual(addMonths(2026, 1, -1), { year: 2025, month: 12 });
  assert.deepEqual(addMonths(2026, 12, 1), { year: 2027, month: 1 });
  assert.equal(weekdayLabel('2026-10-04'), '日');
  assert.equal(todayLocal(new Date(2026, 0, 2, 1, 0)), '2026-01-02');
  assert.match(newManualId(0, () => 0), /^manual-00000$/);
  assert.equal(decodeBase64Utf8(encodeBase64Utf8('読書 記録')), '読書 記録');
});

/** GitHub Contents API の偽物 */
function fakeGitHub({ file = emptyRecordsFile(), status = 200, conflicts = 0, missingFile = false } = {}) {
  const state = { file, sha: 's1', puts: [], auth: [] };
  const fetchImpl = async (url, init = {}) => {
    state.auth.push(init.headers?.Authorization);
    assert.ok(!String(url).includes('ghp_'), 'トークンは URL に入れない');
    if (status !== 200) return new Response('{}', { status, headers: { 'x-ratelimit-remaining': '10' } });
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body);
      state.puts.push(body);
      if (conflicts > 0) {
        conflicts -= 1;
        state.sha += 'x';
        return new Response('{}', { status: 409 });
      }
      if (body.sha !== (missingFile ? undefined : state.sha)) return new Response('{}', { status: 409 });
      state.file = JSON.parse(decodeBase64Utf8(body.content));
      state.sha += 'y';
      missingFile = false;
      return new Response(JSON.stringify({ content: { sha: state.sha } }));
    }
    assert.match(String(url), /\/repos\/nihi566\/bookshelf\/contents\/records\.json\?ref=records$/);
    if (missingFile) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({ sha: state.sha, content: encodeBase64Utf8(JSON.stringify(state.file)) }));
  };
  return { state, fetchImpl };
}

test('records-github: 読む（トークン無しでも読める）・保存する（sha 付き、競合したら 1 回だけ取り直す）', async () => {
  const gh = fakeGitHub({ file: fileOf(read('a', '2026-10-01', 10)) });
  const f = await fetchRecords('', { fetchImpl: gh.fetchImpl });
  assert.equal(f.records.a.pages, 10);
  assert.equal(gh.state.auth[0], undefined);

  const gh2 = fakeGitHub({ conflicts: 1 });
  const saved = await saveChange('ghp_token', read('b', '2026-10-04', 200), { fetchImpl: gh2.fetchImpl, now: () => 'T' });
  assert.equal(saved.records.b.pages, 200);
  assert.equal(gh2.state.puts.length, 2, '競合したら取り直して再送');
  assert.equal(gh2.state.puts[1].branch, 'records');
  assert.equal(gh2.state.file.records.b.updated_at, 'T');
  assert.ok(gh2.state.auth.every((a) => a === 'Bearer ghp_token'));

  await assert.rejects(saveChange('ghp_token', read('c', '2026-10-04', 1), { fetchImpl: fakeGitHub({ conflicts: 2 }).fetchImpl }), (e) => e.kind === 'conflict');
});

test('records-github: ファイルがまだ無ければ最初の保存で作る。トークン無しの保存・権限・通信の失敗は種類で返す', async () => {
  const gh = fakeGitHub({ missingFile: true });
  await saveChange('ghp_token', read('a', '2026-10-04', 1), { fetchImpl: gh.fetchImpl });
  assert.equal(gh.state.puts[0].sha, undefined);
  assert.equal(gh.state.file.records.a.pages, 1);

  await assert.rejects(saveChange('', read('a', '2026-10-04', 1)), (e) => e.kind === 'auth');
  await assert.rejects(fetchRecords('ghp_token', { fetchImpl: fakeGitHub({ status: 401 }).fetchImpl }), (e) => e.kind === 'auth' && !e.message.includes('ghp_'));
  await assert.rejects(fetchRecords('', { fetchImpl: fakeGitHub({ status: 404 }).fetchImpl }), (e) => e.kind === 'notfound');
  await assert.rejects(fetchRecords('', { fetchImpl: async () => { throw new Error('offline'); } }), (e) => e.kind === 'network');
  assert.match(recordsErrorMessage({ kind: 'forbidden' }), /権限/);
});
