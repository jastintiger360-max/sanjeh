// نرمال‌سازی متن فارسی برای جست‌وجو و مقایسه
const AR_TO_FA = { 'ي': 'ی', 'ى': 'ی', 'ك': 'ک', 'ۀ': 'ه', 'ة': 'ه', 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ؤ': 'و' };
const DIGITS = { '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };

export function fixLetters(s) { return String(s ?? '').replace(/[يىك]/g, c => AR_TO_FA[c]); }

export function normalize(s) {
  return String(s ?? '')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // اعراب و کشیده
    .replace(/[يىكۀةأإآٱؤ]/g, c => AR_TO_FA[c])
    .replace(/[۰-۹٠-٩]/g, c => DIGITS[c])
    .replace(/[\u200c\u200f\u200e\u00a0]/g, ' ')
    .replace(/لا/g, 'ال') // یکسان‌سازی برای مقابله با خرابی لیگاتور «لا» در استخراج PDF (فقط در مقایسه)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set(('از به با در که این آن را و یا تا برای بر هم نیز های ها می است بود شد شده شود کند کرد کرده ای ی یک دو سه چه چرا کدام چند مورد گزینه زیر موارد صحیح درست نادرست غلط عبارت عبارات کدامیک ' +
  'هر همه اگر اما ولی پس سپس باید نمی نه بی خود او ما شما آنها ایشان وی من تو ' +
  'the a an of to in on for and or is are be by with as at from that this which what').split(/\s+/));

export function tokens(s) { return normalize(s).split(' ').filter(t => t.length > 1 && !STOP.has(t)); }

export function trigrams(s) {
  const n = ' ' + normalize(s) + ' ';
  const set = new Set();
  for (let i = 0; i < n.length - 2; i++) set.add(n.slice(i, i + 3));
  return set;
}
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
export const similarity = (x, y) => jaccard(trigrams(x), trigrams(y));

export function toFaDigits(s) { return String(s).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]); }
