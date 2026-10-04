// 本の表紙画像の URL。Kindle の本は ASIN から Amazon の画像、Play ブックスの本は書籍 ID から Google ブックスの画像。
// どちらも検索 API を使わずに URL が決まる（回数制限やキーが要らない）。ID の形を確かめてから URL に入れる。

const ASIN = /^[A-Z0-9]{10}$/;
const VOLUME_ID = /^[\w-]{3,24}$/;

/** @param {{ asin?: string, volumeId?: string } | null | undefined} book @returns {string} 表紙の URL（無ければ空） */
export function bookCoverUrl(book) {
  if (ASIN.test(book?.asin || '')) return `https://images-na.ssl-images-amazon.com/images/P/${book.asin}.09.MZZZZZZZ.jpg`;
  if (VOLUME_ID.test(book?.volumeId || '')) return `https://books.google.com/books/content?id=${book.volumeId}&printsec=frontcover&img=1&zoom=1`;
  return '';
}
