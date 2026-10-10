// 表紙の取れない Play ブックスの本に ISBN を付ける（bh serve の中で定期的に動く）
//
// Play ブックスの書籍 ID（volumeId）では、購入した本の多くで Google ブックスが「画像なし」の画像しか返さない
// （Play ブックスのメモに埋め込まれた表紙も同じ画像。鍵なしの Books API は 1 日の上限が 0 で使えない）。
// そこで国立国会図書館サーチで書名・著者から ISBN を探して本に付け、表紙は ISBN-10 から Amazon の画像を使う
// （web/core/covers.js）。送るのは書名・著者だけ（docs/architecture.md §外部との通信先）

import { matchVolume, parseNdlRss } from '../web/core/analysis/recommend.js';
import { isbn10 } from '../web/core/covers.js';

const NDL = 'https://ndlsearch.ndl.go.jp/api/opensearch';
export const LOOKUP_INTERVAL_MS = 10 * 60_000;
// 1 回の確認で探す冊数（国立国会図書館サーチへの問い合わせをまとめて送りすぎない。残りは次の確認で）
const PER_RUN = 20;
// 応答が無いまま待ち続けると、次の確認も始まらなくなる
const REQUEST_TIMEOUT_MS = 15_000;
// 続けて問い合わせると回数制限（HTTP 429）で断られるので、問い合わせの間を空ける
const REQUEST_GAP_MS = 1_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 探す書名の候補。書名そのまま → 括弧（叢書名など）を除く → 副題を除く → 空白で区切った最も長い語。
 * Play ブックスの書名は副題や叢書名まで 1 行に入っていて、そのままでは見つからないことが多い
 * shorten: false なら括弧を除くところまで（副題・語に縮めない）
 * @param {string} title @returns {string[]}
 */
export function titleCandidates(title, { shorten = true } = {}) {
  const full = String(title || '').trim();
  const noBrackets = full.replace(/[（(【［[][^）)】］\]]*[）)】］\]]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!shorten) return [...new Set([full, noBrackets].filter(Boolean))];
  const noSubtitle = noBrackets.split(/[:：―～]/)[0].trim();
  const longest = noSubtitle.split(/\s+/).reduce((a, b) => ([...b].length > [...a].length ? b : a), '');
  return [...new Set([full, noBrackets, noSubtitle, longest].filter(Boolean))];
}

/**
 * 書名・著者が一致する本の ISBN（ISBN-10 にできるもの）を国立国会図書館サーチで探す。見つからなければ空。通信できなければ例外
 * @param {{ title: string, author?: string }} book
 */
export async function findIsbn(book, { fetchImpl = fetch, signal, gapMs = 0 } = {}) {
  const creator = String(book.author || '').split(/[、,，\s]/)[0];
  // 著者が分からない本は、書名を短くして探さない（書名の一部だけで別の本に当たり、その表紙が出続けるため）
  for (const [i, title] of titleCandidates(book.title, { shorten: Boolean(creator) }).entries()) {
    if (i && gapMs) await sleep(gapMs);
    const params = new URLSearchParams({ title, mediatype: 'books', cnt: '10' });
    if (creator) params.set('creator', creator);
    const res = await fetchImpl(`${NDL}?${params}`, { signal: signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw Object.assign(new Error(`国立国会図書館サーチ: HTTP ${res.status}`), { status: res.status });
    const items = parseNdlRss(await res.text()).filter((it) => isbn10(it.isbn));
    const hit = matchVolume(items, { title, author: book.author || '' });
    if (hit) return hit.isbn;
  }
  return '';
}

/** 探す対象: Play ブックスの本で、表紙を自分で付けておらず、ASIN・ISBN が無く、まだ探していない本 */
export function booksNeedingIsbn(library, tried = {}) {
  return Object.values(library.books || {}).filter(
    (b) => b && !b.deleted && (b.sources || []).includes('playbooks') && !b.cover && !b.asin && !b.isbn && !Object.hasOwn(tried, b.id),
  );
}

/**
 * 表紙の取れない本に ISBN を付ける。探した本は state.json の coverLookup.tried に残し、二度探さない
 * （書名を直すと本の ID が変わるので、そのときは探し直す）。通信できなかった本は残さず、次の確認で探し直す
 * @returns {Promise<{ checked: number, found: number }>}
 */
export async function fillMissingIsbns({ store, fetchImpl = fetch, signal, max = PER_RUN, gapMs = REQUEST_GAP_MS }) {
  const tried = (await store.state()).coverLookup?.tried || {};
  const targets = booksNeedingIsbn(await store.library(), tried).slice(0, max);
  const found = {};
  const checked = [];
  for (const [i, b] of targets.entries()) {
    if (i && gapMs) await sleep(gapMs);
    try {
      const isbn = await findIsbn(b, { fetchImpl, signal, gapMs });
      if (isbn) found[b.id] = isbn;
      checked.push(b.id);
    } catch (e) {
      // その本の問い合わせだけが断られた（4xx。混みあっている 429 を除く）なら、探したことにして先へ進む（毎回その本で止まらない）
      if (e.status >= 400 && e.status < 500 && e.status !== 429) {
        checked.push(b.id);
        continue;
      }
      // 通信できない・混みあっている間は続けても失敗するだけなので、次の確認まで待つ
      break;
    }
  }
  if (!checked.length) return { checked: 0, found: 0 };
  await store.lock(async () => {
    // 探している間に取り込み・同期で本が変わっていることがあるので、読み直してから付ける
    const lib = await store.library();
    const now = new Date().toISOString();
    let changed = false;
    for (const [id, isbn] of Object.entries(found)) {
      const b = Object.hasOwn(lib.books, id) ? lib.books[id] : null;
      if (!b || b.isbn) continue;
      b.isbn = isbn;
      // ほかの端末へ届くよう更新時刻を進める（取り込みで決まる欄なので、新しい方が採られる）
      b.updatedAt = now;
      changed = true;
    }
    if (changed) await store.saveLibrary(lib);
    // state.json はほかの記録（Kindle・自動の分析）と共有なので、読み直してから書く
    const st = await store.state();
    const prev = st.coverLookup?.tried || {};
    await store.saveState({ ...st, coverLookup: { ...st.coverLookup, tried: { ...prev, ...Object.fromEntries(checked.map((id) => [id, now])) } } });
  });
  return { checked: checked.length, found: Object.keys(found).length };
}

/** bh serve の中で定期的に fillMissingIsbns を呼ぶ（起動の少しあとに 1 回目）。失敗しても止めない */
export function startCoverLookup({ store, intervalMs = LOOKUP_INTERVAL_MS, firstDelayMs = 30_000, log = console.log }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await fillMissingIsbns({ store });
      if (r.found) log(`[cover] 表紙のための ISBN を ${r.found} 冊に付けました（${r.checked} 冊を探しました）`);
    } catch (e) {
      log(`[cover] ${e.message}`);
    } finally {
      running = false;
    }
  };
  const timers = [setTimeout(tick, firstDelayMs), setInterval(tick, intervalMs)];
  return { stop: () => timers.forEach((t) => clearTimeout(t)) };
}
