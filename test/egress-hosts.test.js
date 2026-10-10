// 外部との通信先の見張り（NIH-85）。
// ソースに文字で書いた http(s):// のホストと、docs/architecture.md §外部との通信先 の表のホストが一致することを確かめる。
// 新しい送信先を足したら、表に「何をやりとりするか」を書き足さないとここで落ちる（ハイライトの本文を外に送らない約束を人の記憶だけに頼らない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 見張る場所。web/vendor（同梱した Cytoscape.js）と web/wishlist-site（別のシステムが書き出す公開ページ）はこのシステムのコードではないので除く
const SCAN_DIRS = ['web', 'cli', 'extension'];
const SKIP_DIRS = new Set(['web/vendor', 'web/wishlist-site']);
const SCAN_EXT = new Set(['.js', '.html', '.json', '.webmanifest', '.css']);
const SECTION = '## 外部との通信先';

async function sourceFiles(dir) {
  const out = [];
  for (const ent of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${ent.name}`;
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(rel)) out.push(...(await sourceFiles(rel)));
    } else if (SCAN_EXT.has(path.extname(ent.name))) {
      out.push(rel);
    }
  }
  return out;
}

// コメント行（// や JSDoc の * で始まる行）の URL は例示なので数えない。
// テンプレート文字列の中で行頭が * や // の行も読み飛ばしてしまうので、URL を書く行をそう始めない
const isCommentLine = (line) => /^\s*(\/\/|\/?\*)/.test(line);

/** 文字列から http(s):// のホストを拾う（${…} や … で組み立てるホストは拾えない。表の下に文で書く） */
function hostsIn(text) {
  const hosts = new Set();
  for (const line of text.split('\n')) {
    if (isCommentLine(line)) continue;
    for (const m of line.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*)/gi)) hosts.add(m[1].toLowerCase());
  }
  return hosts;
}

/** architecture.md の §外部との通信先 の表の 1 列目に `ホスト` で書いたものを拾う */
function documentedHosts(text) {
  // core.autocrlf で取り出した作業ツリーでは改行が CRLF になる
  const markdown = text.replace(/\r\n/g, '\n');
  const start = markdown.indexOf(`\n${SECTION}\n`);
  if (start < 0) return null;
  const body = markdown.slice(start + SECTION.length + 2);
  const end = body.search(/\n## /);
  const hosts = new Set();
  for (const line of (end < 0 ? body : body.slice(0, end)).split('\n')) {
    if (!line.startsWith('|')) continue;
    const firstCell = line.split('|')[1] || '';
    for (const m of firstCell.matchAll(/`([^`]+)`/g)) hosts.add(m[1].toLowerCase());
  }
  return hosts;
}

async function sourceHosts() {
  const where = new Map();
  for (const dir of SCAN_DIRS) {
    for (const file of await sourceFiles(dir)) {
      for (const host of hostsIn(await readFile(path.join(ROOT, file), 'utf8'))) {
        if (!where.has(host)) where.set(host, []);
        where.get(host).push(file);
      }
    }
  }
  return where;
}

test('hostsIn: 文字列の URL のホストを拾い、コメント行と組み立てたホストは拾わない', () => {
  const src = [
    "const A = 'https://api.example.com/v1';",
    '  img.src = `http://IMG.example.org:8080/a.png`;',
    '// 例: https://comment.example.com',
    ' * http://user:pass@host を伏せる',
    'fetch(`https://${host}/x`); fetch(`https://….ts.net`);',
  ].join('\n');
  assert.deepEqual([...hostsIn(src)].sort(), ['api.example.com', 'img.example.org']);
});

test('documentedHosts: 節の表の 1 列目のホストだけを拾い、次の節では止まる', () => {
  const md = `# x\n\n${SECTION}\n\n| ホスト | 中身 |\n| --- | --- |\n| \`a.example.com\`・\`b.example.com\` | \`not.host\` |\n\n## 次\n\n| \`c.example.com\` | x |\n`;
  assert.deepEqual([...documentedHosts(md)].sort(), ['a.example.com', 'b.example.com']);
  assert.deepEqual([...documentedHosts(md.replace(/\n/g, '\r\n'))].sort(), ['a.example.com', 'b.example.com']);
  assert.equal(documentedHosts('# 節が無い'), null);
});

test('ソースに書いた通信先のホストが、すべて architecture.md §外部との通信先 の表にある（一覧に無いホストを足すと落ちる）', async () => {
  const documented = documentedHosts(await readFile(path.join(ROOT, 'docs/architecture.md'), 'utf8'));
  assert.ok(documented, `docs/architecture.md に「${SECTION}」の節が無い`);
  const missing = [...(await sourceHosts())].filter(([host]) => !documented.has(host)).map(([host, files]) => `${host}（${files.join(', ')}）`);
  assert.deepEqual(missing, [], '表に無い通信先。何をやりとりするか（ハイライトの本文を送っていないか）を確かめて表に足す');
});

test('architecture.md §外部との通信先 の表のホストが、すべてソースで使われている（使わなくなった通信先を表に残さない）', async () => {
  const documented = documentedHosts(await readFile(path.join(ROOT, 'docs/architecture.md'), 'utf8'));
  assert.ok(documented, `docs/architecture.md に「${SECTION}」の節が無い`);
  const used = await sourceHosts();
  assert.deepEqual([...documented].filter((host) => !used.has(host)), [], 'ソースに無いホストが表に残っている');
});
