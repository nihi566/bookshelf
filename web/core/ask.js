// 知識と対話する（G8）: 意味で探す・問いかける
//
// - 意味で探す: 点（分析の点 = 技術書を除くハイライトと、捨てていないメモ）と永久ノートを、質問の埋め込みとの近さの順に返す
// - 問いかける: 質問に近い点を最大 8 件集め、ローカル LLM が点だけを根拠に日本語で答える。答えには根拠の点の番号が付く。
//   いちばん近い点でも近さが足りなければ、AI を呼ばずに「手元の点からは答えられない」と返す（AI に答えを作らせない）
// 埋め込み・チャットは引数で受け取る（PC の bh serve がローカル LLM を渡す。テストは偽の LLM を渡す）

import { analysisPoints, embedText, pointById, pointLabel } from './points.js';
import { liveNotes } from './notes.js';
import { cleanText, hash, sliceChars, truncate } from './text.js';
import { dot } from './analysis/vectors.js';
import { farText } from './analysis/far.js';

// 意味で探すときに返す数
export const SEARCH_LIMIT = 30;
// 問いかけで集める点の数
export const ASK_MAX_POINTS = 8;
// 問いかけで答えるのに要る近さ（いちばん近い点がこれ未満なら答えない）と、根拠に入れる点の近さ。
// bge-m3 と実データ（点 1,811 件）で決めた: 本の内容を聞いた質問は 12 問中 11 問で 1 位が 0.64〜0.86、
// 本に無いこと（天気・料理など）を聞いた質問は 8 問すべて 0.55 以下だった
export const ASK_MIN_SIMILARITY = 0.58;
export const ASK_CONTEXT_SIMILARITY = 0.5;
// 質問・答えの長さ
export const QUESTION_MAX = 300;
export const ANSWER_MAX = 1200;
// 1 回の探す・問いかけるで、その場で埋め込む数の上限（分析していない・埋め込みモデルを変えた直後に、全部を埋め込んで待たせない。
// 点は分析のときに埋め込むので、ふだんは分析のあとに増えた点とノートだけ）
export const EMBED_ON_DEMAND_MAX = 200;
// 使わなくなったベクトル（文を直した・消した点とノート）を捨てるのは、これだけたまってから
const PRUNE_SLACK = 100;
// 依頼文に入れる点 1 件の長さ（小さなモデルの読める長さを超えないように）
const POINT_TEXT_MAX = 300;

/** 関係する点が見つからなかったときの答え（G8-3） */
export const NO_ANSWER = '手元の点からは答えられない質問でした（関係する点が見つかりませんでした）。';

/** 質問・探す言葉を整える（1 行にし、制御文字を落とし、長さを切る） */
export const cleanQuery = (v) => farText(v, QUESTION_MAX);

/** 点の位置（書名と並べて出す。位置もページも無ければ空） */
export function placeText(p) {
  if (p?.location != null && p.location !== '') return `位置 ${p.location}`;
  return p?.page ? `p.${p.page}` : '';
}

/**
 * 意味で探す相手（点と永久ノート）と、埋め込む文。点の文は分析と同じ（分析のキャッシュのベクトルをそのまま使える）
 * @returns {{ id: string, kind: 'point'|'note', text: string }[]}
 */
export function searchTargets(library) {
  return [
    ...analysisPoints(library).map((p) => ({ id: p.id, kind: 'point', text: embedText(p) })),
    ...liveNotes(library).map((n) => ({ id: n.id, kind: 'note', text: [n.title, n.body].filter(Boolean).join('\n') })),
  ];
}

const byScore = (a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * 質問のベクトルに近い順（同じ近さは ID の順）。ベクトルの無い相手は飛ばす
 * @returns {{ id: string, kind: string, score: number }[]}
 */
export function rankByVector(queryVector, items, vectorOf, limit = SEARCH_LIMIT) {
  const scored = [];
  for (const it of items) {
    const v = vectorOf(it);
    if (v) scored.push({ id: it.id, kind: it.kind, score: dot(queryVector, v) });
  }
  return scored.sort(byScore).slice(0, limit);
}

/**
 * 点と永久ノートのベクトルを持つ（PC の bh serve が埋め込みモデルごとに 1 つ持つ）。
 * 分析のキャッシュのベクトルを使い（seed）、無いもの・文が変わったものだけを埋め込む。今の点・ノートに無いベクトルは捨てる
 * @param {{ embed: (texts: string[], opts?: object) => Promise<Float32Array[]>, model: string }} p
 */
export function createSemanticIndex({ embed, model }) {
  const vectors = new Map();
  const keyOf = (it) => `${it.kind}:${it.id}:${hash(it.text)}`;
  // 同時に来た問い合わせは順にそろえる（同じ点・ノートを 2 回埋め込まない。あとの問い合わせは先の分を使う）
  let chain = Promise.resolve();
  const inTurn = (fn) => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };
  return {
    model,
    /** 分析のキャッシュ（cache.embeddings。同じモデルで、同じ文を埋め込んだもの）のベクトルを使えるようにする */
    seed(embeddings, items) {
      if (!embeddings || embeddings.model !== model) return 0;
      let n = 0;
      for (const it of items) {
        if (it.kind !== 'point') continue;
        const v = Object.hasOwn(embeddings.vectors || {}, it.id) ? embeddings.vectors[it.id] : null;
        if (v && embeddings.keys?.[it.id] === hash(it.text)) {
          vectors.set(keyOf(it), v);
          n++;
        }
      }
      return n;
    },
    /** 相手すべてのベクトルをそろえ、引く関数を返す。埋め込んでいないものが多すぎれば、先に分析するよう断る */
    vectorsFor: (items, opts) => inTurn(() => ensure(items, opts)),
    embedQuery: async (text, opts) => (await embed([text], opts))[0],
    get size() {
      return vectors.size;
    },
  };

  async function ensure(items, { maxNew = EMBED_ON_DEMAND_MAX, ...opts } = {}) {
    const keys = items.map(keyOf);
    const missing = items.filter((_, i) => !vectors.has(keys[i]));
    // 数えるのは点だけ（永久ノートは分析では埋め込まないので、いつもその場で埋め込む）
    const missingPoints = missing.filter((it) => it.kind === 'point').length;
    if (missingPoints > maxNew) {
      throw Object.assign(new Error(`PC でまだ埋め込んでいない点が ${missingPoints} 件あります。先に知識の画面で分析してください（分析で点を埋め込みます）`), { code: 'needs-analysis' });
    }
    if (missing.length) {
      const vs = await embed(missing.map((it) => it.text), opts);
      missing.forEach((it, i) => vectors.set(keyOf(it), vs[i]));
    }
    // 今の点・ノートに無いベクトルは、たまってから捨てる（問い合わせのたびに捨てると、同時に来た別の問い合わせの分まで消しかねない）
    if (vectors.size > keys.length + PRUNE_SLACK) {
      const live = new Set(keys);
      for (const k of [...vectors.keys()]) if (!live.has(k)) vectors.delete(k);
    }
    return (it) => vectors.get(keyOf(it));
  }
}

/** 意味で探す（G8-1）。近い順に点と永久ノートの ID と近さ */
export async function semanticSearch({ library, query, index, limit = SEARCH_LIMIT, signal }) {
  const q = cleanQuery(query);
  if (!q) return [];
  const items = searchTargets(library);
  const vectorOf = await index.vectorsFor(items, { signal });
  return rankByVector(await index.embedQuery(q, { signal }), items, vectorOf, limit);
}

/** 問いかけに使う点（いちばん近い点が minSimilarity 未満なら、答えられないので空） */
export function askContext(ranked, { minSimilarity = ASK_MIN_SIMILARITY, contextSimilarity = ASK_CONTEXT_SIMILARITY, max = ASK_MAX_POINTS } = {}) {
  const points = ranked.filter((r) => r.kind === 'point');
  if (!points.length || points[0].score < minSimilarity) return [];
  return points.filter((r) => r.score >= contextSimilarity).slice(0, max);
}

/**
 * 問いかけの依頼文。点は [1] から番号を付け、書名と位置を添える
 * @param {{ text: string, note?: string, book: string, place: string }[]} points
 */
export function askPrompt(question, points) {
  const list = points
    .map((p, i) => {
      // 書名と位置も 1 行に整えて短く切る（同期で届いた長い書名・改行で、依頼文を長くしたり偽の番号の行を作らせない）
      const where = [farText(p.book, 40), farText(p.place, 20)].filter(Boolean).join('・');
      return `[${i + 1}] ${truncate(p.text.replace(/\s+/g, ' '), POINT_TEXT_MAX)}${p.note ? `（読者のメモ: ${truncate(p.note.replace(/\s+/g, ' '), 120)}）` : ''}${where ? `（${where}）` : ''}`;
    })
    .join('\n');
  return {
    name: 'answer',
    system:
      'あなたは読者の読書の記録をもとに質問に答える助手です。渡された点（読者が本に引いた線と、読者のメモ）だけを根拠に、日本語で簡潔に答えます。' +
      '点に書かれていないことは足さず、推測もしません。根拠にした点の番号を [1] のように文中に添えます。点から答えられないときは answerable を false にします。',
    user: `質問: ${question}\n\n点:\n${list}\n\n次の JSON だけを出力してください: {"answerable": true または false, "answer": "答え（400 字以内）", "used": [根拠にした点の番号]}`,
    schema: {
      type: 'object',
      properties: { answerable: { type: 'boolean' }, answer: { type: 'string' }, used: { type: 'array', items: { type: 'integer' } } },
      required: ['answerable', 'answer', 'used'],
      additionalProperties: false,
    },
  };
}

/** 番号として読めるもの（数か、数字だけの文字列。true などを 1 番にしない。骨組みの答えでも使う） */
export const asNumber = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,2}$/.test(v.trim()) ? Number(v) : NaN);

/**
 * AI の答えを読む。答えられるのは answerable が true（構造化出力が使えないサーバでは "true" の文字）のときだけ
 * （読めない答えは答えない側に倒す。点に無いことを答えさせない最後の関門）。根拠の番号は、used と文中の [n] のうち、渡した点の番号に当たるものだけ
 */
export function readAnswer(r, count) {
  const answer = sliceChars(cleanText(typeof r?.answer === 'string' ? r.answer.slice(0, ANSWER_MAX * 4) : ''), ANSWER_MAX);
  const nums = [...(Array.isArray(r?.used) ? r.used : []), ...[...answer.matchAll(/\[(\d{1,2})\]/g)].map((m) => m[1])].map(asNumber);
  const used = [...new Set(nums.filter((n) => Number.isInteger(n) && n >= 1 && n <= count))].sort((a, b) => a - b);
  const yes = r?.answerable === true || (typeof r?.answerable === 'string' && r.answerable.trim().toLowerCase() === 'true');
  return { answerable: yes && Boolean(answer), answer, used };
}

/** 前に問いかけた答えを保存したメモか（AI が書いた文なので、次の答えの根拠や骨組みの引用にはしない。点としては残る） */
export const isAskAnswer = (library, id) => pointById(library, id)?.answerTo?.kind === 'ask';

/**
 * 問いかける（G8-2・G8-3）
 * @returns {Promise<{ question: string, answerable: boolean, answer: string, citations: { n: number, id: string }[], cited?: boolean }>}
 *   citations の n は答えの中の [n]、id は根拠の点の ID。cited: false は、AI が根拠の番号を示さなかったので、渡した点をすべて並べたもの
 */
export async function askLibrary({ library, question, index, chatJson, minSimilarity, contextSimilarity, signal }) {
  const q = cleanQuery(question);
  if (!q) throw new Error('質問を入れてください');
  const items = searchTargets(library);
  const vectorOf = await index.vectorsFor(items, { signal });
  const candidates = items.filter((it) => it.kind === 'point' && !isAskAnswer(library, it.id));
  const ranked = rankByVector(await index.embedQuery(q, { signal }), candidates, vectorOf, ASK_MAX_POINTS * 2);
  const context = askContext(ranked, { minSimilarity, contextSimilarity });
  const none = { question: q, answerable: false, answer: '', citations: [] };
  if (!context.length) return none;
  const points = context.map((r) => pointById(library, r.id));
  const r = await chatJson({ ...askPrompt(q, points.map((p) => ({ text: p.text, note: p.userNote || p.note || '', book: pointLabel(library, p), place: placeText(p) }))), signal });
  const a = readAnswer(r, points.length);
  if (!a.answerable) return none;
  const cited = a.used.length > 0;
  const used = cited ? a.used : points.map((_, i) => i + 1);
  return { question: q, answerable: true, answer: a.answer, citations: used.map((n) => ({ n, id: context[n - 1].id })), cited };
}

/** 答えをメモとして残す文（答えと、根拠の点の書名・位置。G8-4）。根拠の番号が無かった答えは「AI に渡した点」と書く */
export function answerMemoText(library, result) {
  const sources = result.citations
    .map(({ n, id }) => {
      const p = pointById(library, id);
      return p ? `[${n}] ${[pointLabel(library, p), placeText(p)].filter(Boolean).join('・')}` : '';
    })
    .filter(Boolean);
  return sources.length ? `${result.answer}\n\n${result.cited === false ? 'AI に渡した点' : '根拠'}: ${sources.join(' / ')}` : result.answer;
}
