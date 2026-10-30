// تصحیح خودکار بر اساس نسخه دقیق سؤال و کلید همان آزمون
import { safeJson } from '../http/util.js';

export function computeScore({ items, negativeRatio, floorZero }) {
  // items: [{points, choice, correct_index, meta}]
  let score = 0, max = 0, correct = 0, wrong = 0, blank = 0;
  const groups = { subject: {}, chapter: {}, topic: {}, difficulty: {} };
  const bump = (g, k, field, pts) => { const key = k || 'نامشخص'; const o = (groups[g][key] ||= { correct: 0, wrong: 0, blank: 0, total: 0, score: 0, max: 0 }); o[field]++; o.total++; o.score += pts.s; o.max += pts.m; };
  const perItem = items.map(it => {
    const p = Number(it.points) || 0; max += p;
    let status, s = 0;
    if (it.choice == null) { status = 'blank'; blank++; }
    else if (it.choice === it.correct_index) { status = 'correct'; correct++; s = p; }
    else { status = 'wrong'; wrong++; s = -p * negativeRatio; }
    score += s;
    for (const g of Object.keys(groups)) bump(g, String(it.meta?.[g] ?? ''), status, { s, m: p });
    return { ...it, status, earned: s };
  });
  if (floorZero && score < 0) score = 0;
  const pct = o => (o.max ? Math.round((o.score / o.max) * 10000) / 100 : 0);
  for (const g of Object.values(groups)) for (const o of Object.values(g)) o.percent = pct(o);
  return { score: Math.round(score * 1000) / 1000, max, percent: max ? Math.round((score / max) * 10000) / 100 : 0, correct, wrong, blank, breakdown: groups, perItem };
}

export async function gradeAttempt(db, attemptId) {
  const a = await db.get('SELECT * FROM attempts WHERE id = ?', [attemptId]);
  const exam = await db.get('SELECT points_per_question, negative_ratio, floor_zero FROM exams WHERE id = ?', [a.exam_id]);
  const rows = await db.all(`SELECT eq.id AS eqid, eq.points, v.correct_index, v.subject, v.chapter, v.topic, v.difficulty, ans.choice
    FROM exam_questions eq JOIN question_versions v ON v.id = eq.question_version_id
    LEFT JOIN attempt_answers ans ON ans.exam_question_id = eq.id AND ans.attempt_id = ? WHERE eq.exam_id = ?`, [attemptId, a.exam_id]);
  const items = rows.map(r => ({ eqid: r.eqid, points: r.points ?? exam.points_per_question, choice: r.choice ?? null, correct_index: r.correct_index, meta: { subject: r.subject, chapter: r.chapter, topic: r.topic, difficulty: r.difficulty } }));
  const res = computeScore({ items, negativeRatio: exam.negative_ratio, floorZero: !!exam.floor_zero });
  await db.tx(async () => {
    for (const it of res.perItem) {
      await db.run(`INSERT INTO attempt_answers(attempt_id, exam_question_id, choice, flagged, seq, server_ts, is_correct) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(attempt_id, exam_question_id) DO UPDATE SET is_correct = excluded.is_correct`, [attemptId, it.eqid, null, 0, 0, Date.now(), it.status === 'correct' ? 1 : it.status === 'wrong' ? 0 : null]);
    }
    const spent = (a.submitted_at || Math.min(Date.now(), a.deadline_at)) - a.started_at;
    await db.run('UPDATE attempts SET score = ?, max_score = ?, percent = ?, correct_count = ?, wrong_count = ?, blank_count = ?, breakdown = ?, time_spent_ms = ?, graded_at = ? WHERE id = ?',
      [res.score, res.max, res.percent, res.correct, res.wrong, res.blank, JSON.stringify(res.breakdown), spent, Date.now(), attemptId]);
  });
  return res;
}
export const parseBreakdown = s => safeJson(s, {});
