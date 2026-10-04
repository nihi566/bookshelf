// パーサの境界値テスト（空・BOM・改行コード・壊れた入力・紛らわしい形式など）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFiles, decodeText } from '../web/core/parsers/index.js';
import { looksLikeClippings, parseClippingMeta, parseKindleClippings, splitTitleAuthor } from '../web/core/parsers/kindle-clippings.js';
import { isNotebookJson, looksLikeKindleExport, parseKindleDate, parseKindleExportHtml, parseNoteHeading, parseNotebookJson } from '../web/core/parsers/kindle-notebook.js';
import { looksLikePlayBooksMarkdown, parsePlayBooksDocx, parsePlayBooksHtml, parsePlayBooksMarkdown, playBooksVolumeId, titleFromFileName } from '../web/core/parsers/playbooks.js';
import { noteTitleFromFileName, parseReadingNote } from '../web/core/parsers/reading-notes.js';
import { blocksToText, colorName, docxXmlToBlocks, htmlToBlocks } from '../web/core/parsers/blocks.js';
import { createZip } from '../web/core/zip.js';
import { makeDeflateZip, playBooksDocumentXml } from './helpers/docx.js';

const enc = (s) => new TextEncoder().encode(s);
const BOM = '\uFEFF';
const SEP = '==========';
const clip = (title, meta, body = '') => `${title}\n${meta}\n\n${body}\n${SEP}\n`;
const one = async (name, content) => (await parseFiles([{ name, bytes: typeof content === 'string' ? enc(content) : content }])).results[0];

// ---------------------------------------------------------------- My Clippings.txt

test('clippings: 空・空白だけ・区切りだけの入力は本が 0 冊で落ちない', () => {
  assert.deepEqual(parseKindleClippings(''), []);
  assert.deepEqual(parseKindleClippings('   \n\n\t'), []);
  assert.deepEqual(parseKindleClippings(`${SEP}\n${SEP}\n`), []);
  assert.deepEqual(parseKindleClippings(BOM), []);
  assert.deepEqual(parseKindleClippings(null), []);
});

test('clippings: CR だけの改行・CRLF・LF が同じ結果になる', () => {
  const lf = clip('本 (著者)', '- 位置No. 10-12のハイライト |作成日: 2024年1月2日 火曜日 3:04:05', '本文です') + clip('本 (著者)', '- Your Highlight on Location 20-22 | Added on Tuesday, January 2, 2024 3:04:05 AM', 'English body');
  const a = parseKindleClippings(lf);
  const b = parseKindleClippings(lf.replace(/\n/g, '\r\n'));
  const c = parseKindleClippings(lf.replace(/\n/g, '\r'));
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
  assert.equal(a[0].highlights.length, 2);
  assert.equal(a[0].highlights[0].text, '本文です');
});

test('clippings: 各件の頭に BOM が付いていてもタイトルが分かれない', () => {
  const t = `${BOM}本 (著者)\n- 位置No. 1-2のハイライト |作成日: 2024年1月1日\n\nA\n${SEP}\n${BOM}本 (著者)\n- 位置No. 3-4のハイライト |作成日: 2024年1月1日\n\nB\n${SEP}\n`;
  const books = parseKindleClippings(t);
  assert.equal(books.length, 1);
  assert.equal(books[0].title, '本');
  assert.deepEqual(books[0].highlights.map((h) => h.text), ['A', 'B']);
});

test('clippings: 最後の区切りが無い・区切りの後ろに空白があるファイル', () => {
  const t = `本 (著者)\n- 位置No. 1-2のハイライト |作成日: 2024年1月1日\n\nA\n==========   \n本 (著者)\n- 位置No. 3-4のハイライト |作成日: 2024年1月1日\n\nB`;
  assert.deepEqual(parseKindleClippings(t)[0].highlights.map((h) => h.text), ['A', 'B']);
});

test('clippings: 本文が複数行・本文中の空行はそのまま残す', () => {
  const t = clip('本 (著者)', '- 位置No. 1-2のハイライト |作成日: 2024年1月1日', '一行目\n\n三行目');
  assert.equal(parseKindleClippings(t)[0].highlights[0].text, '一行目\n\n三行目');
});

test('clippings: メタ行が欠けた件・未知の種類（記事のクリップ）は飛ばす', () => {
  const t =
    clip('本 (著者)', '', '本文') +
    `本 (著者)\n${SEP}\n` +
    clip('Article (Web)', '- Your Clip This Article | Added on Monday, January 1, 2024 1:00:00 AM', 'clipped') +
    clip('本 (著者)', '- 位置No. 5-6のハイライト |作成日: 2024年1月1日', '残る');
  const books = parseKindleClippings(t);
  assert.deepEqual(books.map((b) => b.title), ['本']);
  assert.deepEqual(books[0].highlights.map((h) => h.text), ['残る']);
});

test('clippings: ブックマークだけの本は本として出さない', () => {
  const t = clip('栞だけ (著者)', '- 位置No. 50のブックマーク |作成日: 2024年1月1日') + clip('Bookmarked (A)', '- Your Bookmark on Location 50 | Added on Monday, January 1, 2024 1:00:00 AM');
  assert.deepEqual(parseKindleClippings(t), []);
});

test('clippings: 本文の空なハイライトだけの本は 0 件の本として返さない', () => {
  const t = clip('空 (著者)', '- 位置No. 1-2のハイライト |作成日: 2024年1月1日', '');
  const books = parseKindleClippings(t);
  assert.ok(books.every((b) => b.highlights.length > 0), JSON.stringify(books));
});

test('clippings: 同じハイライトの重複はパーサでは両方残す（取り込み時に除く）', () => {
  const c = clip('本 (著者)', '- 位置No. 1-2のハイライト |作成日: 2024年1月1日', '同じ');
  const books = parseKindleClippings(c + c);
  assert.equal(books[0].highlights.length, 2);
});

test('clippings: メモの紐付け（範囲の終端・範囲内・ページだけ・対応なし）', () => {
  const t =
    clip('Book (A)', '- Your Highlight on page 3 | Location 100-105 | Added on Monday, January 1, 2024 1:00:00 AM', 'hl one') +
    clip('Book (A)', '- Your Note on page 3 | Location 103 | Added on Monday, January 1, 2024 1:01:00 AM', 'inside range') +
    clip('Book (A)', '- Your Highlight on page 9 | Added on Monday, January 1, 2024 1:00:00 AM', 'page only') +
    clip('Book (A)', '- Your Note on page 9 | Added on Monday, January 1, 2024 1:02:00 AM', 'page note') +
    clip('Book (A)', '- Your Note on Location 999 | Added on Monday, January 1, 2024 1:03:00 AM', 'orphan');
  const [book] = parseKindleClippings(t);
  const byText = Object.fromEntries(book.highlights.map((h) => [h.text, h]));
  assert.equal(byText['hl one'].note, 'inside range');
  assert.equal(byText['page only'].note, 'page note');
  assert.equal(byText.orphan.kind, 'note');
  assert.equal(byText.orphan.location, 999);
  assert.equal(book.highlights.length, 3);
  assert.ok(book.highlights.every((h) => !('kind' in h) || h.kind === 'highlight' || h.kind === 'note'));
});

test('clippings: メモが先に書かれていてもハイライトに付く', () => {
  const t = clip('本 (著者)', '- 位置No. 12のメモ |作成日: 2024年1月1日', 'メモ') + clip('本 (著者)', '- 位置No. 10-12のハイライト |作成日: 2024年1月1日', '本文');
  const [book] = parseKindleClippings(t);
  assert.equal(book.highlights.length, 1);
  assert.equal(book.highlights[0].note, 'メモ');
});

test('parseClippingMeta: 位置・ページの境界値', () => {
  assert.deepEqual([parseClippingMeta('- Your Highlight on Location 1-1 | Added on x').location, parseClippingMeta('- Your Highlight on Location 1-1 | Added on x').locationEnd], [1, 1]);
  const big = parseClippingMeta('- Your Highlight at location 123456-123460 | Added on Monday, January 1, 2024 1:00:00 AM');
  assert.deepEqual([big.location, big.locationEnd], [123456, 123460]);
  const abbr = parseClippingMeta('- Highlight Loc. 998-1002 | Added on Monday, January 1, 2024');
  assert.deepEqual([abbr.location, abbr.locationEnd], [998, 1002]);
  const abbr2 = parseClippingMeta('- Highlight Loc. 1998-02 | Added on Monday, January 1, 2024');
  assert.deepEqual([abbr2.location, abbr2.locationEnd], [1998, 2002]);
  const single = parseClippingMeta('- 位置No. 0のメモ |作成日: 2024年1月1日');
  assert.equal(single.location, 0);
  assert.equal(single.locationEnd, null);
  assert.equal(single.kind, 'note');
  // 全角数字
  const fw = parseClippingMeta('- 位置Ｎｏ．１２３－１２５のハイライト |作成日: ２０２４年１月１日');
  assert.deepEqual([fw.location, fw.locationEnd, fw.kind], [123, 125, 'highlight']);
  assert.equal(fw.createdAt, new Date(2024, 0, 1).toISOString());
  // ページの範囲は先頭だけ、ローマ数字
  assert.equal(parseClippingMeta('- Your Highlight on page 12-13 | Location 5-6 | Added on x').page, '12');
  assert.equal(parseClippingMeta('- Your Highlight on page XIV | Location 5-6 | Added on x').page, 'XIV');
  assert.equal(parseClippingMeta('- 45ページ|位置No. 690-692のハイライト |作成日: 2024年1月1日').page, '45');
  // 位置もページも無い
  const none = parseClippingMeta('- Your Highlight | Added on Monday, January 1, 2024 1:00:00 AM');
  assert.deepEqual([none.kind, none.location, none.page], ['highlight', null, '']);
  // 種類の分からない行
  assert.equal(parseClippingMeta('').kind, null);
  assert.equal(parseClippingMeta('- Your Clip This Article').kind, null);
});

test('parseClippingMeta: 桁区切りのカンマが入った位置', () => {
  const m = parseClippingMeta('- Your Highlight on page 45 | Location 1,234-1,236 | Added on Monday, January 1, 2024 1:00:00 AM');
  assert.deepEqual([m.location, m.locationEnd], [1234, 1236]);
  const n = parseClippingMeta('- Your Note on Location 12,345 | Added on Monday, January 1, 2024 1:00:00 AM');
  assert.deepEqual([n.location, n.locationEnd], [12345, null]);
});

test('parseClippingMeta: 日付が読めないときは null（落ちない）', () => {
  assert.equal(parseClippingMeta('- 位置No. 1-2のハイライト |作成日: いつか').createdAt, null);
  assert.equal(parseClippingMeta('- Your Highlight on Location 1-2 | Added on someday').createdAt, null);
  assert.equal(parseClippingMeta('- 位置No. 1-2のハイライト |作成日: 2024年1月1日 月曜日 午後11:59:59').createdAt, new Date(2024, 0, 1, 23, 59, 59).toISOString());
});

test('splitTitleAuthor: 変わったタイトル', () => {
  assert.deepEqual(splitTitleAuthor('Title'), { title: 'Title', author: '' });
  assert.deepEqual(splitTitleAuthor('  Title (Author)  '), { title: 'Title', author: 'Author' });
  assert.deepEqual(splitTitleAuthor('(Author only)'), { title: '(Author only)', author: '' });
  assert.deepEqual(splitTitleAuthor('本（著者）'), { title: '本', author: '著者' });
  assert.deepEqual(splitTitleAuthor('本 (上) (著者)'), { title: '本 (上)', author: '著者' });
  assert.deepEqual(splitTitleAuthor('Book: A - B | C (Smith, John; Doe, Jane)'), { title: 'Book: A - B | C', author: 'Smith, John; Doe, Jane' });
  assert.deepEqual(splitTitleAuthor('📚 絵文字の本 🎉 (著者 ✨)'), { title: '📚 絵文字の本 🎉', author: '著者 ✨' });
  assert.deepEqual(splitTitleAuthor('Unbalanced) (Author)'), { title: 'Unbalanced)', author: 'Author' });
  // 閉じ括弧が多すぎて対応が取れないときは全体をタイトルにする
  assert.deepEqual(splitTitleAuthor('Weird))'), { title: 'Weird))', author: '' });
  assert.deepEqual(splitTitleAuthor(''), { title: '', author: '' });
  assert.deepEqual(splitTitleAuthor(`${BOM}Title (A)`), { title: 'Title', author: 'A' });
});

test('looksLikeClippings: 区切りと種類の両方が要る', () => {
  assert.equal(looksLikeClippings(''), false);
  assert.equal(looksLikeClippings(SEP), false);
  assert.equal(looksLikeClippings('Your Highlight'), false);
  assert.equal(looksLikeClippings(`a\n- Your Highlight\n\nb\n${SEP}`), true);
});

test('clippings: 巨大な入力（2 万件）も短時間で処理できる', () => {
  const parts = [];
  for (let i = 0; i < 20000; i++) parts.push(clip(`Book ${i % 50} (A)`, `- Your Highlight on Location ${i * 3}-${i * 3 + 2} | Added on Monday, January 1, 2024 1:00:00 AM`, `text ${i}`));
  const t0 = Date.now();
  const books = parseKindleClippings(parts.join(''));
  assert.equal(books.length, 50);
  assert.equal(books.reduce((s, b) => s + b.highlights.length, 0), 20000);
  assert.ok(Date.now() - t0 < 5000);
});

// ---------------------------------------------------------------- Kindle エクスポート HTML

const exportHtml = (body, title = 'Book') => `<html><body><div class="bookTitle">${title}</div><div class="authors">Author</div>${body}</body></html>`;

test('kindle export: 空文字・見出しだけ・タイトル無しは 0 冊', () => {
  assert.deepEqual(parseKindleExportHtml(''), []);
  assert.deepEqual(parseKindleExportHtml(exportHtml('')), []);
  assert.deepEqual(parseKindleExportHtml('<div class="noteHeading">Highlight - Location 1</div><div class="noteText">x</div>'), []);
});

test('kindle export: 本文の無い見出し・ブックマークは飛ばし、後ろの件はずれない', () => {
  const html = exportHtml(
    '<div class="noteHeading">Highlight (<span class="highlight_blue">blue</span>) - Location 1</div>' +
      '<div class="noteHeading">Bookmark - Location 2</div>' +
      '<div class="noteHeading">Highlight (<span class="highlight_pink">pink</span>) - Location 3</div><div class="noteText">three</div>',
  );
  const [book] = parseKindleExportHtml(html);
  assert.deepEqual(book.highlights.map((h) => [h.text, h.color, h.location]), [['three', 'pink', 3]]);
});

test('kindle export: 閉じタグの無い・途中で切れた HTML でも最後の件を読む', () => {
  const html = '<div class="bookTitle">Book<div class="authors">A<div class="noteHeading">Highlight - Page 4 · Location 10<div class="noteText">truncated text';
  const [book] = parseKindleExportHtml(html);
  assert.equal(book.title, 'Book');
  assert.equal(book.author, 'A');
  assert.equal(book.highlights[0].text, 'truncated text');
  assert.equal(book.highlights[0].page, '4');
});

test('kindle export: エンティティ（二重エスケープは 1 段だけ戻す）と絵文字・全角', () => {
  const html = exportHtml('<div class="noteHeading">Highlight - Location 1</div><div class="noteText">A &amp;amp; B &lt;tag&gt; &#x1F4DA; &#12354; ＡＢＣ</div>', 'Tom &amp; Jerry');
  const [book] = parseKindleExportHtml(html);
  assert.equal(book.title, 'Tom & Jerry');
  assert.equal(book.highlights[0].text, 'A &amp; B <tag> 📚 あ ＡＢＣ');
});

test('kindle export: 見出しより前のメモ・遠い位置のメモは単独の点', () => {
  const html = exportHtml(
    '<div class="noteHeading">Note - Location 1</div><div class="noteText">first note</div>' +
      '<div class="noteHeading">Highlight - Location 10</div><div class="noteText">hl</div>' +
      '<div class="noteHeading">Note - Location 50</div><div class="noteText">far note</div>' +
      '<div class="noteHeading">Note - Location 51</div><div class="noteText">far note 2</div>',
  );
  const [book] = parseKindleExportHtml(html);
  assert.deepEqual(book.highlights.map((h) => [h.kind, h.text, h.note]), [['note', 'first note', ''], ['highlight', 'hl', ''], ['note', 'far note', ''], ['note', 'far note 2', '']]);
});

test('parseNoteHeading: 英語・日本語・ドイツ語、桁区切り、ページだけ、ローマ数字', () => {
  assert.deepEqual(parseNoteHeading('Highlight (<span class="highlight_yellow">yellow</span>) - Chapter 1 &gt; Page 12 · Location 1,234'), { kind: 'highlight', color: 'yellow', location: 1234, page: '12', chapter: 'Chapter 1' });
  assert.deepEqual(parseNoteHeading('メモ - ページ xii'), { kind: 'note', color: '', location: null, page: 'xii', chapter: '' });
  assert.equal(parseNoteHeading('Notiz - Seite 5 · Position 77').kind, 'note');
  assert.equal(parseNoteHeading('Notiz - Seite 5 · Position 77').location, 77);
  assert.equal(parseNoteHeading('Lesezeichen - Position 77').kind, 'bookmark');
  assert.equal(parseNoteHeading('').kind, 'highlight');
  assert.equal(parseNoteHeading('ハイライト(ブルー) - 位置No.１２３').location, 123);
});

test('looksLikeKindleExport: noteHeading と noteText の両方が要る（シングルクォートも可）', () => {
  assert.equal(looksLikeKindleExport("<h3 class='noteHeading'>x</h3><div class='noteText'>y</div>"), true);
  assert.equal(looksLikeKindleExport('<div class="noteHeading">x</div>'), false);
});

// ---------------------------------------------------------------- ブックマークレット JSON

test('notebook json: 欠けた項目・空の本・カンマ付きの位置・数値のページ', () => {
  const data = {
    format: 'book-highlights/kindle-notebook',
    books: [
      { title: '  ', author: 'x', highlights: [{ text: 'a' }] },
      { title: 'No highlights' },
      { title: 'Book', highlights: [{ text: '', note: '' }, { text: 'hl', location: '1,234', page: '' }, { note: 'only note', location: '' }, { text: 'p', page: 12 }] },
    ],
  };
  const books = parseNotebookJson(data);
  assert.equal(books.length, 1);
  assert.deepEqual(books[0].highlights.map((h) => [h.kind, h.text, h.location]), [['highlight', 'hl', 1234], ['note', 'only note', null], ['highlight', 'p', null]]);
  assert.equal(books[0].author, '');
});

test('notebook json: 読めない最終日付は付けない', () => {
  assert.equal(parseKindleDate('Sunday February 30, 2026'), '');
  assert.equal(parseKindleDate('Smarch 1, 2026'), '');
  assert.equal(parseKindleDate(''), '');
  assert.equal(parseKindleDate(null), '');
  assert.equal(parseKindleDate('２０２６年２月２９日'), '');
  assert.equal(parseKindleDate('2024年2月29日 木曜日'), '2024-02-29');
  assert.equal(isNotebookJson({ format: 'book-highlights/kindle-notebook', books: {} }), false);
  assert.ok(!isNotebookJson(null));
});

// ---------------------------------------------------------------- Play ブックス

test('titleFromFileName: さまざまなファイル名', () => {
  assert.equal(titleFromFileName('Notes from "Deep Work".docx'), 'Deep Work');
  assert.equal(titleFromFileName('Notes from “Deep Work”.html'), 'Deep Work');
  assert.equal(titleFromFileName('「本 (上)」のメモ.docx'), '本 (上)');
  assert.equal(titleFromFileName('「A」と「B」のメモ.md'), 'A」と「B');
  assert.equal(titleFromFileName('Notes_from_Deep_Work.docx'), 'Notes from Deep Work');
  assert.equal(titleFromFileName(''), '');
  assert.equal(titleFromFileName(undefined), '');
  assert.equal(titleFromFileName('no-extension'), 'no-extension');
});

test('playBooksVolumeId: 直接・リダイレクト・&amp; のリンク、無ければ空', () => {
  assert.equal(playBooksVolumeId('https://play.google.com/books/reader?id=AbC-123_x&pg=GBS.PA1'), 'AbC-123_x');
  assert.equal(playBooksVolumeId('https://www.google.com/url?q=https://play.google.com/books/reader?id%3DXyZ987%26pg%3D1'), 'XyZ987');
  assert.equal(playBooksVolumeId('https://play.google.com/books/reader?printsec=frontcover&amp;id=QQQ111'), 'QQQ111');
  assert.equal(playBooksVolumeId(''), '');
  assert.equal(playBooksVolumeId(null), '');
});

test('play books html: 空・本文の無い HTML・注釈の無い表は 0 冊', () => {
  assert.deepEqual(parsePlayBooksHtml('', 'x'), []);
  assert.deepEqual(parsePlayBooksHtml('<html><body><h1>Title</h1><p>Author</p></body></html>', 'x'), []);
  assert.deepEqual(parsePlayBooksHtml('<table><tr><td>a</td><td>b</td></tr></table>', 'x'), []);
});

const pbRow = (text, date, page, cls = 'hl') => `<table><tr><td><img src="x.png"></td><td><p><span class="${cls}">${text}</span></p><p></p><p><span>${date}</span></p></td><td><p><a href="https://play.google.com/books/reader?id=VOL123&pg=1">${page}</a></p></td></tr></table>`;
const pbHtml = (rows, head = '<h1>Title</h1><p>Author</p>') => `<html><head><title>「Title」のメモ</title><style>.hl{background-color:#fde096}</style></head><body>${head}${rows}</body></html>`;

test('play books html: 注釈 1 行・タイトルが無ければ <title> のドキュメント名から', () => {
  const books = parsePlayBooksHtml(pbHtml(pbRow('本文 &amp; 記号', '2024年5月1日', '12'), ''), '');
  assert.equal(books.length, 1);
  assert.equal(books[0].title, 'Title');
  assert.equal(books[0].volumeId, 'VOL123');
  assert.deepEqual([books[0].highlights[0].text, books[0].highlights[0].page, books[0].highlights[0].color], ['本文 & 記号', '12', 'yellow']);
});

test('play books html: DOCTYPE や XML 宣言は段落の文字にならない', () => {
  const blocks = htmlToBlocks('<!DOCTYPE html><?xml version="1.0"?><html><body><p>hello</p></body></html>');
  assert.equal(blocksToText(blocks), 'hello');
});

test('play books html: 読めない注釈（表示できません）は飛ばす', () => {
  const html = pbHtml(pbRow('ハイライト表示したテキストを表示できません', '2024年5月1日', '3') + pbRow('残る', '2024年5月1日', '4'));
  assert.deepEqual(parsePlayBooksHtml(html, '')[0].highlights.map((h) => h.text), ['残る']);
});

test('play books markdown: 空・表の無い Markdown・ヘッダ行だけ', () => {
  assert.deepEqual(parsePlayBooksMarkdown(''), []);
  assert.deepEqual(parsePlayBooksMarkdown('# Title\n\nsome text'), []);
  assert.deepEqual(parsePlayBooksMarkdown('| a | b |\n| --- | --- |\n'), []);
});

test('play books markdown: CRLF・エスケープ・メモ・日付の形', () => {
  const link = (p) => `[${p}](https://www.google.com/url?q=https://play.google.com/books/reader?id%3DMDV1%26pg%3D1)`;
  const md = [
    '| ![Cover Image][image1] | *Title \\(上\\)* Author |',
    '| :---- | :---- |',
    '',
    '## Chapter 1',
    `|  ![][image2] *highlight \\(one\\)* my note May 1, 2024 ${link('12')}  |`,
    `|  ![][image2] *日本語の線* 2024年5月1日 ${link('xiv')}  |`,
    `|  ![][image2] *no date here* ${link('13')}  |`,
  ].join('\r\n');
  const [book] = parsePlayBooksMarkdown(md, 'fallback');
  assert.equal(book.title, 'Title (上)');
  assert.equal(book.volumeId, 'MDV1');
  assert.deepEqual(book.highlights.map((h) => [h.text, h.note, h.page, h.chapter]), [['highlight (one)', 'my note', '12', 'Chapter 1'], ['日本語の線', '', 'xiv', 'Chapter 1']]);
});

test('play books docx: document.xml の無い zip・空の document.xml', async () => {
  assert.deepEqual(await parsePlayBooksDocx([], 'x'), []);
  assert.deepEqual(await parsePlayBooksDocx([{ name: 'word/document.xml', bytes: enc('') }], 'x'), []);
  assert.deepEqual(docxXmlToBlocks(''), []);
});

test('play books docx: 絵文字・全角・エンティティを含む本', async () => {
  const xml = playBooksDocumentXml({ title: '📚 本 &amp; ノート', author: '著者', annotations: [{ chapter: '第１章', text: 'Ａ &lt; B', fill: 'fde096', date: '2024年5月1日', page: '1' }] });
  const zip = makeDeflateZip([{ name: 'word/document.xml', content: xml }]);
  const r = await parseFiles([{ name: 'x.docx', bytes: zip }]);
  assert.equal(r.books[0].title, '📚 本 & ノート');
  assert.equal(r.books[0].highlights[0].text, 'Ａ < B');
  assert.equal(r.books[0].highlights[0].chapter, '第１章');
});

// ---------------------------------------------------------------- blocks

test('colorName: 6 桁・3 桁・名前・不正な値', () => {
  assert.equal(colorName('#fde096'), 'yellow');
  assert.equal(colorName('fde096'), 'yellow');
  assert.equal(colorName('#ff0'), 'yellow');
  assert.equal(colorName('fed'), colorName('ffeedd'));
  assert.equal(colorName('#f00'), 'red');
  assert.equal(colorName('yellow'), 'yellow');
  assert.equal(colorName(''), '');
  assert.equal(colorName(null), '');
  assert.equal(colorName('#808080'), '');
});

test('htmlToBlocks: 閉じていない表・セル、入れ子の表、壊れたタグでも落ちない', () => {
  assert.ok(Array.isArray(htmlToBlocks('<table><tr><td>a<td>b<table><tr><td>c</td></tr></table><p>after')));
  assert.doesNotThrow(() => htmlToBlocks('<p class="unterminated>text'));
  assert.doesNotThrow(() => htmlToBlocks('</td></tr></table></span></p>'));
  assert.doesNotThrow(() => docxXmlToBlocks('</w:tc></w:tbl><w:tc><w:p><w:r><w:t>x</w:t></w:r></w:p>'));
});

test('htmlToBlocks: 閉じ引用符の無い属性がたくさんあっても固まらない', () => {
  const html = '<p>' + '<a title="x>y '.repeat(3000) + '</p>';
  const t0 = Date.now();
  htmlToBlocks(html);
  assert.ok(Date.now() - t0 < 3000);
});

// ---------------------------------------------------------------- 読書メモ

test('reading note: 空・空白だけ・BOM だけ・front matter だけ', () => {
  for (const s of ['', '   \n\n', BOM, '---\ntags: [a]\n---\n', undefined, null]) {
    const r = parseReadingNote(s, 't');
    assert.deepEqual(r.highlights, [], JSON.stringify(s));
  }
});

test('reading note: CR だけ・CRLF の改行と BOM 付きの front matter', () => {
  const md = `${BOM}---\ntitle: x\n---\n# 章\n\nこれは一つ目の段落です。\n\n- 項目A\n- 項目B\n`;
  const a = parseReadingNote(md, 't').highlights;
  assert.deepEqual(parseReadingNote(md.replace(/\n/g, '\r\n'), 't').highlights, a);
  assert.deepEqual(parseReadingNote(md.replace(/\n/g, '\r'), 't').highlights, a);
  assert.deepEqual(a.map((h) => [h.text, h.chapter]), [['これは一つ目の段落です。', '章'], ['項目A', '章'], ['項目B', '章']]);
});

test('reading note: 閉じていない front matter は本文として残す', () => {
  const r = parseReadingNote('---\ntitle: x\n\n本文の文章です。', 't');
  assert.ok(r.highlights.some((h) => h.text.includes('本文の文章です。')));
});

test('reading note: 画像だけ・壊れたリンクや埋め込み', () => {
  const r = parseReadingNote('![[a.png]]\n![alt](b.jpg)\n![[unclosed\n[link](no close', 't');
  assert.deepEqual(r.images, ['a.png', 'b.jpg']);
  assert.ok(r.highlights.every((h) => !h.text.includes('a.png')));
});

test('reading note: 巨大な 1 行・大量の行でも短時間で終わる', () => {
  const t0 = Date.now();
  parseReadingNote('[' + 'a'.repeat(200000) + '\n' + '![[' + 'x'.repeat(100000), 't');
  const many = Array.from({ length: 50000 }, (_, i) => (i % 3 ? `- 項目 ${i}` : '')).join('\n');
  const r = parseReadingNote(many, 't');
  assert.ok(r.highlights.length > 30000);
  assert.ok(Date.now() - t0 < 5000);
});

test('noteTitleFromFileName: 空・拡張子だけ・Windows パス', () => {
  assert.equal(noteTitleFromFileName(''), '');
  assert.equal(noteTitleFromFileName(undefined), '');
  assert.equal(noteTitleFromFileName('C:\\notes\\本.MD'), '本');
  assert.equal(noteTitleFromFileName('「」のメモ.md'), '「」のメモ');
});

// ---------------------------------------------------------------- 形式の判定（index.js）

test('parseFiles: 空のファイル・空白だけのファイルはエラーとして返り、落ちない', async () => {
  for (const name of ['a.txt', 'a.md', 'a.html', 'a.json', 'a', 'a.docx', 'a.zip']) {
    const r = await one(name, '');
    assert.ok(r.error, name);
    const w = await one(name, '  \n ');
    assert.ok(w.error, name);
  }
});

test('parseFiles: JSON の null・数値・空配列・壊れた JSON', async () => {
  for (const s of ['null', '123', '[]', '{}', '"str"', '{"books": null}', '[null]', '{"format":"book-highlights/kindle-notebook","books":[]}']) {
    const r = await one('a.json', s);
    assert.ok(r.error, s);
    assert.doesNotMatch(r.error, /Cannot read|undefined|null/, s);
  }
  assert.equal((await one('a.json', '{"books": [')).error, 'JSON として読めませんでした');
});

test('parseFiles: [ で始まる My Clippings.txt は JSON と誤認しない', async () => {
  const r = await one('My Clippings.txt', clip('[新装版] 本 (著者)', '- 位置No. 1-2のハイライト |作成日: 2024年1月1日', '本文'));
  assert.equal(r.format, 'kindle-clippings');
  assert.equal(r.highlights, 1);
});

test('parseFiles: ハイライトに HTML のタグを含む My Clippings.txt（技術書）も Clippings として読む', async () => {
  const text = clip('HTML入門 (著者)', '- Your Highlight on Location 10-12 | Added on Monday, January 1, 2024 1:00:00 AM', 'Wrap the content in a <div> or <p> element, then style the <table>.');
  const r = await one('My Clippings.txt', text);
  assert.equal(r.format, 'kindle-clippings');
  assert.equal(r.highlights, 1);
});

test('parseFiles: インライン HTML を含む読書メモ（.md）は読書メモとして読む', async () => {
  const r = await one('本.md', '# 第1章\n\n<div align="center">中央寄せの見出し</div>\n\nこれは本文の文章です。<br>改行もある。\n');
  assert.equal(r.format, 'reading-note');
  assert.ok(r.highlights >= 1);
});

test('parseFiles: Setext 見出し（=====）と「作成日」を含む読書メモは Clippings と誤認しない', async () => {
  const md = '読書メモ\n==========\n\n作成日: 2024-01-01\n\nこの本はとても面白かった。\n\n- 第一の学び\n- 第二の学び\n';
  const r = await one('本.md', md);
  assert.equal(r.format, 'reading-note');
  assert.equal(r.highlights, 4);
});

test('parseFiles: 拡張子の無い Clippings・大文字の拡張子', async () => {
  const text = clip('本 (著者)', '- 位置No. 1-2のハイライト |作成日: 2024年1月1日', '本文');
  assert.equal((await one('clippings', text)).format, 'kindle-clippings');
  assert.equal((await one('MY CLIPPINGS.TXT', text)).format, 'kindle-clippings');
  assert.equal((await one('note.MD', '# 章\n\n本文の文章です。')).format, 'reading-note');
});

test('parseFiles: BOM 付き・Shift_JIS の Clippings', async () => {
  const text = clip('本 (著者)', '- 位置No. 1-2のハイライト |作成日: 2024年1月1日', '本文');
  const r = await one('My Clippings.txt', enc(BOM + text));
  assert.equal(r.format, 'kindle-clippings');
  const sjis = new Uint8Array([0x96, 0x7b, 0x0a]); // 「本」
  assert.equal(decodeText(sjis), '本\n');
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), 'a');
});

test('parseFiles: UTF-16（BOM 付き）で保存し直した Clippings も読む', async () => {
  const text = clip('本 (著者)', '- 位置No. 1-2のハイライト |作成日: 2024年1月1日', '本文');
  const le = Buffer.from('\uFEFF' + text, 'utf16le');
  assert.equal(decodeText(new Uint8Array(le)), text);
  const r = await one('My Clippings.txt', new Uint8Array(le));
  assert.equal(r.format, 'kindle-clippings');
  const be = Buffer.from('\uFEFF' + text, 'utf16le').swap16();
  assert.equal(decodeText(new Uint8Array(be)), text);
});

test('parseFiles: 壊れた zip・中身の空な zip・__MACOSX は落ちずに扱う', async () => {
  const broken = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  const r = await parseFiles([{ name: 'x.zip', bytes: broken }]);
  assert.equal(r.results.length, 1);
  assert.ok(r.results[0].error);
  const text = clip('本 (著者)', '- 位置No. 1-2のハイライト |作成日: 2024年1月1日', '本文');
  const zip = createZip([{ name: '__MACOSX/._My Clippings.txt', content: 'junk' }, { name: 'My Clippings.txt', content: text }]);
  const z = await parseFiles([{ name: 'a.zip', bytes: zip }]);
  assert.deepEqual(z.results.map((x) => x.format), ['kindle-clippings']);
});

test('parseFiles: Kindle エクスポートの判定は Play Books より先、ハイライトの無い HTML はエラー', async () => {
  const k = await one('x.html', exportHtml('<div class="noteHeading">Highlight - Location 1</div><div class="noteText">t</div>'));
  assert.equal(k.format, 'kindle-export');
  const none = await one('x.html', '<html><body><p>nothing</p></body></html>');
  assert.ok(none.error);
});

test('parseFiles: 汎用 JSON は source を 3 種類に丸める', async () => {
  const r = await parseFiles([{ name: 'x.json', bytes: enc(JSON.stringify([{ title: 'T', source: 'evil', highlights: [{ text: 'a' }] }])) }]);
  assert.equal(r.books[0].source, 'manual');
});

test('parseFiles: 本文が画像だけの読書メモは画像の数を知らせるエラー', async () => {
  const r = await one('a.md', '![[a.png]]\n![[b.png]]');
  assert.match(r.error, /画像 2 枚/);
});
