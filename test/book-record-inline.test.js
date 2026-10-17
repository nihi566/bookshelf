// 本の画面で読み終えた日をその場で記録する（シートも読書記録の画面も開かない）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, registerBook } from '../web/core/model.js';
import { decodeBase64Utf8, encodeBase64Utf8 } from '../web/core/records.js';
import { mountBookRecord } from '../web/js/views/records.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function until(box, pattern) {
  for (let i = 0; i < 50 && !pattern.test(box.innerHTML); i += 1) await tick();
  assert.match(box.innerHTML, pattern);
}

test('本の画面: 日付を入れて「記録」を押すと、その場で records.json に書き、「記録済み」に変わる', async () => {
  const saved = [];
  let stored = { version: 1, records: {}, excluded: {} };
  const keep = { fetch: globalThis.fetch, FormData: globalThis.FormData, localStorage: globalThis.localStorage, document: globalThis.document };
  const toastEl = { textContent: '', classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null, append() {} };
  globalThis.document = { getElementById: () => toastEl };
  globalThis.localStorage = { getItem: () => 'test-token', setItem() {}, removeItem() {} };
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body);
      stored = JSON.parse(decodeBase64Utf8(body.content));
      saved.push(stored);
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({}) };
    }
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ content: encodeBase64Utf8(JSON.stringify(stored)), sha: 'sha-1' }) };
  };
  globalThis.FormData = class {
    constructor(form) {
      this.values = form.values;
    }
    get(name) {
      return this.values[name];
    }
  };
  try {
    const library = emptyLibrary();
    const book = registerBook(library, { title: '手入力の本', author: '著者' });
    const box = { isConnected: true, innerHTML: '', onsubmit: null };
    mountBookRecord(box, { library }, book);

    await until(box, /<input type="date" name="read_on"/);
    assert.match(box.innerHTML, /<button class="btn primary" type="submit">記録<\/button>/);

    const form = { values: { read_on: '2026-10-17' }, querySelector: () => ({ disabled: false }) };
    await box.onsubmit({ target: { closest: () => form }, preventDefault() {} });

    assert.equal(saved.length, 1);
    assert.deepEqual(
      { title: saved[0].records[book.id].title, read_on: saved[0].records[book.id].read_on, pages: saved[0].records[book.id].pages },
      { title: '手入力の本', read_on: '2026-10-17', pages: null },
    );
    assert.match(box.innerHTML, /（記録済み）/);
    assert.match(box.innerHTML, /value="2026-10-17"/);
    assert.match(box.innerHTML, /type="submit">更新<\/button>/);
    assert.equal(toastEl.textContent, '読み終えた日を記録しました');
  } finally {
    Object.assign(globalThis, keep);
  }
});

test('本の画面: 保存に失敗したら描き直さず（入れた日付を残し）、ボタンを押せる状態に戻す', async () => {
  const keep = { fetch: globalThis.fetch, FormData: globalThis.FormData, localStorage: globalThis.localStorage, document: globalThis.document };
  const toastEl = { textContent: '', classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null, append() {} };
  globalThis.document = { getElementById: () => toastEl };
  globalThis.localStorage = { getItem: () => 'test-token', setItem() {}, removeItem() {} };
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'PUT') return { ok: false, status: 401, headers: new Headers(), json: async () => ({}) };
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ content: encodeBase64Utf8(JSON.stringify({ version: 1, records: {}, excluded: {} })), sha: 'sha-1' }) };
  };
  globalThis.FormData = class {
    constructor(form) {
      this.values = form.values;
    }
    get(name) {
      return this.values[name];
    }
  };
  try {
    const library = emptyLibrary();
    const book = registerBook(library, { title: '失敗する本' });
    const box = { isConnected: true, innerHTML: '', onsubmit: null };
    mountBookRecord(box, { library }, book);
    await until(box, /<input type="date" name="read_on"/);
    const before = box.innerHTML;
    const button = { disabled: false };
    const form = { values: { read_on: '2026-01-02' }, querySelector: () => button };
    await box.onsubmit({ target: { closest: () => form }, preventDefault() {} });
    assert.equal(button.disabled, false);
    assert.equal(box.innerHTML, before);
    assert.notEqual(toastEl.textContent, '読み終えた日を記録しました');
  } finally {
    Object.assign(globalThis, keep);
  }
});
