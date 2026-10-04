// ファイルの形式を自動判定してパースする入口（CLI / コンパニオンサーバ / Web アプリで共通）
//
// 対応形式
//   Kindle     : My Clippings.txt（端末） / 「ノートブックをエクスポート」HTML（アプリ） / ブックマークレットの JSON（read.amazon.co.jp/notebook）
//   Play Books : Google ドライブ「Play ブックスのメモ」のドキュメントを .docx / .html / .md で書き出したもの
//   zip        : 上記をまとめた zip（ドライブでフォルダごとダウンロードすると docx の zip になる）
//   JSON       : このアプリのバックアップ（ライブラリ全体）

import { isZip, readZip } from '../zip.js';
import { BACKUP_FORMAT } from '../importing.js';
import { looksLikeClippings, parseKindleClippings } from './kindle-clippings.js';
import { isNotebookJson, looksLikeKindleExport, parseKindleExportHtml, parseNotebookJson } from './kindle-notebook.js';
import { looksLikePlayBooksMarkdown, parsePlayBooksDocx, parsePlayBooksHtml, parsePlayBooksMarkdown, titleFromFileName } from './playbooks.js';
import { noteTitleFromFileName, parseReadingNote } from './reading-notes.js';

export const FORMAT_LABELS = {
  'kindle-clippings': 'Kindle（My Clippings.txt）',
  'kindle-export': 'Kindle（ノートブックのエクスポート HTML）',
  'kindle-notebook': 'Kindle（ノートブックのブックマークレット）',
  playbooks: 'Play Books（ドライブのメモ）',
  'reading-note': '読書メモ（Markdown）',
  library: 'このアプリのバックアップ',
  parsed: '汎用 JSON',
};

export const ACCEPT = '.txt,.html,.htm,.docx,.md,.markdown,.json,.zip';

export function decodeText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // メモ帳で「Unicode」として保存し直したファイル（UTF-16、BOM 付き）
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b).replace(/^﻿/, '');
  } catch {
    // Windows で保存された日本語テキスト向け
    try {
      return new TextDecoder('shift_jis').decode(b);
    } catch {
      return new TextDecoder('utf-8').decode(b);
    }
  }
}

function ext(name) {
  return (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
}

/** バックアップ（新形式: { format, library, analysis } / 旧形式: ライブラリに analysis を足したもの）→ { library, analysis } */
function readBackup(data) {
  if (data?.format === BACKUP_FORMAT && isLibraryBackup(data.library)) return { library: data.library, analysis: data.analysis || null };
  if (isLibraryBackup(data)) {
    const { analysis, ...library } = data;
    return { library, analysis: analysis || null };
  }
  return null;
}

function isLibraryBackup(data) {
  return data && typeof data === 'object' && data.books && data.highlights && !Array.isArray(data.books) && typeof data.highlights === 'object';
}

/**
 * .md は Play ブックスの書き出し（表の形）なら Play Books、それ以外は自分で書いた読書メモとして読む。
 * 読書メモに Play ブックスのページへのリンクを貼っただけのものもあるので、表の形で線が取れたときだけ Play Books にする
 */
function parseMarkdown(text, base) {
  if (looksLikePlayBooksMarkdown(text)) {
    const books = parsePlayBooksMarkdown(text, titleFromFileName(base));
    if (books.some((b) => b.highlights.length)) return { format: 'playbooks', books };
  }
  const { images, ...note } = parseReadingNote(text, noteTitleFromFileName(base));
  if (!note.highlights.length) {
    return { error: images.length ? `本文が無く、画像 ${images.length} 枚だけのメモです（画像は取り込めません）` : '本文の無いメモです' };
  }
  return { format: 'reading-note', books: [note], images: images.length };
}

/** 1 ファイル → { format, books?, library?, error?, images?（取り込めなかった画像の数） } */
async function parseOne(name, bytes) {
  const e = ext(name);
  const base = String(name).split('/').pop();
  if (isZip(bytes)) {
    const entries = await readZip(bytes);
    if (e === 'docx' || entries.some((x) => x.name === 'word/document.xml')) {
      return { format: 'playbooks', books: await parsePlayBooksDocx(entries, titleFromFileName(base)) };
    }
    return { format: 'zip', entries };
  }
  const text = decodeText(bytes);
  if (e === 'json' || /^\s*[{[]/.test(text)) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      if (e === 'json') return { error: 'JSON として読めませんでした' };
    }
    if (data !== undefined) {
      if (isNotebookJson(data)) return { format: 'kindle-notebook', books: parseNotebookJson(data) };
      const backup = readBackup(data);
      if (backup) return { format: 'library', backup };
      const arr = Array.isArray(data) ? data : data?.books;
      if (Array.isArray(arr) && arr.every((b) => b && b.title && Array.isArray(b.highlights))) {
        return { format: 'parsed', books: arr.map((b) => ({ ...b, source: b.source === 'playbooks' ? 'playbooks' : b.source === 'kindle' ? 'kindle' : 'manual' })) };
      }
      return { error: '対応していない JSON です' };
    }
  }
  // .txt / .md の本文には <div> などが普通に出てくる（技術書のハイライト・読書メモのインライン HTML）ので、文書の頭が HTML のときだけ HTML として読む
  const textExt = e === 'txt' || e === 'md' || e === 'markdown';
  if (textExt ? /^\s*<(!doctype|html)/i.test(text) : /<html|<body|<div|<table|<p[\s>]/i.test(text)) {
    if (looksLikeKindleExport(text)) return { format: 'kindle-export', books: parseKindleExportHtml(text) };
    const books = parsePlayBooksHtml(text, titleFromFileName(base));
    if (books.length) return { format: 'playbooks', books };
    return { error: 'ハイライトが見つからない HTML です（Kindle のエクスポートか Play ブックスのメモを選んでください）' };
  }
  // .md は読書メモを先に見る（Setext 見出しの ===== と「作成日」などで Clippings に見えることがある）
  if (e === 'md' || e === 'markdown') return parseMarkdown(text, base);
  if (looksLikeClippings(text)) return { format: 'kindle-clippings', books: parseKindleClippings(text) };
  if (looksLikePlayBooksMarkdown(text)) return { format: 'playbooks', books: parsePlayBooksMarkdown(text, titleFromFileName(base)) };
  if (e === 'txt') return { error: 'My Clippings.txt の形式ではありません（Play ブックスのメモは .docx か .html で書き出してください）' };
  return { error: '対応していない形式です' };
}

/**
 * @param {{ name: string, bytes: Uint8Array }[]} files
 * @returns {{ books: object[], backups: { library, analysis }[], results: { name, format, formatLabel, books, highlights, images, error }[] }}
 */
export async function parseFiles(files) {
  const books = [];
  const backups = [];
  const results = [];
  const queue = [...files];
  while (queue.length) {
    const f = queue.shift();
    if (/(^|\/)(__MACOSX|\.DS_Store)|(^|\/)\._/.test(f.name)) continue;
    let r;
    try {
      r = await parseOne(f.name, f.bytes);
    } catch (e) {
      r = { error: e.message };
    }
    if (r.format === 'zip') {
      for (const entry of r.entries) queue.push({ name: `${f.name}/${entry.name}`, bytes: entry.bytes });
      continue;
    }
    if (r.backup) backups.push(r.backup);
    if (r.books) books.push(...r.books);
    const lib = r.backup?.library;
    const hl = r.books ? r.books.reduce((s, b) => s + b.highlights.length, 0) : lib ? Object.keys(lib.highlights).length : 0;
    if (!r.error && !lib && hl === 0) r.error = 'ハイライトが見つかりませんでした';
    results.push({ name: f.name, format: r.format || '', formatLabel: FORMAT_LABELS[r.format] || '', books: r.books?.length ?? (lib ? Object.keys(lib.books).length : 0), highlights: hl, images: r.images || 0, error: r.error || '' });
  }
  return { books, backups, results };
}
