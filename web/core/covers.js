// 本の表紙画像の URL。自分でアップロードした表紙（紙の本など）があればそれを使う。
// 無ければ Kindle の本は ASIN から Amazon の画像、ISBN が分かった本は ISBN-10 から Amazon の画像、
// Play ブックスの本は書籍 ID から Google ブックスの画像。
// どれも検索 API を使わずに URL が決まる（回数制限やキーが要らない）。ID の形を確かめてから URL に入れる。

const ASIN = /^[A-Z0-9]{10}$/;
const VOLUME_ID = /^[\w-]{3,24}$/;

// アップロードした表紙は縮小した画像の data URL で本のデータに入れ、PC・ほかの端末へ同期する。
// 同期で届いた値も画面に出すので、ラスタ画像の base64 だけを通す（SVG・HTML は通さない）
const UPLOADED_COVER = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
// 縮小後の表紙は数十 KB。大きすぎる値は同期を重くするので受け付けない
export const COVER_MAX_LENGTH = 400_000;

/** アップロードした表紙として使える値か */
export function isUploadedCover(value) {
  return typeof value === 'string' && value.length <= COVER_MAX_LENGTH && UPLOADED_COVER.test(value);
}

/**
 * ISBN を ISBN-10 にする（978 で始まる ISBN-13 か ISBN-10。それ以外は空）。紙の本の Amazon の ASIN は ISBN-10 と同じ
 * @param {string | undefined} isbn @returns {string}
 */
export function isbn10(isbn) {
  const s = String(isbn || '').replace(/-/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(s)) return s;
  if (!/^978\d{10}$/.test(s)) return '';
  const body = s.slice(3, 12);
  const sum = [...body].reduce((acc, d, i) => acc + Number(d) * (10 - i), 0);
  const check = (11 - (sum % 11)) % 11;
  return body + (check === 10 ? 'X' : String(check));
}

const amazonCover = (id) => `https://images-na.ssl-images-amazon.com/images/P/${id}.09.MZZZZZZZ.jpg`;

/**
 * 表紙の URL（無ければ空）。アップロードした表紙 > ASIN > ISBN（Amazon の紙の本の表紙）> Play ブックスの書籍 ID の順。
 * isbn は PC が書名・著者から探して付ける（cli/covers.js）。購入した Play ブックスの本の多くは、書籍 ID では
 * Google ブックスが「画像なし」の画像しか返さないため、ISBN があればそちらを使う
 * @param {{ cover?: string, asin?: string, isbn?: string, volumeId?: string } | null | undefined} book @returns {string}
 */
export function bookCoverUrl(book) {
  if (isUploadedCover(book?.cover)) return book.cover;
  if (ASIN.test(book?.asin || '')) return amazonCover(book.asin);
  const fromIsbn = isbn10(book?.isbn);
  if (fromIsbn) return amazonCover(fromIsbn);
  if (VOLUME_ID.test(book?.volumeId || '')) return `https://books.google.com/books/content?id=${book.volumeId}&printsec=frontcover&img=1&zoom=1`;
  return '';
}
