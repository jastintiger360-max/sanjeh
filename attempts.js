// اجرای آزمون دانش‌آموز. زمان معتبر = زمان سرور. پاسخ صحیح هرگز پیش از زمان مجاز ارسال نمی‌شود.
import crypto from 'node:crypto';
import { now, bad, forbidden, notFound, conflict, safeJson, v } from '../http/util.js';
import { gradeAttempt } from './grading.js';
import { audit } from './audit.js';

function shuffle(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

export function examWindow(e, t = now()) {
  if (e.status === 'cancelled') return 'cancelled';
  if (t < e.start_at) return 'upcoming';
  if (t >= e.end_at) return 'ended';
  return 'active';
}
export function resultsVisible(e, attempt, t = now()) {
  if (!attempt || !['submitted', 'expired'].includes(attempt.status)) return false;
  if (e.result_policy === 'immediate') return true;
  if (e.result_policy === 'after_end') return t >= e.end_at || !!e.results_released;
  if (e.result_policy === 'manual') return !!e.results_released;
  return false;
}
export function keyVisible(e, attempt, t = now()) {
  if (!attempt || !['submitted', 'expired'].includes(attempt.status)) return false;
  if (e.explanation_policy === 'after_submit') return true;
  if (e.explanation_policy === 'after_end') return t >= e.end_at || !!e.explanations_released;
  if (e.explanation_policy === 'manual') return !!e.explanations_released;
  return false;
}

export function createAttemptService(ctx) {
  const { db, settings } = ctx;

  async function assignedExam(examId, userId) {
    const e = await db.get(`SELECT e.* FROM exams e WHERE e.id = ? AND e.status IN ('published','cancelled') AND EXISTS (
      SELECT 1 FROM exam_assignments a WHERE a.exam_id = e.id AND (a.user_id = ? OR a.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)))`, [examId, userId, userId]);
    if (!e) throw notFound('آزمون یافت نشد.'); // عمداً 404 تا وجود آزمون‌های دیگران افشا نشود
    return e;
  }
  async function finalizeIfExpired(a) {
    if (a.status !== 'in_progress') return a;
    const grace = (await settings.get('submit_grace_sec')) * 1000;
    if (now() > a.deadline_at + grace) {
      const r = await db.run("UPDATE attempts SET status = 'expired', submitted_at = deadline_at WHERE id = ? AND status = 'in_progress'", [a.id]);
      if (r.changes) await gradeAttempt(db, a.id);
      return db.get('SELECT * FROM attempts WHERE id = ?', [a.id]);
    }
    return a;
  }

  const svc = {
    async listForStudent(user) {
      const rows = await db.all(`SELECT e.id, e.title, e.description, e.subject, e.duration_min, e.start_at, e.end_at, e.status, e.result_policy, e.explanation_policy, e.results_released, e.explanations_released,
          (SELECT COUNT(*) FROM exam_questions WHERE exam_id = e.id) AS question_count,
          a.id AS attempt_id, a.status AS attempt_status, a.deadline_at, a.submitted_at
        FROM exams e LEFT JOIN attempts a ON a.exam_id = e.id AND a.user_id = ?
        WHERE e.status IN ('published','cancelled') AND EXISTS (SELECT 1 FROM exam_assignments x WHERE x.exam_id = e.id AND (x.user_id = ? OR x.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)))
        ORDER BY e.start_at DESC`, [user.id, user.id, user.id]);
      const t = now();
      for (const r of rows) {
        if (r.attempt_status === 'in_progress') { const fin = await finalizeIfExpired({ id: r.attempt_id, status: 'in_progress', deadline_at: r.deadline_at }); r.attempt_status = fin.status; }
        r.window = examWindow(r, t);
        r.results_visible = resultsVisible(r, r.attempt_id ? { status: r.attempt_status } : null, t);
        delete r.results_released; delete r.explanations_released;
      }
      return { server_now: t, exams: rows };
    },

    async start(examId, user, ip) {
      const e = await assignedExam(examId, user.id);
      const w = examWindow(e);
      const existing = await db.get('SELECT * FROM attempts WHERE exam_id = ? AND user_id = ?', [examId, user.id]);
      if (existing) {
        const a = await finalizeIfExpired(existing);
        if (a.status === 'in_progress') return a.id; // ادامه آزمون (Refresh یا ورود مجدد)
        throw conflict('این آزمون قبلاً به پایان رسیده است.');
      }
      if (w !== 'active') throw conflict(w === 'upcoming' ? 'زمان آزمون هنوز شروع نشده است.' : w === 'cancelled' ? 'این آزمون لغو شده است.' : 'زمان آزمون به پایان رسیده است.');
      const eqs = await db.all('SELECT id FROM exam_questions WHERE exam_id = ? ORDER BY position', [examId]);
      const order = e.shuffle_questions ? shuffle(eqs.map(x => x.id)) : eqs.map(x => x.id);
      const opt = {}; for (const x of eqs) opt[x.id] = e.shuffle_options ? shuffle([0, 1, 2, 3]) : [0, 1, 2, 3];
      const t = now();
      const deadline = Math.min(t + e.duration_min * 60_000, e.end_at);
      try {
        const id = await db.insert('INSERT INTO attempts(exam_id, user_id, status, started_at, deadline_at, question_order, option_orders) VALUES (?,?,?,?,?,?,?)',
          [examId, user.id, 'in_progress', t, deadline, JSON.stringify(order), JSON.stringify(opt)]);
        await audit(db, { userId: user.id, action: 'attempt.start', entity: 'attempt', entityId: id, ip });
        return id;
      } catch (err) {
        // شروع هم‌زمان از دو تب: یکتایی (exam_id,user_id) تضمین می‌کند فقط یک تلاش ساخته شود
        const again = await db.get('SELECT id FROM attempts WHERE exam_id = ? AND user_id = ?', [examId, user.id]);
        if (again) return again.id;
        throw err;
      }
    },

    async ownAttempt(attemptId, user) {
      const a = await db.get('SELECT * FROM attempts WHERE id = ? AND user_id = ?', [attemptId, user.id]);
      if (!a) throw notFound('آزمون یافت نشد.');
      return finalizeIfExpired(a);
    },

    async view(attemptId, user) {
      const a = await svc.ownAttempt(attemptId, user);
      const e = await db.get('SELECT * FROM exams WHERE id = ?', [a.exam_id]);
      if (a.status === 'voided' || e.status === 'cancelled') throw conflict('این آزمون لغو شده است.');
      if (a.status !== 'in_progress') return { id: a.id, exam_id: a.exam_id, status: a.status, finished: true };
      const order = safeJson(a.question_order, []); const opt = safeJson(a.option_orders, {});
      const rows = await db.all(`SELECT eq.id AS eqid, v.qtype, v.stem, v.passage, v.statements, v.table_data, v.image_path, v.options FROM exam_questions eq
        JOIN question_versions v ON v.id = eq.question_version_id WHERE eq.exam_id = ?`, [a.exam_id]);
      const byId = new Map(rows.map(r => [r.eqid, r]));
      // فقط فیلدهای مجاز؛ کلید، پاسخ تشریحی، دلایل گزینه‌ها و منبع حذف می‌شوند
      const questions = order.map((eqid, i) => {
        const r = byId.get(eqid); const options = safeJson(r.options, []);
        return { eqid, n: i + 1, qtype: r.qtype, stem: r.stem, passage: r.passage, image: r.image_path ? `/api/student/attempts/${a.id}/image/${eqid}` : null,
          statements: (safeJson(r.statements) || []).map(s => ({ label: s.label, text: s.text })) || null, table: safeJson(r.table_data),
          options: (opt[eqid] || [0, 1, 2, 3]).map(oi => ({ id: oi, text: options[oi]?.text ?? '' })) };
      });
      const answers = await db.all('SELECT exam_question_id AS eqid, choice, flagged, seq FROM attempt_answers WHERE attempt_id = ?', [a.id]);
      return { id: a.id, exam: { id: e.id, title: e.title, allow_back: !!e.allow_back, allow_flag: !!e.allow_flag, negative: e.negative_ratio > 0 },
        status: a.status, started_at: a.started_at, deadline_at: a.deadline_at, server_now: now(), autosave_sec: await settings.get('autosave_interval_sec'), questions, answers };
    },

    async save(attemptId, user, list) {
      // سیاست حل تعارض: برای هر سؤال، تغییری با seq بزرگ‌تر از seq ذخیره‌شده پذیرفته می‌شود (seq یکنوا در کلاینت).
      if (!Array.isArray(list) || list.length > 500) throw bad('پاسخ‌ها نامعتبر است.');
      const a = await svc.ownAttempt(attemptId, user);
      if (a.status !== 'in_progress') throw conflict('زمان آزمون به پایان رسیده یا آزمون ثبت نهایی شده است.', { code: 'ATTEMPT_CLOSED' });
      const e = await db.get('SELECT allow_back, allow_flag, status FROM exams WHERE id = ?', [a.exam_id]);
      if (e.status === 'cancelled') throw conflict('آزمون لغو شده است.', { code: 'ATTEMPT_CLOSED' });
      const t = now();
      if (t > a.deadline_at + (await settings.get('submit_grace_sec')) * 1000) throw conflict('زمان آزمون به پایان رسیده است.', { code: 'ATTEMPT_CLOSED' });
      const order = safeJson(a.question_order, []);
      const pos = new Map(order.map((id, i) => [id, i]));
      const results = [];
      await db.tx(async () => {
        let furthest = -1;
        if (!e.allow_back) for (const r of await db.all('SELECT exam_question_id FROM attempt_answers WHERE attempt_id = ?', [a.id])) furthest = Math.max(furthest, pos.get(r.exam_question_id) ?? -1);
        for (const item of list) {
          const eqid = v.int(item.eqid, 'سؤال', { min: 1 });
          if (!pos.has(eqid)) throw bad('سؤال متعلق به این آزمون نیست.');
          const choice = item.choice == null ? null : v.int(item.choice, 'گزینه', { min: 0, max: 3 });
          const seq = v.int(item.seq, 'seq', { min: 1 });
          const flagged = e.allow_flag && v.bool(item.flagged) ? 1 : 0;
          if (item.client_ts && Number(item.client_ts) > a.deadline_at + 5000 && t > a.deadline_at) { results.push({ eqid, accepted: false, reason: 'late' }); continue; }
          if (!e.allow_back && pos.get(eqid) < furthest) { results.push({ eqid, accepted: false, reason: 'no_back' }); continue; }
          const cur = await db.get('SELECT choice, flagged, seq FROM attempt_answers WHERE attempt_id = ? AND exam_question_id = ?', [a.id, eqid]);
          if (cur && cur.seq >= seq) { results.push({ eqid, accepted: false, reason: 'stale', server: cur }); continue; }
          await db.run(`INSERT INTO attempt_answers(attempt_id, exam_question_id, choice, flagged, seq, client_ts, server_ts) VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(attempt_id, exam_question_id) DO UPDATE SET choice = excluded.choice, flagged = excluded.flagged, seq = excluded.seq, client_ts = excluded.client_ts, server_ts = excluded.server_ts`,
            [a.id, eqid, choice, flagged, seq, item.client_ts ? Number(item.client_ts) : null, t]);
          furthest = Math.max(furthest, pos.get(eqid));
          results.push({ eqid, accepted: true, seq });
        }
      });
      return { server_now: t, deadline_at: a.deadline_at, results };
    },

    async submit(attemptId, user, ip) {
      const a = await svc.ownAttempt(attemptId, user);
      if (a.status !== 'in_progress') return { status: a.status };
      const r = await db.run("UPDATE attempts SET status = 'submitted', submitted_at = ? WHERE id = ? AND status = 'in_progress'", [Math.min(now(), a.deadline_at), a.id]);
      if (r.changes) { await gradeAttempt(db, a.id); await audit(db, { userId: user.id, action: 'attempt.submit', entity: 'attempt', entityId: a.id, ip }); }
      return { status: 'submitted' };
    },

    async result(examId, user) {
      const e = await assignedExam(examId, user.id);
      let a = await db.get('SELECT * FROM attempts WHERE exam_id = ? AND user_id = ?', [examId, user.id]);
      if (!a) throw notFound('در این آزمون شرکت نکرده‌اید.');
      a = await finalizeIfExpired(a);
      if (!resultsVisible(e, a)) throw forbidden('نتیجه این آزمون هنوز منتشر نشده است.');
      const showKey = keyVisible(e, a);
      const out = { exam: { id: e.id, title: e.title, negative_ratio: e.negative_ratio }, status: a.status, score: a.score, max_score: a.max_score, percent: a.percent,
        correct: a.correct_count, wrong: a.wrong_count, blank: a.blank_count, time_spent_ms: a.time_spent_ms, breakdown: safeJson(a.breakdown, {}), key_visible: showKey };
      if (showKey) {
        const order = safeJson(a.question_order, []); const opt = safeJson(a.option_orders, {});
        const rows = await db.all(`SELECT eq.id AS eqid, v.stem, v.passage, v.statements, v.table_data, v.options, v.correct_index, v.explanation, ans.choice FROM exam_questions eq
          JOIN question_versions v ON v.id = eq.question_version_id LEFT JOIN attempt_answers ans ON ans.attempt_id = ? AND ans.exam_question_id = eq.id WHERE eq.exam_id = ?`, [a.id, e.id]);
        const by = new Map(rows.map(r => [r.eqid, r]));
        out.items = order.map((eqid, i) => { const r = by.get(eqid); const o = safeJson(r.options, []);
          return { n: i + 1, stem: r.stem, passage: r.passage, statements: (safeJson(r.statements) || []).map(s => ({ label: s.label, text: s.text, is_true: s.is_true })), table: safeJson(r.table_data),
            options: (opt[eqid] || [0, 1, 2, 3]).map(oi => ({ id: oi, text: o[oi]?.text, rationale: o[oi]?.rationale })), correct: r.correct_index, choice: r.choice, explanation: r.explanation }; });
      }
      return out;
    },

    async sweep() {
      const grace = (await settings.get('submit_grace_sec')) * 1000;
      const due = await db.all("SELECT id FROM attempts WHERE status = 'in_progress' AND deadline_at + ? < ?", [grace, now()]);
      for (const d of due) { const r = await db.run("UPDATE attempts SET status = 'expired', submitted_at = deadline_at WHERE id = ? AND status = 'in_progress'", [d.id]); if (r.changes) await gradeAttempt(db, d.id); }
      return due.length;
    },
  };
  return svc;
}
