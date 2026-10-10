// NIH-99: 今日の点で、前日〜数日前に見せた点を後ろへ回す（点が足りないときは今までどおり選ぶ）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECENT_PICK_DAYS, dailyPicks, emptyLibrary, mergeParsed, parseSeenPicks, recentPickIds, recordSeenPicks } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';

const day = (d, h = 9) => new Date(2026, 9, d, h, 0);

function sampleLib() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  return lib;
}

const ids = (picks) => picks.map((h) => h.id);

test('NIH-99: 前日に見せた点は、次の日の今日の点で後ろへ回る', () => {
  const lib = sampleLib();
  const first = ids(dailyPicks(lib, 2, day(10)));
  const history = recordSeenPicks([], day(10), first);
  const next = ids(dailyPicks(lib, 2, day(11), '', recentPickIds(history, day(11))));
  assert.equal(next.length, 2);
  assert.ok(next.every((id) => !first.includes(id)), `${next} は ${first} を含まない`);
});

test('NIH-99: 数日続けて開いても、直近 RECENT_PICK_DAYS 日に見せた点は出ない', () => {
  const lib = sampleLib();
  let history = [];
  const shown = [];
  for (let d = 1; d <= RECENT_PICK_DAYS + 1; d++) {
    const picks = ids(dailyPicks(lib, 2, day(d), '', recentPickIds(history, day(d))));
    const recent = shown.slice(-RECENT_PICK_DAYS).flat();
    assert.ok(picks.every((id) => !recent.includes(id)), `${d} 日目`);
    history = recordSeenPicks(history, day(d), picks);
    shown.push(picks);
  }
});

test('NIH-99: 同じ日に開き直しても組は変わらない（今日見せた点は今日の除外に入れない）', () => {
  const lib = sampleLib();
  let history = recordSeenPicks([], day(10), ids(dailyPicks(lib, 2, day(10))));
  const morning = ids(dailyPicks(lib, 2, day(11, 8), '', recentPickIds(history, day(11, 8))));
  history = recordSeenPicks(history, day(11, 8), morning);
  const evening = ids(dailyPicks(lib, 2, day(11, 22), '', recentPickIds(history, day(11, 22))));
  assert.deepEqual(evening, morning);
  // 「別の点」（種あり）でも、同じ種なら同じ組
  const a = ids(dailyPicks(lib, 2, day(11), 'abc', recentPickIds(history, day(11))));
  assert.deepEqual(ids(dailyPicks(lib, 2, day(11), 'abc', recentPickIds(history, day(11)))), a);
});

test('NIH-99: 点が少なくて足りないときは、最近見た点でも埋めて件数を出す', () => {
  const lib = sampleLib();
  const all = ids(dailyPicks(lib, 1000, day(10)));
  const avoid = new Set(all.slice(1));
  const picks = ids(dailyPicks(lib, 3, day(11), '', avoid));
  assert.equal(picks.length, 3);
  assert.equal(picks[0], all[0], '最近見ていない点が先');
  assert.deepEqual(new Set(ids(dailyPicks(lib, 1000, day(11), '', new Set(all)))), new Set(all), '全部見ていても全部出る');
});

test('NIH-99: 除外が無ければ今までと同じ組', () => {
  const lib = sampleLib();
  assert.deepEqual(ids(dailyPicks(lib, 2, day(11), '', new Set())), ids(dailyPicks(lib, 2, day(11))));
  assert.deepEqual(ids(dailyPicks(lib, 2, day(11), 'x', new Set())), ids(dailyPicks(lib, 2, day(11), 'x')));
});

test('NIH-99: 履歴は数日分だけ残り、同じ日に見せた点はまとめる', () => {
  let h = recordSeenPicks([], day(1), ['a', 'b']);
  h = recordSeenPicks(h, day(1, 20), ['b', 'c']);
  assert.equal(h.length, 1);
  assert.deepEqual(h[0].ids, ['a', 'b', 'c']);
  for (let d = 2; d <= 10; d++) h = recordSeenPicks(h, day(d), [`p${d}`]);
  assert.ok(h.length <= RECENT_PICK_DAYS + 1, `残るのは数日分（${h.length}）`);
  assert.deepEqual([...recentPickIds(h, day(11))].sort(), Array.from({ length: RECENT_PICK_DAYS }, (_, i) => `p${10 - i}`).sort());
  // 何も変わらないときは同じ配列を返す（保存し直さなくてよい）
  assert.equal(recordSeenPicks(h, day(10), ['p10']), h);
});

test('NIH-99: 履歴を保存して読み直せる。無い・壊れている・形が違うときは空', () => {
  const h = recordSeenPicks([], day(10), ['a', 'b']);
  assert.deepEqual(parseSeenPicks(JSON.stringify(h)), h);
  for (const text of [null, '', 'not json', '{}', 'null', '[{"day":1,"ids":[]}]', '[{"day":"2026-10-10","ids":"a"}]']) {
    const parsed = parseSeenPicks(text);
    assert.ok(Array.isArray(parsed), String(text));
    assert.equal(recentPickIds(parsed, day(11)).size, 0, String(text));
  }
  // 形の正しい項目だけ残す
  assert.deepEqual(parseSeenPicks('[{"day":"2026-10-10","ids":["a",3]},{"day":5}]'), [{ day: '2026-10-10', ids: ['a'] }]);
});

test('NIH-99: 月・年をまたいでも日数で数える', () => {
  const h = recordSeenPicks([], new Date(2026, 11, 31), ['x']);
  assert.ok(recentPickIds(h, new Date(2027, 0, 1)).has('x'));
  assert.ok(!recentPickIds(h, new Date(2027, 0, 1 + RECENT_PICK_DAYS)).has('x'));
});
