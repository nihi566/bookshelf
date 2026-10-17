// 1 冊 = 1 つの Markdown（Obsidian の 400_読書メモ に置く読書メモ）との相互変換（NIH-311）。DOM にも fs にも依存しない
//
// ---
// bookId: b123
// title: 書名
// author: 著者
// ---
// ## 章の名前
// - 点の文 ^h123            … 行末の ^ID は Obsidian のブロック ID。これで同じ点と突き合わせる
//   文が複数行なら、続きの行を 2 文字字下げして書く
//   - メモ: 自分のメモ
//   - タグ: #a #b
//   - ★
// - ID の無い箇条書き                … Obsidian で足した新しい点（取り込むと点になる）

import { addHighlight, liveHighlights, registerBook, updateHighlight } from './model.js';

const BLOCK_ID = /\s\^(h[0-9a-z]+)\s*$/;
const SUB_NOTE = /^ {2}- メモ: ?(.*)$/;
const SUB_TAGS = /^ {2}- タグ: ?(.*)$/;
const SUB_STAR = /^ {2}- ★\s*$/;
const TOP_ITEM = /^- (.*)$/;
const FILE_UNSAFE = /[\\/:*?"<>|#^[\]\u0000-\u001f]/g;

/** 書名 → ファイル名（拡張子つき）。Windows と Obsidian のリンクで使えない文字は全角に近い「_」へ */
export function bookNoteFileName(title) {
  const base = String(title ?? '').normalize('NFC').replace(FILE_UNSAFE, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120);
  return `${base || '無題'}.md`;
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 文の中の行頭が「- 」「## 」などでも点の区切りに読まれないよう、続きの行は 2 文字字下げして書く */
function pointLines(h) {
  const [first, ...rest] = String(h.text ?? '').split('\n');
  const lines = [`- ${first}`, ...rest.map((l) => `    ${l}`)];
  lines[lines.length - 1] += ` ^${h.id}`;
  if (h.userNote) lines.push(`  - メモ: ${oneLine(h.userNote)}`);
  const tags = (h.tags || []).map((t) => String(t).replace(/\s+/g, '')).filter(Boolean);
  if (tags.length) lines.push(`  - タグ: ${tags.map((t) => `#${t}`).join(' ')}`);
  if (h.favorite) lines.push('  - ★');
  return lines;
}

/** 本の中の並びで点を章ごとに出す。点が 1 件も無い本は書かない（呼ぶ側が決める） */
export function renderBookNote(library, bookId) {
  const book = library.books[bookId];
  const points = liveHighlights(library).filter((h) => h.bookId === bookId);
  const out = ['---', `bookId: ${bookId}`, `title: ${oneLine(book.title)}`, `author: ${oneLine(book.author)}`, '---', ''];
  let chapter = null;
  for (const h of points) {
    const ch = oneLine(h.chapter);
    if (ch !== chapter) {
      chapter = ch;
      if (ch) out.push(`## ${ch}`, '');
    }
    out.push(...pointLines(h), '');
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

/**
 * Markdown → { bookId, points: [{ id|null, text, userNote, tags, favorite, chapter }] }
 * bookId の無いファイルは bookId: ''（Obsidian で新しく作ったメモ。呼ぶ側が書名から決める）
 */
export function parseBookNote(markdown) {
  const text = String(markdown ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = {};
  for (const line of (fm ? fm[1] : '').split('\n')) {
    const m = line.match(/^([\w.-]+):[ \t]*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  const body = fm ? text.slice(fm[0].length) : text;
  const points = [];
  let chapter = '';
  let cur = null;
  const close = () => {
    if (!cur) return;
    const last = cur.lines.length - 1;
    let id = null;
    const m = cur.lines[last].match(BLOCK_ID);
    if (m) {
      id = m[1];
      cur.lines[last] = cur.lines[last].replace(BLOCK_ID, '');
    }
    const t = cur.lines.join('\n').trim();
    if (t) points.push({ id, text: t, userNote: cur.userNote, tags: cur.tags, favorite: cur.favorite, chapter: cur.chapter });
    cur = null;
  };
  for (const line of body.split('\n')) {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      close();
      chapter = h[1].trim();
      continue;
    }
    const top = line.match(TOP_ITEM);
    if (top) {
      close();
      cur = { lines: [top[1]], userNote: '', tags: [], favorite: false, chapter };
      continue;
    }
    if (!cur) continue;
    let m;
    if ((m = line.match(SUB_NOTE))) cur.userNote = m[1].trim();
    else if ((m = line.match(SUB_TAGS))) cur.tags = [...new Set(m[1].split(/\s+/).map((t) => t.replace(/^#/, '')).filter(Boolean))];
    else if (SUB_STAR.test(line)) cur.favorite = true;
    else if (line.startsWith('    ')) cur.lines.push(line.slice(4));
  }
  close();
  return { bookId: meta.bookId || '', title: meta.title || '', author: meta.author || '', points };
}

const sameTags = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());

/**
 * 読み込んだ Markdown の内容をライブラリに反映する（Markdown が正）。引数のライブラリを直接変える
 * - ID のある点: 文・メモ・タグ・★が違うところだけ直す。Markdown から消えた点は消さない（誤って消した行で点を失わない）
 * - ID の無い点（または手元に無い ID）: 新しい点として足す
 * - bookId の無い・手元に無い本: 書名（無ければ fallbackTitle = ファイル名）の本として足す
 * 戻り値: { changed: 直した点の数, added: 足した点の数, bookId }
 */
export function applyBookNote(library, parsed, fallbackTitle, now = new Date().toISOString()) {
  let bookId = library.books[parsed.bookId] && !library.books[parsed.bookId].deleted ? parsed.bookId : '';
  if (!bookId) bookId = registerBook(library, { title: parsed.title || fallbackTitle, author: parsed.author }, now).id;
  const stat = { changed: 0, added: 0, bookId };
  for (const p of parsed.points) {
    const h = p.id ? library.highlights[p.id] : null;
    if (h && !h.deleted && h.bookId === bookId) {
      const patch = {};
      if (p.text !== h.text) patch.text = p.text;
      // メモは 1 行、タグは空白なしで書き出すので、書き出しで変わる分は直したとみなさない
      if ((p.userNote || '') !== oneLine(h.userNote)) patch.userNote = p.userNote;
      if (!sameTags(p.tags, (h.tags || []).map((t) => String(t).replace(/\s+/g, '')).filter(Boolean))) patch.tags = p.tags;
      if (p.favorite !== Boolean(h.favorite)) patch.favorite = p.favorite;
      if (Object.keys(patch).length) {
        updateHighlight(library, h.id, patch, now);
        stat.changed++;
      }
      continue;
    }
    if (h) continue; // 削除済み・別の本の点の ID は触らない
    const { highlight, added } = addHighlight(library, bookId, { text: p.text, chapter: p.chapter }, now);
    if (!added) continue;
    stat.added++;
    if (p.userNote || p.tags.length || p.favorite) updateHighlight(library, highlight.id, { userNote: p.userNote, tags: p.tags, favorite: p.favorite }, now);
  }
  return stat;
}
