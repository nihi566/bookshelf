// PC のライブラリと Obsidian の読書メモ（1 冊 1 つの Markdown）を揃える（NIH-311）
//
// Markdown が正。1 回の同期は「Markdown の直したところをライブラリへ → ライブラリの内容を Markdown へ」の順
// - 読み込むのは、前回の同期より新しく、こちらが最後に書いた内容と違うファイルだけ（こちらの書き込みを読み返さない）
// - 書くのは、内容が変わる本だけ。front matter に bookId が無いファイル（Obsidian の他のメモ）は読まず、書き換えない

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { liveHighlights } from '../web/core/model.js';
import { applyBookNote, bookNoteFileName, parseBookNote, renderBookNote } from '../web/core/book-notes.js';

const isMarkdown = (name) => /\.md$/i.test(name);

/**
 * @param {{ dir: string }} opts dir … 読書メモを置くフォルダ（400_読書メモ）
 */
export function createNotesSync({ dir, since = 0 }) {
  // こちらが最後に書いた（または読んだ）ファイルの中身。ファイル名 → 中身
  const known = new Map();
  // since … 前回の同期の時刻（ミリ秒）。起動し直しても、止めている間にライブラリだけが変わった本を古いファイルで戻さない
  let lastSyncMs = since;

  async function listNotes() {
    try {
      return (await readdir(dir)).filter(isMarkdown);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  /** Markdown の直したところをライブラリへ。返り値: { changed, added, skipped } */
  async function importChanged(library, now) {
    const total = { changed: 0, added: 0, skipped: 0 };
    for (const name of await listNotes()) {
      const file = path.join(dir, name);
      const md = await readFile(file, 'utf8');
      if (known.get(name) === md) continue;
      const mtime = (await stat(file)).mtimeMs;
      const parsed = parseBookNote(md);
      if (!parsed.bookId) {
        total.skipped++;
        continue;
      }
      known.set(name, md);
      if (mtime <= lastSyncMs) continue;
      const r = applyBookNote(library, parsed, path.basename(name, path.extname(name)), now);
      total.changed += r.changed;
      total.added += r.added;
    }
    return total;
  }

  /** ライブラリの内容を Markdown へ。返り値: 書いたファイルの数 */
  async function exportAll(library) {
    await mkdir(dir, { recursive: true });
    const bookIds = [...new Set(liveHighlights(library).map((h) => h.bookId))].filter((id) => library.books[id] && !library.books[id].deleted);
    const taken = new Set();
    let written = 0;
    for (const id of bookIds) {
      let name = bookNoteFileName(library.books[id].title);
      // 書名が違っても同じファイル名になってしまう本は、本の ID を付けて分ける
      if (taken.has(name)) name = name.replace(/\.md$/, ` (${id}).md`);
      taken.add(name);
      const md = renderBookNote(library, id);
      let current = known.get(name);
      if (current === undefined) current = await readFile(path.join(dir, name), 'utf8').catch(() => null);
      if (current === md) {
        known.set(name, md);
        continue;
      }
      // 本の ID が違うファイル（同じ名前の別のメモ）は上書きしない
      if (current !== null && parseBookNote(current).bookId !== id) continue;
      await writeFile(path.join(dir, name), md);
      known.set(name, md);
      written++;
    }
    return written;
  }

  return {
    dir,
    /** 1 回の同期。library を直接変えるので、変わったか（changed + added > 0）を見て保存する */
    async sync(library, now = new Date().toISOString()) {
      const startedMs = Date.now();
      const imported = await importChanged(library, now);
      const exported = await exportAll(library);
      lastSyncMs = startedMs;
      return { ...imported, written: exported, syncedAt: startedMs };
    },
  };
}
