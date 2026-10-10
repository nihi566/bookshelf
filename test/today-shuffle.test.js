// NIH-89: 今日の点で「別の点」を押したあと、アプリを開き直しても最初の点に戻らない（その日のうちは最後に選び直した組を出す）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyPicks, emptyLibrary, mergeParsed, parseShuffleRecord, shuffleRecord, shuffleSeedFor } from '../web/core/model.js';
import { browserStore } from '../web/core/wishlist.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';

const DAY = new Date(2026, 9, 10, 9, 0);
const LATER_SAME_DAY = new Date(2026, 9, 10, 23, 59);
const NEXT_DAY = new Date(2026, 9, 11, 0, 1);

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test('NIH-89: 選び直した種を保存して読み直すと、同じ日のうちは同じ組が出る（開き直しても最初の点に戻らない）', () => {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  const ids = (seed, date) => dailyPicks(lib, 2, date, seed).map((h) => h.id).join();
  const store = browserStore(memoryStorage());
  store.set('today-shuffle', JSON.stringify(shuffleRecord(DAY, 'abc123')));
  // アプリを開き直した = 保存先から読み直す
  const reopened = parseShuffleRecord(store.get('today-shuffle'));
  assert.equal(shuffleSeedFor(reopened, LATER_SAME_DAY), 'abc123');
  assert.equal(ids(shuffleSeedFor(reopened, LATER_SAME_DAY), LATER_SAME_DAY), ids('abc123', DAY), '選び直した組のまま');
});

test('NIH-89: 日付が変わったら、選び直した種は使わず、その日の今日の点に戻る', () => {
  const r = parseShuffleRecord(JSON.stringify(shuffleRecord(DAY, 'abc123')));
  assert.equal(shuffleSeedFor(r, NEXT_DAY), '');
});

test('NIH-89: 保存が無い・壊れている・形が違うときは種なし（日付の今日の点）', () => {
  for (const text of [null, '', 'not json', '[]', '{"day":1,"seed":"x"}', '{"day":"2026-10-10","seed":3}', 'null']) {
    assert.equal(shuffleSeedFor(parseShuffleRecord(text), DAY), '', String(text));
  }
  assert.equal(shuffleSeedFor(null, DAY), '');
});
