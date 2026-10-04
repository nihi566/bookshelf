// ベクトル演算とクラスタリング（点 → 線、線 → 面 のグルーピングに使う）

import { hash, normalizeText, seededRandom } from '../text.js';

export function l2normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * LLM の埋め込みモデルが無いときの代替：文字 n-gram の TF-IDF をハッシュで固定次元に落とす。
 * 日本語は単語境界が無いので、文字 2-gram / 3-gram が語彙の近さをよく拾う。
 */
export function tfidfEmbed(texts, dims = 1024) {
  const docs = texts.map((t) => {
    const s = normalizeText(t).replace(/[\s\p{P}\p{S}]/gu, '');
    const grams = new Map();
    for (const n of [2, 3]) {
      for (let i = 0; i + n <= s.length; i++) {
        const g = s.slice(i, i + n);
        grams.set(g, (grams.get(g) || 0) + 1);
      }
    }
    return grams;
  });
  const df = new Map();
  for (const d of docs) for (const g of d.keys()) df.set(g, (df.get(g) || 0) + 1);
  const N = docs.length;
  return docs.map((d) => {
    const v = new Float32Array(dims);
    for (const [g, tf] of d) {
      const idf = Math.log((N + 1) / ((df.get(g) || 0) + 1)) + 1;
      // 1 つしか出てこない n-gram は類似度に寄与しないので軽くする
      const w = (1 + Math.log(tf)) * idf * ((df.get(g) || 0) > 1 ? 1 : 0.3);
      const hv = parseInt(hash(g).slice(-6), 36);
      v[hv % dims] += hv & 1 ? w : -w;
    }
    return l2normalize(v);
  });
}

export function centroid(vectors) {
  const dims = vectors[0].length;
  const c = new Float32Array(dims);
  for (const v of vectors) for (let i = 0; i < dims; i++) c[i] += v[i];
  return l2normalize(c);
}

/**
 * 球面 k-means（コサイン類似度）。k-means++ 初期化、シード固定で再現性あり。
 * 戻り値: { assign: number[], centroids: Float32Array[] }
 */
export function kmeans(vectors, k, { seed = 42, iterations = 30, maxSize = Infinity } = {}) {
  const n = vectors.length;
  k = Math.max(1, Math.min(k, n));
  const rand = seededRandom(seed);
  const centroids = [vectors[Math.floor(rand() * n)]];
  const best = new Float64Array(n).fill(Infinity);
  while (centroids.length < k) {
    const last = centroids[centroids.length - 1];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.max(0, 1 - dot(vectors[i], last));
      if (d < best[i]) best[i] = d;
      total += best[i] * best[i];
    }
    if (total === 0) break;
    let r = rand() * total;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      r -= best[i] * best[i];
      if (r <= 0) {
        pick = i;
        break;
      }
    }
    centroids.push(vectors[pick]);
  }
  let assign = new Array(n).fill(0);
  // 上限があっても全員が入れるよう、組の数 × 上限 が n を下回らないようにする
  const cap = Math.max(maxSize, Math.ceil(n / centroids.length));
  for (let it = 0; it < iterations; it++) {
    const next = cap < n ? assignCapped(vectors, centroids, cap) : assignNearest(vectors, centroids);
    const moved = it === 0 ? n : next.filter((c, i) => c !== assign[i]).length;
    assign = next;
    for (let c = 0; c < centroids.length; c++) {
      const members = vectors.filter((_, i) => assign[i] === c);
      if (members.length) centroids[c] = centroid(members);
    }
    if (moved === 0) break;
  }
  return { assign, centroids };
}

function assignNearest(vectors, centroids) {
  return vectors.map((v) => {
    let bi = 0;
    let bs = -Infinity;
    for (let c = 0; c < centroids.length; c++) {
      const s = dot(v, centroids[c]);
      if (s > bs) {
        bs = s;
        bi = c;
      }
    }
    return bi;
  });
}

/**
 * 組の大きさに上限がある割り当て。似ている組み合わせから順に決め、満員の組には入れない。
 * 似た点が 1 か所に固まると（文字 n-gram のベクトルでありふれた語を共有するときなど）、
 * ふつうの k-means では 1 つの組が膨らみ、中身の薄い「線」や「面」になるため
 */
function assignCapped(vectors, centroids, cap) {
  const k = centroids.length;
  const sims = new Float64Array(vectors.length * k);
  vectors.forEach((v, i) => centroids.forEach((c, j) => (sims[i * k + j] = dot(v, c))));
  const order = [...sims.keys()].sort((a, b) => sims[b] - sims[a] || a - b);
  const assign = new Array(vectors.length).fill(-1);
  const sizes = new Array(k).fill(0);
  for (const p of order) {
    const i = Math.floor(p / k);
    const c = p % k;
    if (assign[i] !== -1 || sizes[c] >= cap) continue;
    assign[i] = c;
    sizes[c]++;
  }
  return assign;
}

/**
 * 点を線にまとめる。似た点どうしを k-means で束ね、中心から遠すぎる点は「まだつながらない点」として外す。
 * 戻り値: { groups: number[][] (インデックスの配列), isolated: number[] }
 */
export function groupPoints(vectors, { targetSize = 5, minSize = 2, minSimilarity = 'auto', maxGroups = 60, seed = 42 } = {}) {
  const n = vectors.length;
  if (n < minSize) return { groups: [], isolated: [...Array(n).keys()] };
  const k = Math.max(1, Math.min(maxGroups, Math.round(n / targetSize)));
  // 1 本の線は平均の 2.5 倍まで（大きすぎる線は LLM が中心の 12 点しか見ず、ぼやけた概念になる）
  const { assign, centroids } = kmeans(vectors, k, { seed, maxSize: Math.ceil((n / k) * 2.5) });
  const sims = vectors.map((v, i) => dot(v, centroids[assign[i]]));
  // 'auto': 埋め込みモデルごとに類似度の分布が違うので、全体の分布から外れ値だけを落とす
  let threshold = minSimilarity;
  if (threshold === 'auto') {
    const mean = sims.reduce((s, x) => s + x, 0) / n;
    const sd = Math.sqrt(sims.reduce((s, x) => s + (x - mean) ** 2, 0) / n);
    threshold = mean - 1.5 * sd;
  }
  const groups = [];
  const isolated = [];
  for (let c = 0; c < centroids.length; c++) {
    const members = [];
    for (let i = 0; i < n; i++) {
      if (assign[i] !== c) continue;
      if (sims[i] >= threshold) members.push(i);
      else isolated.push(i);
    }
    if (members.length >= minSize) groups.push(members);
    else isolated.push(...members);
  }
  // 大きい線から順に
  groups.sort((a, b) => b.length - a.length);
  return { groups, isolated: isolated.sort((a, b) => a - b) };
}

/** 線を面にまとめる。線の数の平方根程度の面に分ける */
export function groupLines(vectors, { seed = 7, maxPlanes = 8 } = {}) {
  const n = vectors.length;
  if (n === 0) return [];
  if (n <= 2) return [[...Array(n).keys()]];
  const k = Math.max(2, Math.min(maxPlanes, Math.round(Math.sqrt(n))));
  // 1 つの面は平均の 1.6 倍まで（「知識と人生」のような何でも入る面にしない）
  const { assign, centroids } = kmeans(vectors, k, { seed, maxSize: Math.ceil((n / k) * 1.6) });
  const groups = centroids.map((_, c) => assign.map((a, i) => (a === c ? i : -1)).filter((i) => i >= 0)).filter((g) => g.length);
  // 線 1 本だけの面は、いちばん近い他の面に入れる（線 1 本ではテーマにならない）。入れた先がまた 1 本の面なら 2 本になる
  for (let lone = groups.find((g) => g.length === 1); lone && groups.length > 1; lone = groups.find((g) => g.length === 1)) {
    groups.splice(groups.indexOf(lone), 1);
    const v = vectors[lone[0]];
    const closeness = (g) => dot(v, centroid(g.map((i) => vectors[i])));
    groups.reduce((best, g) => (closeness(g) > closeness(best) ? g : best)).push(lone[0]);
  }
  return groups.sort((a, b) => b.length - a.length);
}
