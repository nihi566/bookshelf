// PC（bh serve）が、人の操作なしに分析し直すかどうかの判断（判断だけ。時計・保存は呼び出し側）

// 既定: 前回の分析のあとに点が 10 件増えるか、24 時間たって 1 件以上増えたら分析する
export const AUTO_DEFAULTS = { enabled: true, minPoints: 10, maxHours: 24 };
// 自動の分析が失敗したあと、次に試すまで待つ時間（LLM が止まっているときに試し続けない）
export const AUTO_RETRY_MS = 30 * 60 * 1000;
// 分析に要る点の数（analyzeLibrary と同じ）
const MIN_POINTS = 4;

/** 前回の分析に入っていない点（どの線にも「まだつながらない点」にも無い点）。前回が無ければすべて（形の壊れた分析も無いものとして扱う） */
export function pendingPointList(points, analysis) {
  if (!analysis || !Array.isArray(analysis.lines)) return points;
  const ids = (xs) => (Array.isArray(xs) ? xs.filter((x) => typeof x === 'string') : []);
  const seen = new Set([...analysis.lines.flatMap((l) => ids(l?.highlightIds)), ...ids(analysis.isolated)]);
  return points.filter((p) => !seen.has(p.id));
}

/** 前回の分析に入っていない点の数（pendingPointList の件数） */
export function pendingPoints(points, analysis) {
  return pendingPointList(points, analysis).length;
}

/** 数として読める値か（null・空文字・真偽値は既定値に戻す。Number(null) が 0 になるため） */
function readNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

/** 設定の値を確かめて既定値で埋める（bh config で変えた値・手で直した config.json・古い版の設定） */
export function autoConfig(c = {}) {
  const num = (v, d, ok) => (Number.isFinite(readNumber(v)) && ok(readNumber(v)) ? readNumber(v) : d);
  const off = [false, 0, 'false', 'off', '0'].includes(c?.enabled);
  return { enabled: !off, minPoints: num(c?.minPoints, AUTO_DEFAULTS.minPoints, (n) => n >= 1), maxHours: num(c?.maxHours, AUTO_DEFAULTS.maxHours, (n) => n > 0) };
}

/** 時刻から now までの経過（未来の時刻は 0 として扱わず、待たない: 端末の時計を戻したときに待たされ続けないように） */
function elapsed(now, iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) && t <= now ? now - t : Infinity;
}

/**
 * 自動の分析を始めるか。
 * - 前回の分析のあとに点が minPoints 件以上増えた / 前回から maxHours 時間以上たって 1 件以上増えた
 * - 前回の分析が失敗してから AUTO_RETRY_MS たっていなければ待つ（次の機会に試し直す）
 * - 利用者が分析を中止してから AUTO_RETRY_MS たっていなければ待つ（止めた直後に始め直さない）
 * @param {{ points: {id:string}[], analysis: object|null, config?: object, now?: Date, lastFailureAt?: string|null, lastCancelledAt?: string|null }} p
 * @returns {{ due: boolean, pending: number, reason: string }}
 */
export function autoAnalyzeDue({ points, analysis, config, now = new Date(), lastFailureAt = null, lastCancelledAt = null }) {
  const c = autoConfig(config);
  const pending = pendingPoints(points, analysis);
  const at = now.valueOf();
  if (!c.enabled) return { due: false, pending, reason: '自動の分析は切ってあります' };
  if (points.length < MIN_POINTS) return { due: false, pending, reason: `点が ${MIN_POINTS} 件未満です` };
  if (!pending) return { due: false, pending, reason: '前回の分析のあとに増えた点はありません' };
  if (elapsed(at, lastFailureAt) < AUTO_RETRY_MS) return { due: false, pending, reason: '前回の分析が失敗したので、少し待ってから試し直します' };
  if (elapsed(at, lastCancelledAt) < AUTO_RETRY_MS) return { due: false, pending, reason: '分析を中止したので、少し待ってから始めます' };
  const since = elapsed(at, analysis?.createdAt);
  const hours = since === Infinity ? Infinity : since / 3_600_000;
  if (pending >= c.minPoints) return { due: true, pending, reason: `前回の分析のあとに点が ${pending} 件増えました` };
  if (hours >= c.maxHours) return { due: true, pending, reason: `前回の分析から ${Number.isFinite(hours) ? Math.floor(hours) : '–'} 時間たち、点が ${pending} 件増えました` };
  return { due: false, pending, reason: `点が ${c.minPoints} 件増えるか、前回から ${c.maxHours} 時間たつと分析します` };
}
