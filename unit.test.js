import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runChecks, sanitizeQuestion, verifyQuote } from '../src/ai/checks.js';
import { aggregate } from '../src/ai/pipeline.js';
import { computeScore } from '../src/services/grading.js';
import { allocate } from '../src/services/exams.js';
import { normalize, similarity } from '../src/services/textnorm.js';
import { xlsx } from '../src/services/export.js';
import { readZip, writeZip } from '../src/services/zip.js';
import { extractFile, cleanText } from '../src/services/extract.js';
import { chunkPages } from '../src/services/chunker.js';
import { resultsVisible, keyVisible, examWindow } from '../src/services/attempts.js';

const chunk = { id: 7, source_id: 1, page_start: 12, page_end: 12, text: 'پپسینوژن در محیط اسیدی معده به پپسین تبدیل می‌شود. پپسین پروتئین‌ها را تجزیه می‌کند.' };
const good = () => sanitizeQuestion({ qtype: 'mcq', stem: 'پپسینوژن در کدام شرایط به پپسین تبدیل می‌شود؟',
  options: [{ text: 'در محیط اسیدی معده', rationale: 'مطابق متن' }, { text: 'در محیط قلیایی روده', rationale: 'جابه‌جایی محیط' }, { text: 'در حضور صفرا در دوازدهه', rationale: 'اشتباه محل' }, { text: 'در دهان با کمک بزاق', rationale: 'اشتباه محل' }],
  correct_index: 0, explanation: 'طبق متن کتاب، پپسینوژن در محیط اسیدی معده به پپسین تبدیل می‌شود.', difficulty: 1, cognitive_level: 'understand',
  evidence: [{ chunk_id: 7, quote: 'پپسینوژن در محیط اسیدی معده به پپسین تبدیل می‌شود' }] });
const ctx = { evidenceById: new Map([[7, chunk]]), bank: [] };

test('آزمون‌های قطعی: سؤال سالم بدون ایراد مسدودکننده', () => {
  const r = runChecks(good(), ctx);
  assert.deepEqual(r.checks.filter(c => !c.ok && c.severity !== 'minor').map(c => c.id), []);
  assert.equal(r.evidence[0].verified, true);
});
test('آزمون‌های قطعی: نشانه طول، گزینه تکراری، نقل‌قول جعلی، استناد خارج از شواهد', () => {
  const q = good(); q.options[0].text = 'در محیط اسیدی معده که توسط یاخته‌های کناری با ترشح کلریدریک‌اسید فراهم می‌شود و بسیار مهم است';
  q.options[2].text = q.options[1].text; q.evidence = [{ chunk_id: 7, quote: 'این جمله هرگز در کتاب نیامده است و جعلی است' }, { chunk_id: 99, quote: 'x' }];
  const failed = runChecks(q, ctx).checks.filter(c => !c.ok).map(c => c.id);
  for (const id of ['cue.length', 'options.distinct', 'evidence.verified', 'evidence.cited']) assert.ok(failed.includes(id), id);
});
test('آزمون‌های قطعی: تکرار واژه صورت سؤال فقط در گزینه صحیح', () => {
  const q = good(); q.stem = 'نقش یاخته‌های کناری معده چیست؟'; q.options[0].text = 'یاخته‌های کناری اسید ترشح می‌کنند';
  assert.ok(runChecks(q, ctx).checks.find(c => c.id === 'cue.echo' && !c.ok));
});
test('آزمون‌های قطعی: سازگاری کلید سؤال گزاره‌ای', () => {
  const q = good(); q.qtype = 'statement'; q.stem = 'چند مورد از عبارات زیر درست است؟';
  q.statements = [{ label: 'الف', text: 'a', is_true: true }, { label: 'ب', text: 'b', is_true: true }, { label: 'ج', text: 'c', is_true: false }];
  q.options = ['۱', '۲', '۳', 'صفر'].map(t => ({ text: t + ' مورد', rationale: 'شمارش' })); q.correct_index = 1;
  assert.ok(runChecks(q, ctx).checks.find(c => c.id === 'logic.statements').ok);
  q.correct_index = 2;
  assert.equal(runChecks(q, ctx).checks.find(c => c.id === 'logic.statements').ok, false);
});
test('آزمون‌های قطعی: پاسخ عددی سؤال محاسباتی و شباهت با بانک', () => {
  const q = good(); q.qtype = 'calc'; q.numeric_answer = 12; q.options = ['۱۲ متر', '۱۴ متر', '۸ متر', '۶ متر'].map(t => ({ text: t, rationale: 'محاسبه' }));
  assert.ok(runChecks(q, ctx).checks.find(c => c.id === 'logic.numeric').ok);
  const sig = q.stem + ' ' + q.options[0].text;
  assert.equal(runChecks(q, { ...ctx, bank: [{ question_id: 5, sig }] }).checks.find(c => c.id === 'similarity.bank').ok, false);
});
test('نقل‌قول: تطبیق با تفاوت‌های نوشتاری (ي/ی، نیم‌فاصله، لیگاتور «لا»)', () => {
  assert.equal(verifyQuote('پپسينوژن در محيط اسیدی معده به پپسین تبدیل ميشود', chunk.text).ok, true);
  assert.equal(verifyQuote('دیواره شامل لایه مخاطی است', 'دیواره شامل الیه مخاطی است').ok, true);
  assert.equal(verifyQuote('موضوعی کاملا متفاوت درباره ستاره‌ها', chunk.text).ok, false);
});
test('جمع‌بندی: مخالفت حل‌کننده مستقل → نیازمند اصلاح', () => {
  const q = good(); const checks = runChecks(q, ctx).checks;
  const critic = { scores: { source_alignment: 9, answer_correctness: 9, distractor_quality: 9, clarity: 9, explanation_quality: 9, difficulty_fit: 9 }, verdict: 'pass', estimated_difficulty: 1, issues: [] };
  const ok = aggregate({ q, checks, critic, solver: { answer: 3, options: [] }, solverOrder: [2, 1, 0, 3], requested: { difficulty: 1 }, maxSimilarity: 0 });
  assert.equal(ok.status, 'pending_review'); assert.equal(ok.solverAgrees, true);
  const bad = aggregate({ q, checks, critic, solver: { answer: 1, options: [] }, solverOrder: [2, 1, 0, 3], requested: { difficulty: 1 }, maxSimilarity: 0 });
  assert.equal(bad.status, 'needs_revision'); assert.ok(bad.score < ok.score);
  assert.equal(aggregate({ q, checks, critic: null, solver: null, solverOrder: [0, 1, 2, 3], requested: { difficulty: 1 }, maxSimilarity: 0 }).status, 'needs_revision', 'ارزیابی ناقص هرگز «سالم» تلقی نشود');
});
test('تصحیح: فرمول نمره منفی قابل تنظیم و تفکیک مبحث/دشواری', () => {
  const items = [{ points: 1, choice: 0, correct_index: 0, meta: { topic: 'الف', difficulty: 1 } }, { points: 1, choice: 2, correct_index: 1, meta: { topic: 'الف', difficulty: 2 } },
    { points: 1, choice: null, correct_index: 3, meta: { topic: 'ب', difficulty: 2 } }, { points: 1, choice: 1, correct_index: 2, meta: { topic: 'ب', difficulty: 3 } }];
  const r = computeScore({ items, negativeRatio: 1 / 3, floorZero: false });
  assert.equal(r.correct, 1); assert.equal(r.wrong, 2); assert.equal(r.blank, 1);
  assert.equal(r.score, Math.round((1 - 2 / 3) * 1000) / 1000);
  assert.equal(r.percent, Math.round(((1 - 2 / 3) / 4) * 10000) / 100); // فرمول کنکوری (3C−W)/(3N)
  assert.equal(r.breakdown.topic['الف'].correct, 1);
  const neg = computeScore({ items: [{ points: 1, choice: 1, correct_index: 0, meta: {} }], negativeRatio: 0.25, floorZero: true });
  assert.equal(neg.score, 0);
});
test('ترکیب دشواری: گرد کردن با بزرگ‌ترین باقیمانده و خطای مجموع درصد', () => {
  assert.deepEqual(allocate(10, { mode: 'percent', 1: 20, 2: 40, 3: 30, 4: 10 }), { 1: 2, 2: 4, 3: 3, 4: 1 });
  const a = allocate(7, { mode: 'percent', 1: 25, 2: 25, 3: 25, 4: 25 }); assert.equal(a[1] + a[2] + a[3] + a[4], 7);
  assert.throws(() => allocate(10, { mode: 'percent', 1: 50, 2: 10, 3: 0, 4: 0 }));
});
test('سیاست انتشار نتیجه و کلید', () => {
  const t = 1000; const e = { start_at: 0, end_at: 2000, status: 'published', result_policy: 'after_end', explanation_policy: 'after_end' };
  const a = { status: 'submitted' };
  assert.equal(resultsVisible(e, a, t), false); assert.equal(resultsVisible(e, a, 2500), true);
  assert.equal(keyVisible({ ...e, explanation_policy: 'never' }, a, 99999), false);
  assert.equal(resultsVisible({ ...e, result_policy: 'immediate' }, { status: 'in_progress' }, t), false);
  assert.equal(examWindow(e, -1), 'upcoming'); assert.equal(examWindow({ ...e, status: 'cancelled' }, t), 'cancelled');
});
test('نرمال‌سازی فارسی و شباهت', () => {
  assert.equal(normalize('كتاب‌هاي  علمي ۱۲'), normalize('کتاب های علمی 12'));
  assert.ok(similarity('پپسین پروتئین را تجزیه می‌کند', 'پپسين پروتئين را تجزيه ميکند') > 0.7);
});
test('XLSX واقعی (قابل باز شدن) و ZIP', () => {
  const buf = xlsx([{ name: 'آزمون', rows: [['نام', 'نمره'], ['علی', 18.5]] }]);
  const z = readZip(buf);
  assert.ok(z.names.includes('xl/workbook.xml'));
  assert.match(z.read('xl/worksheets/sheet1.xml').toString(), /علی.*18\.5/s);
  assert.equal(readZip(writeZip([{ name: 'a.txt', data: 'سلام' }])).read('a.txt').toString(), 'سلام');
});
test('استخراج Word با حفظ تیتر، جدول، فرمول و شکست صفحه', async () => {
  const doc = `<?xml version="1.0"?><w:document xmlns:w="w" xmlns:m="m"><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>فصل ۱: حرکت</w:t></w:r></w:p>
    <w:p><w:r><w:t>سرعت متوسط برابر جابه‌جایی تقسیم بر زمان است.</w:t></w:r><m:oMath><m:r><m:t>v=Δx/Δt</m:t></m:r></m:oMath></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>کمیت</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>یکا</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>سرعت</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>m/s</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:br w:type="page"/><w:t>فصل ۲: نیرو</w:t></w:r></w:p><w:p><w:r><w:t>قانون دوم نیوتون رابطه نیرو و شتاب را بیان می‌کند و در حل مسائل کاربرد دارد.</w:t></w:r></w:p></w:body></w:document>`;
  const f = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'snj-')), 'a.docx');
  await fs.writeFile(f, writeZip([{ name: 'word/document.xml', data: doc }]));
  const pages = await extractFile(f, { name: 'a.docx' });
  assert.equal(pages.length, 2);
  assert.ok(pages[0].has_table && pages[0].has_formula);
  assert.match(pages[0].text, /کمیت \| یکا/); assert.match(pages[0].text, /⟦v=Δx\/Δt⟧/);
  const chunks = chunkPages(pages.map(p => ({ ...p, flagged: 0 })), { offset: 9 });
  assert.ok(chunks.some(c => c.chapter === 'فصل ۲: نیرو' && c.page_start === 11), 'اختلاف شماره صفحه چاپی اعمال شود');
});
test('پاک‌سازی نویسه‌های کنترل جهت PDF', () => {
  assert.equal(cleanText('\u202B.\u202Cمخاطی است\u202C'), 'مخاطی است.');
});
