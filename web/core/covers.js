// 本の表紙画像の URL。自分でアップロードした表紙（紙の本など）があればそれを使う。
// 無ければ Kindle の本は ASIN から Amazon の画像、Play ブックスの本は書籍 ID から Google ブックスの画像。
// どちらも検索 API を使わずに URL が決まる（回数制限やキーが要らない）。ID の形を確かめてから URL に入れる。

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

/** @param {{ cover?: string, asin?: string, volumeId?: string } | null | undefined} book @returns {string} 表紙の URL（無ければ空） */
export function bookCoverUrl(book) {
  if (isUploadedCover(book?.cover)) return book.cover;
  if (ASIN.test(book?.asin || '')) return `https://images-na.ssl-images-amazon.com/images/P/${book.asin}.09.MZZZZZZZ.jpg`;
  if (VOLUME_ID.test(book?.volumeId || '')) return `https://books.google.com/books/content?id=${book.volumeId}&printsec=frontcover&img=1&zoom=1`;
  return '';
}
