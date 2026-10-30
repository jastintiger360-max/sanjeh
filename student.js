import fs from 'node:fs/promises';
import { readJson, sendJson, notFound, safeJson, v } from '../http/util.js';
import { requireRole } from '../auth/sessions.js';

export function studentRoutes(r, ctx) {
  const { attempts, db } = ctx;
  const S = requireRole('student');
  r.get('/api/student/exams', S, async (req, res) => sendJson(res, 200, await attempts.listForStudent(req.session.user)));
  r.post('/api/student/exams/:id/start', S, async (req, res) => {
    const id = await attempts.start(v.int(req.params.id, 'آزمون', { min: 1 }), req.session.user, req.ip);
    sendJson(res, 200, { attempt_id: id });
  });
  r.get('/api/student/attempts/:id', S, async (req, res) => sendJson(res, 200, await attempts.view(v.int(req.params.id, 'id', { min: 1 }), req.session.user)));
  r.put('/api/student/attempts/:id/answers', S, async (req, res) => {
    const body = await readJson(req, 200_000);
    sendJson(res, 200, await attempts.save(v.int(req.params.id, 'id', { min: 1 }), req.session.user, body.answers));
  });
  r.post('/api/student/attempts/:id/submit', S, async (req, res) => {
    const body = await readJson(req, 200_000).catch(() => ({}));
    const id = v.int(req.params.id, 'id', { min: 1 });
    if (Array.isArray(body.answers) && body.answers.length) await attempts.save(id, req.session.user, body.answers).catch(() => {});
    sendJson(res, 200, await attempts.submit(id, req.session.user, req.ip));
  });
  r.get('/api/student/exams/:id/result', S, async (req, res) => sendJson(res, 200, await attempts.result(v.int(req.params.id, 'id', { min: 1 }), req.session.user)));
  r.get('/api/student/attempts/:id/image/:eqid', S, async (req, res) => {
    const a = await attempts.ownAttempt(v.int(req.params.id, 'id', { min: 1 }), req.session.user);
    const eqid = v.int(req.params.eqid, 'eqid', { min: 1 });
    if (!safeJson(a.question_order, []).includes(eqid)) throw notFound();
    const row = await db.get('SELECT v.image_path FROM exam_questions eq JOIN question_versions v ON v.id = eq.question_version_id WHERE eq.id = ?', [eqid]);
    if (!row?.image_path) throw notFound();
    const data = await fs.readFile(row.image_path);
    res.writeHead(200, { 'Content-Type': row.image_path.endsWith('.png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'private, max-age=600' });
    res.end(data);
  });
}
