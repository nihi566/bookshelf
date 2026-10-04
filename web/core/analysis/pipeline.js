// 「点 → 線 → 面 → 立体」の分析パイプライン
//
// 1. 点: ハイライトを埋め込みベクトルにする（埋め込みモデルが無ければ文字 n-gram の TF-IDF）
// 2. 線: 似た点をクラスタリングし、LLM が共通する考えを抽象化して名前と説明を付ける
// 3. 面: 線をクラスタリングし、LLM がテーマとしてまとめる
// 4. 立体: LLM が面どうしの関係・核となる考え・原則・問いを組み立てる
// 5. おすすめ: 立体と「問い」をもとに LLM が次の本を選び、書誌 DB で実在を確認する
//
// 前回の分析（previous）を渡すと、線・面を引き継いで（ID を保って）点の増減だけを反映する（incremental.js）。
// 線・面・立体は「顔ぶれの指紋（sig）」が前回と同じなら AI を呼ばずに前回の結果を使い、変わったところだけ作り直す。
// LLM の結果は指紋でキャッシュもするので、前回の結果が無くても同じ顔ぶれなら呼び直さない。

import { feedbackByStatus } from '../model.js';
import { analysisPoints, embedText, isThought, legacyEmbedText, pointLabel } from '../points.js';
import { bookKey, hash } from '../text.js';
import { PROMPT_VERSION, RECOMMEND_KINDS, RELATION_TYPES, linePrompt, pickPrompt, planePrompt, recommendPrompt, searchPrompt, solidPrompt } from './prompts.js';
import { centroid, dot, l2normalize, tfidfEmbed } from './vectors.js';
import { carryLines, carryPlanes } from './incremental.js';
import { diffAnalyses } from './changes.js';
import { findDiscoveries, mergeDiscoveries } from './discoveries.js';
import { EMBED_BATCH_SIZE } from './llm.js';
import { isAnalysisShape } from './shape.js';
import { searchBooks, verifyBooks } from './recommend.js';
import { titleKey, wishlistForRecommend } from '../wishlist.js';

// おすすめの候補に混ぜる欲しい本の冊数（多すぎると小さなモデルが選びきれない）
const WISHLIST_CANDIDATES = 8;

// 2: 線を小さくした（点 8 件で線 1 本・上限 400 本）。前の版の分析は引き継がず、最初から作り直す
export const ANALYSIS_VERSION = 2;

// 点いくつで線 1 本にするかの目安と、線の数の上限。線が大きくなりすぎると「1 ノート = 1 アイデア」から離れ、
// AI も中心の 12 点しか見ないので、ぼやけた概念になる（点 1,000 件で 1 本の点の数の中央値が 10 以下になるようにした）
export const LINE_TARGET_SIZE = 8;
export const MAX_LINES = 400;
// 面の数の上限と、面を作る AI に見せる線の数（面の中心に近い線から）
export const MAX_PLANES = 12;
export const PLANE_SAMPLE_SIZE = 12;
// 1 本の線に入れる点の上限（目安の 2.5 倍。増えた点を加えるときもこれを超えない）
const lineMaxSize = (target) => Math.ceil(target * 2.5);
// 前回最初から作り直したときから点がこれだけ増えたら、引き継がずに作り直す（小さいうちの線・面の形に縛られ続けないように）
const REBUILD_GROWTH = 1.5;
const REBUILD_MIN_ADDED = 40;

// 埋め込みモデル無し（文字 n-gram）で分析したときの案内。実データ（点 920）で試すと、ありふれた言葉を共有する点が
// 1 本の線に集まり、面の名前も「知識の〜」ばかりになった。bge-m3 にすると面がテーマごとに分かれた
export const TFIDF_HINT = '埋め込みモデルを使わず、文字の並びだけで点をつないでいます。ありふれた言葉でつながりやすく、面の名前が似通いがちです。PC で ollama pull bge-m3 を実行し、埋め込みモデルに bge-m3 を設定すると、意味の近さでつなげます。';

// embeddings.keys: 点ごとに、埋め込んだ文のハッシュ（自分のメモ・タグを書き換えた点だけ埋め込み直すため）
export function emptyCache() {
  return { embeddings: { model: '', vectors: {}, keys: {} }, llm: {} };
}

// 線を作る AI に見せる点の数（中心に近い点から）
export const LINE_SAMPLE_SIZE = 12;

/**
 * 線を作る AI に見せる点を選ぶ。ordered は線の点（中心に近い順）。
 * お気に入りの点を優先して入れ、残りを中心に近い順に足して max 件。並びは中心に近い順のまま
 */
export function lineSample(ordered, isFavorite, max = LINE_SAMPLE_SIZE) {
  const fav = ordered.filter(isFavorite).slice(0, max);
  const rest = ordered.filter((i) => !isFavorite(i)).slice(0, max - fav.length);
  const chosen = new Set([...fav, ...rest]);
  return ordered.filter((i) => chosen.has(i));
}

/** AI に渡す点の形（prompts.js の pointLine） */
function promptPoint(library, p) {
  return { text: p.text, label: pointLabel(library, p), thought: isThought(p), note: p.note || '', userNote: p.userNote || '', tags: p.tags || [] };
}

/**
 * @param {object} p
 * @param {object} p.library
 * @param {object} p.llm        createLlmClient() の戻り値
 * @param {object} [p.cache]    emptyCache() 形式。呼び出し側で保存すると次回が速い
 * @param {object} [p.previous] 前回の分析結果。渡すと線・面を引き継ぎ、変わったところだけ AI を呼ぶ
 * @param {function} [p.onProgress] ({ stage, done, total, message }) => void
 * @param {AbortSignal} [p.signal]
 * @param {object} [p.options]  { granularity: 点いくつで線 1 本か (既定 8), maxLines, maxPlanes, full: 前回を引き継がず最初から作り直す,
 *                                recommend: true / false / 'keep'（前回のおすすめを残す。自動の分析は欲しい本の印を知らないため）,
 *                                verify: bool, fetchImpl, wishlist: toRecommendWishlist() の結果 }
 */
export async function analyzeLibrary({ library, llm: rawLlm, cache = emptyCache(), previous: rawPrevious = null, onProgress = () => {}, signal, options = {} }) {
  // 形の壊れた前回の結果（ほかの端末・バックアップから届いたもの）は使わない（毎回の失敗にしない）
  const previous = rawPrevious && isAnalysisShape(rawPrevious) ? rawPrevious : null;
  const { granularity = LINE_TARGET_SIZE, maxLines = MAX_LINES, maxPlanes = MAX_PLANES, full = false, recommend = true, verify = true, recommendCount = 6, fetchImpl, wishlist } = options;
  // 点 = 本に引いた線（技術書は除く）+ 思いつき（捨てたものは除く）
  const points = analysisPoints(library);
  if (points.length < 4) throw new Error(`点（ハイライト・思いつき）が ${points.length} 件しかありません。4 件以上取り込んでから分析してください。`);
  const check = () => {
    if (signal?.aborted) throw new Error('分析を中止しました');
  };
  // 線・面・立体を作るために AI を呼んだ回数（おすすめの本は数えない）。変わったところだけ呼んだかを結果に残す
  const calls = { chat: 0, embed: 0 };
  const llm = {
    ...rawLlm,
    chatJson: (p) => (calls.chat++, rawLlm.chatJson(p)),
    // 埋め込みは 1 回の依頼で EMBED_BATCH_SIZE 件ずつ送るので、依頼の数で数える（中の言い直しは数えない）
    embed: (texts, o) => (calls.embed += Math.max(1, Math.ceil(texts.length / EMBED_BATCH_SIZE)), rawLlm.embed(texts, o)),
  };

  // 1. 点 → ベクトル（自分のメモ・タグも入れる。書き換えた点だけ埋め込み直す）
  const texts = points.map(embedText);
  const textKeys = texts.map((t) => hash(t));
  const textKeyById = new Map(points.map((p, i) => [p.id, textKeys[i]]));
  let vectors;
  let embedMethod;
  if (llm.embedModel) {
    if (cache.embeddings.model !== llm.embedModel) cache.embeddings = { model: llm.embedModel, vectors: {}, keys: {} };
    const emb = cache.embeddings;
    emb.keys = emb.keys || {};
    // 文のハッシュを持たない前の版のキャッシュは、前の版と同じ文（自分のメモ・タグが無い点）なら使い続ける
    const fresh = (i) => Boolean(emb.vectors[points[i].id]) && (emb.keys[points[i].id] ?? hash(legacyEmbedText(points[i]))) === textKeys[i];
    const missing = points.map((_, i) => i).filter((i) => !fresh(i));
    onProgress({ stage: 'embed', done: 0, total: missing.length, message: `点をベクトル化しています（${llm.embedModel}）` });
    if (missing.length) {
      const vecs = await llm.embed(
        missing.map((i) => texts[i]),
        { signal, onProgress: (done, total) => onProgress({ stage: 'embed', done, total, message: '点をベクトル化しています' }) },
      );
      missing.forEach((i, j) => (emb.vectors[points[i].id] = vecs[j]));
    }
    points.forEach((p, i) => (emb.keys[p.id] = textKeys[i]));
    vectors = points.map((p) => emb.vectors[p.id]);
    embedMethod = llm.embedModel;
  } else {
    onProgress({ stage: 'embed', done: 0, total: 1, message: '点をベクトル化しています（文字 n-gram）' });
    vectors = tfidfEmbed(texts);
    embedMethod = 'tfidf';
  }
  check();

  // 前回の結果を引き継げるか（同じ版の分析で、同じ方法で埋め込んだとき。違えば最初から作り直す）。
  // 前回最初から作り直したときから点が 1.5 倍（かつ 40 件以上）に増えていたら作り直す（小さいうちの形に縛られ続けない）
  const pointsAtFull = Number.isFinite(previous?.pointsAtFull) ? previous.pointsAtFull : previous?.stats?.points || 0;
  const grew = points.length >= Math.max(pointsAtFull * REBUILD_GROWTH, pointsAtFull + REBUILD_MIN_ADDED);
  const base = !full && !grew && previous?.version === ANALYSIS_VERSION && previous.model?.embed === embedMethod ? previous : null;
  const prevLines = new Map((base?.lines || []).map((l) => [l.id, l]));
  const prevPlanes = new Map((base?.planes || []).map((p) => [p.id, p]));

  // 2. 点 → 線（前回の線を引き継ぎ、増えた点は近い線に加える）
  const { lines: groups, isolated } = carryLines({ ids: points.map((p) => p.id), vectors, previousLines: base?.lines || [], previousIsolated: base?.isolated || [], targetSize: granularity, maxSize: lineMaxSize(granularity), maxGroups: maxLines });
  const lines = [];
  const used = new Set();
  for (let gi = 0; gi < groups.length; gi++) {
    check();
    const { members } = groups[gi];
    const c = centroid(members.map((i) => vectors[i]));
    // プロンプトには中心に近い点から最大 12 件（お気に入りの点は優先して入れる）
    const ordered = [...members].sort((a, b) => dot(vectors[b], c) - dot(vectors[a], c));
    const chosen = lineSample(ordered, (i) => Boolean(points[i].favorite));
    const ids = ordered.map((i) => points[i].id);
    // 指紋: 点の顔ぶれと文（自分のメモ・タグを含む）・AI に見せる点（★を付け替えたなど）・モデル・プロンプトの版
    // 見せた点は並べ替えてから入れる（文字 n-gram では点が増えるたびに中心への近さの順が少し入れ替わるため）
    const sig = 'line:' + hash([PROMPT_VERSION, rawLlm.chatModel, ...ids.map((id) => `${id}:${textKeyById.get(id)}`).sort(), '|見せた点|', ...chosen.map((i) => points[i].id).sort()].join('|'));
    let id = groups[gi].id || 'l' + hash([...ids].sort().join('|'));
    if (used.has(id)) id += gi.toString(36);
    used.add(id);
    onProgress({ stage: 'lines', done: gi, total: groups.length, message: `点をつないで線を引いています（${gi + 1}/${groups.length}）` });
    const before = prevLines.get(groups[gi].id);
    let r = before?.sig === sig ? before : cache.llm[sig];
    if (!r) {
      r = await llm.chatJson({ ...linePrompt(chosen.map((i) => promptPoint(library, points[i]))), signal });
      cache.llm[sig] = r;
    }
    lines.push({
      id,
      name: clean(r.name, 40) || `線 ${gi + 1}`,
      summary: clean(r.summary, 600),
      insight: clean(r.insight, 300),
      keywords: (Array.isArray(r.keywords) ? r.keywords : []).map((k) => clean(k, 30)).filter(Boolean).slice(0, 6),
      // 点の ID（思いつきの ID も入る。名前は前の版のまま）
      highlightIds: ids,
      bookIds: [...new Set(ids.map((id) => library.highlights[id]?.bookId).filter(Boolean))],
      sig,
      vector: c,
    });
  }
  onProgress({ stage: 'lines', done: groups.length, total: groups.length, message: `線を ${lines.length} 本引きました` });
  if (!lines.length) throw new Error('点どうしのつながりが見つかりませんでした。ハイライトを増やしてから試してください。');
  dedupeNames(lines);

  // 3. 線 → 面（線の説明文の埋め込みがあればそれも使う。説明文が変わった線だけ埋め込む）
  const summaryKeys = lines.map((l) => 's' + hash(`${l.name}\n${l.summary}`));
  if (llm.embedModel) {
    const emb = cache.embeddings;
    const need = [...new Set(summaryKeys.filter((k) => !emb.vectors[k]))];
    if (need.length) {
      const vecs = await llm.embed(need.map((k) => { const l = lines[summaryKeys.indexOf(k)]; return `${l.name}\n${l.summary}`; }), { signal });
      need.forEach((k, i) => (emb.vectors[k] = vecs[i]));
    }
    lines.forEach((l, i) => (l.vector = l2normalize(l.vector.map((x, j) => x + emb.vectors[summaryKeys[i]][j]))));
  }
  const planeGroups = carryPlanes({ lineIds: lines.map((l) => l.id), vectors: lines.map((l) => l.vector), previousPlanes: base?.planes || [], maxPlanes });
  const planes = [];
  for (let pi = 0; pi < planeGroups.length; pi++) {
    check();
    const ls = planeGroups[pi].members.map((i) => lines[i]);
    const lineIds = ls.map((l) => l.id);
    // 面は線の顔ぶれが変わったときだけ作り直す（線の名前が少し変わっただけでは呼び直さない）
    const sig = 'plane:' + hash([PROMPT_VERSION, rawLlm.chatModel, ...[...lineIds].sort()].join('|'));
    const id = planeGroups[pi].id || 'p' + hash([...lineIds].sort().join('|'));
    onProgress({ stage: 'planes', done: pi, total: planeGroups.length, message: `線を束ねて面を作っています（${pi + 1}/${planeGroups.length}）` });
    const before = prevPlanes.get(planeGroups[pi].id);
    let r = before?.sig === sig ? before : cache.llm[sig];
    if (!r) {
      // 面の中心に近い線から最大 12 本だけ見せる（多すぎると小さなモデルの読める長さを超える）
      const c = centroid(ls.map((l) => l.vector));
      const shown = [...ls].sort((a, b) => dot(b.vector, c) - dot(a.vector, c)).slice(0, PLANE_SAMPLE_SIZE);
      r = await llm.chatJson({ ...planePrompt(shown, { more: ls.length - shown.length }), signal });
      cache.llm[sig] = r;
    }
    planes.push({ id, name: clean(r.name, 40) || `面 ${pi + 1}`, summary: clean(r.summary, 800), lineIds, sig });
  }
  dedupeNames(planes);

  // 4. 面 → 立体（面の名前と顔ぶれが前回と同じなら、前回の立体をそのまま使う）
  check();
  onProgress({ stage: 'solid', done: 0, total: 1, message: '面の関係から立体を組み立てています' });
  const solidSig = 'solid:' + hash([PROMPT_VERSION, rawLlm.chatModel, ...planes.map((p) => p.id + p.name)].join('|'));
  let solid;
  if (base?.solid?.sig === solidSig) solid = structuredClone(base.solid);
  else {
    const planeInput = planes.map((p) => ({ ...p, lines: p.lineIds.map((id) => lines.find((l) => l.id === id)) }));
    let s = cache.llm[solidSig];
    if (!s) {
      s = await llm.chatJson({ ...solidPrompt(planeInput), signal });
      cache.llm[solidSig] = s;
    }
    const planeRef = (ref) => planes[parseInt(String(ref).replace(/[^\d]/g, ''), 10) - 1]?.id;
    solid = {
      title: clean(s.title, 60) || '知識の核',
      core: clean(s.core, 1200),
      relations: (Array.isArray(s.relations) ? s.relations : [])
        .map((r) => ({ from: planeRef(r.from), to: planeRef(r.to), type: RELATION_TYPES.find((t) => String(r.type).includes(t)) || '関連する', description: clean(r.description, 300) }))
        .filter((r) => r.from && r.to && r.from !== r.to),
      principles: strList(s.principles, 8, 300),
      questions: strList(s.questions, 6, 300),
      sig: solidSig,
    };
  }
  onProgress({ stage: 'solid', done: 1, total: 1, message: '立体ができました' });

  // 使わなくなった AI の結果（顔ぶれが変わる前の線・面・立体）をキャッシュから外す（分析のたびに増え続けないように）
  const usedSigs = new Set([...lines.map((l) => l.sig), ...planes.map((p) => p.sig), solidSig]);
  for (const k of Object.keys(cache.llm)) if (/^(line|plane|solid):/.test(k) && !usedSigs.has(k)) delete cache.llm[k];
  // 使わなくなった埋め込み（消えた点・変わった線の説明文）をキャッシュから外す（保存を重くしない）
  if (llm.embedModel) {
    const live = new Set([...points.map((p) => p.id), ...summaryKeys]);
    for (const k of Object.keys(cache.embeddings.vectors)) if (/^[hts]/.test(k) && !live.has(k)) delete cache.embeddings.vectors[k];
    for (const k of Object.keys(cache.embeddings.keys || {})) if (!live.has(k)) delete cache.embeddings.keys[k];
  }

  const analysis = {
    version: ANALYSIS_VERSION,
    createdAt: new Date().toISOString(),
    model: { chat: rawLlm.chatModel, embed: embedMethod },
    // incremental: 前回の線・面を引き継いだか（false は最初から作り直した）。calls: 線・面・立体のために AI を呼んだ回数
    incremental: Boolean(base),
    // 最後に最初から作り直したときの点の数（ここから 1.5 倍に増えたら作り直す）
    pointsAtFull: base ? pointsAtFull : points.length,
    stats: { points: points.length, thoughts: points.filter(isThought).length, lines: lines.length, planes: planes.length, isolated: isolated.length, calls },
    lines: lines.map(({ vector, ...l }) => l),
    planes,
    solid,
    isolated: isolated.map((i) => points[i].id),
    recommendations: [],
  };
  // 前回から何が変わったか（最初から作り直したときは、線の ID が変わるので一覧ではなく「作り直した」と出す）
  const changes = diffAnalyses(previous, analysis);
  // rebuilt の理由: full（作り直しを指定）/ grew（点が大きく増えた）/ format（前回と分析の版・埋め込みの方法が違う）
  if (changes) analysis.changes = base ? changes : { previousAt: changes.previousAt, rebuilt: true, reason: full ? 'full' : grew ? 'grew' : 'format', addedLines: [], grownLines: [], removedLines: [], connectedPoints: [] };
  // 発見（前回の分析との差から。前回を引き継いだときだけ作り、それまでの発見は点が残っていれば持ち越す）
  const indexOf = new Map(points.map((p, i) => [p.id, i]));
  const foundNow = base
    ? findDiscoveries({
        previous: base,
        lines: analysis.lines,
        sourceOf: (id) => (isThought(points[indexOf.get(id)]) ? id : points[indexOf.get(id)]?.bookId || id),
        vectorOf: (id) => vectors[indexOf.get(id)],
        formerIdsOf: formerIdsIn(library),
        now: analysis.createdAt,
      })
    : [];
  analysis.discoveries = mergeDiscoveries(foundNow, previous?.discoveries, (id) => indexOf.has(id));

  // 5. おすすめの本（立体が前回と同じなら、前回のおすすめをそのまま使う。'keep' なら立体が変わっても前回のものを残す）
  if (recommend) {
    const keep = previous?.recommendations?.length && (recommend === 'keep' || (base && solid.sig === base.solid?.sig));
    if (keep) {
      analysis.recommendations = structuredClone(previous.recommendations);
      analysis.recommendationNote = previous.recommendationNote || '';
      analysis.recommendedAt = previous.recommendedAt || previous.createdAt;
    } else if (recommend === 'keep') {
      analysis.recommendationNote = '自動の分析ではおすすめの本を選びません（欲しい本の「購入済み」などの印は画面の側にあるため）。「おすすめを選び直す」で選べます。';
    } else {
      // おすすめで失敗しても、ここまでの分析（線・面・立体）は捨てない
      try {
        analysis.recommendations = await recommendBooks({ library, analysis, llm: rawLlm, signal, onProgress, verify, count: recommendCount, fetchImpl, wishlist });
        analysis.recommendationNote = recommendationNote(analysis.recommendations);
      } catch (e) {
        if (signal?.aborted) throw e;
        analysis.recommendations = [];
        analysis.recommendationNote = `おすすめを選べませんでした（${e.message}）。「おすすめを選び直す」で再実行できます。`;
      }
      analysis.recommendedAt = new Date().toISOString();
    }
  }
  return { analysis, cache };
}

/**
 * 分析済みの立体をもとにおすすめの本を選ぶ（単独でも再実行できる）
 * 1. 書誌 DB を使う版: LLM が検索語を決め → Google Books で実在する候補を集め → LLM が選んで理由を書く
 * 2. 書誌 DB で検索できないとき: LLM が書名を挙げ → Google Books / 国立国会図書館サーチで実在を確認
 */
export async function recommendBooks({ library, analysis, llm, signal, onProgress = () => {}, verify = true, count = 6, fetchImpl, wishlist = [] }) {
  // おすすめへの反応: 読んだ本は既読として扱い、反応済みの本はもう挙げない。読みたい／興味なしは好みとして伝える
  const prefs = feedbackByStatus(library);
  const readTitles = [...Object.values(library.books).filter((b) => !b.deleted).map((b) => b.title), ...prefs.read.map((f) => f.title)];
  const readKeys = new Set([...readTitles, ...prefs.want.map((f) => f.title), ...prefs.no.map((f) => f.title)].map(bookKey));
  // 欲しい本: 購入済み・読んだ本は書誌 DB で見つかっても出さない。残りは候補に混ぜる（書名はレーベル表記を落として照合）
  const wish = wishlistForRecommend(wishlist);
  const skipKeys = new Set(wish.filter((w) => w.skip).map((w) => titleKey(w.title)).filter(Boolean));
  const excluded = (title) => readKeys.has(bookKey(title)) || skipKeys.has(titleKey(title));
  const wishByKey = new Map(wish.filter((w) => !w.skip && titleKey(w.title)).map((w) => [titleKey(w.title), w]));
  const wishInfo = (w) => ({ asin: w.asin, price: w.price, ku: w.ku });
  const planeRef = (ref) => analysis.planes[parseInt(String(ref).replace(/[^\d]/g, ''), 10) - 1]?.id || null;
  const kindOf = (k) => (RECOMMEND_KINDS.includes(k) ? k : 'deepen');

  if (verify) {
    onProgress({ stage: 'recommend', done: 0, total: 3, message: '本を探す方向を考えています' });
    const s = await llm.chatJson({ ...searchPrompt({ solid: analysis.solid, planes: analysis.planes, count: Math.min(6, count), prefs }), signal });
    const searches = (Array.isArray(s?.searches) ? s.searches : []).map((x) => ({ query: clean(x.query, 40), plane: x.plane, kind: kindOf(x.kind) })).filter((x) => x.query).slice(0, 6);
    const candidates = [];
    const seen = new Set(readKeys);
    // 欲しい本のうち、知識の全体像に近い本を先に候補にする
    for (const w of closestWishlist([...wishByKey.values()].filter((w) => !excluded(w.title)), analysis, WISHLIST_CANDIDATES)) {
      seen.add(bookKey(w.title));
      seen.add(titleKey(w.title));
      candidates.push({ title: w.title, authors: '', description: `欲しい本に登録済み（${w.ku ? 'Kindle Unlimited 対象' : w.price === null ? '価格情報なし' : `¥${w.price}`}）`, wishlist: wishInfo(w) });
    }
    for (const [i, q] of searches.entries()) {
      onProgress({ stage: 'recommend', done: 1, total: 3, message: `書誌データベースで探しています（${i + 1}/${searches.length}: ${q.query}）` });
      try {
        const found = await searchBooks(q.query, { fetchImpl, signal });
        for (const b of found.slice(0, 5)) {
          const key = bookKey(b.title);
          if (!key || seen.has(key) || seen.has(titleKey(b.title)) || skipKeys.has(titleKey(b.title))) continue;
          seen.add(key);
          const w = wishByKey.get(titleKey(b.title));
          candidates.push({ ...b, search: q, ...(w ? { wishlist: wishInfo(w) } : {}) });
        }
      } catch (e) {
        if (signal?.aborted) throw e;
      }
    }
    if (candidates.length) {
      onProgress({ stage: 'recommend', done: 2, total: 3, message: `見つかった ${candidates.length} 冊から選んでいます` });
      const r = await llm.chatJson({ ...pickPrompt({ solid: analysis.solid, planes: analysis.planes, candidates, count, prefs }), signal, temperature: 0.3 });
      const picked = new Set();
      const recs = [];
      for (const p of Array.isArray(r?.picks) ? r.picks : []) {
        const c = namedCandidate(p.reason, candidates) || candidates[Number(p.candidate) - 1];
        if (!c || picked.has(c)) continue;
        picked.add(c);
        // 欲しい本だけから来た候補は書誌 DB で確かめていない（search が無い）
        const { search, description, wishlist: wished, ...verified } = c;
        recs.push({ title: c.title, author: c.authors, planeId: planeRef(p.plane) || planeRef(search?.plane), kind: kindOf(p.kind || search?.kind), reason: clean(stripPlaneRefs(p.reason), 400), ...(search ? { query: search.query, verified } : {}), ...(wished ? { wishlist: wished } : {}) });
      }
      onProgress({ stage: 'recommend', done: 3, total: 3, message: `おすすめの本を ${recs.length} 冊選びました` });
      if (recs.length) return recs.slice(0, count);
    }
  }

  // 書誌 DB で候補を集められなかったとき: LLM に書名を挙げさせ、あとで実在を確認する
  onProgress({ stage: 'recommend', done: 0, total: 1, message: 'おすすめの本を選んでいます' });
  const seen = new Set();
  const rejected = [];
  let recs = [];
  // 小さなモデルは既読の本を挙げがちなので、多めに頼み、足りなければ却下した本を伝えてもう一度だけ頼む
  for (let round = 0; round < 2 && recs.length < Math.ceil(count / 2); round++) {
    const p = recommendPrompt({ solid: analysis.solid, planes: analysis.planes, readTitles, count: count + 2, avoid: rejected, prefs });
    const r = await llm.chatJson({ ...p, signal, temperature: 0.5 + round * 0.2 });
    for (const b of Array.isArray(r?.books) ? r.books : []) {
      const rec = { title: clean(b.title, 120), author: clean(b.author, 80), planeId: planeRef(b.plane), kind: kindOf(b.kind), reason: clean(stripPlaneRefs(b.reason), 400) };
      const key = bookKey(rec.title);
      if (!rec.title || seen.has(key)) continue;
      seen.add(key);
      const w = wishByKey.get(titleKey(rec.title));
      if (excluded(rec.title)) rejected.push(rec.title);
      else recs.push(w ? { ...rec, wishlist: wishInfo(w) } : rec);
    }
  }
  recs = recs.slice(0, count);
  if (verify) {
    onProgress({ stage: 'recommend', done: 0, total: 1, message: '書誌データベースで実在を確認しています' });
    recs = await verifyBooks(recs, { fetchImpl, signal });
    // 確認できた本を先に
    recs.sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0));
  }
  onProgress({ stage: 'recommend', done: 1, total: 1, message: `おすすめの本を ${recs.length} 冊選びました` });
  return recs;
}

/** おすすめが選べなかったときの説明（画面に出す） */
export function recommendationNote(recs) {
  if (!recs.length) return 'おすすめを選べませんでした。モデルが既に読んだ本しか挙げなかった可能性があります。より大きなモデル（7B 以上）で「おすすめを選び直す」を試してください。';
  if (recs.every((r) => r.verified === false)) return '挙がった本はどれも書誌データベースで見つかりませんでした。実在しない本の可能性が高いので、より大きなモデルで選び直してください。';
  return '';
}

/**
 * 理由が『書名』で挙げている候補。小さなモデルは候補の番号を 1 つずらして答えることがあり、
 * そのまま番号を信じると書名と理由が別の本を指す（理由の方が本人の意図に近い）
 */
function namedCandidate(reason, candidates) {
  const named = String(reason || '').match(/『([^』]+)』/)?.[1];
  const key = named && titleKey(named);
  return key ? candidates.find((c) => titleKey(c.title) === key) : undefined;
}

/** 理由の文から、プロンプトの中だけの面の記号（P2「…」の P2）を外す（利用者には意味が無く、番号がずれていることもある） */
function stripPlaneRefs(s) {
  return String(s ?? '').replace(/P\d+\s*(?:の\s*)?(?=「)/g, '');
}

function clean(v, max) {
  const s = String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function strList(v, n, max) {
  return (Array.isArray(v) ? v : [])
    .map((x) => clean(typeof x === 'string' ? x : x?.text ?? JSON.stringify(x), max))
    .filter(Boolean)
    .slice(0, n);
}

/**
 * Kindle で伸ばしたハイライトの、置き換わる前の点の ID（伸ばした回数ぶんたどる）。
 * 伸ばしただけの点を、発見で「新しくつながった点」と数えないため
 */
function formerIdsIn(library) {
  const direct = new Map();
  for (const h of Object.values(library.highlights || {})) {
    if (!h?.supersededBy) continue;
    if (!direct.has(h.supersededBy)) direct.set(h.supersededBy, []);
    direct.get(h.supersededBy).push(h.id);
  }
  return (id) => {
    const out = [];
    const stack = [...(direct.get(id) || [])];
    while (stack.length) {
      const x = stack.pop();
      if (out.includes(x) || x === id) continue;
      out.push(x);
      stack.push(...(direct.get(x) || []));
    }
    return out;
  };
}

/** 同じ名前が並ばないよう、2 つ目以降に「 (2)」などを付ける（前回の結果を使った名前に付いた番号とも重ならない番号にする） */
function dedupeNames(items) {
  const used = new Set();
  for (const it of items) {
    let name = it.name;
    for (let n = 2; used.has(name); n++) name = `${it.name} (${n})`;
    it.name = name;
    used.add(name);
  }
}

// キャッシュの保存用（Float32Array ↔ base64）
export function serializeCache(cache) {
  const vectors = {};
  for (const [id, v] of Object.entries(cache.embeddings?.vectors || {})) vectors[id] = toBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  return { embeddings: { model: cache.embeddings?.model || '', vectors, keys: cache.embeddings?.keys || {} }, llm: cache.llm || {} };
}

export function deserializeCache(data) {
  if (!data) return emptyCache();
  const vectors = {};
  for (const [id, b64] of Object.entries(data.embeddings?.vectors || {})) {
    const bytes = fromBase64(b64);
    vectors[id] = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }
  // keys が壊れていたら持たない（前の版のキャッシュと同じに扱い、文が同じ点は使い続ける）
  const keys = data.embeddings?.keys;
  const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);
  return { embeddings: { model: data.embeddings?.model || '', vectors, keys: plain(keys) ? keys : {} }, llm: plain(data.llm) ? data.llm : {} };
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** 欲しい本のうち、知識の全体像（核・面）に書名が近い順に limit 冊（文字 n-gram の TF-IDF。LLM は使わない） */
function closestWishlist(books, analysis, limit) {
  if (books.length <= limit) return books;
  const profile = [analysis.solid?.core, ...analysis.planes.map((p) => `${p.name} ${p.summary}`)].filter(Boolean).join(' ');
  const [target, ...vectors] = tfidfEmbed([profile, ...books.map((b) => b.title)]);
  return books
    .map((b, i) => ({ b, score: dot(target, vectors[i]), i }))
    .sort((x, y) => y.score - x.score || x.i - y.i)
    .slice(0, limit)
    .map((x) => x.b);
}
