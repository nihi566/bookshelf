// 文書に書いた数の見張り（NIH-93）。
// docs/concept.md・README.md に書いた件数（今日の点・発見・意味の近い点など）が、実装の定数と同じかを確かめる。
// 定数を変えて文書を直し忘れると、ここで「どの文書のどの文と、どの定数か」を出して落ちる（NIH-78 で今日の点の件数が古いまま残った）。
// 文書の言い回しを変えて文が見つからなくなったら、下の照合表の正規表現も直す（数のすぐ前後だけを見ているので、ほかの言い回しは自由に変えてよい）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 定数はソースの文字から読む（画面のモジュール web/js/views/* は Node で import できないため）。
// name は `NAME = 数` か、オブジェクトの `name: 数` の形で 1 回だけ書かれている前提
const HOME_PICKS = { file: 'web/js/views/library.js', name: 'HOME_PICKS' };
const ON_HOME = { file: 'web/js/views/discoveries.js', name: 'ON_HOME' };
const NEIGHBORS_MAX = { file: 'web/core/analysis/neighbors.js', name: 'NEIGHBORS_MAX' };
const ASK_MAX_POINTS = { file: 'web/core/ask.js', name: 'ASK_MAX_POINTS' };
const FAR_MAX_PAIRS = { file: 'web/core/analysis/far.js', name: 'FAR_MAX_PAIRS' };
const LINE_TARGET_SIZE = { file: 'web/core/analysis/pipeline.js', name: 'LINE_TARGET_SIZE' };
const MAX_LINES = { file: 'web/core/analysis/pipeline.js', name: 'MAX_LINES' };
const HISTORY_KEEP = { file: 'cli/store.js', name: 'HISTORY_KEEP' };
const HISTORY_PIN_MAX = { file: 'cli/store.js', name: 'HISTORY_PIN_MAX' };
const AUTO_MIN_POINTS = { file: 'web/core/auto-analysis.js', name: 'minPoints' };
const AUTO_MAX_HOURS = { file: 'web/core/auto-analysis.js', name: 'maxHours' };
const PICKS_MAX = { file: 'web/core/outline-draft.js', name: 'PICKS_MAX' };
const RECENT_PICK_DAYS = { file: 'web/core/model.js', name: 'RECENT_PICK_DAYS' };

const CONCEPT = 'docs/concept.md';
const README = 'README.md';

// 照合表: 文書の中で、正規表現の 1 つ目のかっこ（数）が定数と同じであること。文書の中に出てくる箇所はすべて照合する
const CHECKS = [
  { doc: CONCEPT, re: /「今日の点」が日ごとに点を (\d+) つ選んで/g, constant: HOME_PICKS },
  { doc: CONCEPT, re: /ホームの上の方に未読の新しい順に (\d+) 件/g, constant: ON_HOME },
  { doc: README, re: /ホームの上の方に未読の新しい順に (\d+) 件/g, constant: ON_HOME },
  { doc: CONCEPT, re: /「意味の近い点（別の本から）」が最大 (\d+) 件/g, constant: NEIGHBORS_MAX },
  { doc: README, re: /「意味の近い点（別の本から）」が最大 (\d+) 件/g, constant: NEIGHBORS_MAX },
  { doc: CONCEPT, re: /PC が近い点を最大 (\d+) 件集め/g, constant: ASK_MAX_POINTS },
  { doc: README, re: /PC が質問に近い点を最大 (\d+) 件集め/g, constant: ASK_MAX_POINTS },
  { doc: CONCEPT, re: /を最大 (\d+) 組選び/g, constant: FAR_MAX_PAIRS },
  { doc: README, re: /を最大 (\d+) 組選び/g, constant: FAR_MAX_PAIRS },
  { doc: CONCEPT, re: /点 (\d+) 件で線 1 本/g, constant: LINE_TARGET_SIZE },
  { doc: CONCEPT, re: /線 1 本（上限 (\d+) 本）/g, constant: MAX_LINES },
  { doc: CONCEPT, re: /直近 (\d+) 回分/g, constant: HISTORY_KEEP },
  { doc: README, re: /直近 (\d+) 回分/g, constant: HISTORY_KEEP },
  { doc: CONCEPT, re: /印は (\d+) 回まで/g, constant: HISTORY_PIN_MAX },
  { doc: README, re: /印は (\d+) 回まで/g, constant: HISTORY_PIN_MAX },
  { doc: CONCEPT, re: /前回の分析のあとに点が (\d+) 件増える/g, constant: AUTO_MIN_POINTS },
  { doc: README, re: /前回の分析のあとに点（思いつきを含む）が (\d+) 件増える/g, constant: AUTO_MIN_POINTS },
  { doc: CONCEPT, re: /件増えるか、(\d+) 時間たって/g, constant: AUTO_MAX_HOURS },
  { doc: README, re: /件増えるか、(\d+) 時間たって/g, constant: AUTO_MAX_HOURS },
  { doc: CONCEPT, re: /面・線・永久ノートを選ぶと（(\d+) つまで）/g, constant: PICKS_MAX },
  { doc: README, re: /材料を選ぶと（(\d+) つまで）/g, constant: PICKS_MAX },
  { doc: CONCEPT, re: /前の (\d+) 日間にその端末で見せた点/g, constant: RECENT_PICK_DAYS },
  { doc: README, re: /前の (\d+) 日間にこの端末で見せた点/g, constant: RECENT_PICK_DAYS },
];

const cache = new Map();
const read = (file) => {
  if (!cache.has(file)) cache.set(file, readFile(path.join(ROOT, file), 'utf8'));
  return cache.get(file);
};

/** ソースから定数の値を読む。見つからない・2 回以上書かれているときは null */
async function constantValue({ file, name }) {
  const source = await read(file);
  const found = [...source.matchAll(new RegExp(`\\b${name}\\s*[=:]\\s*(\\d[\\d_]*)\\b`, 'g'))];
  return found.length === 1 ? Number(found[0][1].replace(/_/g, '')) : null;
}

for (const { doc, re, constant } of CHECKS) {
  test(`${doc} の ${re.source} が ${constant.name} と同じ`, async () => {
    const value = await constantValue(constant);
    assert.notEqual(value, null, `${constant.file} に ${constant.name} = 数 が 1 回だけ書かれていない（定数の名前・置き場所を変えたら、この照合表も直す）`);
    const hits = [...(await read(doc)).matchAll(re)];
    assert.ok(hits.length > 0, `${doc} に ${re.source} に当たる文が無い（言い回しを変えたら、この照合表の正規表現も直す）`);
    for (const m of hits) {
      assert.equal(Number(m[1]), value, `${doc} の「${m[0]}」の ${m[1]} が ${constant.file} の ${constant.name} = ${value} と合わない（文書か定数のどちらかを直す）`);
    }
  });
}
