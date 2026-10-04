// 分析結果の形を確かめる（ほかの端末・バックアップから届いた分析を、前回の結果・履歴・件数の計算に使う前に）
//
// 届いた分析が壊れていると、前回の結果として読んだ分析が毎回失敗し、PC の状態（/api/info）も返せなくなる。
// ここでは中身の正しさまでは見ず、使う場所が前提にしている形（配列・文字列）だけを確かめる。

const isStr = (v, max = 200) => typeof v === 'string' && v.length <= max;
const isIdList = (v) => Array.isArray(v) && v.every((x) => isStr(x, 80));

// 分析した時刻として受け入れる範囲（未来すぎる時刻は、端末の時計のずれでも履歴の順番を壊すので受け入れない）
const FUTURE_TOLERANCE_MS = 24 * 3600 * 1000;

/** 分析した時刻として使える ISO 形式の文字列か */
export function isAnalysisTime(v, now = Date.now()) {
  if (!isStr(v, 40) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v)) return false;
  const t = Date.parse(v);
  return Number.isFinite(t) && t <= now + FUTURE_TOLERANCE_MS;
}

/**
 * 分析結果として使える形か。だめなら理由（画面・API で返す）を、よければ空文字を返す
 * @returns {string}
 */
export function analysisShapeError(a, now = Date.now()) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return '分析結果の形ではありません';
  if (!isAnalysisTime(a.createdAt, now)) return '分析した時刻（createdAt）の形が違います';
  if (a.recommendedAt != null && !isAnalysisTime(a.recommendedAt, now)) return 'おすすめを選んだ時刻（recommendedAt）の形が違います';
  if (a.version != null && !Number.isInteger(a.version)) return '分析の版（version）の形が違います';
  if (!Array.isArray(a.lines) || !a.lines.every((l) => l && typeof l === 'object' && isStr(l.id, 80) && isIdList(l.highlightIds))) return '線（lines）の形が違います';
  if (!Array.isArray(a.planes) || !a.planes.every((p) => p && typeof p === 'object' && isStr(p.id, 80) && isIdList(p.lineIds))) return '面（planes）の形が違います';
  if (a.isolated != null && !isIdList(a.isolated)) return 'まだつながらない点（isolated）の形が違います';
  if (!a.solid || typeof a.solid !== 'object' || Array.isArray(a.solid)) return '立体（solid）の形が違います';
  return '';
}

export const isAnalysisShape = (a, now) => !analysisShapeError(a, now);
