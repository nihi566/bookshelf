// PC（bh serve）が、人の操作なしに分析し直すかどうかの判断（判断だけ。時計・保存は呼び出し側）
import { isUneditedLineDraft, notesForAnalysis, notesOf } from './notes.js';
import { humanLine } from './analysis/prompts.js';
import { hash } from './text.js';

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

/**
 * 分析に渡した永久ノートの指紋（面・立体の指紋に入るのと同じ文から作る。ノートが無ければ空文字）。
 * notes は notesForAnalysis の結果
 */
export function notesKey(notes) {
  if (!notes.length) return '';
  // 根拠の点も入れる（点を付け替えると、ノートを見せる面が変わる）
  return hash(notes.map((n) => `${n.id}:${hash(humanLine(n))}:${hash((n.pointIds || []).join(','))}`).sort().join('|'));
}

/**
 * 前回の分析のあとに、AI に渡す永久ノートを書いた・直した・消したか（NIH-83）。
 * 指紋を持つ分析は指紋で比べる（分析の最中に直したノートも拾う）。持たない古い分析は、分析の時刻より後に直したノートがあるかで見る
 */
export function notesChanged(library, analysis) {
  if (!analysis || !Array.isArray(analysis.lines)) return false;
  if (typeof analysis.notesKey === 'string') return analysis.notesKey !== notesKey(notesForAnalysis(library));
  const since = Date.parse(analysis.createdAt || '');
  if (!Number.isFinite(since)) return false;
  return Object.values(notesOf(library)).some((n) => n && !isUneditedLineDraft(n) && Date.parse(n.updatedAt || '') > since);
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
 * - 前回の分析のあとに点が minPoints 件以上増えた / 前回から maxHours 時間以上たって、点が 1 件以上増えたか永久ノートを書いた・直した
 * - 前回の分析が失敗してから AUTO_RETRY_MS たっていなければ待つ（次の機会に試し直す）
 * - 利用者が分析を中止してから AUTO_RETRY_MS たっていなければ待つ（止めた直後に始め直さない）
 * @param {{ points: {id:string}[], analysis: object|null, config?: object, now?: Date, lastFailureAt?: string|null, lastCancelledAt?: string|null, notesChanged?: boolean }} p
 *   notesChanged: 前回の分析のあとに永久ノートを書いた・直したか（notesChanged() の結果）
 * @returns {{ due: boolean, pending: number, reason: string }}
 */
export function autoAnalyzeDue({ points, analysis, config, now = new Date(), lastFailureAt = null, lastCancelledAt = null, notesChanged: notes = false }) {
  const c = autoConfig(config);
  const pending = pendingPoints(points, analysis);
  const at = now.valueOf();
  if (!c.enabled) return { due: false, pending, reason: '自動の分析は切ってあります' };
  if (points.length < MIN_POINTS) return { due: false, pending, reason: `点が ${MIN_POINTS} 件未満です` };
  if (!pending && !notes) return { due: false, pending, reason: '前回の分析のあとに増えた点も、書いた・直した永久ノートもありません' };
  if (elapsed(at, lastFailureAt) < AUTO_RETRY_MS) return { due: false, pending, reason: '前回の分析が失敗したので、少し待ってから試し直します' };
  if (elapsed(at, lastCancelledAt) < AUTO_RETRY_MS) return { due: false, pending, reason: '分析を中止したので、少し待ってから始めます' };
  const since = elapsed(at, analysis?.createdAt);
  const hours = since === Infinity ? Infinity : since / 3_600_000;
  if (pending >= c.minPoints) return { due: true, pending, reason: `前回の分析のあとに点が ${pending} 件増えました` };
  if (hours >= c.maxHours) {
    const what = [pending ? `点が ${pending} 件増えました` : '', notes ? '永久ノートを書いた・直しました' : ''].filter(Boolean).join('。');
    return { due: true, pending, reason: `前回の分析から ${Number.isFinite(hours) ? Math.floor(hours) : '–'} 時間たち、${what}` };
  }
  // 永久ノートは、書いている途中で分析が始まらないように、前回から maxHours たつまで待つ（点の数の条件には数えない）
  if (!pending) return { due: false, pending, reason: `書いた・直した永久ノートは、前回から ${c.maxHours} 時間たつと分析に入れます` };
  return { due: false, pending, reason: `点が ${c.minPoints} 件増えるか、前回から ${c.maxHours} 時間たつと分析します` };
}
