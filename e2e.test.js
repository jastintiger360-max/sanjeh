// سناریوهای بخش پانزدهم، به‌صورت آزمون خودکار واقعی روی سرور HTTP واقعی و پایگاه داده واقعی (SQLite)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeAiServer, tmpDir, Client, until, sleep } from './helpers.js';
import { readZip } from '../src/services/zip.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let app, base, ai, dir;
const admin = () => { const c = new Client(base); return c; };
const S = {}; // وضعیت مشترک بین مراحل

before(async () => {
  ai = await fakeAiServer();
  dir = await tmpDir();
  Object.assign(process.env, { AI_API_KEY: 'test-key', AI_BASE_URL: ai.url, AI_ALLOWED_MODELS: 'gen-model', AI_DEFAULT_MODEL: 'gen-model', AI_REVIEW_MODEL: 'review-model', AI_PROVIDER: 'openai',
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin-pass-123456', OCR_LANGS: 'eng', PUBLIC_ORIGIN: '' });
  const { loadConfig } = await import('../src/config.js');
  const { createApp } = await import('../src/app.js');
  app = await createApp(loadConfig({ dataDir: dir, port: 0 }));
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  S.admin = admin();
});
after(async () => { await app?.close(); ai?.server.close(); await fs.rm(dir, { recursive: true, force: true }); });

test('۱. ورود مدیر، محافظت CSRF و بارگذاری منبع', async () => {
  const bad = await S.admin.login('admin', 'wrong-password');
  assert.equal(bad.status, 401);
  const r = await S.admin.login('admin', 'admin-pass-123456');
  assert.equal(r.status, 200); assert.equal(r.data.user.role, 'admin');
  // بدون توکن CSRF درخواست تغییر رد می‌شود
  const noCsrf = await S.admin.req('POST', '/api/admin/groups', { name: 'x' }, { headers: { 'x-csrf-token': 'nope' } });
  assert.equal(noCsrf.status, 403);
  const fd = new FormData();
  fd.append('title', 'زیست‌شناسی آزمایشی (داده تست)'); fd.append('subject', 'زیست‌شناسی'); fd.append('grade', 'یازدهم'); fd.append('field', 'تجربی');
  fd.append('file', new Blob([await fs.readFile(path.join(here, 'fixtures/sample-biology.txt'))]), 'sample-biology.txt');
  const up = await S.admin.req('POST', '/api/admin/sources', fd);
  assert.equal(up.status, 201, up.text); S.sourceId = up.data.id;
  const dup = await S.admin.req('POST', '/api/admin/sources', (() => { const f = new FormData(); f.append('file', new Blob(['[داده آزمایشی]\n' + 'x'.repeat(10)]), 'a.txt'); return f; })());
  assert.equal(dup.status, 201); S.otherSource = dup.data.id;
});

test('۲. استخراج و ساختاردهی محتوا، جست‌وجو و کنترل اعتبار منبع', async () => {
  const s = await until(async () => { const x = (await S.admin.get(`/api/admin/sources/${S.sourceId}`)).data; return x.status === 'ready' || x.status === 'failed' ? x : null; });
  assert.equal(s.status, 'ready', s.error);
  assert.equal(s.page_count, 2); assert.ok(s.chunk_count >= 3);
  assert.ok(s.structure.some(x => x.chapter?.startsWith('فصل ۱') && x.topic?.includes('گوارش در معده')));
  assert.ok(s.structure.some(x => x.chapter?.startsWith('فصل ۲') && x.page_start === 2), 'شماره صفحه حفظ شود');
  const hits = (await S.admin.get(`/api/admin/search?q=${encodeURIComponent('پپسینوژن')}&sources=${S.sourceId}`)).data;
  assert.ok(hits.length >= 1 && hits[0].snippet.includes('پپسینوژن'));
  // منبع تأییدنشده نمی‌تواند رسمی شود
  const off = await S.admin.patch(`/api/admin/sources/${S.sourceId}`, { authority: 'official' });
  assert.equal(off.status, 400);
  const ok = await S.admin.patch(`/api/admin/sources/${S.sourceId}`, { authority: 'official', validation_status: 'verified' });
  assert.equal(ok.status, 200); assert.equal(ok.data.authority, 'official');
});

test('۲-ب. PDF متنی و PDF اسکن‌شده (OCR) با علامت‌گذاری صفحات مشکوک', { skip: !(await hasTool('pdftotext')) }, async () => {
  for (const [name, expectOcr] of [['scanned-english.pdf', true], ['sample-biology.pdf', false]]) {
    const fd = new FormData(); fd.append('file', new Blob([await fs.readFile(path.join(here, 'fixtures', name))]), name);
    const up = await S.admin.req('POST', '/api/admin/sources', fd); assert.equal(up.status, 201, up.text);
    const s = await until(async () => { const x = (await S.admin.get(`/api/admin/sources/${up.data.id}`)).data; return ['ready', 'failed'].includes(x.status) ? x : null; }, 60000);
    assert.equal(s.status, 'ready', s.error);
    const pages = (await S.admin.get(`/api/admin/sources/${up.data.id}/pages?from=1&to=5`)).data;
    if (expectOcr) { assert.equal(pages[0].method, 'ocr'); assert.match(pages[0].text, /Mitosis/); assert.ok(s.structure.some(x => /Chapter 3/.test(x.chapter || ''))); }
    else { assert.ok(s.flagged_count >= 1, 'PDF فارسی با لیگاتور خراب باید علامت بخورد'); assert.ok(s.flagged_pages[0].flag_reason); }
    // منبع دارای صفحه علامت‌خورده بدون تأیید آگاهانه معتبر نمی‌شود
    if (s.flagged_count) assert.equal((await S.admin.patch(`/api/admin/sources/${up.data.id}`, { validation_status: 'verified' })).status, 400);
  }
});

test('۳ و ۴. تولید سؤال از مبحث و اعتبارسنجی چندمرحله‌ای', async () => {
  const job = await S.admin.post('/api/admin/jobs', { source_ids: [S.sourceId], chapters: ['فصل ۱'], query: 'پپسین معده', count: 3, difficulty: 2, cognitive_level: 'understand', qtype: 'mcq', subject: 'زیست‌شناسی', grade: 'یازدهم', field: 'تجربی' });
  assert.equal(job.status, 201, job.text); S.jobId = job.data.id;
  const j = await until(async () => { const x = (await S.admin.get(`/api/admin/jobs/${S.jobId}`)).data; return ['completed', 'failed', 'refused'].includes(x.status) ? x : null; });
  assert.equal(j.status, 'completed', j.error || j.refused_reason);
  assert.equal(j.produced_count, 3);
  assert.equal(j.calls, 1 + 3 * 2, 'یک فراخوانی طراح + منتقد و حل‌کننده برای هر سؤال');
  assert.ok(j.prompt_tokens > 0 && j.calls_log.some(c => c.stage === 'solver' && c.model === 'review-model'));
  // تکرار همان درخواست کنترل می‌شود
  const again = await S.admin.post('/api/admin/jobs', { source_ids: [S.sourceId], chapters: ['فصل ۱'], query: 'پپسین معده', count: 3, difficulty: 2, cognitive_level: 'understand', qtype: 'mcq', subject: 'زیست‌شناسی', grade: 'یازدهم', field: 'تجربی' });
  assert.equal(again.status, 409);
  const list = (await S.admin.get(`/api/admin/questions?job_id=${S.jobId}`)).data;
  assert.equal(list.total, 3);
  for (const it of list.items) {
    const full = (await S.admin.get(`/api/admin/questions/${it.id}`)).data;
    assert.equal(full.status, 'pending_review', JSON.stringify(full.current.quality.issues) + full.current.stem + JSON.stringify(full.current.options));
  }
  const q = (await S.admin.get(`/api/admin/questions/${list.items[0].id}`)).data;
  assert.ok(q.current.quality.checks.find(c => c.id === 'evidence.verified').ok, 'نقل‌قول شاهد باید در منبع یافت شود');
  assert.equal(q.current.quality.solver_agrees, true);
  assert.ok(q.current.source_refs[0].page_start >= 1);
  S.questionIds = list.items.map(i => i.id);
  // سؤال تأییدنشده در بانک نیست
  assert.equal((await S.admin.get('/api/admin/questions?scope=bank')).data.total, 0);
});

test('۳-ب. سؤال معیوب «نیازمند اصلاح» می‌شود و بدون تأیید آگاهانه قابل تأیید نیست؛ امتناع مدل ثبت می‌شود', async () => {
  ai.state.mode = 'bad';
  const job = await S.admin.post('/api/admin/jobs', { source_ids: [S.sourceId], count: 1, difficulty: 3, qtype: 'mcq', force: true });
  const j = await until(async () => { const x = (await S.admin.get(`/api/admin/jobs/${job.data.id}`)).data; return ['completed', 'failed', 'refused'].includes(x.status) ? x : null; });
  ai.state.mode = 'good';
  const q = (await S.admin.get(`/api/admin/questions?job_id=${j.id}`)).data.items[0];
  assert.equal(q.status, 'needs_revision');
  const full = (await S.admin.get(`/api/admin/questions/${q.id}`)).data;
  const failed = full.current.quality.checks.filter(c => !c.ok).map(c => c.id);
  for (const id of ['options.distinct', 'cue.length', 'evidence.verified']) assert.ok(failed.includes(id), id);
  const ap = (await S.admin.post('/api/admin/questions/approve', { ids: [q.id] })).data.results[0];
  assert.equal(ap.ok, false);
  S.badQuestion = q.id;
  ai.state.mode = 'refuse';
  const rj = await S.admin.post('/api/admin/jobs', { source_ids: [S.sourceId], count: 2, difficulty: 4, qtype: 'mcq', force: true });
  const r = await until(async () => { const x = (await S.admin.get(`/api/admin/jobs/${rj.data.id}`)).data; return ['completed', 'failed', 'refused'].includes(x.status) ? x : null; });
  ai.state.mode = 'good';
  assert.equal(r.status, 'refused'); assert.match(r.refused_reason, /خودداری/);
  // منبع بدون محتوای کافی: امتناع پیش از هر فراخوانی مدل
  const calls = ai.state.calls.length;
  const nj = await S.admin.post('/api/admin/jobs', { source_ids: [S.sourceId], count: 1, difficulty: 1, page_from: 50, page_to: 60, force: true });
  const n = await until(async () => { const x = (await S.admin.get(`/api/admin/jobs/${nj.data.id}`)).data; return ['completed', 'failed', 'refused'].includes(x.status) ? x : null; });
  assert.equal(n.status, 'refused'); assert.equal(ai.state.calls.length, calls);
});

test('۳-ج. توقف و ازسرگیری تولید', async () => {
  ai.state.delayMs = 400;
  const job = await S.admin.post('/api/admin/jobs', { source_ids: [S.sourceId], count: 3, difficulty: 1, force: true });
  await until(async () => (await S.admin.get(`/api/admin/jobs/${job.data.id}`)).data.status === 'running');
  assert.equal((await S.admin.post(`/api/admin/jobs/${job.data.id}/cancel`)).status, 200);
  const j = await until(async () => { const x = (await S.admin.get(`/api/admin/jobs/${job.data.id}`)).data; return ['cancelled', 'completed', 'failed'].includes(x.status) ? x : null; });
  assert.equal(j.status, 'cancelled');
  ai.state.delayMs = 0;
  assert.equal((await S.admin.post(`/api/admin/jobs/${job.data.id}/retry`)).status, 200);
  const k = await until(async () => { const x = (await S.admin.get(`/api/admin/jobs/${job.data.id}`)).data; return ['completed', 'failed'].includes(x.status) ? x : null; });
  assert.equal(k.status, 'completed'); assert.equal(k.produced_count, 3);
});

test('۵ و ۶. تأیید مدیر و ورود به بانک مرکزی؛ ویرایش نسخه جدید می‌سازد', async () => {
  const res = (await S.admin.post('/api/admin/questions/approve', { ids: S.questionIds })).data.results;
  assert.ok(res.every(r => r.ok), JSON.stringify(res));
  const bank = (await S.admin.get('/api/admin/questions?scope=bank')).data;
  assert.equal(bank.total, 3);
  assert.ok(!bank.items.some(i => i.id === S.badQuestion));
  assert.equal((await S.admin.put(`/api/admin/questions/${S.questionIds[0]}/tags`, { tags: ['معده', 'تست'] })).data.tags.length, 2);
  assert.equal((await S.admin.get('/api/admin/questions?scope=bank&tag=معده')).data.total, 1);
});

test('۷ و ۸. ساخت آزمون از بانک، کمبود سطح دشواری و اختصاص به دانش‌آموز', async () => {
  for (const [u, n] of [['student1', 'دانش‌آموز اول'], ['student2', 'دانش‌آموز دوم']]) {
    const r = await S.admin.post('/api/admin/students', { username: u, full_name: n, password: 'student-pass-1' });
    assert.equal(r.status, 201, r.text); S[u] = r.data.id;
  }
  const t = Date.now();
  const ex = await S.admin.post('/api/admin/exams', { title: 'آزمون آزمایشی گوارش', duration_min: 30, start_at: t - 60_000, end_at: t + 3600_000, points_per_question: 1, negative_ratio: 1 / 3,
    shuffle_questions: true, shuffle_options: true, allow_back: true, allow_flag: true, result_policy: 'immediate', explanation_policy: 'after_end' });
  assert.equal(ex.status, 201, ex.text); S.examId = ex.data.id;
  const prop = (await S.admin.post(`/api/admin/exams/${S.examId}/propose`, { count: 4, mix: { mode: 'percent', 1: 25, 2: 50, 3: 25, 4: 0 } })).data;
  assert.ok(prop.shortages.length >= 1, 'کمبود سطح دشوار باید اعلام شود');
  assert.ok(prop.picks.every(p => p.difficulty !== 3), 'سؤال ساده‌تر جایگزین نشود');
  const items = S.questionIds.map(id => ({ question_id: id }));
  assert.equal((await S.admin.put(`/api/admin/exams/${S.examId}/questions`, { items })).status, 200);
  assert.equal((await S.admin.put(`/api/admin/exams/${S.examId}/questions`, { items: [{ question_id: S.badQuestion }] })).status, 400, 'سؤال تأییدنشده وارد آزمون نشود');
  assert.equal((await S.admin.post(`/api/admin/exams/${S.examId}/publish`)).status, 400, 'بدون اختصاص منتشر نشود');
  await S.admin.put(`/api/admin/exams/${S.examId}/assignments`, { user_ids: [S.student1] });
  const pub = await S.admin.post(`/api/admin/exams/${S.examId}/publish`);
  assert.equal(pub.status, 200, pub.text); assert.equal(pub.data.status, 'published');
  assert.equal((await S.admin.put(`/api/admin/exams/${S.examId}/questions`, { items: [] })).status, 409, 'سؤال آزمون منتشرشده قابل تغییر نیست');
  // ویرایش سؤال پس از انتشار: نسخه جدید ساخته می‌شود و آزمون همچنان نسخه قبلی را دارد
  const q0 = (await S.admin.get(`/api/admin/questions/${S.questionIds[0]}`)).data;
  S.q0OldKey = q0.current.correct_index;
  const newOpts = [...q0.current.options].reverse();
  const ed = await S.admin.put(`/api/admin/questions/${S.questionIds[0]}`, { options: newOpts, correct_index: 3 - q0.current.correct_index, change_note: 'جابه‌جایی گزینه‌ها' });
  assert.equal(ed.status, 200, ed.text);
  const after = (await S.admin.get(`/api/admin/questions/${S.questionIds[0]}`)).data;
  assert.equal(after.versions.length, 2); assert.equal(after.status, 'pending_review');
  assert.equal((await S.admin.get('/api/admin/questions?scope=bank')).data.total, 3, 'نسخه تأییدشده قبلی در بانک می‌ماند');
  const exam = (await S.admin.get(`/api/admin/exams/${S.examId}`)).data;
  assert.equal(exam.questions.find(q => q.question_id === S.questionIds[0]).question_version_id, q0.current.id);
});

test('۹ و ۱۳. ورود دانش‌آموز و مسدود بودن دسترسی‌های مدیریتی و محرمانه', async () => {
  S.st = new Client(base);
  assert.equal((await S.st.login('student1', 'student-pass-1')).status, 200);
  for (const u of ['/api/admin/questions?scope=bank', '/api/admin/dashboard', '/api/admin/exams', `/api/admin/questions/${S.questionIds[0]}`, '/api/admin/export/bank.xlsx', `/api/admin/exams/${S.examId}/paper.html?key=1`])
    assert.equal((await S.st.get(u)).status, 403, u);
  assert.equal((await S.st.post('/api/admin/questions/approve', { ids: [S.badQuestion] })).status, 403);
  const page = await S.st.req('GET', '/admin/', undefined, { raw: true });
  assert.equal(page.status, 302, 'کد پنل مدیریت به دانش‌آموز تحویل داده نشود');
  const js = await S.st.req('GET', '/admin/app.js', undefined, { raw: true });
  assert.equal(js.status, 302);
  // دانش‌آموز دیگر آزمون اختصاص‌نیافته را نمی‌بیند
  const st2 = new Client(base); await st2.login('student2', 'student-pass-1');
  assert.equal((await st2.get('/api/student/exams')).data.exams.length, 0);
  assert.equal((await st2.post(`/api/student/exams/${S.examId}/start`)).status, 404);
  S.st2 = st2;
});

test('۱۰، ۱۱ و ۱۴. اجرای آزمون: عدم افشای کلید، ذخیره خودکار، Refresh، تعارض نسخه، ورود هم‌زمان و تحویل', async () => {
  const list = (await S.st.get('/api/student/exams')).data;
  assert.equal(list.exams[0].window, 'active');
  const st = await S.st.post(`/api/student/exams/${S.examId}/start`);
  assert.equal(st.status, 200); S.attemptId = st.data.attempt_id;
  // شروع دوباره (Refresh یا تب دوم) همان تلاش را برمی‌گرداند
  assert.equal((await S.st.post(`/api/student/exams/${S.examId}/start`)).data.attempt_id, S.attemptId);
  const view = await S.st.get(`/api/student/attempts/${S.attemptId}`);
  assert.equal(view.status, 200);
  for (const secret of ['correct_index', 'explanation', 'rationale', 'source_refs', 'quality']) assert.ok(!view.text.includes(secret), `نباید «${secret}» به دانش‌آموز برسد`);
  assert.ok(view.data.deadline_at > view.data.server_now);
  const qs = view.data.questions; assert.equal(qs.length, 3);
  // کلید واقعی هر سؤال از دید مدیر
  const exam = (await S.admin.get(`/api/admin/exams/${S.examId}`)).data;
  const keyOf = eqid => exam.questions.find(q => q.exam_question_id === eqid).correct_index;
  // پاسخ: سؤال اول درست، دوم غلط، سوم نزده
  const answers = [{ eqid: qs[0].eqid, choice: keyOf(qs[0].eqid), seq: 2 }, { eqid: qs[1].eqid, choice: (keyOf(qs[1].eqid) + 1) % 4, seq: 1, flagged: true }];
  const sv = (await S.st.put(`/api/student/attempts/${S.attemptId}/answers`, { answers })).data;
  assert.ok(sv.results.every(r => r.accepted));
  // نسخه قدیمی‌تر (seq کمتر) از تب دیگر یا پس از قطع اینترنت جایگزین نمی‌شود
  const stale = (await S.st.put(`/api/student/attempts/${S.attemptId}/answers`, { answers: [{ eqid: qs[0].eqid, choice: (keyOf(qs[0].eqid) + 2) % 4, seq: 1 }] })).data;
  assert.equal(stale.results[0].accepted, false); assert.equal(stale.results[0].reason, 'stale');
  // سؤال خارج از آزمون پذیرفته نمی‌شود
  assert.equal((await S.st.put(`/api/student/attempts/${S.attemptId}/answers`, { answers: [{ eqid: 999999, choice: 1, seq: 5 }] })).status, 400);
  // Refresh: پاسخ‌ها از سرور بازیابی می‌شوند
  const re = (await S.st.get(`/api/student/attempts/${S.attemptId}`)).data;
  assert.equal(re.answers.find(a => a.eqid === qs[0].eqid).choice, keyOf(qs[0].eqid));
  assert.equal(re.answers.find(a => a.eqid === qs[1].eqid).flagged, 1);
  // دانش‌آموز دیگر به تلاش این دانش‌آموز دسترسی ندارد
  assert.equal((await S.st2.get(`/api/student/attempts/${S.attemptId}`)).status, 404);
  // ورود هم‌زمان از دستگاه دیگر: نشست قبلی باطل می‌شود، داده حفظ می‌شود
  const other = new Client(base); await other.login('student1', 'student-pass-1');
  const old = await S.st.get(`/api/student/attempts/${S.attemptId}`);
  assert.equal(old.status, 401); assert.equal(old.data.code, 'SESSION_REVOKED');
  const cont = (await other.get(`/api/student/attempts/${S.attemptId}`)).data;
  assert.equal(cont.answers.length, 2);
  // نتیجه پیش از تحویل در دسترس نیست
  assert.equal((await other.get(`/api/student/exams/${S.examId}/result`)).status, 403);
  const sub = await other.post(`/api/student/attempts/${S.attemptId}/submit`, {});
  assert.equal(sub.data.status, 'submitted');
  assert.equal((await other.put(`/api/student/attempts/${S.attemptId}/answers`, { answers: [{ eqid: qs[2].eqid, choice: 0, seq: 9 }] })).status, 409, 'پس از تحویل پاسخ پذیرفته نشود');
  S.st = other;
});

test('۱۱ و ۱۲. تصحیح خودکار با نمره منفی، کارنامه دانش‌آموز و مدیر، و عدم انتشار کلید پیش از زمان مجاز', async () => {
  const r = (await S.st.get(`/api/student/exams/${S.examId}/result`)).data;
  assert.equal(r.correct, 1); assert.equal(r.wrong, 1); assert.equal(r.blank, 1);
  assert.equal(r.score, Math.round((1 - 1 / 3) * 1000) / 1000);
  assert.equal(r.percent, Math.round(((1 - 1 / 3) / 3) * 10000) / 100);
  assert.equal(r.key_visible, false); assert.equal(r.items, undefined, 'کلید پیش از پایان آزمون منتشر نشود');
  const res = (await S.admin.get(`/api/admin/exams/${S.examId}/results`)).data;
  assert.equal(res.attempts.length, 1); assert.equal(res.attempts[0].rank, 1);
  assert.equal(res.items.length, 3);
  const rep = await S.admin.get(`/api/admin/attempts/${S.attemptId}/report.html`);
  assert.equal(rep.status, 200); assert.match(rep.text, /کارنامه/);
  const xl = await S.admin.req('GET', `/api/admin/exams/${S.examId}/results.xlsx`, undefined, { raw: true });
  const zip = readZip(Buffer.from(await xl.arrayBuffer()));
  assert.ok(zip.read('xl/worksheets/sheet1.xml').toString().includes('دانش‌آموز اول'));
  // کلید نسخه دقیق آزمون: ویرایش بعدی سؤال روی تصحیح اثری ندارد
  const det = (await S.admin.get(`/api/admin/attempts/${S.attemptId}`)).data;
  assert.equal(det.items.find(i => i.position === 1 || true) && det.items.filter(i => i.is_correct === 1).length, 1);
  // انتشار دستی پاسخ تشریحی
  await S.admin.post(`/api/admin/exams/${S.examId}/release`, { explanations: true });
  const r2 = (await S.st.get(`/api/student/exams/${S.examId}/result`)).data;
  assert.equal(r2.key_visible, true); assert.equal(r2.items.length, 3);
});

test('۱۴-ب. پایان زمان آزمون سمت سرور: تحویل خودکار و رد پاسخ دیرهنگام', async () => {
  const t = Date.now();
  const ex = (await S.admin.post('/api/admin/exams', { title: 'آزمون زمان‌دار', duration_min: 1, start_at: t - 1000, end_at: t + 3600_000, result_policy: 'manual', explanation_policy: 'never' })).data.id;
  await S.admin.put(`/api/admin/exams/${ex}/questions`, { items: [{ question_id: S.questionIds[1] }] });
  await S.admin.put(`/api/admin/exams/${ex}/assignments`, { group_ids: [(await S.admin.post('/api/admin/groups', { name: 'گروه الف' })).data.id] });
  const groups = (await S.admin.get('/api/admin/groups')).data;
  await S.admin.patch(`/api/admin/groups/${groups[0].id}`, { member_ids: [S.student2] });
  const pb = await S.admin.post(`/api/admin/exams/${ex}/publish`); assert.equal(pb.status, 200, pb.text);
  const at = (await S.st2.post(`/api/student/exams/${ex}/start`)).data.attempt_id;
  assert.ok(at, 'دسترسی از طریق گروه');
  // شبیه‌سازی گذشت زمان: مهلت در پایگاه داده به گذشته منتقل می‌شود
  await app.ctx.db.run('UPDATE attempts SET deadline_at = ? WHERE id = ?', [Date.now() - 60_000, at]);
  const late = await S.st2.put(`/api/student/attempts/${at}/answers`, { answers: [{ eqid: 1, choice: 0, seq: 1 }] });
  assert.equal(late.status, 409);
  const list = (await S.st2.get('/api/student/exams')).data.exams.find(e => e.id === ex);
  assert.equal(list.attempt_status, 'expired'); assert.equal(list.results_visible, false);
  assert.equal((await S.st2.get(`/api/student/exams/${ex}/result`)).status, 403, 'نتیجه دستی منتشر نشده است');
  await S.admin.post(`/api/admin/exams/${ex}/release`, { results: true });
  const r = (await S.st2.get(`/api/student/exams/${ex}/result`)).data;
  assert.equal(r.blank, 1); assert.equal(r.key_visible, false);
});

test('۱۵. صحت داده‌ها پس از خروج و ورود مجدد و پس از راه‌اندازی مجدد سرور', async () => {
  await S.st.post('/api/auth/logout');
  assert.equal((await S.st.get('/api/student/exams')).status, 401);
  const c = new Client(base); await c.login('student1', 'student-pass-1');
  const e = (await c.get('/api/student/exams')).data.exams.find(x => x.id === S.examId);
  assert.equal(e.attempt_status, 'submitted');
  // راه‌اندازی مجدد کامل برنامه روی همان پایگاه داده
  await app.close();
  const { loadConfig } = await import('../src/config.js'); const { createApp } = await import('../src/app.js');
  app = await createApp(loadConfig({ dataDir: dir, port: 0 }));
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const c2 = new Client(base); await c2.login('student1', 'student-pass-1');
  const r = (await c2.get(`/api/student/exams/${S.examId}/result`)).data;
  assert.equal(r.correct, 1); assert.equal(r.items.length, 3);
  const a2 = new Client(base); await a2.login('admin', 'admin-pass-123456');
  assert.equal((await a2.get('/api/admin/questions?scope=bank')).data.total, 3);
  const audit = (await a2.get('/api/admin/audit')).data;
  assert.ok(audit.some(x => x.action === 'attempt.submit') && audit.some(x => x.action === 'question.approve'));
  assert.equal((await a2.post('/api/admin/backup')).status, 200);
});

test('بدون کلید API، تولید هوشمند صریحاً غیرفعال اعلام می‌شود', async () => {
  const d = await tmpDir();
  const saved = process.env.AI_API_KEY; process.env.AI_API_KEY = '';
  const { loadConfig } = await import('../src/config.js'); const { createApp } = await import('../src/app.js');
  const a = await createApp(loadConfig({ dataDir: d, port: 0 }));
  process.env.AI_API_KEY = saved;
  await new Promise(r => a.server.listen(0, '127.0.0.1', r));
  const c = new Client(`http://127.0.0.1:${a.server.address().port}`); await c.login('admin', 'admin-pass-123456');
  assert.equal((await c.get('/api/admin/ai/status')).data.enabled, false);
  const r = await c.post('/api/admin/jobs', { source_ids: [1], count: 1, difficulty: 1 });
  assert.equal(r.status, 503); assert.equal(r.data.code, 'AI_DISABLED');
  await a.close(); await fs.rm(d, { recursive: true, force: true });
});

async function hasTool(t) { const { execFile } = await import('node:child_process'); return new Promise(r => execFile(t, ['-v'], e => r(!e || e.code !== 'ENOENT'))); }
