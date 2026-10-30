import { safeJson } from '../http/util.js';

const stats = (xs) => {
  if (!xs.length) return { n: 0, mean: null, median: null, sd: null, min: null, max: null };
  const s = [...xs].sort((a, b) => a - b); const n = s.length; const mean = s.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  const r = x => Math.round(x * 100) / 100;
  return { n, mean: r(mean), median: r(median), sd: r(sd), min: r(s[0]), max: r(s[n - 1]) };
};

export function createAnalytics(ctx) {
  const { db } = ctx;
  return {
    async dashboard() {
      const q = await db.all('SELECT status, COUNT(*) AS n FROM questions GROUP BY status');
      const bank = await db.all(`SELECT v.difficulty, COUNT(*) AS n FROM questions q JOIN question_versions v ON v.id = q.approved_version_id WHERE q.status NOT IN ('archived','rejected') GROUP BY v.difficulty`);
      const src = await db.get("SELECT COUNT(*) AS n, SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END) AS ready, SUM(CASE WHEN authority='official' THEN 1 ELSE 0 END) AS official, SUM(COALESCE(flagged_count,0)) AS flagged FROM sources");
      const exams = await db.all('SELECT status, COUNT(*) AS n FROM exams GROUP BY status');
      const t = Date.now();
      const active = await db.get("SELECT COUNT(*) AS n FROM exams WHERE status='published' AND start_at <= ? AND end_at > ?", [t, t]);
      const students = await db.get("SELECT COUNT(*) AS n, SUM(active) AS active FROM users WHERE role='student'");
      const ai = await db.get('SELECT COUNT(*) AS calls, COALESCE(SUM(prompt_tokens),0) AS pt, COALESCE(SUM(completion_tokens),0) AS ct, COALESCE(SUM(est_cost),0) AS cost FROM ai_calls WHERE created_at > ?', [t - 30 * 86400_000]);
      const recent = await db.all(`SELECT a.id, a.percent, a.submitted_at, a.status, u.full_name, e.title FROM attempts a JOIN users u ON u.id=a.user_id JOIN exams e ON e.id=a.exam_id
        WHERE a.status IN ('submitted','expired') ORDER BY a.submitted_at DESC LIMIT 8`);
      return { questions: Object.fromEntries(q.map(r => [r.status, r.n])), bank: Object.fromEntries(bank.map(r => [r.difficulty, r.n])), sources: src, exams: Object.fromEntries(exams.map(r => [r.status, r.n])),
        active_exams: active.n, students, ai_30d: ai, recent };
    },
    async examResults(examId) {
      const exam = await db.get('SELECT id, title, start_at, end_at, negative_ratio, status FROM exams WHERE id = ?', [examId]);
      if (!exam) return null;
      const attempts = await db.all(`SELECT a.id, a.user_id, u.full_name, u.username, a.status, a.score, a.max_score, a.percent, a.correct_count, a.wrong_count, a.blank_count, a.time_spent_ms, a.started_at, a.submitted_at, a.breakdown
        FROM attempts a JOIN users u ON u.id = a.user_id WHERE a.exam_id = ? ORDER BY a.percent DESC`, [examId]);
      const done = attempts.filter(a => ['submitted', 'expired'].includes(a.status));
      done.forEach((a, i) => { a.rank = i + 1; a.breakdown = safeJson(a.breakdown, {}); });
      const pcts = done.map(a => a.percent);
      const hist = Array.from({ length: 10 }, (_, i) => ({ from: i * 10, to: i * 10 + 10, n: 0 }));
      for (const p of pcts) hist[Math.max(0, Math.min(9, Math.floor(p / 10)))].n++;
      const negatives = pcts.filter(p => p < 0).length;
      // تحلیل سؤال: ضریب دشواری (p) و ضریب تمیز (گروه بالا و پایین ۲۷٪)
      const items = await db.all(`SELECT eq.id AS eqid, eq.position, q.id AS question_id, q.uid, v.stem, v.difficulty, v.chapter, v.topic, v.correct_index FROM exam_questions eq JOIN questions q ON q.id = eq.question_id
        JOIN question_versions v ON v.id = eq.question_version_id WHERE eq.exam_id = ? ORDER BY eq.position`, [examId]);
      const answers = await db.all(`SELECT ans.attempt_id, ans.exam_question_id AS eqid, ans.choice, ans.is_correct FROM attempt_answers ans JOIN attempts a ON a.id = ans.attempt_id
        WHERE a.exam_id = ? AND a.status IN ('submitted','expired')`, [examId]);
      const k = Math.max(1, Math.round(done.length * 0.27));
      const upper = new Set(done.slice(0, k).map(a => a.id)), lower = new Set(done.slice(-k).map(a => a.id));
      const itemStats = items.map(it => {
        const as = answers.filter(a => a.eqid === it.eqid);
        const dist = [0, 0, 0, 0]; let blank = 0, correct = 0;
        for (const a of as) { if (a.choice == null) blank++; else dist[a.choice]++; if (a.is_correct === 1) correct++; }
        const n = done.length || 1;
        const u = as.filter(a => upper.has(a.attempt_id) && a.is_correct === 1).length / k;
        const l = as.filter(a => lower.has(a.attempt_id) && a.is_correct === 1).length / k;
        return { ...it, stem: it.stem.slice(0, 140), p: Math.round((correct / n) * 100) / 100, discrimination: done.length >= 4 ? Math.round((u - l) * 100) / 100 : null, distribution: dist, blank };
      });
      const byDiff = {};
      for (const it of itemStats) { const o = (byDiff[it.difficulty] ||= { items: 0, p_sum: 0 }); o.items++; o.p_sum += it.p; }
      for (const o of Object.values(byDiff)) o.mean_p = Math.round((o.p_sum / o.items) * 100) / 100;
      return { exam, attempts, stats: stats(pcts), histogram: hist, negatives, items: itemStats, by_difficulty: byDiff,
        participation: { assigned_students: (await db.get(`SELECT COUNT(DISTINCT u.id) AS n FROM users u WHERE u.role='student' AND (u.id IN (SELECT user_id FROM exam_assignments WHERE exam_id = ? AND user_id IS NOT NULL)
          OR u.id IN (SELECT gm.user_id FROM group_members gm JOIN exam_assignments x ON x.group_id = gm.group_id WHERE x.exam_id = ?))`, [examId, examId])).n, finished: done.length,
          in_progress: attempts.filter(a => a.status === 'in_progress').length } };
    },
    async attemptDetail(attemptId) {
      const a = await db.get('SELECT a.*, u.full_name, u.username, e.title FROM attempts a JOIN users u ON u.id = a.user_id JOIN exams e ON e.id = a.exam_id WHERE a.id = ?', [attemptId]);
      if (!a) return null;
      a.breakdown = safeJson(a.breakdown, {});
      a.items = await db.all(`SELECT eq.position, q.uid, v.stem, v.correct_index, v.difficulty, v.topic, ans.choice, ans.is_correct, ans.flagged, ans.server_ts FROM exam_questions eq
        JOIN questions q ON q.id = eq.question_id JOIN question_versions v ON v.id = eq.question_version_id LEFT JOIN attempt_answers ans ON ans.attempt_id = ? AND ans.exam_question_id = eq.id
        WHERE eq.exam_id = ? ORDER BY eq.position`, [attemptId, a.exam_id]);
      delete a.question_order; delete a.option_orders;
      return a;
    },
    async compare(examIds) {
      const exams = []; const students = new Map();
      for (const id of examIds) {
        const e = await db.get('SELECT id, title, start_at FROM exams WHERE id = ?', [id]); if (!e) continue;
        const rows = await db.all("SELECT a.user_id, u.full_name, a.percent FROM attempts a JOIN users u ON u.id = a.user_id WHERE a.exam_id = ? AND a.status IN ('submitted','expired')", [id]);
        exams.push({ ...e, stats: stats(rows.map(r => r.percent)) });
        for (const r of rows) { const s = students.get(r.user_id) || { user_id: r.user_id, full_name: r.full_name, percents: {} }; s.percents[id] = r.percent; students.set(r.user_id, s); }
      }
      return { exams, students: [...students.values()] };
    },
    async studentHistory(userId) {
      return db.all(`SELECT a.id AS attempt_id, e.id AS exam_id, e.title, e.start_at, a.status, a.percent, a.score, a.max_score, a.correct_count, a.wrong_count, a.blank_count, a.submitted_at
        FROM attempts a JOIN exams e ON e.id = a.exam_id WHERE a.user_id = ? ORDER BY e.start_at`, [userId]);
    },
  };
}
