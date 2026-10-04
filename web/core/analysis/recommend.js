// おすすめの本と書誌データベース
//
// ローカル LLM は存在しない本をもっともらしく挙げることがある。そこで
//   1. 書誌 DB で「実在する候補」を集め、LLM にはその中から選ばせる（Google Books → CiNii Books → 国立国会図書館サーチ）
//   2. 検索できないときは LLM に書名を挙げさせ、Google Books → 国立国会図書館サーチ の順で実在を確認する
// どちらもブラウザ（CORS 対応）と PC の両方から呼べる。

import { bookKey } from '../text.js';

const GOOGLE = 'https://www.googleapis.com/books/v1/volumes';
const NDL = 'https://ndlsearch.ndl.go.jp/api/opensearch';
const CINII = 'https://ci.nii.ac.jp/books/opensearch/search';

function fetcher(fetchImpl) {
  return fetchImpl || globalThis.fetch?.bind(globalThis);
}

async function getJson(doFetch, url, signal) {
  const res = await doFetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function httpsOnly(url) {
  return /^https:\/\/[^\s"'<>]+$/.test(String(url || '')) ? url : '';
}

function fromGoogle(it) {
  const info = it.volumeInfo || {};
  return {
    title: (info.title || '') + (info.subtitle ? ` ${info.subtitle}` : ''),
    authors: (info.authors || []).join(', '),
    publishedDate: info.publishedDate || '',
    description: String(info.description || '').replace(/\s+/g, ' ').slice(0, 160),
    link: httpsOnly(info.infoLink) || httpsOnly(info.canonicalVolumeLink) || `https://books.google.com/books?id=${encodeURIComponent(it.id)}`,
    thumbnail: httpsOnly(String(info.imageLinks?.thumbnail || '').replace(/^http:/, 'https:')),
    isbn: (info.industryIdentifiers || []).find((x) => x.type === 'ISBN_13')?.identifier || '',
    source: 'Google Books',
  };
}

/**
 * キーワードで本を探す。Google Books（関連度順）→ CiNii Books（所蔵館の多い順）→ 国立国会図書館サーチ
 * （書名にキーワードを含む本・新しい順）の順に、使えるところで探す。どこにも通信できなければ例外。
 * 鍵なしの Google Books は回数制限で使えないことが多い（2026-10 に 1 日の上限が 0 になっているのを確認）
 */
export async function searchBooks(query, { fetchImpl, signal, max = 6, lang = 'ja', now = new Date() } = {}) {
  const doFetch = fetcher(fetchImpl);
  try {
    const url = `${GOOGLE}?q=${encodeURIComponent(query)}&maxResults=${max}&printType=books&orderBy=relevance${lang ? `&langRestrict=${lang}` : ''}`;
    const data = await getJson(doFetch, url, signal);
    return (data.items || []).map(fromGoogle).filter((b) => b.title);
  } catch (e) {
    if (signal?.aborted) throw e;
  }
  try {
    const found = await searchCinii(doFetch, query, { signal, max, now });
    if (found.length) return found;
  } catch (e) {
    if (signal?.aborted) throw e;
  }
  // CiNii に通信できない・条件に合う本が無いときは国立国会図書館サーチ
  return searchNdl(doFetch, query, { signal, max });
}

// CiNii Books で候補にする出版年の幅（古い専門書ばかりにならないように）
const CINII_MAX_AGE_YEARS = 25;

/**
 * CiNii Books（大学図書館の総合目録）。国立国会図書館サーチと違ってキーワードの関連度で探せる。
 * 関連度の高い 40 件のうち、ISBN があって新しすぎず古すぎない本を、所蔵館の多い順（=定番の本）に並べる
 */
async function searchCinii(doFetch, query, { signal, max, now }) {
  const data = await getJson(doFetch, `${CINII}?${new URLSearchParams({ q: query, format: 'json', count: '40' })}`, signal);
  const minYear = now.getFullYear() - CINII_MAX_AGE_YEARS;
  return parseCinii(data)
    .filter((b) => b.isbn && (parseInt(b.publishedDate, 10) || 0) >= minYear)
    .sort((a, b) => b.owners - a.owners)
    .slice(0, max)
    .map(({ owners, ...b }) => b);
}

/** CiNii Books OpenSearch の JSON を読む */
export function parseCinii(data) {
  const items = data?.['@graph']?.[0]?.items;
  return (Array.isArray(items) ? items : [])
    .map((it) => ({
      title: String(it.title || '').trim(),
      // 「山田太郎著」「佐藤花子編」の役割表示を外す
      authors: String(it['dc:creator'] || '').replace(/\s*[著編訳監修]+(?=\s*(;|$))/g, '').replace(/\s*;\s*/g, ', ').trim(),
      publishedDate: String(it['dc:date'] || ''),
      link: httpsOnly(it['@id']),
      thumbnail: '',
      isbn: ([].concat(it['dcterms:hasPart'] || []).map((p) => String(p?.['@id'] || '').match(/^urn:isbn:([\dX]{10,13})$/i)?.[1]).find(Boolean) || '').toUpperCase(),
      owners: parseInt(it['cinii:ownerCount'], 10) || 0,
      source: 'CiNii Books',
    }))
    .filter((b) => b.title);
}

async function searchNdl(doFetch, query, { signal, max }) {
  const words = String(query).split(/\s+/).filter(Boolean);
  let items = [];
  // 書名に全ての語を含む本 → 無ければ最初の語だけ
  for (const title of [words.join(' '), words[0]]) {
    if (!title) continue;
    const res = await doFetch(`${NDL}?${new URLSearchParams({ title, cnt: '40' })}`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    items = parseNdlRss(await res.text()).filter((b) => b.isbn);
    if (items.length) break;
  }
  return items.sort((a, b) => String(b.publishedDate).localeCompare(String(a.publishedDate))).slice(0, max);
}

/** 国立国会図書館サーチの OpenSearch（RSS）を読む。DOM を使わない */
export function parseNdlRss(xml) {
  const items = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const text = (re) => (it.match(re)?.[1] || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
    const categories = [...it.matchAll(/<category>([^<]*)<\/category>/g)].map((x) => x[1]);
    if (categories.length && !categories.includes('図書')) continue;
    const creators = [...it.matchAll(/<dc:creator>([^<]*)<\/dc:creator>/g)].map((x) => x[1].replace(/,\s*\d{4}-(\d{4})?$/, '').replace(/,\s*/g, ' ').trim());
    items.push({
      title: text(/<dc:title>([^<]*)<\/dc:title>/) || text(/<title>([^<]*)<\/title>/),
      authors: creators.join(', '),
      publishedDate: text(/<dc:date[^>]*>([^<]*)<\/dc:date>/),
      link: httpsOnly(text(/<link>([^<]*)<\/link>/)),
      thumbnail: '',
      isbn: text(/<dc:identifier xsi:type="dcndl:ISBN">([^<]*)<\/dc:identifier>/).replace(/-/g, ''),
      source: '国立国会図書館サーチ',
    });
  }
  return items;
}

async function ndlLookup(doFetch, rec, signal) {
  const params = new URLSearchParams({ title: rec.title, cnt: '10' });
  if (rec.author) params.set('creator', rec.author.split(/[、,，\s]/)[0]);
  const res = await doFetch(`${NDL}?${params}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return matchVolume(parseNdlRss(await res.text()), rec);
}

async function googleLookup(doFetch, rec, signal) {
  for (const q of [`intitle:${rec.title} inauthor:${rec.author}`, `intitle:${rec.title}`]) {
    const data = await getJson(doFetch, `${GOOGLE}?q=${encodeURIComponent(q)}&maxResults=5&printType=books`, signal);
    const v = matchVolume((data.items || []).map(fromGoogle), rec);
    if (v) return v;
  }
  return null;
}

/**
 * LLM が挙げた本の実在確認。verified: 見つかった書誌 / false: どこにも無い / undefined: 確認できなかった（通信不可）
 */
export async function verifyBooks(recs, { fetchImpl, signal } = {}) {
  const doFetch = fetcher(fetchImpl);
  if (!doFetch) return recs;
  const out = [];
  for (const r of recs) {
    let result;
    let reached = false;
    for (const lookup of [googleLookup, ndlLookup]) {
      try {
        result = await lookup(doFetch, r, signal);
        reached = true;
        if (result) break;
      } catch {
        /* 次の書誌 DB へ */
      }
    }
    out.push(reached ? { ...r, verified: result || false } : { ...r });
  }
  return out;
}

/** 検索結果（fromGoogle / parseNdlRss の形）から書名と著者が一致するものを選ぶ */
export function matchVolume(items, rec) {
  const want = bookKey(rec.title);
  const wantAuthor = bookKey(rec.author || '');
  for (const it of items) {
    const got = bookKey(it.title || '');
    if (!got || !want) continue;
    const titleOk = got === want || (want.length >= 4 && got.includes(want)) || (got.length >= 4 && want.includes(got));
    if (!titleOk) continue;
    if (wantAuthor && it.authors) {
      const names = String(it.authors).split(/[,、]\s*/).map(bookKey).filter((x) => x.length >= 2);
      const all = bookKey(it.authors);
      const authorOk = all.includes(wantAuthor) || wantAuthor.includes(all) || names.some((x) => wantAuthor.includes(x) || x.includes(wantAuthor));
      if (!authorOk) continue;
    }
    const { description, ...rest } = it;
    return rest;
  }
  return null;
}
