// 読書記録（GitHub の records ブランチにある records.json）を扱う純関数。ブラウザと Node で共用する。
// 形: { version: 1, records: { "<本の ID>": {
//   title, author, asin, volumeId（表紙に使う）, read_on: "YYYY-MM-DD"（読み終えた日）, pages: 整数|null（ページ数）, updated_at
// } }, excluded: { "<本の ID>": 外した時刻 } }
// 本の ID はライブラリの本の ID（線を引いた本）か、MANUAL_ID_PREFIX 付きの ID（ライブラリに無い本を手で足したもの）。
// 1 冊 = 1 件。読んだ日に、その本の冊数とページ数を数える。
// 読んだ日は 'YYYY-MM-DD' の文字列のまま扱い、Date に変換しない（UTC 解釈で日付がずれるため）。
//
// 自動の記録: 線が 1 本でもある本は読み終えたとみなす（autoRecords）。records.json には書かず、表示のたびにライブラリから作る。
// 手で記録した本（records）と、利用者が記録から外した本（excluded）は自動にしない。

import { listBooks } from './model.js';

export const RECORDS_VERSION = 1;
export const MANUAL_ID_PREFIX = 'manual-';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ASIN = /^[A-Z0-9]{10}$/;
const VOLUME_ID = /^[\w-]{3,24}$/;
// 1 冊のページ数の上限（打ち間違いで集計が壊れないように）
export const MAX_PAGES = 20000;

export function emptyRecordsFile() {
  return { version: RECORDS_VERSION, records: {} };
}

export function isValidDate(value) {
  const match = typeof value === 'string' && DATE_RE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function isValidPages(value) {
  return value === null || (Number.isInteger(value) && value >= 1 && value <= MAX_PAGES);
}

export function isManualId(bookId) {
  return String(bookId).startsWith(MANUAL_ID_PREFIX);
}

export function newManualId(now = Date.now(), random = Math.random) {
  return `${MANUAL_ID_PREFIX}${now.toString(36)}${Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0')}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** 取得したファイル全体の形を確かめる。不正なら例外にし、読めないファイルを上書き保存させない */
export function assertRecordsShape(json) {
  if (!isPlainObject(json) || !isPlainObject(json.records)) {
    throw Object.assign(new Error('records.json の形が不正です'), { kind: 'parse' });
  }
  return json;
}

/** 表示用に正規化する。読んだ日が読めない項目は捨て、それ以外の値は安全な既定値へ倒す */
export function parseRecordsFile(json) {
  assertRecordsShape(json);
  const records = {};
  for (const [bookId, entry] of Object.entries(json.records)) {
    // __proto__ を鍵にすると、入れ物の継承元を書き換えてしまう
    if (bookId === '__proto__' || !isPlainObject(entry) || !isValidDate(entry.read_on)) continue;
    records[bookId] = {
      title: text(entry.title, 200),
      author: text(entry.author, 100),
      asin: ASIN.test(entry.asin || '') ? entry.asin : '',
      volumeId: VOLUME_ID.test(entry.volumeId || '') ? entry.volumeId : '',
      read_on: entry.read_on,
      pages: isValidPages(entry.pages) ? entry.pages : null,
      updated_at: typeof entry.updated_at === 'string' ? entry.updated_at : '',
    };
  }
  const excluded = {};
  if (isPlainObject(json.excluded)) for (const [bookId, at] of Object.entries(json.excluded)) if (bookId !== '__proto__' && typeof at === 'string') excluded[bookId] = at;
  return { version: RECORDS_VERSION, records, excluded };
}

/** 入力欄のページ数（空なら null）。数でない・範囲外なら例外 */
export function parsePagesInput(value) {
  const s = String(value ?? '').trim().normalize('NFKC');
  if (!s) return null;
  const n = Number(s);
  if (!isValidPages(n)) throw new Error(`ページ数は 1〜${MAX_PAGES} の整数で入れてください`);
  return n;
}

/**
 * 1 件の変更を当てた新しいファイルを返す（引数は変更しない）。
 * 変更する本以外の項目・未知のキーはそのまま残す（他端末や将来の版が書いた内容を消さないため）
 * change = { type: 'read', book_id, title, author?, asin?, volumeId?, read_on, pages? } | { type: 'remove', book_id }
 *        | { type: 'exclude', book_id }（記録を消し、線があっても自動で記録しない本にする）
 */
export function applyChange(file, change, now) {
  const bookId = String(change?.book_id ?? '');
  if (!bookId) throw new Error('book_id がありません');
  const records = { ...file.records };
  const excluded = { ...(isPlainObject(file.excluded) ? file.excluded : {}) };
  if (change.type === 'remove') {
    delete records[bookId];
  } else if (change.type === 'exclude') {
    delete records[bookId];
    excluded[bookId] = now;
  } else if (change.type === 'read') {
    delete excluded[bookId];
    if (!isValidDate(change.read_on)) throw new Error('読んだ日が不正です');
    const pages = change.pages ?? null;
    if (!isValidPages(pages)) throw new Error('ページ数が不正です');
    const title = text(change.title, 200);
    if (!title) throw new Error('書名がありません');
    records[bookId] = {
      title,
      author: text(change.author, 100),
      asin: ASIN.test(change.asin || '') ? change.asin : '',
      volumeId: VOLUME_ID.test(change.volumeId || '') ? change.volumeId : '',
      read_on: change.read_on,
      pages,
      updated_at: now,
    };
  } else {
    throw new Error('未知の変更です');
  }
  return { ...file, records, excluded };
}

// 線を引いた時刻は日本時間の日付にする（Play ブックスのメモの日付は日本時間の 0 時で入るので、端末の時間帯で日付が変わらないように）
const JST_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });

/** 本ごとの最初の線の日（日本時間）。日付のある線だけを見る */
function firstHighlightDates(library) {
  const first = new Map();
  for (const h of Object.values(library.highlights)) {
    if (h.deleted || !h.createdAt) continue;
    // 日付だけの値は Date に通すと UTC の 0 時として読まれてずれるので、そのまま使う
    const time = isValidDate(h.createdAt) ? null : new Date(h.createdAt);
    if (time && Number.isNaN(time.getTime())) continue;
    const date = time ? JST_DATE.format(time) : h.createdAt;
    if (!first.has(h.bookId) || date < first.get(h.bookId)) first.set(h.bookId, date);
  }
  return first;
}

/**
 * 線が 1 本でもある本を、読み終えた本として自動で記録したもの（records.json には書かない）。
 * 読んだ日は最初に線を引いた日。線に日付が無ければ Kindle の最終ハイライト日（Book.annotatedOn）。
 * 手で記録した本・記録から外した本は除く。読んだ日が分からない本は undated に回す（月・日の集計に入れない）
 * 戻り値: { dated: { "<本の ID>": 記録 }, undated: [記録] }。記録には auto: true が付く
 */
export function autoRecords(library, file) {
  const dated = {};
  const undated = [];
  const firstDates = firstHighlightDates(library);
  for (const book of listBooks(library)) {
    if (Object.hasOwn(file.records, book.id) || Object.hasOwn(file.excluded ?? {}, book.id)) continue;
    const entry = {
      title: book.title,
      author: book.author || '',
      asin: ASIN.test(book.asin || '') ? book.asin : '',
      volumeId: VOLUME_ID.test(book.volumeId || '') ? book.volumeId : '',
      read_on: firstDates.get(book.id) || (isValidDate(book.annotatedOn) ? book.annotatedOn : ''),
      pages: null,
      auto: true,
    };
    if (entry.read_on) dated[book.id] = entry;
    else undated.push({ book_id: book.id, ...entry });
  }
  undated.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  return { dated, undated };
}

export function encodeBase64Utf8(s) {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64Utf8(base64) {
  const binary = atob(String(base64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** 端末のローカル日付（日本時間の朝 9 時前に前日にならないよう UTC を使わない） */
export function todayLocal(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---- 集計（年・月・日） ----

function entriesOf(records) {
  return Object.entries(records ?? {}).map(([bookId, entry]) => ({ book_id: bookId, ...entry }));
}

function prefixOf(year, month) {
  return month ? `${year}-${String(month).padStart(2, '0')}-` : `${year}-`;
}

/** 冊数・ページ数（ページ数が分からない本は合計に含めず unknownCount に数える） */
function totals(items) {
  return {
    count: items.length,
    pages: items.reduce((sum, item) => sum + (item.pages ?? 0), 0),
    unknownCount: items.filter((item) => item.pages == null).length,
  };
}

/** 月のまとめと、日ごとの一覧（新しい日から） */
export function summarizeMonth(records, year, month) {
  const items = entriesOf(records).filter((item) => item.read_on.startsWith(prefixOf(year, month)));
  const byDate = new Map();
  for (const item of items) byDate.set(item.read_on, [...(byDate.get(item.read_on) ?? []), item]);
  const days = [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([date, dayItems]) => ({ date, ...totals(dayItems), items: [...dayItems].sort((a, b) => a.title.localeCompare(b.title, 'ja')) }));
  return { ...totals(items), days };
}

/** 年のまとめと、月ごとの冊数・ページ数（1〜12 月） */
export function summarizeYear(records, year) {
  const items = entriesOf(records).filter((item) => item.read_on.startsWith(prefixOf(year)));
  const months = Array.from({ length: 12 }, (_, index) => {
    const { count, pages } = totals(items.filter((item) => item.read_on.startsWith(prefixOf(year, index + 1))));
    return { month: index + 1, count, pages };
  });
  return { ...totals(items), months };
}

/** 手で付けた記録と、線から自動で付けた記録を合わせたもの（手で付けた記録が優先）。読んだ日が分からない本は undated */
export function mergedRecords(library, file) {
  const auto = autoRecords(library, file);
  return { records: { ...auto.dated, ...file.records }, undated: auto.undated };
}

/** その月の冊数・ページ数（手で付けた記録と自動の記録を合わせて数える。ホームの 1 行に使う） */
export function monthReading(library, file, year, month) {
  const { count, pages, unknownCount } = summarizeMonth(mergedRecords(library, file).records, year, month);
  return { year, month, count, pages, unknownCount };
}

export function addMonths(year, month, delta) {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export function weekdayLabel(date) {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()];
}
