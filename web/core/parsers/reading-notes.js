// Obsidian などに書いた読書メモ（Markdown）を「点」に分ける。書き方は人それぞれなので、構造だけを手がかりにする
//
// - 見出し（#〜######）… 章にする（空の見出しは無視）
// - 空行・区切り線（---・- - -）… 点の区切り
// - 箇条書きで始まる塊 … いちばん外側の項目ごとに 1 点（入れ子の項目は「・」を付けてその点に含める）
// - 文で始まる塊 … 塊ごと 1 点（中の箇条書きは「・」を付けて含める）
// - 「・」でつないだ行（「・A ・B」）… 「・」ごとに分ける
// - Play ブックスの書き出しを貼ったメモ（ページへのリンク + 改行で切れた断片）… リンクの直後の断片を 1 点につなぐ
// - 画像の埋め込み（![[…]]）… 点にせず、名前だけ数える（画像は取り込めないので知らせる）
//
// ParsedBook = { title, author: '', source: 'memo', highlights: [{ text, chapter }], images: [ファイル名] }

const HEADING = /^#{1,6}(?:\s+(.*))?$/;
const RULE = /^\s*(?:[-*_]\s*){3,}$/;
const LIST_ITEM = /^(\s*)(?:(?:[-*+]|\d+[.)])\s+|・\s*)(.*)$/;
// 括弧の中身は長さに上限を付ける（閉じ括弧の無い長い行で、開き括弧ごとに行末まで探し直して固まらないように）
const EMBED = /!\[\[([^\]|\n]{1,300})(?:\|[^\]\n]{0,100})?\]\]/g;
const MD_IMAGE = /!\[[^\]\n]{0,300}\]\(([^)\s]{1,2000})[^)\n]{0,300}\)/g;
const PLAY_LINK = /^https?:\/\/www\.google\.com\/url\?q=https?:\/\/play\.google\.com\/books\//;
// 「キー: 値」で始まるときだけ front matter とみなす（区切り線で始まるメモの本文を消さない）
const FRONT_MATTER = /^---\n[\w.-]+[ \t]*:[^\n]*\n(?:[\s\S]*?\n)??---(?:\n|$)/;
// タグだけの行（#読書 #本）は本文ではない
const TAGS_ONLY = /^\s*(?:#[^\s#]+\s*)+$/;
// 1 行の長さの上限（貼り付けの事故などで極端に長い行があっても処理が終わるように）
const LINE_MAX = 20000;
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
    .replace(/\[\[([^\]|\n]{1,300})\|([^\]\n]{1,300})\]\]/g, '$2')
    .replace(/\[\[([^\]\n]{1,300})\]\]/g, '$1')
    .replace(/\[([^\]\n]{1,300})\]\([^)\s]{1,2000}\)/g, '$1')
    .trim();
}

/** Play ブックスの断片をつなぐ。日本語はそのまま、英数字どうしの境目だけ空白を入れる */
function joinFragments(parts) {
  return parts.reduce((acc, p) => (acc && /[A-Za-z0-9,.;:]$/.test(acc) && /^[A-Za-z0-9]/.test(p) ? `${acc} ${p}` : acc + p), '');
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
  const images = [];
  const highlights = [];
  let chapter = '';
  let block = [];
  // Play ブックスのページへのリンクの直後の塊は、改行で切れた 1 つの線の断片
  let afterPlayLink = false;
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
    if (afterPlayLink) {
      afterPlayLink = false;
      push(joinFragments(lines.map((l) => inline(l.match(LIST_ITEM)?.[2] ?? l))));
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

  const takeImage = (_, name) => {
    images.push(name.trim());
    return '';
  };
  for (let raw of rawLines) {
    // 引用は記号だけ外して本文として読む
    raw = raw.slice(0, LINE_MAX).replace(/^(\s*>\s?)+/, '');
    raw = raw.replace(EMBED, takeImage).replace(MD_IMAGE, takeImage);
    const line = raw.replace(/\s+$/, '');
    if (PLAY_LINK.test(line.trim())) {
      flush();
      afterPlayLink = true;
      continue;
    }
    if (RULE.test(line) || !line.trim()) {
      flush();
      continue;
    }
    if (TAGS_ONLY.test(line)) continue;
    const h = line.match(HEADING);
    if (h) {
      flush();
      releaseLabels();
      afterPlayLink = false;
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
