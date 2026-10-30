import crypto from 'node:crypto';
import { now, bad, notFound, conflict, safeJson, v } from '../http/util.js';
import { audit } from './audit.js';
import { parseVersion } from './questions.js';

const RESULT_POLICIES = ['immediate', 'after_end', 'manual', 'hidden'];
const EXPL_POLICIES = ['after_submit', 'after_end', 'manual', 'never'];
const LEVEL_NAMES = { 1: 'آسان', 2: 'متوسط', 3: 'دشوار', 4: 'چالشی' };

export function allocate(count, mix) {
  // mix: {1: n|percent, ...}, mode 'percent' | 'count' — روش بزرگ‌ترین باقیمانده برای گرد کردن
  if (mix.mode === 'count') return { 1: +mix[1] || 0, 2: +mix[2] || 0, 3: +mix[3] || 0, 4: +mix[4] || 0 };
  const total = [1, 2, 3, 4].reduce((a, k) => a + (+mix[k] || 0), 0);
  if (Math.abs(total - 100) > 0.01) throw bad('مجموع درصد سطوح دشواری باید ۱۰۰ باشد.');
  const raw = [1, 2, 3, 4].map(k => ({ k, x: count * (+mix[k] || 0) / 100 }));
  const out = {}; let used = 0;
  for (const r of raw) { out[r.k] = Math.floor(r.x); used += out[r.k]; }
  raw.sort((a, b) => (b.x - Math.floor(b.x)) - (a.x - Math.floor(a.x)));
  for (let i = 0; used < count; i++, used++) out[raw[i % 4].k]++;
  return out;
}

function secureShuffle(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

export function createExamService(ctx) {
  const { db, settings } = ctx;

  function readExam(body, partial = false) {
    const out = {};
    const has = k => !partial || k in body;
    if (has('title')) out.title = v.str(body.title, 'عنوان', { min: 2, max: 200 });
    if (has('description')) out.description = v.str(body.description, 'توضیحات', { max: 3000, optional: true });
    for (const k of ['field', 'grade', 'subject']) if (has(k)) out[k] = v.str(body[k], k, { max: 100, optional: true });
    if (has('topics')) out.topics = JSON.stringify((body.topics || []).map(String).slice(0, 50));
    if (has('duration_min')) out.duration_min = v.int(body.duration_min, 'مدت زمان', { min: 1, max: 600 });
    if (has('start_at')) out.start_at = v.int(body.start_at, 'تاریخ شروع', { min: 0 });
    if (has('end_at')) out.end_at = v.int(body.end_at, 'تاریخ پایان', { min: 0 });
    if (has('points_per_question')) out.points_per_question = v.num(body.points_per_question, 'نمره هر سؤال', { min: 0.01, max: 100 });
    if (has('negative_ratio')) out.negative_ratio = v.num(body.negative_ratio ?? 0, 'ضریب نمره منفی', { min: 0, max: 1 });
    for (const k of ['floor_zero', 'shuffle_questions', 'shuffle_options', 'allow_back', 'allow_flag']) if (has(k)) out[k] = v.bool(body[k]) ? 1 : 0;
    if (has('result_policy')) out.result_policy = v.oneOf(body.result_policy || 'after_end', 'نحوه نمایش نتیجه', RESULT_POLICIES);
    if (has('explanation_policy')) out.explanation_policy = v.oneOf(body.explanation_policy || 'after_end', 'زمان انتشار پاسخ تشریحی', EXPL_POLICIES);
    if (has('blueprint')) out.blueprint = body.blueprint ? JSON.stringify(body.blueprint) : null;
    return out;
  }

  async function getRaw(id) { const e = await db.get('SELECT * FROM exams WHERE id = ?', [id]); if (!e) throw notFound('آزمون یافت نشد.'); return e; }

  async function bankCandidates(f) {
    const where = ["q.approved_version_id IS NOT NULL", "q.status NOT IN ('archived','rejected')"]; const p = [];
    for (const k of ['field', 'grade', 'subject']) if (f[k]) { where.push(`v.${k} = ?`); p.push(f[k]); }
    if (f.chapters?.length) { where.push(`v.chapter IN (${f.chapters.map(() => '?').join(',')})`); p.push(...f.chapters); }
    if (f.topics?.length) { where.push(`v.topic IN (${f.topics.map(() => '?').join(',')})`); p.push(...f.topics); }
    if (f.qtype) { where.push('v.qtype = ?'); p.push(f.qtype); }
    if (f.tag) { where.push('q.tags LIKE ?'); p.push(`%${JSON.stringify(String(f.tag))}%`); }
    if (f.exclude_used) where.push('NOT EXISTS (SELECT 1 FROM exam_questions eq JOIN exams e ON e.id = eq.exam_id WHERE eq.question_id = q.id AND e.status = \'published\')');
    return db.all(`SELECT q.id, q.uid, q.approved_version_id, v.difficulty, v.stem, v.chapter, v.topic, v.subject, v.quality_score FROM questions q JOIN question_versions v ON v.id = q.approved_version_id WHERE ${where.join(' AND ')}`, p);
  }

  const svc = {
    async list() {
      return db.all(`SELECT e.*, (SELECT COUNT(*) FROM exam_questions WHERE exam_id = e.id) AS question_count,
        (SELECT COUNT(*) FROM attempts WHERE exam_id = e.id AND status IN ('submitted','expired')) AS finished_count,
        (SELECT COUNT(*) FROM exam_assignments WHERE exam_id = e.id) AS assignment_count FROM exams e ORDER BY e.created_at DESC`);
    },
    async get(id) {
      const e = await getRaw(id);
      e.topics = safeJson(e.topics, []); e.blueprint = safeJson(e.blueprint);
      e.questions = (await db.all(`SELECT eq.id AS exam_question_id, eq.position, eq.points, eq.question_id, eq.question_version_id, q.uid, q.status AS question_status, q.approved_version_id,
          v.version_no, v.qtype, v.stem, v.options, v.correct_index, v.difficulty, v.cognitive_level, v.chapter, v.topic, v.subject, v.quality_score
        FROM exam_questions eq JOIN questions q ON q.id = eq.question_id JOIN question_versions v ON v.id = eq.question_version_id WHERE eq.exam_id = ? ORDER BY eq.position`, [id]))
        .map(r => ({ ...r, options: safeJson(r.options, []), newer_version_available: r.approved_version_id !== r.question_version_id }));
      e.assignments = await db.all(`SELECT a.id, a.user_id, a.group_id, u.full_name, u.username, g.name AS group_name FROM exam_assignments a
        LEFT JOIN users u ON u.id = a.user_id LEFT JOIN student_groups g ON g.id = a.group_id WHERE a.exam_id = ?`, [id]);
      e.difficulty_counts = [1, 2, 3, 4].map(k => e.questions.filter(q => q.difficulty === k).length);
      return e;
    },
    async create(body, user, ip) {
      const defaults = { points_per_question: 1, allow_back: true, allow_flag: true, result_policy: 'after_end', explanation_policy: 'after_end', topics: [] };
      const d = readExam({ ...defaults, ...Object.fromEntries(Object.entries(body).filter(([, x]) => x !== undefined && x !== null && x !== '')) });
      if (d.end_at <= d.start_at) throw bad('تاریخ پایان باید بعد از تاریخ شروع باشد.');
      if (body.negative_ratio === undefined) d.negative_ratio = await settings.get('default_negative_ratio');
      const t = now();
      const cols = Object.keys(d);
      const id = await db.insert(`INSERT INTO exams(${cols.join(',')}, status, created_by, created_at, updated_at) VALUES (${cols.map(() => '?').join(',')}, 'draft', ?, ?, ?)`, [...cols.map(c => d[c]), user.id, t, t]);
      await audit(db, { userId: user.id, action: 'exam.create', entity: 'exam', entityId: id, ip });
      return id;
    },
    async update(id, body, user, ip) {
      const e = await getRaw(id);
      if (e.status === 'cancelled') throw conflict('آزمون لغوشده قابل ویرایش نیست.');
      const d = readExam(body, true);
      if (e.status === 'published') {
        // پس از انتشار فقط موارد بی‌خطر قابل تغییر است؛ تمدید پایان مجاز، کوتاه‌کردن مجاز نیست
        const allowed = ['title', 'description', 'end_at', 'result_policy', 'explanation_policy'];
        for (const k of Object.keys(d)) if (!allowed.includes(k)) throw conflict(`پس از انتشار، «${k}» قابل تغییر نیست.`);
        if (d.end_at != null && d.end_at < e.end_at) throw conflict('پس از انتشار فقط تمدید زمان پایان مجاز است.');
      }
      const start = d.start_at ?? e.start_at, end = d.end_at ?? e.end_at;
      if (end <= start) throw bad('تاریخ پایان باید بعد از تاریخ شروع باشد.');
      const cols = Object.keys(d);
      if (cols.length) await db.run(`UPDATE exams SET ${cols.map(c => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, [...cols.map(c => d[c]), now(), id]);
      await audit(db, { userId: user.id, action: 'exam.update', entity: 'exam', entityId: id, details: { fields: cols }, ip });
    },
    async propose(id, body) {
      // انتخاب نیمه‌خودکار: فقط پیشنهاد؛ ذخیره پس از بازبینی مدیر
      const e = await getRaw(id);
      const count = v.int(body.count, 'تعداد سؤال', { min: 1, max: 500 });
      const need = allocate(count, body.mix || { mode: 'percent', 1: 25, 2: 25, 3: 25, 4: 25 });
      const existing = new Set((await db.all('SELECT question_id FROM exam_questions WHERE exam_id = ?', [id])).map(r => r.question_id));
      const cands = (await bankCandidates({ field: body.field ?? e.field, grade: body.grade ?? e.grade, subject: body.subject ?? e.subject, chapters: body.chapters, topics: body.topics, qtype: body.qtype, tag: body.tag, exclude_used: v.bool(body.exclude_used) }))
        .filter(c => !existing.has(c.id));
      const picks = []; const shortages = [];
      for (const lvl of [1, 2, 3, 4]) {
        const pool = secureShuffle(cands.filter(c => c.difficulty === lvl));
        const n = need[lvl] || 0;
        picks.push(...pool.slice(0, n));
        if (pool.length < n) shortages.push({ difficulty: lvl, name: LEVEL_NAMES[lvl], needed: n, available: pool.length, missing: n - pool.length });
      }
      return { need, picks, shortages, note: shortages.length ? 'سؤال کافی در برخی سطوح وجود ندارد. سؤال ساده‌تر به‌طور خودکار جایگزین نشده است؛ تصمیم با مدیر است.' : null };
    },
    async setQuestions(id, items, user, ip) {
      // items: [{question_id, points?}] به ترتیب
      const e = await getRaw(id);
      if (e.status !== 'draft') throw conflict('فقط سؤال‌های آزمون پیش‌نویس قابل تغییر است.');
      if (!Array.isArray(items)) throw bad('فهرست سؤال نامعتبر است.');
      const ids = items.map(i => v.int(i.question_id, 'سؤال', { min: 1 }));
      if (new Set(ids).size !== ids.length) throw bad('سؤال تکراری در آزمون مجاز نیست.');
      await db.tx(async () => {
        const prev = new Map((await db.all('SELECT question_id, question_version_id FROM exam_questions WHERE exam_id = ?', [id])).map(r => [r.question_id, r.question_version_id]));
        await db.run('DELETE FROM exam_questions WHERE exam_id = ?', [id]);
        for (let i = 0; i < items.length; i++) {
          const q = await db.get("SELECT id, approved_version_id, status FROM questions WHERE id = ?", [ids[i]]);
          if (!q || !q.approved_version_id || ['archived', 'rejected'].includes(q.status)) throw bad(`سؤال ${ids[i]} در بانک تأییدشده نیست.`);
          const ver = items[i].refresh_version ? q.approved_version_id : (prev.get(q.id) || q.approved_version_id);
          await db.run('INSERT INTO exam_questions(exam_id, question_id, question_version_id, position, points) VALUES (?,?,?,?,?)',
            [id, q.id, ver, i + 1, items[i].points == null || items[i].points === '' ? null : v.num(items[i].points, 'نمره', { min: 0, max: 100 })]);
        }
        await db.run('UPDATE exams SET updated_at = ? WHERE id = ?', [now(), id]);
      });
      await audit(db, { userId: user.id, action: 'exam.questions', entity: 'exam', entityId: id, details: { count: items.length }, ip });
    },
    async setAssignments(id, { user_ids = [], group_ids = [] }, user, ip) {
      const e = await getRaw(id);
      if (e.status === 'cancelled') throw conflict('آزمون لغو شده است.');
      const uids = v.ids(user_ids, 'دانش‌آموزان'), gids = v.ids(group_ids, 'گروه‌ها');
      await db.tx(async () => {
        await db.run('DELETE FROM exam_assignments WHERE exam_id = ?', [id]);
        for (const u of uids) {
          const s = await db.get("SELECT id FROM users WHERE id = ? AND role = 'student'", [u]);
          if (!s) throw bad('دانش‌آموز نامعتبر است.');
          await db.run('INSERT INTO exam_assignments(exam_id, user_id, created_at) VALUES (?,?,?)', [id, u, now()]);
        }
        for (const g of gids) {
          if (!(await db.get('SELECT id FROM student_groups WHERE id = ?', [g]))) throw bad('گروه نامعتبر است.');
          await db.run('INSERT INTO exam_assignments(exam_id, group_id, created_at) VALUES (?,?,?)', [id, g, now()]);
        }
      });
      await audit(db, { userId: user.id, action: 'exam.assign', entity: 'exam', entityId: id, details: { users: uids.length, groups: gids.length }, ip });
    },
    async publish(id, user, ip) {
      const e = await svc.get(id);
      if (e.status !== 'draft') throw conflict('فقط آزمون پیش‌نویس قابل انتشار است.');
      const problems = [];
      if (!e.questions.length) problems.push('آزمون سؤال ندارد.');
      if (!e.assignments.length) problems.push('آزمون به هیچ دانش‌آموز یا گروهی اختصاص داده نشده است.');
      if (e.end_at <= now()) problems.push('زمان پایان آزمون گذشته است.');
      if (e.duration_min * 60_000 > e.end_at - e.start_at) problems.push('مدت آزمون از فاصله شروع تا پایان بیشتر است.');
      for (const q of e.questions) if (['archived', 'rejected'].includes(q.question_status)) problems.push(`سؤال ${q.uid} دیگر در بانک فعال نیست.`);
      if (problems.length) throw bad('انتشار ممکن نیست:\n' + problems.join('\n'), { problems });
      await db.run("UPDATE exams SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?", [now(), now(), id]);
      await audit(db, { userId: user.id, action: 'exam.publish', entity: 'exam', entityId: id, ip });
    },
    async cancel(id, user, ip) {
      const e = await getRaw(id);
      if (e.status === 'cancelled') throw conflict('آزمون قبلاً لغو شده است.');
      await db.run("UPDATE exams SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?", [now(), now(), id]);
      await db.run("UPDATE attempts SET status = 'voided' WHERE exam_id = ? AND status = 'in_progress'", [id]);
      await audit(db, { userId: user.id, action: 'exam.cancel', entity: 'exam', entityId: id, ip });
    },
    async release(id, { results, explanations }, user, ip) {
      await getRaw(id);
      await db.run('UPDATE exams SET results_released = COALESCE(?, results_released), explanations_released = COALESCE(?, explanations_released), updated_at = ? WHERE id = ?',
        [results == null ? null : (results ? 1 : 0), explanations == null ? null : (explanations ? 1 : 0), now(), id]);
      await audit(db, { userId: user.id, action: 'exam.release', entity: 'exam', entityId: id, details: { results, explanations }, ip });
    },
    async remove(id, user, ip) {
      const e = await getRaw(id);
      if (e.status !== 'draft') throw conflict('فقط آزمون پیش‌نویس قابل حذف است؛ آزمون منتشرشده را لغو کنید.');
      await db.run('DELETE FROM exams WHERE id = ?', [id]);
      await audit(db, { userId: user.id, action: 'exam.delete', entity: 'exam', entityId: id, ip });
    },
    async paper(id) {
      const e = await svc.get(id);
      const versions = await Promise.all(e.questions.map(q => db.get('SELECT * FROM question_versions WHERE id = ?', [q.question_version_id]).then(parseVersion)));
      return { exam: e, versions };
    },
  };
  return svc;
}
