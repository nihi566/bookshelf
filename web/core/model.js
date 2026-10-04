// ライブラリ（本とハイライト）の正規化モデルとマージ処理
//
// 「点」= 1 つのハイライト。取り込み元（Kindle / Play Books）が違っても同じ形で扱う。
// パーサは ParsedBook[] を返し、mergeParsed() でライブラリへ取り込む。
//
// ParsedBook = { title, author, source, asin?, volumeId?（Play ブックスの書籍 ID）, annotatedOn?（Kindle の最終ハイライト日 'YYYY-MM-DD'）, highlights: ParsedHighlight[] }
// Book.annotatedOn … 最初に取り込んだときの Kindle の最終ハイライト日（線そのものに日付が無い Kindle の本の、読書記録の日付に使う。古い日を残す）
// ParsedHighlight = { text, note?, chapter?, location?, locationEnd?, page?, color?, createdAt?, kind? }

import { bookKey, cleanText, hash, normalizeText } from './text.js';
import { isUploadedCover } from './covers.js';
import { mergeCollections } from './collections.js';
import { mergeThought, normalizeThought, pointThoughts } from './thoughts.js';
import { mergeReads } from './discovery-reads.js';

export const SOURCES = {
  kindle: 'Kindle',
  playbooks: 'Play Books',
  paper: '紙の本',
  // Obsidian などに書いていた読書メモ（Markdown）から移したもの
  memo: '読書メモ',
  manual: '手入力',
};

export const LIBRARY_VERSION = 1;

// ---- 技術書（IT の教科書）。線は残して見られるが、「点」には数えない（件数・今日の点・AI 分析から外す） ----

// 英字の語は前後が英字でないときだけ一致させる（"digital" の git、"javanese" の java などに反応しない）。
// 後読み（?<!）は古い iOS Safari でモジュールごと読めなくなるので使わない
const TECH_WORDS = /(?:^|[^a-z])(?:sql|mysql|postgresql|php|python|javascript|typescript|java|ruby|rails|golang|rust|c\+\+|c#|html|css|linux|unix|git|github|docker|kubernetes|aws|azure|gcp|tcp\/ip|http|api|react|vue|laravel|devops)(?![a-z])/;
const TECH_PHRASES = /データベース|db設計|プログラミング|プログラマ|ソフトウェア|フロントエンド|バックエンド|インフラ|ネットワーク入門|オブジェクト指向|アルゴリズム|データ構造|機械学習|深層学習|ディープラーニング|コマンドライン|シェルスクリプト|itエンジニア|要件定義|システム設計|システム開発|aiのしくみ|web技術|webを支える|コンピュータ|情報処理|テスト駆動|リファクタリング/;

/** 書名から IT の教科書かどうかを推定する */
export function guessTechnical(title) {
  // 「PHP新書」「PHP文庫」は出版社（PHP研究所）の名前で、プログラミング言語ではない
  const t = normalizeText(title).replace(/php(?:新書|文庫|研究所|ビジネス新書|文芸文庫|エディターズ)/g, '');
  return TECH_WORDS.test(t) || TECH_PHRASES.test(t);
}

/** 技術書か。本で決めた値（technical: true / false）があればそれを、無ければ書名から推定する */
export function isTechnicalBook(book) {
  if (!book) return false;
  return typeof book.technical === 'boolean' ? book.technical : guessTechnical(book.title);
}

// thoughts: 本に属さない思いつき（thoughts.js）。古い版のデータには無いので、読むときは thoughtsOf() を通す
export function emptyLibrary() {
  return { version: LIBRARY_VERSION, books: {}, highlights: {}, feedback: {}, thoughts: {}, updatedAt: null };
}

// ---- おすすめの本への反応（読んだ／読みたい／興味なし）。同期され、次のおすすめの選定に使う ----

export const FEEDBACK_LABELS = { read: '読んだ', want: '読みたい', no: '興味なし' };

export function feedbackFor(library, title) {
  const f = library.feedback?.[bookKey(title)];
  return f && f.status ? f : null;
}

/** 反応を付ける。同じ反応をもう一度付けると外す（status: ''） */
export function setFeedback(library, { title, author = '' }, status, now = new Date().toISOString()) {
  if (!Object.hasOwn(FEEDBACK_LABELS, status)) throw new Error(`不明な反応: ${status}`);
  const key = bookKey(title);
  library.feedback = library.feedback || {};
  const cur = library.feedback[key];
  const next = cur?.status === status ? '' : status;
  library.feedback[key] = { key, title: cleanText(title), author: cleanText(author) || cur?.author || '', status: next, updatedAt: now };
  library.updatedAt = now;
  return library.feedback[key];
}

/** 反応ごとの書名の一覧 { read: [...], want: [...], no: [...] } */
export function feedbackByStatus(library) {
  const out = { read: [], want: [], no: [] };
  for (const f of Object.values(library.feedback || {}).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))) if (out[f.status]) out[f.status].push(f);
  return out;
}

export function bookIdFor(title) {
  return 'b' + hash(bookKey(title));
}

export function highlightIdFor(bookId, text) {
  return 'h' + hash(bookId + '|' + normalizeText(text));
}

/**
 * パース結果をライブラリに取り込む。ユーザーの編集（お気に入り・タグ・メモ・削除）は保持する
 * reviveDeleted: false … 削除済みの本は復活させずに飛ばす（ブラウザ拡張の自動取り込みなど、人が操作していない取り込み用）
 */
export function mergeParsed(library, parsedBooks, { now = new Date().toISOString(), reviveDeleted = true } = {}) {
  // memoTitles: 読書メモの書名を既にある本の書名に合わせたもの（取り込み結果で知らせる）
  const stats = { books: 0, booksAdded: 0, booksUpdated: 0, added: 0, updated: 0, unchanged: 0, skippedDeleted: 0, skippedDeletedBooks: 0, memoTitles: [] };
  for (const pb of parsedBooks) {
    // 書名・著者は 1 行にする（改行入りの書名で Markdown の見出しが崩れないように）
    const rawTitle = cleanText(pb.title).replace(/\s+/g, ' ');
    if (!rawTitle) continue;
    const title = pb.source === 'memo' ? noteBookTitle(library, rawTitle) : rawTitle;
    if (title !== rawTitle) stats.memoTitles.push({ from: rawTitle, to: title });
    const bookId = bookIdFor(title);
    let book = library.books[bookId];
    const isNew = !book;
    if (!book) {
      book = library.books[bookId] = {
        id: bookId,
        title,
        author: cleanText(pb.author).replace(/\s+/g, ' '),
        sources: [],
        createdAt: now,
        updatedAt: now,
      };
      stats.booksAdded++;
    } else if (book.deleted && !reviveDeleted) {
      stats.skippedDeletedBooks++;
      continue;
    } else if (book.deleted) {
      // 削除済みの本に再取り込みがあった場合は、本と一緒に消した点ごと復活させる（明示的な取り込み操作のため）
      delete book.deleted;
      book.updatedAt = now;
      book.userUpdatedAt = now;
      for (const h of Object.values(library.highlights)) {
        if (h.bookId === bookId && h.deletedWithBook) {
          keepUserStamp(h);
          delete h.deleted;
          delete h.deletedWithBook;
          h.updatedAt = now;
          h.userUpdatedAt = now;
        }
      }
    }
    stats.books++;
    if (!book.author && pb.author) book.author = cleanText(pb.author).replace(/\s+/g, ' ');
    // 表紙に使う ID。既にある本に後から付いたときも保存し直せるよう数える
    const coverIds = ['asin', 'volumeId'].filter((k) => pb[k] && !book[k]);
    for (const k of coverIds) book[k] = pb[k];
    const annotated = pb.annotatedOn && (!book.annotatedOn || pb.annotatedOn < book.annotatedOn);
    if (annotated) book.annotatedOn = pb.annotatedOn;
    if ((coverIds.length || annotated) && !isNew) {
      book.updatedAt = now;
      stats.booksUpdated++;
    }
    if (!book.sources.includes(pb.source)) book.sources.push(pb.source);

    const existing = Object.values(library.highlights).filter((h) => h.bookId === bookId);
    const cleaned = pb.highlights.map((h) => ({ ...h, text: cleanText(h.text), note: cleanText(h.note) })).filter((h) => h.text);
    // 伸ばす前の短いハイライトが残るのは Kindle だけ。Play ブックスは現在のハイライトだけが並ぶので、包含関係で消さない
    const extendable = pb.source === 'kindle';
    const incoming = extendable ? dedupeContained(cleaned) : cleaned;
    for (const ph of incoming) {
      const id = highlightIdFor(bookId, ph.text);
      const current = library.highlights[id];
      if (current) {
        if (current.deleted) {
          stats.skippedDeleted++;
          continue;
        }
        if (fillMissing(current, ph, now)) stats.updated++;
        else stats.unchanged++;
        continue;
      }
      // 読書メモは Kindle・Play ブックスの線を写したものが多い。既にある線に含まれる文は増やさない
      // 短い文（「習慣」など）はどの線にも含まれがちなので、含む判定はある程度の長さの文だけにする
      const c = compact(ph.text);
      if (pb.source === 'memo' && existing.some((h) => (c.length >= MEMO_CONTAINED_MIN ? compact(h.text).includes(c) : compact(h.text) === c))) {
        stats.unchanged++;
        continue;
      }
      // Kindle はハイライトを伸ばすと古い短い版も残るので、包含関係で置き換える
      const norm = normalizeText(ph.text);
      const sameSpot = (h) => extendable && h.source === pb.source && locationsOverlap(h, ph);
      const shorter = existing.find((h) => sameSpot(h) && !h.deleted && h.text.length < ph.text.length && norm.includes(normalizeText(h.text)));
      if (existing.some((h) => sameSpot(h) && h.text.length > ph.text.length && normalizeText(h.text).includes(norm))) {
        stats.unchanged++;
        continue;
      }
      const hl = {
        id,
        bookId,
        source: pb.source,
        kind: ph.kind || 'highlight',
        text: ph.text,
        note: ph.note || '',
        chapter: cleanText(ph.chapter) || '',
        location: numOrNull(ph.location),
        locationEnd: numOrNull(ph.locationEnd),
        page: ph.page != null && ph.page !== '' ? String(ph.page) : '',
        color: ph.color || '',
        createdAt: ph.createdAt || null,
        importedAt: now,
        updatedAt: now,
        favorite: false,
        tags: [],
        userNote: '',
      };
      if (shorter) {
        // ユーザーの編集を引き継いで古い方を置き換える
        hl.favorite = shorter.favorite;
        hl.tags = shorter.tags;
        hl.userNote = shorter.userNote;
        hl.importedAt = shorter.importedAt;
        keepUserStamp(shorter);
        if (shorter.userUpdatedAt) hl.userUpdatedAt = shorter.userUpdatedAt;
        shorter.deleted = true;
        shorter.supersededBy = id;
        shorter.updatedAt = now;
      }
      library.highlights[id] = hl;
      existing.push(hl);
      stats.added++;
    }
    book.updatedAt = now;
  }
  library.updatedAt = now;
  return stats;
}

const MEMO_CONTAINED_MIN = 12;

/** 空白・改行の違いを無視して比べるための形 */
function compact(text) {
  return normalizeText(text).replace(/\s/g, '');
}

/**
 * 読書メモの書名を、既にある本の書名に合わせる。メモの書名は短く書かれがち（「ハマトン」→『新版 ハマトンの知的生活』）なので、
 * 同じ書名の本が無く、メモの書名を含む本がちょうど 1 冊だけあるときはその本にまとめる（2 冊以上なら決めつけない）
 */
function noteBookTitle(library, title) {
  if (library.books[bookIdFor(title)]) return title;
  const key = bookKey(title);
  if (key.length < 3) return title;
  const hits = Object.values(library.books).filter((b) => !b.deleted && bookKey(b.title).includes(key));
  return hits.length === 1 ? hits[0].title : title;
}

/** 古い版のデータ（userUpdatedAt 無し）で編集の跡があれば、updatedAt を進める前にその時刻を編集時刻として残す */
function keepUserStamp(item) {
  if (!item.userUpdatedAt && (item.favorite || item.tags?.length || item.userNote || (item.deleted && !item.supersededBy))) item.userUpdatedAt = item.updatedAt;
}

function fillMissing(target, src, now) {
  keepUserStamp(target);
  let changed = false;
  for (const key of ['note', 'chapter', 'page', 'color', 'createdAt']) {
    if (!target[key] && src[key]) {
      target[key] = key === 'page' ? String(src[key]) : src[key];
      changed = true;
    }
  }
  for (const key of ['location', 'locationEnd']) {
    if (target[key] == null && numOrNull(src[key]) != null) {
      target[key] = numOrNull(src[key]);
      changed = true;
    }
  }
  if (changed) target.updatedAt = now;
  return changed;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 同じ箇所のハイライトか。位置が無ければページで比べ、どちらも無ければ別の箇所とみなす（消しすぎないように） */
function locationsOverlap(a, b) {
  const as = numOrNull(a.location);
  const bs = numOrNull(b.location);
  if (as == null || bs == null) return Boolean(a.page) && String(a.page) === String(b.page ?? '');
  const ae = numOrNull(a.locationEnd) ?? as;
  const be = numOrNull(b.locationEnd) ?? bs;
  return as <= be + 1 && bs <= ae + 1;
}

/** 同じ取り込み内で、他のハイライトに完全に含まれる短いハイライトを除く（Kindle の伸ばしたハイライト対策） */
export function dedupeContained(highlights) {
  const result = [];
  const sorted = highlights.map((h, i) => ({ h, i, n: normalizeText(h.text) })).sort((a, b) => b.n.length - a.n.length);
  const kept = [];
  for (const item of sorted) {
    const dup = kept.find((k) => k.n.includes(item.n) && locationsOverlap(k.h, item.h));
    if (dup) {
      if (!dup.h.note && item.h.note) dup.h = { ...dup.h, note: item.h.note };
      continue;
    }
    kept.push(item);
  }
  kept.sort((a, b) => a.i - b.i);
  for (const k of kept) result.push(k.h);
  return result;
}

// 利用者が編集する欄（★・タグ・自分のメモ・削除）。取り込みで埋まる欄とは別の時刻（userUpdatedAt）で比べる
const USER_FIELDS = ['favorite', 'tags', 'userNote', 'deleted', 'deletedWithBook'];
// 本の表紙（アップロードしたもの）と技術書かどうかも、利用者が決める欄
const BOOK_USER_FIELDS = ['deleted', 'technical', 'cover'];

const isBlank = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
const later = (a, b) => ((a || '') > (b || '') ? a : b) || null;

/** 利用者の編集の時刻。古い版のデータ（userUpdatedAt 無し）は、編集の跡があれば updatedAt で代用する */
function userStamp(item, fields) {
  if (item.userUpdatedAt) return item.userUpdatedAt;
  const edited = fields === BOOK_USER_FIELDS ? item.deleted : item.favorite || item.tags?.length || item.userNote || (item.deleted && !item.supersededBy);
  return edited ? item.updatedAt || '' : '';
}

/** 同じ時刻どうしでも結果が向きに依らないよう、内容で順番を決める */
function order(a, b, stampA, stampB) {
  if (stampA !== stampB) return stampA < stampB ? [a, b] : [b, a];
  return JSON.stringify(a) <= JSON.stringify(b) ? [a, b] : [b, a];
}

function mergeItem(a, b, userFields) {
  // 取り込みで決まる欄: 新しい方を基本に、空欄はもう一方で埋める
  const [older, newer] = order(a, b, a.updatedAt || '', b.updatedAt || '');
  const out = { ...structuredClone(older), ...structuredClone(newer) };
  for (const [k, v] of Object.entries(older)) if (!userFields.includes(k) && isBlank(out[k]) && !isBlank(v)) out[k] = structuredClone(v);
  // 利用者の欄: 編集が新しい方をまとめて採用する
  const ua = userStamp(a, userFields);
  const ub = userStamp(b, userFields);
  const [, winner] = order(a, b, ua, ub);
  for (const k of userFields) {
    if (k in winner) out[k] = structuredClone(winner[k]);
    else delete out[k];
  }
  const stamp = later(a.userUpdatedAt, b.userUpdatedAt);
  if (stamp) out.userUpdatedAt = stamp;
  else delete out.userUpdatedAt;
  out.updatedAt = later(a.updatedAt, b.updatedAt);
  return out;
}

function mergeHighlight(a, b) {
  const out = mergeItem(a, b, USER_FIELDS);
  // 伸ばしたハイライトに置き換わった古い点は、どちらの端末から来ても消えたまま
  const supersededBy = [a.supersededBy, b.supersededBy].filter(Boolean).sort()[0];
  if (supersededBy) Object.assign(out, { deleted: true, supersededBy });
  return out;
}

function mergeBook(a, b) {
  const out = mergeItem(a, b, BOOK_USER_FIELDS);
  // ほかの端末から届いた表紙は形を確かめる（画像の data URL でなければ・大きすぎれば持たない）
  if ('cover' in out && !isUploadedCover(out.cover)) delete out.cover;
  const rank = (x) => (Object.keys(SOURCES).indexOf(x) + 1 || 99);
  out.sources = [...new Set([...(a.sources || []), ...(b.sources || [])])].sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
  out.createdAt = [a.createdAt, b.createdAt].filter(Boolean).sort()[0] || out.createdAt;
  const annotatedOn = [a.annotatedOn, b.annotatedOn].filter(Boolean).sort()[0];
  if (annotatedOn) out.annotatedOn = annotatedOn;
  return out;
}

/**
 * 2 つのライブラリを統合する（PC とスマホの同期用）。項目の欄ごとに統合し、どちら向きに統合しても同じ結果になる。
 * - 取り込みで決まる欄（章・色・位置など）は新しい方を採り、空欄はもう一方で埋める
 * - 利用者の欄（★・タグ・自分のメモ・削除）は、利用者が編集した時刻（userUpdatedAt）が新しい方を採る
 */
export function mergeLibraries(base, incoming) {
  const out = structuredClone(base);
  for (const [kind, merge] of [['books', mergeBook], ['highlights', mergeHighlight]]) {
    out[kind] = out[kind] || {};
    for (const [id, item] of Object.entries(incoming[kind] || {})) {
      const cur = out[kind][id];
      out[kind][id] = cur ? merge(cur, item) : structuredClone(item);
    }
  }
  // 片方にしか無かった本の表紙も形を確かめる（mergeBook を通らないため）
  for (const b of Object.values(out.books)) if ('cover' in b && !isUploadedCover(b.cover)) delete b.cover;
  // 置き換わった古い点に、置き換え先より新しい自分の編集（もう一方の端末で未同期だったもの）があれば引き継ぐ
  for (const h of Object.values(out.highlights)) {
    const target = h.supersededBy && out.highlights[h.supersededBy];
    if (!target || target.deleted) continue;
    const hs = userStamp(h, USER_FIELDS);
    if (hs && hs > userStamp(target, USER_FIELDS)) {
      for (const k of ['favorite', 'tags', 'userNote']) target[k] = structuredClone(h[k]);
      target.userUpdatedAt = hs;
      target.updatedAt = later(target.updatedAt, hs);
    }
  }
  // おすすめへの反応は、付けた時刻が新しい方
  out.feedback = { ...(base.feedback || {}) };
  for (const [key, f] of Object.entries(incoming.feedback || {})) {
    const cur = out.feedback[key];
    out.feedback[key] = structuredClone(cur ? order(cur, f, cur.updatedAt || '', f.updatedAt || '')[1] : f);
  }
  // 思いつきは書き直した時刻が新しい方（状態は状態を変えた時刻が新しい方）。消したものはどちらから来ても消えたまま
  out.thoughts = mergeCollections(base.thoughts, incoming.thoughts, { stickyDelete: true, normalize: normalizeThought, mergeItem: mergeThought });
  // 発見の既読は、どちらかで読んでいれば既読（読んだ時刻は早い方）
  out.discoveryReads = mergeReads(base.discoveryReads, incoming.discoveryReads);
  out.updatedAt = later(base.updatedAt, incoming.updatedAt);
  return out;
}

export function liveHighlights(library) {
  return Object.values(library.highlights).filter((h) => !h.deleted && !library.books[h.bookId]?.deleted);
}

/** 「点」として数える線（技術書の線を除く）。件数・今日の点・AI 分析はこれを使う */
export function pointHighlights(library) {
  return liveHighlights(library).filter((h) => !isTechnicalBook(library.books[h.bookId]));
}

/** 本の中での並び順（位置 → ページ → 日付） */
export function compareInBook(a, b) {
  const la = a.location ?? pageNumber(a.page);
  const lb = b.location ?? pageNumber(b.page);
  if (la != null && lb != null && la !== lb) return la - lb;
  if (la != null && lb == null) return -1;
  if (la == null && lb != null) return 1;
  return String(a.createdAt || a.importedAt || '').localeCompare(String(b.createdAt || b.importedAt || ''));
}

function pageNumber(p) {
  const n = parseInt(p, 10);
  return Number.isFinite(n) ? n : null;
}

export function bookHighlights(library, bookId) {
  return liveHighlights(library).filter((h) => h.bookId === bookId).sort(compareInBook);
}

/**
 * 本の一覧（ハイライト数・最終ハイライト日・技術書かどうかつき）。新しく線を引いた順
 * includeEmpty: 線がまだ無い紙の本も含める（登録した直後の本を一覧から開けるように。Obsidian の書き出しなどには含めない）
 */
export function listBooks(library, { includeEmpty = false } = {}) {
  const byBook = new Map();
  for (const h of liveHighlights(library)) {
    const e = byBook.get(h.bookId) || { count: 0, last: '' };
    e.count++;
    const t = h.createdAt || h.importedAt || '';
    if (t > e.last) e.last = t;
    byBook.set(h.bookId, e);
  }
  return Object.values(library.books)
    .filter((b) => !b.deleted && (byBook.has(b.id) || (includeEmpty && b.sources?.includes('paper'))))
    .map((b) => ({ ...b, count: byBook.get(b.id)?.count || 0, lastHighlightedAt: byBook.get(b.id)?.last || b.createdAt || '', isTechnical: isTechnicalBook(b) }))
    .sort((a, b) => b.lastHighlightedAt.localeCompare(a.lastHighlightedAt) || a.title.localeCompare(b.title, 'ja'));
}

/** 全文検索。空白区切りの AND 検索、タグ（#tag）・ソース・お気に入りで絞り込み */
export function searchHighlights(library, query = '', { source = '', favorite = false, bookId = '' } = {}) {
  const terms = normalizeText(query).split(' ').filter(Boolean);
  return liveHighlights(library)
    .filter((h) => (!source || h.source === source) && (!favorite || h.favorite) && (!bookId || h.bookId === bookId))
    .filter((h) => {
      if (!terms.length) return true;
      const book = library.books[h.bookId];
      const hay = normalizeText([h.text, h.note, h.userNote, h.chapter, book?.title, book?.author, ...(h.tags || []).map((t) => '#' + t)].join(' '));
      return terms.every((t) => hay.includes(t));
    })
    .sort((a, b) => String(b.createdAt || b.importedAt).localeCompare(String(a.createdAt || a.importedAt)));
}

export function updateHighlight(library, id, patch, now = new Date().toISOString()) {
  const h = library.highlights[id];
  if (!h) return null;
  const allowed = ['favorite', 'tags', 'userNote', 'deleted'];
  for (const k of allowed) if (k in patch) h[k] = patch[k];
  if (Array.isArray(h.tags)) h.tags = [...new Set(h.tags.map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean))];
  if (patch.deleted === false) delete h.deletedWithBook;
  h.updatedAt = now;
  h.userUpdatedAt = now;
  library.updatedAt = now;
  return h;
}

export function deleteBook(library, bookId, now = new Date().toISOString()) {
  const b = library.books[bookId];
  if (!b) return;
  b.deleted = true;
  b.updatedAt = now;
  b.userUpdatedAt = now;
  for (const h of Object.values(library.highlights)) {
    if (h.bookId === bookId && !h.deleted) {
      h.deleted = true;
      h.deletedWithBook = true;
      h.updatedAt = now;
      h.userUpdatedAt = now;
    }
  }
  library.updatedAt = now;
}

/**
 * highlights は本の点の数（技術書の線を除く）。technical は数えなかった技術書の線の数。
 * thoughts は点になる思いつき（捨てたものを除く）の数、points は分析の点の数（highlights + thoughts）
 */
export function libraryStats(library) {
  const live = liveHighlights(library);
  const hs = live.filter((h) => !isTechnicalBook(library.books[h.bookId]));
  const books = listBooks(library);
  const bySource = {};
  for (const h of hs) bySource[h.source] = (bySource[h.source] || 0) + 1;
  const thoughts = pointThoughts(library).length;
  return { books: books.length, highlights: hs.length, technical: live.length - hs.length, bySource, favorites: hs.filter((h) => h.favorite).length, thoughts, points: hs.length + thoughts };
}

// ---- 紙の本（書名・表紙を登録し、線を引いた文を手で入れる） ----

function oneLine(s) {
  return cleanText(s).replace(/\s+/g, ' ');
}

function checkCover(cover) {
  if (cover && !isUploadedCover(cover)) throw new Error('表紙は JPEG・PNG・WebP の画像にしてください');
}

/**
 * 紙の本を登録する。同じ書名の本が既にあれば、その本に「紙の本」を足す（線はそのまま）
 * technical を省くと書名からの推定に任せる
 */
export function registerBook(library, { title, author = '', cover = '', technical } = {}, now = new Date().toISOString()) {
  const t = oneLine(title);
  if (!t) throw new Error('書名を入力してください');
  checkCover(cover);
  mergeParsed(library, [{ title: t, author: oneLine(author), source: 'paper', highlights: [] }], { now });
  const patch = {};
  if (cover) patch.cover = cover;
  if (typeof technical === 'boolean') patch.technical = technical;
  return updateBook(library, bookIdFor(t), patch, now);
}

/** 本の情報を変える（著者・表紙・技術書）。cover: '' で表紙を外す、technical: null で書名からの推定に戻す */
export function updateBook(library, bookId, patch, now = new Date().toISOString()) {
  const b = library.books[bookId];
  if (!b || b.deleted) throw new Error('本が見つかりません');
  checkCover(patch.cover);
  if ('author' in patch) b.author = oneLine(patch.author);
  if ('cover' in patch) {
    if (patch.cover) b.cover = patch.cover;
    else delete b.cover;
  }
  if ('technical' in patch) {
    if (typeof patch.technical === 'boolean') b.technical = patch.technical;
    else delete b.technical;
  }
  b.updatedAt = now;
  // 表紙・技術書を変えたときだけ利用者の編集時刻を進める（著者だけの修正で、別の端末で付けた表紙を負かさない）
  if ('cover' in patch || 'technical' in patch) b.userUpdatedAt = now;
  library.updatedAt = now;
  return b;
}

/**
 * 紙の本に線を引いた文を足す。同じ文が既にあれば増やさず、消した文なら戻す
 * @returns {{ highlight: object, added: boolean }}
 */
export function addHighlight(library, bookId, { text, page = '', chapter = '', note = '' } = {}, now = new Date().toISOString()) {
  const b = library.books[bookId];
  if (!b || b.deleted) throw new Error('本が見つかりません');
  const t = cleanText(text);
  if (!t) throw new Error('線を引いた文を入力してください');
  const id = highlightIdFor(bookId, t);
  const current = library.highlights[id];
  if (current && !current.deleted) return { highlight: current, added: false };
  if (current) {
    updateHighlight(library, id, { deleted: false }, now);
    delete current.deleted;
    delete current.supersededBy;
    return { highlight: current, added: true };
  }
  mergeParsed(library, [{ title: b.title, source: 'paper', highlights: [{ text: t, page: oneLine(page), chapter: oneLine(chapter), note, createdAt: now }] }], { now });
  return { highlight: library.highlights[id], added: true };
}

/**
 * 日付をシードにした「今日の点」（思いつきも含む。捨てたものは出さない）。同じ日には同じ結果になる
 * seed を渡すと日付の代わりにそれで選ぶ（「別の点」用。日付をずらすと翌日以降の今日の点と同じ組になる）
 */
export function dailyPicks(library, count = 3, date = new Date(), seed = '') {
  const hs = [...pointHighlights(library), ...pointThoughts(library)].sort((a, b) => a.id.localeCompare(b.id));
  if (!hs.length) return [];
  const key = seed ? `seed:${seed}` : `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  const scored = hs.map((h) => ({ h, s: hash(key + h.id) }));
  scored.sort((a, b) => a.s.localeCompare(b.s));
  return scored.slice(0, count).map((x) => x.h);
}
