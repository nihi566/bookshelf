// 遠いものを結ぶ: 分野や本が遠いのに、根っこで同じことを言っているかもしれない点どうしを選び、AI に判定させる
//
// 似たものを束ねる（線・面）だけでは「想定内の答え」にしかならない。そこで、別の本・別の面にあって意味の近さが
// 低めの点の組を選び、AI に「共通する考えがあるか」を判定させる。あると判定した組だけを「遠いつながり」として残す。
//
// FarConnection = { id: 'f…', a, b, idea, explanation, foundAt }（a・b は点の ID。a < b）

import { hash, truncate } from '../text.js';
import { dot } from './vectors.js';

// 1 回の分析で AI に判定させる組の数（AI を呼ぶ回数の上限）と、残しておく遠いつながりの数
export const FAR_MAX_PAIRS = 10;
export const FAR_KEEP = 50;
// 候補を選ぶ代表の点の数の上限（組の数は代表の点の数の 2 乗で増えるので、点が 1 万件を超えても重くならないように）
export const FAR_MAX_REPS = 600;
// 候補にする近さの帯（別の本・別の面にある組の近さのうち、下から 15%〜45% の組。近すぎる組は線で足り、遠すぎる組はこじつけになる）
const BAND = [0.15, 0.45];
// 1 回の候補のうち、まだつながらない点を含む組に先に割り当てる数（全部をそれにすると、線どうしの組を試せなくなる）
const ISOLATED_SLOTS = Math.ceil(FAR_MAX_PAIRS / 2);
// AI への依頼がこの回数続けて失敗したら、残りの組は次の分析に回す（PC の AI が止まっているときに分析を長引かせない）
const MAX_FAILURES = 2;
// AI の答えがこの回数読めなかった組は、もう試さない（いつも同じ組が先頭に来て、ほかの組を試せなくならないように）
export const FAR_MAX_UNREADABLE = 2;
// 共通する考え・なぜつながるかの長さ（反応の記録も同じ長さで持つ）
export const IDEA_MAX = 40;
export const EXPLANATION_MAX = 300;

const FAR_ID = /^f[0-9a-z]{1,40}$/;
// 点の ID（ハイライトは 'h'、思いつきは 't' で始まる）
const POINT_ID = /^[ht][0-9a-z]{1,40}$/;
export const isFarId = (v) => typeof v === 'string' && FAR_ID.test(v);
export const isPointId = (v) => typeof v === 'string' && POINT_ID.test(v);

/** 2 点の組の ID（並びに依らない） */
export function farId(a, b) {
  return 'f' + hash([a, b].sort().join('|'));
}

/** AI やほかの端末から来た文を、1 行の短い文にする（制御文字を落とす。長い文は先に切ってから整える。文字の途中では切らない） */
export function farText(v, max) {
  const s = (typeof v === 'string' ? v.slice(0, max * 4) : '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200d\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(s, max);
}

/**
 * 候補を選ぶ代表の点を、上限までに絞る（同じ入力なら同じ結果）。線の代表を先に、残りをまだつながらない点で埋める。
 * まだつながらない点は、前に判定した組に入った回数が少ない点から（点が多いときも、いつかは全部の点を試す）
 * @param {{ id: string, isolated: boolean }[]} reps
 * @param {(id: string) => number} [judgedCount]
 */
export function pickReps(reps, judgedCount = () => 0, max = FAR_MAX_REPS) {
  const lines = reps.filter((r) => !r.isolated).slice(0, max);
  const isolated = reps
    .filter((r) => r.isolated)
    .map((r) => ({ r, n: judgedCount(r.id) }))
    .sort((x, y) => x.n - y.n || (x.r.id < y.r.id ? -1 : x.r.id > y.r.id ? 1 : 0))
    .slice(0, max - lines.length)
    .map((x) => x.r);
  return [...lines, ...isolated];
}

/**
 * 遠い組み合わせの候補を選ぶ（同じ入力なら同じ候補。乱数は使わない）
 * @param {object} p
 * @param {{ id: string, vector: Float32Array, plane: string|null, source: string, isolated: boolean }[]} p.reps
 *   代表の点（線の中心にいちばん近い点と、まだつながらない点。pickReps で絞ったもの）。plane は点の線が入っている面（まだつながらない点は null）
 * @param {(pair: { id: string, a: string, b: string }) => boolean} [p.skip] 候補にしない組（前に判定した組・反応を付けた組）
 * @param {number} [p.max]
 * @returns {{ id: string, a: string, b: string, sim: number }[]} 先頭の最大 5 組は、まだつながらない点を含む組（あれば）
 */
export function farCandidates({ reps: given, skip = () => false, max = FAR_MAX_PAIRS }) {
  const reps = given.slice(0, FAR_MAX_REPS);
  const n = reps.length;
  // 別の本（思いつきは 1 つずつ別）・別の面（まだつながらない点は、どの面とも別）の組の近さ。組を 1 つずつの物にはしない（重くなるため）
  const total = (n * (n - 1)) / 2;
  const ia = new Uint32Array(total);
  const ib = new Uint32Array(total);
  const sims = new Float64Array(total);
  let m = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = reps[i];
      const b = reps[j];
      if (a.source === b.source || (a.plane && a.plane === b.plane)) continue;
      ia[m] = i;
      ib[m] = j;
      sims[m] = dot(a.vector, b.vector);
      m++;
    }
  }
  if (!m) return [];
  const sorted = sims.slice(0, m).sort();
  const at = (r) => sorted[Math.min(m - 1, Math.floor(r * m))];
  const [lo, hi] = [at(BAND[0]), at(BAND[1])];
  const band = [];
  for (let k = 0; k < m; k++) {
    if (sims[k] < lo || sims[k] > hi) continue;
    const [x, y] = [reps[ia[k]], reps[ib[k]]];
    // 組の 2 点は ID の順（入力の並びに依らず、AI に見せる順も同じになる）
    const [a, b] = x.id < y.id ? [x.id, y.id] : [y.id, x.id];
    band.push({ a, b, sim: sims[k], isolated: x.isolated || y.isolated });
  }
  // 近い順（遠い組のうち、共通点がありそうなものから）。同じ近さなら ID の順
  band.sort((x, y) => y.sim - x.sim || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
  const used = new Set();
  const out = [];
  const take = (p) => {
    // 同じ点は 1 回の分析で 1 組まで（いろいろな点を試す）
    if (out.length >= max || used.has(p.a) || used.has(p.b)) return;
    const pair = { id: farId(p.a, p.b), a: p.a, b: p.b, sim: p.sim };
    if (skip(pair)) return;
    used.add(p.a);
    used.add(p.b);
    out.push(pair);
  };
  // まだつながらない点を含む組を先に（候補の半分まで）。残りを、まだつながらない点を含むかに関わらず近い順に
  for (const p of band) if (p.isolated && out.length < Math.min(max, ISOLATED_SLOTS)) take(p);
  for (const p of band) take(p);
  return out;
}

/**
 * AI の判定を整える。共通する考えとその説明がそろったときだけ「ある」、はっきり「ない」と答えたときだけ「ない」。
 * それ以外（shared が無い・「ある」なのに共通する考えが空など）は読めない答えとして null
 */
export function farVerdict(r) {
  const idea = farText(r?.idea, IDEA_MAX);
  const explanation = farText(r?.explanation, EXPLANATION_MAX);
  if ((r?.shared === true || r?.shared === 'true') && idea && explanation) return { shared: true, idea, explanation };
  if (r?.shared === false || r?.shared === 'false') return { shared: false };
  return null;
}

/**
 * 候補の組を 1 組ずつ AI に判定させる（AI を呼ぶのは候補の数まで）。依頼が失敗した組は判定しなかったことにして次の分析に回す
 * @param {object} p
 * @param {{ id: string, a: string, b: string }[]} p.candidates
 * @param {(pair: object) => object} p.promptOf 組 → チャットの依頼（prompts.js の farPrompt）
 * @param {(pair: object, verdict: object|null) => void} p.remember 判定を残す（同じ組を二度判定しないため。null は読めない答え）
 * @returns {Promise<{ found: object[], calls: number, error: string }>}
 */
export async function judgeFarPairs({ candidates, llm, promptOf, remember = () => {}, signal, onProgress = () => {}, now }) {
  const found = [];
  let calls = 0;
  // 続けて失敗した回数（1 組でも答えが返れば数え直す）
  let failures = 0;
  let error = '';
  for (const [i, c] of candidates.entries()) {
    if (signal?.aborted) throw new Error('分析を中止しました');
    onProgress({ stage: 'far', done: i, total: candidates.length, message: `遠い組み合わせを AI が読んでいます（${i + 1}/${candidates.length}）` });
    const prompt = promptOf(c);
    let answer;
    try {
      calls++;
      answer = await llm.chatJson({ ...prompt, signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      error = e.message;
      if (++failures >= MAX_FAILURES) break;
      continue;
    }
    failures = 0;
    const verdict = farVerdict(answer);
    remember(c, verdict);
    if (verdict?.shared) found.push({ id: c.id, a: c.a, b: c.b, idea: verdict.idea, explanation: verdict.explanation, foundAt: now });
  }
  onProgress({ stage: 'far', done: candidates.length, total: candidates.length, message: `遠いつながりを ${found.length} 組見つけました` });
  return { found, calls, error };
}

/** 遠いつながりとして使える形か（ほかの端末・バックアップから届いた分析の中のものを確かめる） */
export function isFarConnection(f) {
  const text = (v, max) => v == null || (typeof v === 'string' && v.length <= max);
  return Boolean(f) && typeof f === 'object' && isFarId(f.id) && isPointId(f.a) && isPointId(f.b) && f.id === farId(f.a, f.b) && text(f.idea, 200) && text(f.explanation, 2000) && text(f.foundAt, 40);
}

/** 遠いつながりを、決まった欄だけの新しい物にする（届いた物に余計な欄があっても持ち越さない） */
export function farConnectionOf(f) {
  return { id: f.id, a: f.a, b: f.b, idea: farText(f.idea, IDEA_MAX), explanation: farText(f.explanation, EXPLANATION_MAX), foundAt: typeof f.foundAt === 'string' ? f.foundAt : '' };
}

/**
 * 今回見つかった遠いつながりを前回までのものの前に積む（同じ組は 1 つに・点が消えた組は外す・最大 FAR_KEEP 件）。
 * 「ちがう」とした組は外さず、画面に出すときに隠す（far-reactions.js）。FAR_KEEP 件の数にも入れない
 * （新しい組に押し出されず、「ちがう」を取り消したらいつでもまた出せるように。増えるのは反応を付けた数まで）
 * @param {(id: string) => boolean} alive
 * @param {Set<string>} [wrong] 「ちがう」とした組の ID
 */
export function mergeFarConnections(found, previous = [], alive = () => true, wrong = new Set()) {
  const seen = new Set();
  const out = [];
  let kept = 0;
  for (const f of [...found, ...(Array.isArray(previous) ? previous : [])]) {
    if (!isFarConnection(f) || seen.has(f.id) || !alive(f.a) || !alive(f.b)) continue;
    if (!wrong.has(f.id)) {
      if (kept >= FAR_KEEP) continue;
      kept++;
    }
    seen.add(f.id);
    out.push(farConnectionOf(f));
  }
  return out;
}
