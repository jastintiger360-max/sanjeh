import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, readMultipart, sendJson, notFound, bad, v, now, safeJson, sha256 } from '../http/util.js';
import { requireRole } from '../auth/sessions.js';
import { xlsx, printable, esc } from '../services/export.js';
import { criticPrompt, solverPrompt, DIFFICULTY, COGNITIVE, QTYPES } from '../ai/prompts.js';
import { parseJsonLoose } from '../ai/provider.js';
import { aggregate } from '../ai/pipeline.js';
import { audit } from '../services/audit.js';

const STATUS_FA = { generating: 'در حال تولید', pending_review: 'در انتظار بررسی', needs_revision: 'نیازمند اصلاح', approved: 'تأییدشده', rejected: 'ردشده', archived: 'آرشیوشده' };
const fmtDate = t => (t ? new Intl.DateTimeFormat('fa-IR-u-ca-persian', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tehran' }).format(new Date(t)) : '');
const id = req => v.int(req.params.id, 'شناسه', { min: 1 });

function sendFile(res, data, type, filename) {
  res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, 'Cache-Control': 'no-store' });
  res.end(data);
}
function sendHtml(res, html) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); }

function questionHtml(vv, n, withKey) {
  const opts = vv.options.map((o, i) => `<li class="${withKey && i === vv.correct_index ? 'ok' : ''}"><b>${i + 1})</b> ${esc(o.text)}</li>`).join('');
  return `<article class="q"><h3>${n}. ${esc(vv.stem)}</h3>${vv.passage ? `<p class="passage">${esc(vv.passage)}</p>` : ''}
    ${vv.statements?.length ? `<ul class="st">${vv.statements.map(s => `<li>${esc(s.label)}) ${esc(s.text)}</li>`).join('')}</ul>` : ''}
    ${vv.table_data?.headers ? `<table><tr>${vv.table_data.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr>${(vv.table_data.rows || []).map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>` : ''}
    <ol class="opts">${opts}</ol>${withKey ? `<p class="exp"><b>پاسخ: گزینه ${vv.correct_index + 1}</b> — ${esc(vv.explanation)}</p>` : ''}</article>`;
}

export function adminRoutes(r, ctx) {
  const { db, sources, questions, pipeline, exams, students, analytics, settings, ai, cfg } = ctx;
  const A = requireRole('admin');

  // ---------- داشبورد و تنظیمات ----------
  r.get('/api/admin/dashboard', A, async (req, res) => sendJson(res, 200, await analytics.dashboard()));
  r.get('/api/admin/settings', A, async (req, res) => sendJson(res, 200, { settings: await settings.all(), ai: await ai.status() }));
  r.put('/api/admin/settings', A, async (req, res) => {
    const b = await readJson(req);
    const out = {};
    if ('app_name' in b) out.app_name = v.str(b.app_name, 'نام سامانه', { min: 2, max: 60 });
    if ('app_tagline' in b) out.app_tagline = v.str(b.app_tagline, 'شعار', { max: 120, optional: true }) || '';
    if ('ai_model' in b) { if (!cfg.ai.allowedModels.includes(b.ai_model)) throw bad('مدل انتخاب‌شده در فهرست مدل‌های مجاز سرور نیست.'); out.ai_model = b.ai_model; }
    if ('ai_pricing' in b) { if (typeof b.ai_pricing !== 'object') throw bad('قیمت‌گذاری نامعتبر'); out.ai_pricing = Object.fromEntries(Object.entries(b.ai_pricing).map(([k, p]) => [k, { input: +p.input || 0, output: +p.output || 0 }])); }
    for (const [k, lim] of Object.entries({ max_questions_per_request: [1, 50], questions_per_call: [1, 5], retrieval_top_k: [2, 20], evidence_min_chars: [100, 20000], autosave_interval_sec: [3, 60], submit_grace_sec: [0, 120] }))
      if (k in b) out[k] = v.int(b[k], k, { min: lim[0], max: lim[1] });
    if ('duplicate_threshold' in b) out.duplicate_threshold = v.num(b.duplicate_threshold, 'آستانه تکراری', { min: 0.3, max: 0.99 });
    if ('default_negative_ratio' in b) out.default_negative_ratio = v.num(b.default_negative_ratio, 'نمره منفی', { min: 0, max: 1 });
    if ('single_session_students' in b) out.single_session_students = v.bool(b.single_session_students);
    const s = await settings.set(out);
    await audit(db, { userId: req.session.user.id, action: 'settings.update', details: Object.keys(out), ip: req.ip });
    sendJson(res, 200, { settings: s });
  });
  r.get('/api/admin/audit', A, async (req, res) => sendJson(res, 200, await db.all('SELECT l.*, u.full_name FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 300')));
  r.post('/api/admin/backup', A, async (req, res) => {
    const dir = path.join(cfg.dataDir, 'backups'); await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `sanjeh-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    await db.backup(file);
    await audit(db, { userId: req.session.user.id, action: 'backup.create', details: { file: path.basename(file) }, ip: req.ip });
    sendJson(res, 200, { file: path.basename(file) });
  });

  // ---------- منابع ----------
  r.get('/api/admin/sources', A, async (req, res) => sendJson(res, 200, await sources.list()));
  r.post('/api/admin/sources', A, async (req, res) => {
    const { fields, files } = await readMultipart(req, cfg.maxUploadBytes);
    const sid = await sources.upload({ file: files[0], fields, user: req.session.user, ip: req.ip });
    sendJson(res, 201, { id: sid });
  });
  r.get('/api/admin/sources/:id', A, async (req, res) => sendJson(res, 200, await sources.get(id(req))));
  r.patch('/api/admin/sources/:id', A, async (req, res) => sendJson(res, 200, await sources.update(id(req), await readJson(req), req.session.user, req.ip)));
  r.delete('/api/admin/sources/:id', A, async (req, res) => { await sources.remove(id(req), req.session.user, req.ip); sendJson(res, 200, { ok: true }); });
  r.post('/api/admin/sources/:id/reprocess', A, async (req, res) => { sources.reprocess(id(req), { ocr: req.query.get('ocr') === '1' }); sendJson(res, 202, { ok: true }); });
  r.get('/api/admin/sources/:id/pages', A, async (req, res) => {
    const from = v.int(req.query.get('from') || 1, 'from', { min: 1 }); const to = v.int(req.query.get('to') || from + 9, 'to', { min: from, max: from + 50 });
    sendJson(res, 200, await sources.pages(id(req), { from, to }));
  });
  r.put('/api/admin/sources/:id/pages/:page', A, async (req, res) => {
    const b = await readJson(req, 5_000_000);
    await sources.updatePage(id(req), v.int(req.params.page, 'صفحه', { min: 1 }), { text: b.text == null ? null : v.str(b.text, 'متن', { max: 200000 }), flagged: v.bool(b.flagged) }, req.session.user, req.ip);
    sendJson(res, 200, { ok: true });
  });
  r.put('/api/admin/sources/:id/structure', A, async (req, res) => { await sources.setStructure(id(req), (await readJson(req)).ranges, req.session.user, req.ip); sendJson(res, 200, await sources.get(id(req))); });
  r.get('/api/admin/search', A, async (req, res) => {
    const q = req.query;
    sendJson(res, 200, await sources.search({ q: q.get('q') || '', sourceIds: q.get('sources') ? q.get('sources').split(',').map(Number).filter(Boolean) : null, chapter: q.get('chapter') || null,
      pageFrom: q.get('from') ? Number(q.get('from')) : null, pageTo: q.get('to') ? Number(q.get('to')) : null }));
  });
  r.get('/api/admin/chunks/:id', A, async (req, res) => { const c = await sources.chunk(id(req)); if (!c) throw notFound(); sendJson(res, 200, c); });
  r.get('/api/admin/structure-options', A, async (req, res) => {
    sendJson(res, 200, {
      chapters: (await db.all("SELECT DISTINCT c.source_id, c.chapter, c.topic FROM source_chunks c WHERE c.chapter IS NOT NULL OR c.topic IS NOT NULL ORDER BY c.source_id")),
      meta: await db.all("SELECT DISTINCT field, grade, subject FROM sources"),
    });
  });

  // ---------- تولید هوشمند ----------
  r.get('/api/admin/ai/status', A, async (req, res) => sendJson(res, 200, await ai.status()));
  r.get('/api/admin/jobs', A, async (req, res) => sendJson(res, 200, await pipeline.list()));
  r.post('/api/admin/jobs', A, async (req, res) => sendJson(res, 201, { id: await pipeline.create(await readJson(req), req.session.user, req.ip) }));
  r.get('/api/admin/jobs/:id', A, async (req, res) => { const j = await pipeline.get(id(req)); if (!j) throw notFound(); sendJson(res, 200, j); });
  r.post('/api/admin/jobs/:id/cancel', A, async (req, res) => { await pipeline.cancel(id(req), req.session.user); sendJson(res, 200, { ok: true }); });
  r.post('/api/admin/jobs/:id/retry', A, async (req, res) => { await pipeline.retry(id(req), req.session.user); sendJson(res, 200, { ok: true }); });

  // ---------- سؤال‌ها ----------
  r.get('/api/admin/questions', A, async (req, res) => sendJson(res, 200, await questions.list(Object.fromEntries(req.query))));
  r.post('/api/admin/questions', A, async (req, res) => sendJson(res, 201, { id: await questions.createManual(await readJson(req), req.session.user, req.ip) }));
  r.get('/api/admin/questions/duplicates', A, async (req, res) => sendJson(res, 200, await questions.duplicates(req.query.get('threshold') ? Number(req.query.get('threshold')) : null)));
  r.post('/api/admin/questions/approve', A, async (req, res) => {
    const b = await readJson(req);
    sendJson(res, 200, { results: await questions.approve(v.ids(b.ids, 'سؤال‌ها'), req.session.user, req.ip, { override: v.bool(b.override), note: b.note }) });
  });
  r.get('/api/admin/questions/:id', A, async (req, res) => sendJson(res, 200, await questions.get(id(req))));
  r.put('/api/admin/questions/:id', A, async (req, res) => { const vid = await questions.edit(id(req), await readJson(req), req.session.user, req.ip); sendJson(res, 200, { version_id: vid }); });
  r.post('/api/admin/questions/:id/reject', A, async (req, res) => { await questions.reject(id(req), (await readJson(req)).reason, req.session.user, req.ip); sendJson(res, 200, { ok: true }); });
  r.post('/api/admin/questions/:id/archive', A, async (req, res) => { await questions.setArchived(id(req), v.bool((await readJson(req)).archived), req.session.user, req.ip); sendJson(res, 200, { ok: true }); });
  r.put('/api/admin/questions/:id/tags', A, async (req, res) => sendJson(res, 200, { tags: await questions.setTags(id(req), (await readJson(req)).tags, req.session.user) }));
  r.post('/api/admin/questions/:id/image', A, async (req, res) => {
    const { files } = await readMultipart(req, 10 * 1024 * 1024);
    const f = files[0]; if (!f || !/\.(png|jpe?g)$/i.test(f.filename)) throw bad('فقط تصویر PNG یا JPG مجاز است.');
    const dir = path.join(cfg.storageDir, 'images'); await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, sha256(f.data) + path.extname(f.filename).toLowerCase());
    await fs.writeFile(file, f.data, { mode: 0o600 });
    const q = await questions.get(id(req));
    const vid = await db.tx(async () => {
      const cur = q.current;
      const nv = await questions.insertVersion(q.id, { ...cur, table: cur.table_data, image_path: file }, { origin: 'edit', userId: req.session.user.id, note: 'افزودن تصویر', quality: cur.quality, qualityScore: cur.quality_score });
      if (q.status === 'approved') await db.run("UPDATE questions SET status = 'pending_review' WHERE id = ?", [q.id]);
      return nv;
    });
    sendJson(res, 200, { version_id: vid });
  });
  r.get('/api/admin/versions/:id/image', A, async (req, res) => {
    const vv = await questions.version(id(req)); if (!vv?.image_path) throw notFound();
    res.writeHead(200, { 'Content-Type': vv.image_path.endsWith('.png') ? 'image/png' : 'image/jpeg' }); res.end(await fs.readFile(vv.image_path));
  });
  r.post('/api/admin/questions/:id/variants', A, async (req, res) => {
    // تولید نسخه‌های متفاوت از یک سؤال با همان منابع
    const q = await questions.get(id(req)); const b = await readJson(req);
    const job = q.job_id ? await pipeline.get(q.job_id) : null;
    const srcIds = [...new Set((q.current.source_refs || []).map(s => s.source_id))];
    const params = { ...(job?.params ? { source_ids: job.params.sourceIds, chapters: job.params.chapters, topics: job.params.topics, page_from: job.params.pageFrom, page_to: job.params.pageTo, qtype: job.params.qtype, target: job.params.target, combination: job.params.combination, option_complexity: job.params.optionComplexity, subject: job.params.subject, field: job.params.field, grade: job.params.grade } : { source_ids: srcIds, qtype: q.current.qtype, subject: q.current.subject }),
      difficulty: b.difficulty || q.current.difficulty, cognitive_level: q.current.cognitive_level, count: v.int(b.count || 1, 'تعداد', { min: 1, max: 5 }), variant_of: q.id, force: true };
    if (!params.source_ids?.length) throw bad('برای این سؤال منبعی ثبت نشده است.');
    sendJson(res, 201, { id: await pipeline.create(params, req.session.user, req.ip) });
  });
  r.post('/api/admin/questions/:id/review', A, async (req, res) => {
    // بازبینی مجدد نسخه فعلی توسط منتقد و حل‌کننده مستقل (دارای هزینه)
    const q = await questions.get(id(req)); const cur = q.current;
    const ids = (cur.source_refs || []).map(s => s.chunk_id);
    const ev = ids.length ? await db.all(`SELECT id, source_id, page_start, page_end, text FROM source_chunks WHERE id IN (${ids.map(() => '?').join(',')})`, ids) : [];
    if (!ev.length) throw bad('برای بازبینی هوشمند، سؤال باید به بخشی از منبع ارجاع داشته باشد.');
    const qq = { ...cur, table: cur.table_data };
    const order = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
    const rm = ai.reviewModel() || undefined;
    const critic = parseJsonLoose((await ai.chat({ ...criticPrompt(qq, ev, { difficulty: cur.difficulty, cognitive: cur.cognitive_level }), temperature: 0.1, stage: 'critic', modelOverride: rm })).content);
    const solver = parseJsonLoose((await ai.chat({ ...solverPrompt(qq, order, ev), temperature: 0, stage: 'solver', modelOverride: rm })).content);
    const checks = cur.quality?.checks || [];
    const agg = aggregate({ q: qq, checks, critic, solver, solverOrder: order, requested: { difficulty: cur.difficulty }, maxSimilarity: cur.quality?.maxSimilarity || 0 });
    const quality = { ...(cur.quality || {}), critic, solver: { ...solver, display_order: order }, aggregate: agg.report, issues: agg.issues, solver_agrees: agg.solverAgrees, ai_review_of_version: cur.version_no, reviewed_at: now() };
    // محتوای نسخه تغییر نمی‌کند؛ فقط گزارش کیفیت آن به‌روز می‌شود
    await db.run('UPDATE question_versions SET quality = ?, quality_score = ? WHERE id = ?', [JSON.stringify(quality), agg.score, cur.id]);
    if (agg.status === 'needs_revision' && q.status === 'pending_review') await db.run("UPDATE questions SET status = 'needs_revision' WHERE id = ?", [q.id]);
    sendJson(res, 200, { quality, score: agg.score });
  });

  // ---------- آزمون‌ها ----------
  r.get('/api/admin/exams', A, async (req, res) => sendJson(res, 200, await exams.list()));
  r.post('/api/admin/exams', A, async (req, res) => sendJson(res, 201, { id: await exams.create(await readJson(req), req.session.user, req.ip) }));
  r.get('/api/admin/exams/:id', A, async (req, res) => sendJson(res, 200, await exams.get(id(req))));
  r.patch('/api/admin/exams/:id', A, async (req, res) => { await exams.update(id(req), await readJson(req), req.session.user, req.ip); sendJson(res, 200, await exams.get(id(req))); });
  r.delete('/api/admin/exams/:id', A, async (req, res) => { await exams.remove(id(req), req.session.user, req.ip); sendJson(res, 200, { ok: true }); });
  r.post('/api/admin/exams/:id/propose', A, async (req, res) => sendJson(res, 200, await exams.propose(id(req), await readJson(req))));
  r.put('/api/admin/exams/:id/questions', A, async (req, res) => { await exams.setQuestions(id(req), (await readJson(req)).items, req.session.user, req.ip); sendJson(res, 200, await exams.get(id(req))); });
  r.put('/api/admin/exams/:id/assignments', A, async (req, res) => { await exams.setAssignments(id(req), await readJson(req), req.session.user, req.ip); sendJson(res, 200, await exams.get(id(req))); });
  r.post('/api/admin/exams/:id/publish', A, async (req, res) => { await exams.publish(id(req), req.session.user, req.ip); sendJson(res, 200, await exams.get(id(req))); });
  r.post('/api/admin/exams/:id/cancel', A, async (req, res) => { await exams.cancel(id(req), req.session.user, req.ip); sendJson(res, 200, { ok: true }); });
  r.post('/api/admin/exams/:id/release', A, async (req, res) => { await exams.release(id(req), await readJson(req), req.session.user, req.ip); sendJson(res, 200, { ok: true }); });

  // ---------- دانش‌آموزان ----------
  r.get('/api/admin/students', A, async (req, res) => sendJson(res, 200, await students.list()));
  r.post('/api/admin/students', A, async (req, res) => sendJson(res, 201, { id: await students.create(await readJson(req), req.session.user, req.ip) }));
  r.patch('/api/admin/students/:id', A, async (req, res) => { await students.update(id(req), await readJson(req), req.session.user, req.ip); sendJson(res, 200, { ok: true }); });
  r.get('/api/admin/students/:id/history', A, async (req, res) => sendJson(res, 200, await analytics.studentHistory(id(req))));
  r.get('/api/admin/groups', A, async (req, res) => sendJson(res, 200, await students.groups()));
  r.post('/api/admin/groups', A, async (req, res) => sendJson(res, 201, { id: await students.createGroup(await readJson(req), req.session.user, req.ip) }));
  r.patch('/api/admin/groups/:id', A, async (req, res) => { await students.updateGroup(id(req), await readJson(req), req.session.user, req.ip); sendJson(res, 200, { ok: true }); });
  r.delete('/api/admin/groups/:id', A, async (req, res) => { await students.deleteGroup(id(req), req.session.user, req.ip); sendJson(res, 200, { ok: true }); });

  // ---------- نتایج ----------
  r.get('/api/admin/exams/:id/results', A, async (req, res) => { const x = await analytics.examResults(id(req)); if (!x) throw notFound(); sendJson(res, 200, x); });
  r.get('/api/admin/attempts/:id', A, async (req, res) => { const x = await analytics.attemptDetail(id(req)); if (!x) throw notFound(); sendJson(res, 200, x); });
  r.get('/api/admin/compare', A, async (req, res) => sendJson(res, 200, await analytics.compare((req.query.get('exams') || '').split(',').map(Number).filter(Boolean).slice(0, 12))));

  // ---------- خروجی‌ها ----------
  r.get('/api/admin/export/bank.xlsx', A, async (req, res) => {
    const { items } = await questions.list({ ...Object.fromEntries(req.query), scope: 'bank', limit: 500 });
    const rows = [['شناسه', 'وضعیت', 'نوع', 'صورت سؤال', 'گزینه ۱', 'گزینه ۲', 'گزینه ۳', 'گزینه ۴', 'پاسخ', 'دشواری', 'سطح شناختی', 'رشته', 'پایه', 'درس', 'فصل', 'مبحث', 'منبع/صفحه', 'برچسب‌ها', 'امتیاز کیفیت', 'دفعات استفاده', 'تاریخ ایجاد']];
    for (const q of items) rows.push([q.uid, STATUS_FA[q.status], QTYPES[q.qtype] || q.qtype, q.stem, ...q.options.map(o => o.text), q.correct_index + 1, DIFFICULTY[q.difficulty].name, COGNITIVE[q.cognitive_level], q.field || '', q.grade || '', q.subject || '', q.chapter || '', q.topic || '',
      q.source_refs.map(s => `#${s.source_id} ص${s.page_start}-${s.page_end}`).join('؛ '), q.tags.join('، '), q.quality_score ?? '', q.used_count, fmtDate(q.created_at)]);
    await audit(db, { userId: req.session.user.id, action: 'export.bank', details: { count: items.length }, ip: req.ip });
    sendFile(res, xlsx([{ name: 'بانک سؤال', rows }]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'question-bank.xlsx');
  });
  r.get('/api/admin/export/bank.html', A, async (req, res) => {
    const { items } = await questions.list({ ...Object.fromEntries(req.query), scope: 'bank', limit: 500 });
    const vs = await Promise.all(items.map(q => questions.version(q.version_id)));
    sendHtml(res, printable('بانک سؤال', vs.map((vv, i) => questionHtml(vv, i + 1, true)).join(''), await settings.get('app_name')));
  });
  r.get('/api/admin/exams/:id/paper.html', A, async (req, res) => {
    const { exam, versions } = await exams.paper(id(req)); const key = req.query.get('key') === '1';
    sendHtml(res, printable(exam.title + (key ? ' — کلید' : ''), versions.map((vv, i) => questionHtml(vv, i + 1, key)).join(''), await settings.get('app_name')));
  });
  r.get('/api/admin/exams/:id/results.xlsx', A, async (req, res) => {
    const x = await analytics.examResults(id(req)); if (!x) throw notFound();
    const s1 = [['رتبه', 'نام', 'نام کاربری', 'وضعیت', 'نمره', 'از', 'درصد', 'صحیح', 'غلط', 'نزده', 'زمان (دقیقه)']];
    for (const a of x.attempts) s1.push([a.rank ?? '', a.full_name, a.username, a.status, a.score ?? '', a.max_score ?? '', a.percent ?? '', a.correct_count ?? '', a.wrong_count ?? '', a.blank_count ?? '', a.time_spent_ms ? Math.round(a.time_spent_ms / 6000) / 10 : '']);
    const s2 = [['ردیف', 'شناسه', 'صورت سؤال', 'دشواری', 'مبحث', 'ضریب دشواری p', 'ضریب تمیز', 'گزینه ۱', 'گزینه ۲', 'گزینه ۳', 'گزینه ۴', 'نزده', 'کلید']];
    for (const it of x.items) s2.push([it.position, it.uid, it.stem, it.difficulty, it.topic || '', it.p, it.discrimination ?? '', ...it.distribution, it.blank, it.correct_index + 1]);
    sendFile(res, xlsx([{ name: 'نتایج', rows: s1 }, { name: 'تحلیل سؤال', rows: s2 }]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `results-${x.exam.id}.xlsx`);
  });
  r.get('/api/admin/attempts/:id/report.html', A, async (req, res) => {
    const a = await analytics.attemptDetail(id(req)); if (!a) throw notFound();
    const groups = ['subject', 'chapter', 'topic', 'difficulty'].map(g => {
      const rows = Object.entries(a.breakdown[g] || {}); if (!rows.length) return '';
      const label = { subject: 'درس', chapter: 'فصل', topic: 'مبحث', difficulty: 'سطح دشواری' }[g];
      return `<h2>${label}</h2><table><tr><th>${label}</th><th>صحیح</th><th>غلط</th><th>نزده</th><th>درصد</th></tr>${rows.map(([k, o]) => `<tr><td>${esc(g === 'difficulty' ? DIFFICULTY[k]?.name || k : k)}</td><td>${o.correct}</td><td>${o.wrong}</td><td>${o.blank}</td><td>${o.percent}٪</td></tr>`).join('')}</table>`;
    }).join('');
    const body = `<section class="card"><p><b>${esc(a.full_name)}</b> (${esc(a.username)}) — ${esc(a.title)}</p><p class="big">${a.percent ?? '—'}٪</p>
      <p>نمره ${a.score ?? '—'} از ${a.max_score ?? '—'} | صحیح ${a.correct_count ?? 0} | غلط ${a.wrong_count ?? 0} | نزده ${a.blank_count ?? 0} | زمان ${a.time_spent_ms ? Math.round(a.time_spent_ms / 60000) : '—'} دقیقه</p></section>${groups}
      <h2>پاسخ‌ها</h2><table><tr><th>#</th><th>شناسه</th><th>پاسخ داوطلب</th><th>کلید</th><th>نتیجه</th></tr>${a.items.map(it => `<tr><td>${it.position}</td><td>${esc(it.uid)}</td><td>${it.choice == null ? '—' : it.choice + 1}</td><td>${it.correct_index + 1}</td><td>${it.choice == null ? 'نزده' : it.is_correct ? '✔' : '✘'}</td></tr>`).join('')}</table>`;
    sendHtml(res, printable('کارنامه', body, await settings.get('app_name')));
  });
}
