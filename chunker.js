// تقسیم صفحات به بخش‌های قابل جست‌وجو با حفظ فصل/درس/تیتر و شماره صفحه
import { normalize } from './textnorm.js';

// تیتر فصل/درس: خط کوتاهی که با این واژه‌ها شروع شود و شماره یا «:» داشته باشد
const CHAPTER_RE = /^\s*(?:#\s*)?(فصل|بخش|Chapter|Unit)(?=[\s:\-–]|$)/i;
const LESSON_RE = /^\s*(?:#\s*)?(درس|گفتار|Lesson)(?=[\s:\-–]|$)/i;
const isHeadingLine = (l) => l.trim().length < 90 && /[\d۰-۹٠-٩:]|اول|دوم|سوم|چهارم|پنجم|ششم|هفتم|هشتم|نهم|دهم/.test(l);
const HEADING_RE = /^\s*#\s+(.{2,120})$/;

export function chunkPages(pages, { offset = 0, target = 1100, overlap = 150 } = {}) {
  const chunks = [];
  let chapter = null, topic = null, heading = null;
  let buf = [], bufLen = 0, start = null, end = null, flagged = false;
  const flush = (keepOverlap) => {
    const text = buf.join('\n').trim();
    if (text.length >= 30) chunks.push({ ord: chunks.length, page_start: start, page_end: end, chapter, topic, heading, text, norm_text: normalize(text), char_count: text.length, flagged: flagged ? 1 : 0 });
    if (keepOverlap && text.length > overlap) { const tail = text.slice(-overlap); buf = [tail.slice(tail.indexOf(' ') + 1)]; bufLen = buf[0].length; }
    else { buf = []; bufLen = 0; }
    start = null; flagged = false;
  };
  for (const p of pages) {
    const printed = p.page_no + offset;
    const lines = p.text.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, '');
      if (!line.trim()) { if (bufLen > target * 0.7) flush(false); continue; }
      const ch = isHeadingLine(line) && CHAPTER_RE.test(line);
      const ls = !ch && isHeadingLine(line) && LESSON_RE.test(line);
      const hd = line.match(HEADING_RE);
      if (ch || ls || hd) {
        if (bufLen) flush(false);
        if (ch) { chapter = line.replace(/^\s*#\s*/, '').replace(/\s+/g, ' ').trim(); topic = null; }
        else if (ls) topic = line.replace(/^\s*#\s*/, '').replace(/\s+/g, ' ').trim();
        heading = line.replace(/^#\s*/, '').trim();
      }
      if (start === null) start = printed;
      end = printed;
      if (p.flagged) flagged = true;
      buf.push(line); bufLen += line.length + 1;
      if (bufLen >= target) flush(true);
    }
  }
  if (bufLen) flush(false);
  return chunks;
}
