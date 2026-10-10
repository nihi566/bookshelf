// 分析の履歴から、前の分析に戻す（NIH-7）

/**
 * 履歴の 1 回分を、今の時刻の分析にする。
 * - createdAt を今にする（ほかの端末に残っている、戻す前の新しい分析に同期で負けないように。履歴にも 1 回分として残る）
 * - restoredFrom に元の回の時刻を残す（戻した回をもう一度戻しても、最初の回の時刻のまま）
 * - changes は持たない（元の回の「前回からの変化」は、戻した今の変化ではない）
 * - おすすめを選んだ時刻は元のまま（おすすめの日付が、戻した日にならないように）
 * @param {object} entry 履歴の 1 回分（形は確かめてあるもの）
 * @param {string} now ISO 形式の今の時刻
 * @returns {object}
 */
export function restoreAnalysis(entry, now) {
  return {
    ...entry,
    createdAt: now,
    recommendedAt: entry.recommendedAt || entry.createdAt,
    restoredFrom: entry.restoredFrom || entry.createdAt,
    changes: null,
  };
}
