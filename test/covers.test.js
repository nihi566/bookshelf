import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bookCoverUrl } from '../web/core/covers.js';
import { emptyLibrary, mergeParsed } from '../web/core/model.js';
import { parseFiles } from '../web/core/parsers/index.js';
import { parsePlayBooksHtml, parsePlayBooksMarkdown, playBooksVolumeId } from '../web/core/parsers/playbooks.js';
import { makeDeflateZip, playBooksDocumentXml } from './helpers/docx.js';

const fixtureText = async (name) => (await readFile(new URL(`./fixtures/${name}`, import.meta.url))).toString('utf8');

test('bookCoverUrl: ASIN は Amazon、Play ブックスの書籍 ID は Google ブックスの表紙。どちらも無い・形が不正なら空', () => {
  assert.equal(bookCoverUrl({ asin: 'B0D8N5G9GT' }), 'https://images-na.ssl-images-amazon.com/images/P/B0D8N5G9GT.09.MZZZZZZZ.jpg');
  assert.equal(bookCoverUrl({ volumeId: 'zyTCAlFPjgYC' }), 'https://books.google.com/books/content?id=zyTCAlFPjgYC&printsec=frontcover&img=1&zoom=1');
  // 両方あれば ASIN（Kindle の表紙）を優先
  assert.match(bookCoverUrl({ asin: '4798163708', volumeId: 'zyTCAlFPjgYC' }), /amazon/);
  assert.equal(bookCoverUrl({ title: '表紙なし' }), '');
  assert.equal(bookCoverUrl({ asin: 'x"><script>' }), '');
  assert.equal(bookCoverUrl({ volumeId: 'a&b=c' }), '');
  assert.equal(bookCoverUrl(null), '');
});

test('playBooksVolumeId: 本文のリンク（Google のリダイレクトで符号化されたものも）から書籍 ID を拾う', () => {
  assert.equal(playBooksVolumeId('<a href="https://www.google.com/url?q=http://play.google.com/books/reader?id%3DAbC_12-xyz%26pg%3DGBS.PA12&amp;sa=D">12</a>'), 'AbC_12-xyz');
  assert.equal(playBooksVolumeId('[15](http://play.google.com/books/reader?printsec=frontcover&output=reader&id=XYZ123&pg=GBS.PA15)'), 'XYZ123');
  assert.equal(playBooksVolumeId('<Relationship Target="http://play.google.com/books/reader?id=QWERTY987654&amp;pg=GBS.PA3" TargetMode="External"/>'), 'QWERTY987654');
  assert.equal(playBooksVolumeId('リンクなし'), '');
});

test('Play ブックスのメモ（HTML / Markdown / docx）から書籍 ID を取り出す', async () => {
  assert.equal(parsePlayBooksHtml(await fixtureText('playbooks-ja.html'))[0].volumeId, 'ABC');
  assert.equal(parsePlayBooksMarkdown(await fixtureText('playbooks-ja.md'))[0].volumeId, 'XYZ');
  const docx = makeDeflateZip([
    { name: 'word/document.xml', content: playBooksDocumentXml({ title: '書名', author: '著者', annotations: [{ chapter: '第1章', text: '本文', date: '2024年5月1日', page: '3', fill: 'fde096' }] }) },
    { name: 'word/_rels/document.xml.rels', content: '<Relationships><Relationship Id="rId9" Target="http://play.google.com/books/reader?id=DOCX12345678&amp;pg=GBS.PA3" TargetMode="External"/></Relationships>' },
  ]);
  const { books } = await parseFiles([{ name: '書名.docx', bytes: docx }]);
  assert.equal(books[0].volumeId, 'DOCX12345678');
});

test('mergeParsed: 書籍 ID を本に残し、既存の本に後から付いたときは booksUpdated に数える', () => {
  const lib = emptyLibrary();
  const pb = (extra) => ({ title: '深い集中', author: '佐藤', source: 'playbooks', highlights: [{ text: '注意は資源', note: '', page: '12' }], ...extra });
  mergeParsed(lib, [pb({})]);
  const book = Object.values(lib.books)[0];
  assert.equal(book.volumeId, undefined);
  const s = mergeParsed(lib, [pb({ volumeId: 'ABC123' })]);
  assert.equal(book.volumeId, 'ABC123');
  assert.equal(s.booksUpdated, 1);
  assert.equal(mergeParsed(lib, [pb({ volumeId: 'ABC123' })]).booksUpdated, 0);
});
