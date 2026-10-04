import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteTitleFromFileName, parseReadingNote } from '../web/core/parsers/reading-notes.js';
import { parseFiles } from '../web/core/parsers/index.js';
import { bookIdFor, emptyLibrary, libraryStats, listBooks, mergeParsed } from '../web/core/model.js';

const enc = (s) => new TextEncoder().encode(s);
const texts = (book) => book.highlights.map((h) => h.text);

test('noteTitleFromFileName: フォルダと拡張子を外し、「…」のメモ は中の書名にする', () => {
  assert.equal(noteTitleFromFileName('02_古典/パスカル.md'), 'パスカル');
  assert.equal(noteTitleFromFileName('「人はなぜ「自由」から逃走するのか (ワニの本)」のメモ.md'), '人はなぜ「自由」から逃走するのか (ワニの本)');
  assert.equal(noteTitleFromFileName('「技術書」の読書術.md'), '「技術書」の読書術');
  assert.equal(noteTitleFromFileName('a\\b\\躁鬱大学.markdown'), '躁鬱大学');
});

test('parseReadingNote: 見出しを章にし、段落・箇条書きの項目（入れ子ごと）を 1 点にする', () => {
  const md = [
    '---',
    'tags: [book]',
    '---',
    '',
    '# 第１部　「短い」とは「賢い」こと',
    '- - - ',
    '',
    '人類史上、これほど多くの言葉が吐き出されたことはない。',
    '',
    '▼誰もが長い文章を書いている。',
    '',
    '## 第１章　**短く**、しかし浅くはしない',
    '---',
    '- 社会保障とは',
    '\t- 医療・介護・年金',
    '\t- ==さまざまな制度==がある',
    '',
    '- **経営**や財務の知識は',
    '    - 「管理職になるための勉強」ではなく',
    '- 二つ目の項目',
    '',
    '社会保障の理解が難しい理由',
    '- 制度が複雑',
    '- 立場で見え方が違う',
    '',
    '> **福沢諭吉が書いたような学科**',
    '> ',
    '> これは現代の必修科目とも重なる。',
    '',
    '#### ',
    '1.',
  ].join('\n');
  const book = parseReadingNote(md, '本の題');
  assert.equal(book.title, '本の題');
  assert.equal(book.source, 'memo');
  assert.deepEqual(texts(book), [
    '人類史上、これほど多くの言葉が吐き出されたことはない。',
    '▼誰もが長い文章を書いている。',
    '社会保障とは\n・医療・介護・年金\n・さまざまな制度がある',
    '経営や財務の知識は\n・「管理職になるための勉強」ではなく',
    '二つ目の項目',
    '社会保障の理解が難しい理由\n・制度が複雑\n・立場で見え方が違う',
    // 短い太字の 1 行は小見出しとして本文とまとめる
    '福沢諭吉が書いたような学科\nこれは現代の必修科目とも重なる。',
  ]);
  assert.deepEqual(book.highlights.map((h) => h.chapter), [
    '第１部　「短い」とは「賢い」こと',
    '第１部　「短い」とは「賢い」こと',
    '第１章　短く、しかし浅くはしない',
    '第１章　短く、しかし浅くはしない',
    '第１章　短く、しかし浅くはしない',
    '第１章　短く、しかし浅くはしない',
    '第１章　短く、しかし浅くはしない',
  ]);
  assert.deepEqual(book.images, []);
});

test('parseReadingNote: 「・」でつないだ段落は「・」ごとに分け、画像の埋め込みは点にせず数える', () => {
  const md = '「躁鬱大学」 \n\n\n・僕が調子を崩したのは部活をやめてからです。 ・決まった時間に何をすればいいのかがわからなくなった。 ・躁鬱人は暇だと鬱になります。\n\n![[Screenshot_1.png|234x520]]![[image-2.png]]\n本文の [[リンク|別名]] と [外部](https://example.com) と _強調_。\n';
  const book = parseReadingNote(md, '躁鬱大学');
  assert.deepEqual(texts(book), [
    '「躁鬱大学」',
    '僕が調子を崩したのは部活をやめてからです。',
    '決まった時間に何をすればいいのかがわからなくなった。',
    '躁鬱人は暇だと鬱になります。',
    '本文の 別名 と 外部 と 強調。',
  ]);
  assert.deepEqual(book.images, ['Screenshot_1.png', 'image-2.png']);
});

test('parseReadingNote: 句点で終わらない短い 1 行は小見出しとして次の点の頭に付け、題の行に続く「・」の並びも分ける', () => {
  const md = '## 1-1 本を見つける\n\nColumn\n\n読書の名言\n\n「よい本は私の人生におけるイベントである」\n──スタンダール\n\n資格を取る\n\n## 1-2 読む\n\n最後の小見出し\n';
  assert.deepEqual(texts(parseReadingNote(md, '技術書')), [
    'Column\n読書の名言\n「よい本は私の人生におけるイベントである」\n──スタンダール',
    '資格を取る',
    '最後の小見出し',
  ]);
  const gakumon = '「学問のすすめ」\n・学ばない者は、何が正しいのかを判断できません。 ・自分で判断ができない者は、人に頼ります。';
  assert.deepEqual(texts(parseReadingNote(gakumon, '学問のすすめ')), ['「学問のすすめ」', '学ばない者は、何が正しいのかを判断できません。', '自分で判断ができない者は、人に頼ります。']);
});

test('parseReadingNote: Play ブックスの書き出しを貼ったメモは、リンクの間の断片を 1 つの点につなぐ', () => {
  const url = 'https://www.google.com/url?q=http://play.google.com/books/reader?printsec%3Dfrontcover%26id%3DsQUzOQAAAEAJ%26source%3Dbooks-notes-export%26pg%3DGBS.PA277&sa=D';
  const md = `${url}\n- 中には、世間に出回るネガティヴ 情報のせいで、自分はどんな職業にも適合しないのではないか、仮に職に就けてもすぐに不適応\n- になってしまうのではないか、と不安になる子もいる。\n\n${url}\n- 二つ目の線\n`;
  const book = parseReadingNote(md, 'ワニの本');
  assert.deepEqual(texts(book), [
    '中には、世間に出回るネガティヴ 情報のせいで、自分はどんな職業にも適合しないのではないか、仮に職に就けてもすぐに不適応になってしまうのではないか、と不安になる子もいる。',
    '二つ目の線',
  ]);
});

test('parseReadingNote: 本文の無いメモ（空・画像だけ・空の見出しだけ）は点 0 件', () => {
  assert.equal(parseReadingNote('', '空').highlights.length, 0);
  assert.equal(parseReadingNote('\n\n![[image-17 2.png]]', '人間の条件').highlights.length, 0);
  assert.equal(parseReadingNote('## 1. 青年期と自己の課題\n- - - \n### 1. 青年と性格形成\n\n\n#### 2. 欲求と適応\n', '倫理').highlights.length, 0);
});

test('parseFiles: .md の読書メモは「読書メモ」として読み、画像だけのメモは理由つきで知らせる', async () => {
  const r = await parseFiles([
    { name: 'Books/01_哲学/ハマトン.md', bytes: enc('- **節約**ということに無頓着な人が多過ぎ\n\n- 知識には役に立ち始める時点がある\n') },
    { name: 'Books/耳読書.md', bytes: enc('\n\n![[Screenshot_20240520-223446.png]]\n') },
  ]);
  assert.equal(r.books.length, 1);
  assert.equal(r.books[0].title, 'ハマトン');
  assert.equal(r.books[0].source, 'memo');
  assert.equal(r.results[0].formatLabel, '読書メモ（Markdown）');
  assert.equal(r.results[0].highlights, 2);
  assert.match(r.results[1].error, /画像 1 枚/);
});

test('parseFiles: Play ブックスの Markdown 書き出し（表の形）は今までどおり Play Books として読む', async () => {
  const { readFileSync } = await import('node:fs');
  const md = readFileSync(new URL('./fixtures/playbooks-ja.md', import.meta.url));
  const r = await parseFiles([{ name: 'playbooks-ja.md', bytes: new Uint8Array(md) }]);
  assert.equal(r.results[0].format, 'playbooks');
});

test('mergeParsed（読書メモ）: 書名の一部が一致する既存の本にまとめ、既にある線と同じ文は増やさない', () => {
  const lib = emptyLibrary();
  mergeParsed(lib, [
    { title: '新版 ハマトンの知的生活 (三笠書房 電子書籍)', source: 'playbooks', highlights: [{ text: '節約ということにまったく無頓着な人があまりにも多過ぎ' }] },
    { title: '人間の条件 (ちくま学芸文庫)', source: 'playbooks', highlights: [{ text: '活動的生活' }] },
    { title: '精読 アレント『人間の条件』', source: 'kindle', highlights: [{ text: '労働' }] },
  ]);
  const stats = mergeParsed(lib, [
    { title: 'ハマトン', source: 'memo', highlights: [{ text: '節約ということにまったく 無頓着な人が\nあまりにも多過ぎ' }, { text: '知識には役に立ち始める時点がある' }] },
    // 一致する本が 2 冊以上あるときは決めつけず、別の本にする
    { title: '人間の条件', source: 'memo', highlights: [{ text: '人間の条件のメモ' }] },
  ]);
  const hamaton = bookIdFor('新版 ハマトンの知的生活 (三笠書房 電子書籍)');
  assert.equal(lib.books[bookIdFor('ハマトン')], undefined);
  assert.deepEqual(lib.books[hamaton].sources, ['playbooks', 'memo']);
  assert.equal(listBooks(lib).find((b) => b.id === hamaton).count, 2);
  assert.ok(lib.books[bookIdFor('人間の条件')]);
  assert.equal(stats.added, 2);
  assert.equal(stats.unchanged, 1);
  assert.equal(libraryStats(lib).highlights, 5);
});

test('bh import <フォルダ>: 入れ子のフォルダの .md を読み、--dry-run では保存しない', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const run = promisify(execFile);
  const root = mkdtempSync(path.join(tmpdir(), 'bh-notes-'));
  const notes = path.join(root, 'Books');
  mkdirSync(path.join(notes, '01_哲学'), { recursive: true });
  writeFileSync(path.join(notes, '01_哲学', 'パンセ.md'), '# 第1章\n\n人間は考える葦である。\n\n- 気晴らし\n\t- 退屈から逃げる\n');
  writeFileSync(path.join(notes, '耳読書.md'), '![[a.png]]\n');
  writeFileSync(path.join(notes, 'a.png'), 'not an image');
  const dataDir = path.join(root, 'data');
  const bh = new URL('../cli/bh.js', import.meta.url);
  const env = { ...process.env, BH_DATA: dataDir };
  const dry = await run('node', [bh.pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'import', notes, '--dry-run'], { env });
  assert.match(dry.stdout, /01_哲学\/パンセ\.md: 読書メモ（Markdown） — 本 1 冊 \/ 点 2 件/);
  assert.match(dry.stdout, /耳読書\.md: 本文が無く、画像 1 枚だけのメモです/);
  assert.doesNotMatch(dry.stdout, /a\.png/);
  assert.match(dry.stdout, /（試し・保存していません）取り込み: 新しい点 2 件/);
  assert.equal(existsSync(path.join(dataDir, 'library.json')), false);
  await run('node', [bh.pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'import', notes], { env });
  const lib = JSON.parse(readFileSync(path.join(dataDir, 'library.json'), 'utf8'));
  assert.deepEqual(Object.values(lib.books).map((b) => [b.title, b.sources]), [['パンセ', ['memo']]]);
  assert.deepEqual(Object.values(lib.highlights).map((h) => h.text).sort(), ['人間は考える葦である。', '気晴らし\n・退屈から逃げる'].sort());
});
