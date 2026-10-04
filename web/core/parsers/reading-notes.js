// Obsidian などに書いた読書メモ（Markdown）を「点」に分ける。書き方は人それぞれなので、構造だけを手がかりにする
//
// - 見出し（#〜######）… 章にする（空の見出しは無視）
// - 空行・区切り線（---・- - -）… 点の区切り
// - 箇条書きで始まる塊 … いちばん外側の項目ごとに 1 点（入れ子の項目は「・」を付けてその点に含める）
// - 文で始まる塊 … 塊ごと 1 点（中の箇条書きは「・」を付けて含める）
// - 「・」でつないだ行（「・A ・B」）… 「・」ごとに分ける
// - Play ブックスの書き出しを貼ったメモ（ページへのリンク + 改行で切れた断片）… リンクの間の断片を 1 点につなぐ
// - 画像の埋め込み（![[…]]）… 点にせず、名前だけ数える（画像は取り込めないので知らせる）
//
// ParsedBook = { title, author: '', source: 'memo', highlights: [{ text, chapter }], images: [ファイル名] }

const HEADING = /^#{1,6}(?:\s+(.*))?$/;
const RULE = /^\s*(?:[-*_]\s*){3,}$/;
const LIST_ITEM = /^(\s*)(?:(?:[-*+]|\d+[.)])\s+|・\s*)(.*)$/;
const EMBED = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
const PLAY_LINK = /^https?:\/\/www\.google\.com\/url\?q=https?:\/\/play\.google\.com\/books\//;
const FRONT_MATTER = /^---\n[\s\S]*?\n---(?:\n|$)/;
// 小見出しとみなす 1 行の長さの上限と、文の終わりの記号（これで終わる行は小見出しではなく文）
const LABEL_MAX = 20;
const SENTENCE_END = /[。．.!！?？」』）)]$/;

/** ファイル名 → 書名（フォルダ・拡張子を外し、「…」のメモ は中の書名にする） */
export function noteTitleFromFileName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop().replace(/\.(md|markdown)$/i, '').normalize('NFC').trim();
  return base.match(/^「(.+)」のメモ$/)?.[1] || base;
}

/** 太字・マーカー・リンクなどの Markdown の記号を外す */
function inline(s) {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\*\*|__|==|~~/g, '')
    .replace(/(^|[^\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu, '$1$2')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\((?:[^)\s]+)\)/g, '$1')
    .trim();
}

/** 字の無い断片（「1.」や記号だけ）は点にしない */
function hasWords(s) {
  return s.replace(/[\p{P}\p{S}\s]/gu, '').length >= 2;
}

const indentOf = (s) => s.replace(/\t/g, '    ').length;

/** 箇条書きの塊を、いちばん外側の項目ごとの文にする（入れ子は「・」、さらに深いものは字下げして「・」） */
function listPoints(lines) {
  const points = [];
  let base = null;
  let current = null;
  // 入れ子の項目の字下げ（外側から順に）。深さ = 長さ
  let nested = [];
  for (const line of lines) {
    const m = line.match(LIST_ITEM);
    if (m && (base === null || indentOf(m[1]) <= base)) {
      base = indentOf(m[1]);
      current = [inline(m[2])];
      nested = [];
      points.push(current);
      continue;
    }
    if (!m) {
      current.push(inline(line));
      continue;
    }
    const ind = indentOf(m[1]);
    while (nested.length && nested[nested.length - 1] >= ind) nested.pop();
    nested.push(ind);
    current.push(`${'　'.repeat(nested.length - 1)}・${inline(m[2])}`);
  }
  return points.map((p) => p.filter(Boolean).join('\n'));
}

/** 文で始まる塊は 1 点（中の箇条書きは「・」を付ける） */
function paragraphPoint(lines) {
  return lines
    .map((line) => {
      const m = line.match(LIST_ITEM);
      return m ? `・${inline(m[2])}` : inline(line);
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * @param {string} markdown
 * @param {string} title
 */
export function parseReadingNote(markdown, title) {
  const text = String(markdown ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(FRONT_MATTER, '');
  const rawLines = text.split('\n');
  const playExport = rawLines.some((l) => PLAY_LINK.test(l.trim()));
  const images = [];
  const highlights = [];
  let chapter = '';
  let block = [];
  // 句点で終わらない短い 1 行（「Column」「資格を取る」などの小見出し）は、次の点の頭に付ける
  let labels = [];

  const push = (t) => {
    const s = t.trim();
    if (!hasWords(s)) return;
    highlights.push({ text: [...labels, s].join('\n'), chapter });
    labels = [];
  };
  // 続く点が無い小見出し（章の終わり・メモの終わり）は、それだけで 1 点にする
  const releaseLabels = () => {
    const s = labels.join('\n');
    labels = [];
    push(s);
  };
  const flush = () => {
    if (!block.length) return;
    const lines = block;
    block = [];
    if (playExport) {
      // 改行で切れた 1 つの線の断片。日本語なのでそのままつなぐ
      push(lines.map((l) => inline(l.match(LIST_ITEM)?.[2] ?? l)).join(''));
      return;
    }
    if (LIST_ITEM.test(lines[0])) {
      for (const p of listPoints(lines)) push(p);
      return;
    }
    const s = inline(lines[0]);
    if (lines.length === 1 && s.length <= LABEL_MAX && !SENTENCE_END.test(s)) {
      if (hasWords(s)) labels.push(s);
      return;
    }
    push(paragraphPoint(lines));
  };

  for (let raw of rawLines) {
    // 引用は記号だけ外して本文として読む
    raw = raw.replace(/^(\s*>\s?)+/, '');
    raw = raw.replace(EMBED, (_, name) => {
      images.push(name.trim());
      return '';
    });
    const line = raw.replace(/\s+$/, '');
    if (PLAY_LINK.test(line.trim()) || RULE.test(line) || !line.trim()) {
      flush();
      continue;
    }
    const h = line.match(HEADING);
    if (h) {
      flush();
      releaseLabels();
      const name = inline(h[1] || '');
      if (name) chapter = name;
      continue;
    }
    // 「・A ・B ・C」のように 1 行に並べた項目は、前の行と切り離し、項目ごとの点にする
    const items = /^\s*・/.test(line) ? line.split(/\s+(?=・)/).map((s) => s.trim()).filter(Boolean) : [];
    if (items.length > 1) {
      flush();
      block = items;
      flush();
      continue;
    }
    block.push(line);
  }
  flush();
  releaseLabels();
  return { title, author: '', source: 'memo', highlights, images };
}
