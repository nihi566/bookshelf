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
import { analysisPoints, currentPointId, embedText, isThought, legacyEmbedText, pointLabel } from '../points.js';
import { notesForAnalysis } from '../notes.js';
import { bookKey, hash, maskSecrets, truncate } from '../text.js';
import { PROMPT_VERSION, RECOMMEND_KINDS, RELATION_TYPES, farPrompt, humanLine, linePrompt, pickPrompt, planePrompt, recommendPrompt, searchPrompt, solidPrompt } from './prompts.js';
import { centroid, dot, l2normalize, tfidfEmbed } from './vectors.js';
import { carryLines, carryPlanes } from './incremental.js';
import { nearPoints } from './neighbors.js';
import { diffAnalyses } from './changes.js';
import { farDiscovery, findDiscoveries, mergeDiscoveries } from './discoveries.js';
import { FAR_MAX_UNREADABLE, farCandidates, farId, judgeFarPairs, mergeFarConnections, pickReps } from './far.js';
import { farReactionsOf, wrongFarIds } from '../far-reactions.js';
import { EMBED_BATCH_SIZE } from './llm.js';
import { isAnalysisShape } from './shape.js';
import { searchBooks, verifyBooks } from './recommend.js';
import { titleKey, wishlistForRecommend } from '../wishlist.js';

// おすすめの候補に混ぜる欲しい本の冊数（多すぎると小さなモデルが選びきれない）
const WISHLIST_CANDIDATES = 8;
// おすすめに毎回 1 冊以上入れる種類（広げる・揺さぶる）。好みに閉じないため、AI が選ばなければ足す
export const REQUIRED_KINDS = Object.freeze(['broaden', 'challenge']);
// AI が理由を書けなかったときに、足した本に添える理由
const KIND_REASON = { broaden: 'いまの面の隣の分野へ、読書を広げる本として足しました。', challenge: 'いまの考えとは別の立場から、考えを揺さぶる本として足しました。' };

// 2: 線を小さくした（点 8 件で線 1 本・上限 400 本）。前の版の分析は引き継がず、最初から作り直す
export const ANALYSIS_VERSION = 2;

// 点いくつで線 1 本にするかの目安と、線の数の上限。線が大きくなりすぎると「1 ノート = 1 アイデア」から離れ、
// AI も中心の 12 点しか見ないので、ぼやけた概念になる（点 1,000 件で 1 本の点の数の中央値が 10 以下になるようにした）
export const LINE_TARGET_SIZE = 8;
export const MAX_LINES = 400;
// 面の数の上限と、面を作る AI に見せる線の数（面の中心に近い線から）
export const MAX_PLANES = 12;
export const PLANE_SAMPLE_SIZE = 12;
// 面・立体を作る AI に見せる永久ノートの数（新しく直したものから。多すぎると小さなモデルの読める長さを超える）
const NOTES_PER_PLANE = 6;
const NOTES_FOR_SOLID = 12;
// 1 本の線に入れる点の上限（目安の 2.5 倍。増えた点を加えるときもこれを超えない）
const lineMaxSize = (target) => Math.ceil(target * 2.5);
// 前回最初から作り直したときから点がこれだけ増えたら、引き継がずに作り直す（小さいうちの線・面の形に縛られ続けないように）
const REBUILD_GROWTH = 1.5;
const REBUILD_MIN_ADDED = 40;

// 埋め込みモデル無し（文字 n-gram）で分析したときの案内。実データ（点 920）で試すと、ありふれた言葉を共有する点が
// 1 本の線に集まり、面の名前も「知識の〜」ばかりになった。bge-m3 にすると面がテーマごとに分かれた
export const TFIDF_HINT = '埋め込みモデルを使わず、文字の並びだけで点をつないでいます。ありふれた言葉でつながりやすく、面の名前が似通いがちです。PC で ollama pull bge-m3 を実行し、埋め込みモデルに bge-m3 を設定すると、意味の近さでつなげます。';

// embeddings.keys: 点ごとに、埋め込んだ文のハッシュ（自分のメモ・タグを書き換えた点だけ埋め込み直すため）
// far: 遠い組み合わせの AI の判定（判定した組を二度判定せず、分析のたびに新しい組を試すため）
export function emptyCache() {
  return { embeddings: { model: '', vectors: {}, keys: {} }, llm: {}, far: {} };
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
  // 問いかけの答えを保存したメモは AI が書いた文（読者自身の言葉として重く見させない）
  return { text: p.text, label: pointLabel(library, p), thought: isThought(p), aiAnswer: p.answerTo?.kind === 'ask', note: p.note || '', userNote: p.userNote || '', tags: p.tags || [] };
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
  // 前の版のキャッシュには遠い組み合わせの判定が無い
  if (!plainObject(cache.far)) cache.far = {};
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
  let base = !full && !grew && previous?.version === ANALYSIS_VERSION && previous.model?.embed === embedMethod ? previous : null;

  // 2. 点 → 線（前回の線を引き継ぎ、増えた点は近い線に加える）
  const carry = (from) => carryLines({ ids: points.map((p) => p.id), vectors, previousLines: from?.lines || [], previousIsolated: from?.isolated || [], targetSize: granularity, maxSize: lineMaxSize(granularity), maxGroups: maxLines });
  let carried = carry(base);
  // 点が減って前回の線がすべてほどけると、引き継ぎでは新しい線を作らない（増えた点が無い）。最初から束ね直す
  const unraveled = Boolean(base) && !carried.lines.length;
  if (unraveled) {
    base = null;
    carried = carry(null);
  }
  const { lines: groups, isolated } = carried;
  const prevLines = new Map((base?.lines || []).map((l) => [l.id, l]));
  const prevPlanes = new Map((base?.planes || []).map((p) => [p.id, p]));
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
  // 線の点の中心（面を作るときは線の説明文の埋め込みを混ぜるので、その前に取っておく。意味の近い点・関わる点に使う）
  const lineCentroids = lines.map((l) => l.vector);

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
  // 永久ノート（人間がまとめた線）。根拠の点が入っている面と、立体を作る AI に見せる（G3-5。線から作って直していない下書きは除く）。
  // AI に見せる文を指紋にも入れて、ノートを書き直したら面・立体を作り直す（ノートが無ければ指紋は前と同じ）
  const notes = notesForAnalysis(library);
  const lineOfPoint = new Map(lines.flatMap((l) => l.highlightIds.map((id) => [id, l.id])));
  const linesOfNote = new Map(notes.map((n) => [n.id, new Set(n.pointIds.map((id) => lineOfPoint.get(currentPointId(library, id))).filter(Boolean))]));
  const noteKeys = (ns) => (ns.length ? ['|人間がまとめた線|', ...ns.map((n) => `${n.id}:${hash(humanLine(n))}`).sort()] : []);
  const planes = [];
  for (let pi = 0; pi < planeGroups.length; pi++) {
    check();
    const ls = planeGroups[pi].members.map((i) => lines[i]);
    const lineIds = ls.map((l) => l.id);
    const planeNotes = notes.filter((n) => lineIds.some((id) => linesOfNote.get(n.id).has(id))).slice(0, NOTES_PER_PLANE);
    // 面は線の顔ぶれ（と、その面の永久ノート）が変わったときだけ作り直す（線の名前が少し変わっただけでは呼び直さない）
    const sig = 'plane:' + hash([PROMPT_VERSION, rawLlm.chatModel, ...[...lineIds].sort(), ...noteKeys(planeNotes)].join('|'));
    const id = planeGroups[pi].id || 'p' + hash([...lineIds].sort().join('|'));
    onProgress({ stage: 'planes', done: pi, total: planeGroups.length, message: `線を束ねて面を作っています（${pi + 1}/${planeGroups.length}）` });
    const before = prevPlanes.get(planeGroups[pi].id);
    let r = before?.sig === sig ? before : cache.llm[sig];
    if (!r) {
      // 面の中心に近い線から最大 12 本だけ見せる（多すぎると小さなモデルの読める長さを超える）
      const c = centroid(ls.map((l) => l.vector));
      const shown = [...ls].sort((a, b) => dot(b.vector, c) - dot(a.vector, c)).slice(0, PLANE_SAMPLE_SIZE);
      r = await llm.chatJson({ ...planePrompt(shown, { more: ls.length - shown.length, notes: planeNotes }), signal });
      cache.llm[sig] = r;
    }
    planes.push({ id, name: clean(r.name, 40) || `面 ${pi + 1}`, summary: clean(r.summary, 800), lineIds, sig });
  }
  dedupeNames(planes);

  // 4. 面 → 立体（面の名前と顔ぶれ・永久ノートが前回と同じなら、前回の立体をそのまま使う）
  check();
  onProgress({ stage: 'solid', done: 0, total: 1, message: '面の関係から立体を組み立てています' });
  const solidNotes = notes.slice(0, NOTES_FOR_SOLID);
  const solidSig = 'solid:' + hash([PROMPT_VERSION, rawLlm.chatModel, ...planes.map((p) => p.id + p.name), ...noteKeys(solidNotes)].join('|'));
  let solid;
  if (base?.solid?.sig === solidSig) solid = structuredClone(base.solid);
  else {
    const planeInput = planes.map((p) => ({ ...p, lines: p.lineIds.map((id) => lines.find((l) => l.id === id)) }));
    let s = cache.llm[solidSig];
    if (!s) {
      s = await llm.chatJson({ ...solidPrompt(planeInput, { notes: solidNotes }), signal });
      cache.llm[solidSig] = s;
    }
    const planeRef = (ref) => planes[parseInt(String(ref).replace(/[^\d]/g, ''), 10) - 1]?.id;
    solid = {
      title: clean(s.title, 60) || '知識の核',
      core: clean(s.core, 1200),
      relations: objects(s.relations)
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
  const formerIdsOf = formerIdsIn(library);
  const changes = diffAnalyses(previous, analysis, formerIdsOf);
  // rebuilt の理由: full（作り直しを指定）/ grew（点が大きく増えた）/ unraveled（点が減って前回の線がすべてほどけた）/ format（前回と分析の版・埋め込みの方法が違う）
  if (changes) analysis.changes = base ? changes : { previousAt: changes.previousAt, rebuilt: true, reason: full ? 'full' : grew ? 'grew' : unraveled ? 'unraveled' : 'format', addedLines: [], grownLines: [], removedLines: [], connectedPoints: [] };
  const indexOf = new Map(points.map((p, i) => [p.id, i]));
  const alive = (id) => indexOf.has(id);
  // 点の出どころ（本の ID。思いつきは 1 つずつ別の出どころ）
  const sourceOf = (id) => (isThought(points[indexOf.get(id)]) ? id : points[indexOf.get(id)]?.bookId || id);

  // 意味の近い点（G4-2。点の画面からリンクにできる）と、2 番目に近い線にも十分近い点（G4-3。その線の「関わる点」）
  const near = nearPoints({
    ids: points.map((p) => p.id),
    vectors,
    lines: groups.map((g, j) => ({ id: lines[j].id, members: g.members, centroid: lineCentroids[j] })),
    isolated,
    sourceOf: (i) => sourceOf(points[i].id),
  });
  analysis.neighbors = near.neighbors;
  for (const l of analysis.lines) {
    const related = near.related.get(l.id);
    if (related?.length) l.relatedIds = related;
  }

  // 4.5 遠いつながり（別の本・別の面にある、近さが低めの点の組を AI に判定させる。おすすめの本と同じく、線・面・立体の回数には数えない）
  check();
  const far = await findFarConnections({ library, analysis, previous, points, vectors, indexOf, sourceOf, textKeyById, llm: rawLlm, cache, signal, onProgress });
  analysis.farConnections = mergeFarConnections(far.found, previous?.farConnections, alive, wrongFarIds(library));
  analysis.stats.far = { candidates: far.candidates, calls: far.calls, found: far.found.length };
  // エラー文は長さも切る（分析の形の確かめで、長すぎる説明は受け入れないため）
  if (far.error) analysis.farNote = `遠い組み合わせの判定に失敗しました（${truncate(maskSecrets(far.error), 300)}）。次の分析でもう一度試します。`;

  // 発見（前回の分析との差から。前回を引き継いだときだけ作り、それまでの発見は点が残っていれば持ち越す）。
  // 新しい遠いつながりは線の ID に依らないので、作り直した分析でも発見にする（最初の分析では作らない）
  const foundNow = base
    ? findDiscoveries({ previous: base, lines: analysis.lines, sourceOf, vectorOf: (id) => vectors[indexOf.get(id)], formerIdsOf, now: analysis.createdAt })
    : [];
  analysis.discoveries = mergeDiscoveries([...(previous ? far.found.map(farDiscovery) : []), ...foundNow], previous?.discoveries, alive);

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
        analysis.recommendationNote = `おすすめを選べませんでした（${maskSecrets(e.message)}）。「おすすめを選び直す」で再実行できます。`;
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
  const base = { solid: analysis.solid, planes: analysis.planes, prefs };
  // 足りない種類を足すための依頼（失敗しても、それまでに選べた本は捨てない）
  const ask = async (p) => {
    try {
      return await llm.chatJson({ ...p, signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      return null;
    }
  };

  if (verify) {
    onProgress({ stage: 'recommend', done: 0, total: 3, message: '本を探す方向を考えています' });
    const s = await llm.chatJson({ ...searchPrompt({ ...base, count: Math.min(6, count) }), signal });
    // AI の答えの中の壊れた項目（null など）は飛ばす
    const toSearches = (v) => (Array.isArray(v) ? v : []).filter(isObject).map((x) => ({ query: clean(x.query, 40), plane: x.plane, kind: kindOf(x.kind) })).filter((x) => x.query);
    const searches = toSearches(s?.searches).slice(0, 6);
    // 広げる・揺さぶるの検索語が無ければ、その種類だけを頼んで足す（AI 任せにしない）
    for (const kind of REQUIRED_KINDS.filter((k) => !searches.some((x) => x.kind === k))) {
      const more = await ask(searchPrompt({ ...base, count: 2, kinds: [kind] }));
      searches.push(...toSearches(more?.searches).filter((x) => !searches.some((y) => y.query === x.query)).slice(0, 2).map((x) => ({ ...x, kind })));
    }
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
      const r = await llm.chatJson({ ...pickPrompt({ ...base, candidates, count }), signal, temperature: 0.3 });
      // 欲しい本だけから来た候補は書誌 DB で確かめていない（search が無い）
      const toRec = (c, p, kind = kindOf(p.kind || c.search?.kind)) => {
        const { search, description, wishlist: wished, ...verified } = c;
        return { title: c.title, author: c.authors, planeId: planeRef(p.plane) || planeRef(search?.plane), kind, reason: clean(stripPlaneRefs(p.reason), 400), ...(search ? { query: search.query, verified } : {}), ...(wished ? { wishlist: wished } : {}) };
      };
      // 候補 → おすすめ（AI が選んだ候補）
      const recOf = new Map();
      for (const p of (Array.isArray(r?.picks) ? r.picks : []).filter(isObject)) {
        const c = namedCandidate(p.reason, candidates) || candidates[Number(p.candidate) - 1];
        if (!c || recOf.has(c)) continue;
        recOf.set(c, toRec(c, p));
      }
      let recs = [...recOf.values()].slice(0, count);
      // 広げる・揺さぶるの本が無ければ、その種類で探した候補から 1 冊選ばせて、その種類の理由を書かせる（理由を書けなければ決まった理由）。
      // AI が「深める」として選んだ本も選び直せる（その本は種類と理由を書き換える）。広げる・揺さぶるとして選んだ本は動かさない
      const movable = (c) => !recs.includes(recOf.get(c)) || !REQUIRED_KINDS.includes(recOf.get(c).kind);
      for (const kind of recs.length ? REQUIRED_KINDS.filter((k) => !recs.some((x) => x.kind === k)) : []) {
        const pool = candidates.filter((c) => c.search?.kind === kind && movable(c)).slice(0, 5);
        if (!pool.length) continue;
        const one = await ask(pickPrompt({ ...base, candidates: pool, count: 1, kinds: [kind] }));
        const chosen = (x) => namedCandidate(x.reason, pool) || pool[Number(x.candidate) - 1];
        const p = (Array.isArray(one?.picks) ? one.picks : []).filter(isObject).find(chosen);
        const c = p ? chosen(p) : pool[0];
        const rec = toRec(c, p && clean(p.reason, 400) ? p : { reason: KIND_REASON[kind] }, kind);
        const old = recOf.get(c);
        recs = recs.includes(old) ? recs.map((x) => (x === old ? rec : x)) : [...makeRoom(recs, count), rec];
        recOf.set(c, rec);
      }
      onProgress({ stage: 'recommend', done: 3, total: 3, message: `おすすめの本を ${recs.length} 冊選びました` });
      if (recs.length) return recs;
    }
  }

  // 書誌 DB で候補を集められなかったとき: LLM に書名を挙げさせ、あとで実在を確認する
  onProgress({ stage: 'recommend', done: 0, total: 1, message: 'おすすめの本を選んでいます' });
  const seen = new Set();
  const rejected = [];
  let recs = [];
  /** AI が挙げた本 → おすすめ（挙げられない本は rejected へ。挙げた本を返す） */
  const take = (b, kind = kindOf(b?.kind)) => {
    const rec = { title: clean(b?.title, 120), author: clean(b?.author, 80), planeId: planeRef(b?.plane), kind, reason: clean(stripPlaneRefs(b?.reason), 400) };
    const key = bookKey(rec.title);
    if (!rec.title || seen.has(key)) return null;
    seen.add(key);
    if (excluded(rec.title)) return void rejected.push(rec.title);
    const w = wishByKey.get(titleKey(rec.title));
    return w ? { ...rec, wishlist: wishInfo(w) } : rec;
  };
  // 小さなモデルは既読の本を挙げがちなので、多めに頼み、足りなければ却下した本を伝えてもう一度だけ頼む
  for (let round = 0; round < 2 && recs.length < Math.ceil(count / 2); round++) {
    const p = recommendPrompt({ ...base, readTitles, count: count + 2, avoid: rejected });
    const r = await llm.chatJson({ ...p, signal, temperature: 0.5 + round * 0.2 });
    for (const b of Array.isArray(r?.books) ? r.books : []) {
      const rec = take(b);
      if (rec) recs.push(rec);
    }
  }
  recs = recs.slice(0, count);
  // 広げる・揺さぶるの本が無ければ、その種類だけを頼んで 1 冊足す（AI 任せにしない）
  for (const kind of recs.length ? REQUIRED_KINDS.filter((k) => !recs.some((x) => x.kind === k)) : []) {
    const r = await ask(recommendPrompt({ ...base, readTitles, count: 2, avoid: [...rejected, ...recs.map((x) => x.title)], kinds: [kind] }));
    for (const b of Array.isArray(r?.books) ? r.books : []) {
      const rec = take(b, kind);
      if (!rec) continue;
      recs = [...makeRoom(recs, count), rec];
      break;
    }
  }
  if (verify) {
    onProgress({ stage: 'recommend', done: 0, total: 1, message: '書誌データベースで実在を確認しています' });
    recs = await verifyBooks(recs, { fetchImpl, signal });
    // 確認できた本を先に
    recs.sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0));
  }
  onProgress({ stage: 'recommend', done: 1, total: 1, message: `おすすめの本を ${recs.length} 冊選びました` });
  return recs;
}

/**
 * おすすめに 1 冊足すための空きを作る（count 冊そろっていれば、後ろから見て、同じ種類がほかにもある本か、
 * 必ず入れる種類ではない本を 1 冊外す）
 */
function makeRoom(recs, count) {
  if (recs.length < count) return recs;
  const n = new Map();
  for (const r of recs) n.set(r.kind, (n.get(r.kind) || 0) + 1);
  for (let i = recs.length - 1; i >= 0; i--) if (n.get(recs[i].kind) > 1 || !REQUIRED_KINDS.includes(recs[i].kind)) return recs.filter((_, j) => j !== i);
  return recs.slice(0, -1);
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

/** LLM の出力の配列のうち、オブジェクトの要素だけ（null や文字列が混ざっても落ちないように） */
function objects(v) {
  return (Array.isArray(v) ? v : []).filter((x) => x && typeof x === 'object');
}

function strList(v, n, max) {
  return (Array.isArray(v) ? v : [])
    .map((x) => clean(typeof x === 'string' ? x : x?.text ?? JSON.stringify(x), max))
    .filter(Boolean)
    .slice(0, n);
}

/**
 * 遠いつながりを探す（G6）: 線ごとの中心にいちばん近い点と、まだつながらない点のうち、別の本・別の面にある近さが低めの組を
 * 最大 10 組選び、AI に「共通する考えがあるか」を判定させる。前に判定した組（キャッシュ）・反応を付けた組・前回までに
 * 見つかった組は選ばない（分析のたびに、まだ試していない組を試す）。
 * 判定は cache.far に { a, b, shared, idea?, explanation?, at } で残す（読めない答えは { a, b, unreadable: 回数, at }）
 * @returns {Promise<{ found: object[], calls: number, candidates: number, error: string }>}
 */
async function findFarConnections({ library, analysis, previous, points, vectors, indexOf, sourceOf, textKeyById, llm, cache, signal, onProgress }) {
  const judged = cache.far;
  // 判定の指紋: 2 点（並びに依らない）と、それぞれの文（自分のメモ・タグを含む）・モデル・プロンプトの版
  const sig = (a, b) => 'far:' + hash([PROMPT_VERSION, llm.chatModel, ...[a, b].sort().map((id) => `${id}:${textKeyById.get(id)}`)].join('|'));
  const current = (k, v) => typeof v?.a === 'string' && typeof v?.b === 'string' && indexOf.has(v.a) && indexOf.has(v.b) && sig(v.a, v.b) === k;
  const known = new Set([...Object.keys(farReactionsOf(library)), ...(previous?.farConnections || []).map((f) => f.id)]);
  // 前の分析で「ある」と判定したのに、その分析が保存されなかった組（判定のあとで中止・失敗した）。判定し直さず、今回の結果に入れる。
  // 前の分析が履歴から戻した回なら、元の回より後に判定した組も拾う（戻した回には入っていないが、判定済みなので二度と判定しない。NIH-7）
  const since = previous?.restoredFrom || previous?.createdAt;
  const recovered = Object.entries(judged)
    .filter(([k, v]) => v?.shared === true && current(k, v) && typeof v.at === 'string' && (!since || v.at > since) && !known.has(farId(v.a, v.b)))
    .map(([, v]) => ({ id: farId(v.a, v.b), a: v.a, b: v.b, idea: v.idea, explanation: v.explanation, foundAt: v.at }));
  for (const f of recovered) known.add(f.id);
  const planeOfLine = new Map(analysis.planes.flatMap((p) => p.lineIds.map((id) => [id, p.id])));
  // 代表の点は上限まで（まだつながらない点が多いときは、前に判定した組に入った回数が少ない点から）
  const judgedCount = new Map();
  for (const v of Object.values(judged)) for (const id of [v?.a, v?.b]) if (typeof id === 'string') judgedCount.set(id, (judgedCount.get(id) || 0) + 1);
  const reps = pickReps(
    [...analysis.lines.map((l) => ({ id: l.highlightIds[0], plane: planeOfLine.get(l.id) || null, isolated: false })), ...analysis.isolated.map((id) => ({ id, plane: null, isolated: true }))].filter((r) => indexOf.has(r.id)),
    (id) => judgedCount.get(id) || 0,
  ).map((r) => ({ ...r, vector: vectors[indexOf.get(r.id)], source: sourceOf(r.id) }));
  // 判定済み（「ある」「ない」）の組と、答えが何度も読めなかった組は選ばない
  const done = (v) => typeof v?.shared === 'boolean' || (v?.unreadable || 0) >= FAR_MAX_UNREADABLE;
  const candidates = farCandidates({ reps, skip: (c) => known.has(c.id) || done(judged[sig(c.a, c.b)]) });
  const pointOf = (id) => promptPoint(library, points[indexOf.get(id)]);
  const at = analysis.createdAt;
  const r = await judgeFarPairs({
    candidates,
    llm,
    signal,
    onProgress,
    now: at,
    promptOf: (c) => farPrompt(pointOf(c.a), pointOf(c.b)),
    remember: (c, v) => {
      const k = sig(c.a, c.b);
      judged[k] = v ? { a: c.a, b: c.b, ...v, at } : { a: c.a, b: c.b, unreadable: (judged[k]?.unreadable || 0) + 1, at };
    },
  });
  // 使わなくなった判定（消えた点・文を書き換えた点・モデルやプロンプトを変えたときの組）をキャッシュから外す。
  // 残す数にも上限を置く（分析のたびに 10 組ずつ増えるので、古い判定から外す。外した組はいつか判定し直すことがある）
  for (const [k, v] of Object.entries(judged)) if (!current(k, v)) delete judged[k];
  const keys = Object.keys(judged);
  if (keys.length > FAR_CACHE_KEEP) {
    const stamp = (k) => (typeof judged[k].at === 'string' ? judged[k].at : '');
    for (const k of keys.sort((x, y) => (stamp(x) < stamp(y) ? -1 : stamp(x) > stamp(y) ? 1 : 0)).slice(0, keys.length - FAR_CACHE_KEEP)) delete judged[k];
  }
  return { ...r, found: [...recovered, ...r.found], candidates: candidates.length };
}

// 遠い組み合わせの判定を残す数（1 件は百数十字なので、上限まで残しても 1 MB に届かない）
const FAR_CACHE_KEEP = 5000;

/**
 * Kindle で伸ばしたハイライトの、置き換わる前の点の ID（伸ばした回数ぶんたどる）。
 * 伸ばしただけの点を、発見・前回からの変化で「新しくつながった点」と数えないため
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
  return { embeddings: { model: cache.embeddings?.model || '', vectors, keys: cache.embeddings?.keys || {} }, llm: cache.llm || {}, far: cache.far || {} };
}

const plainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isObject = (v) => Boolean(v) && typeof v === 'object';

export function deserializeCache(data) {
  if (!data) return emptyCache();
  const vectors = {};
  for (const [id, b64] of Object.entries(data.embeddings?.vectors || {})) {
    // 壊れたベクトルはその点だけ捨てる（埋め込み直せばよい。キャッシュのせいで分析を毎回失敗させない）
    if (typeof b64 !== 'string') continue;
    let bytes;
    try {
      bytes = fromBase64(b64);
    } catch {
      continue;
    }
    if (bytes.byteLength % 4) continue;
    vectors[id] = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }
  // keys が壊れていたら持たない（前の版のキャッシュと同じに扱い、文が同じ点は使い続ける）
  const keys = data.embeddings?.keys;
  return { embeddings: { model: data.embeddings?.model || '', vectors, keys: plainObject(keys) ? keys : {} }, llm: plainObject(data.llm) ? data.llm : {}, far: plainObject(data.far) ? data.far : {} };
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
