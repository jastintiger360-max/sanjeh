// استخراج متن از PDF / DOCX / TXT / تصویر با حفظ صفحه، تیتر، جدول و فرمول تا جای ممکن.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readZip } from './zip.js';

const run = promisify(execFile);
const exec = (cmd, args, opts = {}) => run(cmd, args, { maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60_000, ...opts })
  .catch(e => { if (e.code === 'ENOENT') throw new Error(`ابزار «${cmd}» روی سرور نصب نیست (راهنمای استقرار را ببینید).`); throw e; });

const PERSIAN_RE = /[\u0600-\u06FF]/g;
const FUNC_WORDS = /(^|\s)(و|در|به|از|که|این|را|با|است|می|های|برای)(?=\s|$)/g;
const FORMULA_RE = /[=∑√±×÷≤≥≠∞∫∆πθλμ^]|\b\d+\s*[\/]\s*\d+\b/;

const BIDI_CTRL = /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/g;
export function cleanText(text) {
  // حذف نویسه‌های کنترل جهت و جابه‌جایی نقطه‌گذاری که pdftotext در خطوط راست‌به‌چپ به ابتدای خط می‌برد
  return text.normalize('NFKC').replace(BIDI_CTRL, '').split('\n').map(l => /[\u0600-\u06FF]/.test(l) ? l.replace(/^(\s*)([.،؛:!؟]+)\s*(.*\S)\s*$/, '$1$3$2') : l).join('\n');
}

export function analyzePage(text) {
  const t = cleanText(text); // NFKC: تبدیل حروف نمایشی عربی به حروف پایه
  const letters = (t.match(/\p{L}/gu) || []).length;
  const persian = (t.match(PERSIAN_RE) || []).length;
  const words = t.split(/\s+/).filter(Boolean).length;
  const func = (t.match(FUNC_WORDS) || []).length;
  const garbage = (t.match(/[\uFFFD\u25A1]/g) || []).length;
  const lines = t.split('\n');
  const tableLines = lines.filter(l => (l.trim().match(/\S\s{3,}\S/g) || []).length >= 2).length;
  let flag = null;
  if (letters < 40) flag = 'متن بسیار کم یا صفحه تصویری';
  else if (garbage > letters * 0.02) flag = 'نویسه‌های ناخوانا در استخراج';
  else if (persian > letters * 0.5 && words > 30 && func / words < 0.03) flag = 'ترتیب حروف فارسی احتمالاً خراب است';
  else if (persian > 300 && !/لا/.test(t) && (t.match(/ال/g) || []).length >= 3) flag = 'احتمال خرابی لیگاتور «لا» و ترتیب متن در لایه متنی PDF (OCR یا نسخه Word توصیه می‌شود)';
  return { text: t, flag, hasTable: tableLines >= 3, hasFormula: FORMULA_RE.test(t) };
}

async function ocrImage(file, langs) {
  const { stdout } = await exec('tesseract', [file, 'stdout', '-l', langs, '--psm', '3', 'tsv']);
  const rows = stdout.split('\n').slice(1).map(l => l.split('\t')).filter(r => r.length >= 12);
  let text = ''; let lastKey = ''; const confs = [];
  for (const r of rows) {
    const [level, , block, par, line, , , , , , conf, word] = r;
    if (level !== '5' || !word?.trim()) continue;
    const key = `${block}-${par}-${line}`;
    text += (lastKey && key !== lastKey ? '\n' : lastKey ? ' ' : '') + word;
    lastKey = key;
    const c = Number(conf); if (c >= 0) confs.push(c);
  }
  const confidence = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
  return { text, confidence };
}

async function extractPdf(file, { langs, onProgress, forceOcr }) {
  const { stdout } = await exec('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-']);
  const raw = stdout.split('\f');
  if (raw.length && raw[raw.length - 1].trim() === '') raw.pop();
  const pages = [];
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snj-ocr-'));
  try {
    for (let i = 0; i < raw.length; i++) {
      const a = analyzePage(raw[i]);
      let page = { page_no: i + 1, text: a.text, method: 'text', confidence: null, flagged: !!a.flag, flag_reason: a.flag, has_table: a.hasTable, has_formula: a.hasFormula };
      if (a.flag || forceOcr) {
        // تلاش برای OCR روی صفحاتی که لایه متنی مناسب ندارند
        try {
          const prefix = path.join(tmp, `p${i + 1}`);
          await exec('pdftoppm', ['-r', '300', '-f', String(i + 1), '-l', String(i + 1), '-png', '-singlefile', file, prefix]);
          const o = await ocrImage(prefix + '.png', langs);
          const b = analyzePage(o.text);
          if (forceOcr || o.text.trim().length > a.text.trim().length * 0.8) {
            const lowConf = o.confidence < 70;
            page = { page_no: i + 1, text: b.text, method: 'ocr', confidence: Math.round(o.confidence), flagged: lowConf || !!b.flag,
              flag_reason: lowConf ? `اطمینان OCR پایین (${Math.round(o.confidence)}٪)` : b.flag, has_table: b.hasTable, has_formula: b.hasFormula };
          }
        } catch (e) { page.flagged = true; page.flag_reason = `${a.flag || 'OCR درخواستی'}؛ OCR ناموفق: ${String(e.message).slice(0, 120)}`; }
      }
      pages.push(page);
      onProgress?.(i + 1, raw.length);
    }
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  return pages;
}

function xmlText(s) { return s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }

function extractDocx(buf) {
  const zip = readZip(buf);
  const xml = zip.read('word/document.xml')?.toString('utf8');
  if (!xml) throw new Error('فایل Word معتبر نیست.');
  const body = xml.replace(/<w:tbl>([\s\S]*?)<\/w:tbl>/g, (_, tbl) => {
    const rows = [...tbl.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)].map(r => [...r[0].matchAll(/<w:tc[\s>][\s\S]*?<\/w:tc>/g)].map(c => xmlText(c[0].replace(/<\/w:p>/g, ' ')).trim()).join(' | '));
    return `<w:p><w:r><w:t>[[TABLE]]\n${rows.join('\n')}\n[[/TABLE]]</w:t></w:r></w:p>`;
  });
  const pages = [[]];
  for (const pm of body.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) {
    const p = pm[0];
    if (/<w:br [^>]*w:type="page"|<w:lastRenderedPageBreak\/>/.test(p) && pages[pages.length - 1].length) pages.push([]);
    const style = p.match(/<w:pStyle w:val="([^"]+)"/)?.[1] || '';
    let text = xmlText(p.replace(/<m:t>([^<]*)<\/m:t>/g, ' ⟦$1⟧ ').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n')).trim();
    if (!text) continue;
    if (/^(Heading|Title|عنوان)/i.test(style)) text = '# ' + text;
    pages[pages.length - 1].push(text);
  }
  // اگر شکست صفحه ثبت نشده بود، صفحات مجازی حدود ۳۰۰۰ نویسه‌ای ساخته می‌شود
  let out = pages.map(p => p.join('\n'));
  if (out.length === 1 && out[0].length > 4000) out = virtualPages(out[0]);
  return out.map((t, i) => { const a = analyzePage(t); return { page_no: i + 1, text: a.text, method: 'docx', confidence: null, flagged: !!a.flag && a.text.trim().length < 40, flag_reason: a.text.trim().length < 40 ? a.flag : null, has_table: t.includes('[[TABLE]]') || a.hasTable, has_formula: t.includes('⟦') || a.hasFormula }; });
}

function virtualPages(text, size = 3000) {
  const paras = text.split(/\n/); const out = []; let cur = '';
  for (const p of paras) { if (cur.length + p.length > size && cur) { out.push(cur); cur = ''; } cur += (cur ? '\n' : '') + p; }
  if (cur) out.push(cur);
  return out;
}

export async function extractFile(file, { mime, name, langs = 'fas+eng', onProgress, forceOcr = false } = {}) {
  const ext = path.extname(name || file).toLowerCase();
  if (ext === '.pdf' || mime === 'application/pdf') return extractPdf(file, { langs, onProgress, forceOcr });
  if (ext === '.docx') return extractDocx(await fs.readFile(file));
  if (ext === '.doc') throw new Error('قالب قدیمی .doc پشتیبانی نمی‌شود؛ فایل را به .docx تبدیل کنید.');
  if (['.txt', '.md'].includes(ext) || mime?.startsWith('text/')) {
    const t = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
    const parts = t.includes('\f') ? t.split('\f') : virtualPages(t);
    return parts.map((p, i) => { const a = analyzePage(p); return { page_no: i + 1, text: a.text, method: 'text', confidence: null, flagged: a.text.trim().length < 20, flag_reason: a.text.trim().length < 20 ? 'صفحه خالی' : null, has_table: a.hasTable, has_formula: a.hasFormula }; });
  }
  if (['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'].includes(ext)) {
    const o = await ocrImage(file, langs);
    const a = analyzePage(o.text);
    const low = o.confidence < 70;
    return [{ page_no: 1, text: a.text, method: 'ocr', confidence: Math.round(o.confidence), flagged: low || !!a.flag, flag_reason: low ? `اطمینان OCR پایین (${Math.round(o.confidence)}٪)` : a.flag, has_table: a.hasTable, has_formula: a.hasFormula }];
  }
  throw new Error('نوع فایل پشتیبانی نمی‌شود. (PDF، DOCX، TXT، تصویر)');
}
