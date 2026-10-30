// سؤال‌ها با نسخه‌های تغییرناپذیر. بانک نهایی = سؤال‌هایی که نسخه تأییدشده مدیر دارند.
import crypto from 'node:crypto';
import { now, bad, notFound, conflict, safeJson, v } from '../http/util.js';
import { runChecks, sanitizeQuestion } from '../ai/checks.js';
import { similarity, normalize } from './textnorm.js';
import { COGNITIVE, QTYPES } from '../ai/prompts.js';
import { audit } from './audit.js';

export const STATUSES = ['generating', 'pending_review', 'needs_revision', 'approved', 'rejected', 'archived'];

export function parseVersion(r) {
  if (!r) return r;
  return { ...r, options: safeJson(r.options, []), statements: safeJson(r.statements), table_data: safeJson(r.table_data), source_refs: safeJson(r.source_refs, []), quality: safeJson(r.quality) };
}
const uid = () => 'Q-' + crypto.randomBytes(4).toString('hex').toUpperCase();

export function createQuestionService(ctx) {
  const { db, settings } = ctx;

  async function event(qid, userId, ev, from, to, note) {
    await db.run('INSERT INTO question_events(question_id, user_id, event, from_status, to_status, note, created_at) VALUES (?,?,?,?,?,?,?)', [qid, userId, ev, from, to, note || null, now()]);
  }
  async function bankSignatures(excludeId = null) {
    const rows = await db.all(`SELECT q.id AS question_id, v.stem, v.options, v.correct_index FROM questions q JOIN question_versions v ON v.id = q.current_version_id
      WHERE q.status NOT IN ('rejected','generating') ${excludeId ? 'AND q.id <> ?' : ''}`, excludeId ? [excludeId] : []);
    return rows.map(r => ({ question_id: r.question_id, sig: r.stem + ' ' + (safeJson(r.options, [])[r.correct_index]?.text || '') }));
  }

  async function insertVersion(qid, data, { origin, userId, note, quality = null, qualityScore = null }) {
    const last = await db.get('SELECT MAX(version_no) AS n FROM question_versions WHERE question_id = ?', [qid]);
    const vid = await db.insert(`INSERT INTO question_versions(question_id, version_no, origin, qtype, stem, passage, statements, table_data, image_path, options, correct_index, explanation,
      field, grade, subject, chapter, topic, difficulty, cognitive_level, source_refs, quality, quality_score, change_note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [qid, (last?.n || 0) + 1, origin, data.qtype, data.stem, data.passage || null, data.statements ? JSON.stringify(data.statements) : null, data.table ? JSON.stringify(data.table) : null,
        data.image_path || null, JSON.stringify(data.options.map(o => ({ text: o.text, rationale: o.rationale || '' }))), data.correct_index, data.explanation,
        data.field || null, data.grade || null, data.subject || null, data.chapter || null, data.topic || null, data.difficulty, data.cognitive_level,
        JSON.stringify(data.source_refs || []), quality ? JSON.stringify(quality) : null, qualityScore, note || null, userId, now()]);
    await db.run('UPDATE questions SET current_version_id = ?, updated_at = ? WHERE id = ?', [vid, now(), qid]);
    return vid;
  }

  function validateManual(body) {
    const q = sanitizeQuestion(body);
    v.oneOf(q.qtype, 'نوع سؤال', Object.keys(QTYPES));
    v.str(q.stem, 'صورت سؤال', { min: 5, max: 5000 });
    if (q.options.length !== 4 || q.options.some(o => !o.text)) throw bad('سؤال باید دقیقاً چهار گزینه غیرخالی داشته باشد.');
    v.int(q.correct_index, 'پاسخ صحیح', { min: 0, max: 3 });
    v.str(q.explanation, 'پاسخ تشریحی', { min: 5, max: 10000 });
    v.int(q.difficulty, 'سطح دشواری', { min: 1, max: 4 });
    v.oneOf(q.cognitive_level, 'سطح شناختی', Object.keys(COGNITIVE));
    return q;
  }

  async function recheck(q, sourceRefs, excludeId) {
    // اجرای مجدد آزمون‌های قطعی پس از ویرایش دستی (بدون هزینه هوش مصنوعی)
    const ids = [...new Set(sourceRefs.map(r => r.chunk_id).filter(Boolean))];
    const chunks = ids.length ? await db.all(`SELECT id, source_id, page_start, page_end, text FROM source_chunks WHERE id IN (${ids.map(() => '?').join(',')})`, ids) : [];
    const evidenceById = new Map(chunks.map(c => [c.id, c]));
    const r = runChecks({ ...q, evidence: sourceRefs.map(s => ({ chunk_id: s.chunk_id, quote: s.quote })) }, { evidenceById, bank: await bankSignatures(excludeId), dupThreshold: await settings.get('duplicate_threshold') });
    return r;
  }

  const svc = {
    STATUSES, insertVersion, bankSignatures, event,

    async createGenerated({ jobId, userId, data, refs, quality, qualityScore, status, meta }) {
      return db.tx(async () => {
        const t = now();
        const qid = await db.insert('INSERT INTO questions(uid, status, job_id, created_by, created_at, updated_at, variant_of, tags) VALUES (?,?,?,?,?,?,?,?)', [uid(), status, jobId, userId, t, t, meta.variantOf || null, '[]']);
        await insertVersion(qid, { ...data, ...meta, source_refs: refs }, { origin: meta.variantOf ? 'variant' : 'ai', userId, quality, qualityScore });
        await event(qid, userId, 'generated', null, status, `job ${jobId}`);
        return qid;
      });
    },

    async createManual(body, user, ip) {
      const q = validateManual(body);
      const refs = Array.isArray(body.source_refs) ? body.source_refs : [];
      const r = await recheck(q, refs, null);
      return db.tx(async () => {
        const t = now();
        const qid = await db.insert('INSERT INTO questions(uid, status, created_by, created_at, updated_at, tags) VALUES (?,?,?,?,?,?)', [uid(), 'pending_review', user.id, t, t, '[]']);
        await insertVersion(qid, { ...q, field: body.field, grade: body.grade, subject: body.subject, source_refs: refs }, { origin: 'manual', userId: user.id, quality: { checks: r.checks, maxSimilarity: r.maxSimilarity, similarTo: r.similarTo, manual: true } });
        await event(qid, user.id, 'created', null, 'pending_review');
        await audit(db, { userId: user.id, action: 'question.create', entity: 'question', entityId: qid, ip });
        return qid;
      });
    },

    async list(f = {}) {
      const where = []; const p = [];
      const bank = f.scope === 'bank';
      const vcol = bank ? 'q.approved_version_id' : 'q.current_version_id';
      if (bank) where.push("q.approved_version_id IS NOT NULL AND q.status NOT IN ('archived','rejected')");
      else if (f.status) { const sts = String(f.status).split(',').filter(s => STATUSES.includes(s)); if (sts.length) { where.push(`q.status IN (${sts.map(() => '?').join(',')})`); p.push(...sts); } }
      else where.push("q.status <> 'archived'");
      for (const k of ['field', 'grade', 'subject', 'chapter', 'topic', 'qtype', 'cognitive_level']) if (f[k]) { where.push(`v.${k} = ?`); p.push(f[k]); }
      if (f.difficulty) { const ds = String(f.difficulty).split(',').map(Number).filter(n => n >= 1 && n <= 4); if (ds.length) { where.push(`v.difficulty IN (${ds.map(() => '?').join(',')})`); p.push(...ds); } }
      if (f.source_id) { where.push('v.source_refs LIKE ?'); p.push(`%"source_id":${Number(f.source_id)},%`); }
      if (f.tag) { where.push('q.tags LIKE ?'); p.push(`%${JSON.stringify(String(f.tag))}%`); }
      if (f.job_id) { where.push('q.job_id = ?'); p.push(Number(f.job_id)); }
      if (f.unused === '1') where.push('NOT EXISTS (SELECT 1 FROM exam_questions eq WHERE eq.question_id = q.id)');
      const sort = { new: 'q.created_at DESC', old: 'q.created_at ASC', updated: 'q.updated_at DESC', quality: 'v.quality_score DESC', difficulty: 'v.difficulty ASC', difficulty_desc: 'v.difficulty DESC' }[f.sort] || 'q.updated_at DESC';
      let rows = await db.all(`SELECT q.id, q.uid, q.status, q.tags, q.current_version_id, q.approved_version_id, q.variant_of, q.created_at, q.updated_at, q.approved_at,
          v.id AS version_id, v.version_no, v.qtype, v.stem, v.options, v.correct_index, v.difficulty, v.cognitive_level, v.field, v.grade, v.subject, v.chapter, v.topic, v.quality_score, v.source_refs,
          (SELECT COUNT(*) FROM exam_questions eq WHERE eq.question_id = q.id) AS used_count
        FROM questions q JOIN question_versions v ON v.id = ${vcol} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${sort}`, p);
      if (f.q) { const n = normalize(f.q); rows = rows.filter(r => normalize(r.stem + ' ' + r.options + ' ' + r.uid).includes(n)); }
      const total = rows.length;
      const limit = Math.min(Number(f.limit) || 50, 500), offset = Number(f.offset) || 0;
      return { total, items: rows.slice(offset, offset + limit).map(r => ({ ...r, tags: safeJson(r.tags, []), options: safeJson(r.options, []), source_refs: safeJson(r.source_refs, []), has_pending_edit: r.approved_version_id && r.current_version_id !== r.approved_version_id })) };
    },

    async get(id) {
      const q = await db.get('SELECT * FROM questions WHERE id = ?', [id]);
      if (!q) throw notFound('سؤال یافت نشد.');
      q.tags = safeJson(q.tags, []);
      q.versions = (await db.all('SELECT * FROM question_versions WHERE question_id = ? ORDER BY version_no DESC', [id])).map(parseVersion);
      q.current = q.versions.find(x => x.id === q.current_version_id) || null;
      q.events = await db.all('SELECT e.*, u.full_name FROM question_events e LEFT JOIN users u ON u.id = e.user_id WHERE question_id = ? ORDER BY e.created_at DESC', [id]);
      q.usage = await db.all('SELECT e.id AS exam_id, e.title, e.status, e.start_at, eq.question_version_id FROM exam_questions eq JOIN exams e ON e.id = eq.exam_id WHERE eq.question_id = ? ORDER BY e.start_at DESC', [id]);
      q.variants = await db.all('SELECT id, uid, status FROM questions WHERE variant_of = ?', [id]);
      return q;
    },

    async edit(id, body, user, ip) {
      const q = await db.get('SELECT * FROM questions WHERE id = ?', [id]);
      if (!q) throw notFound('سؤال یافت نشد.');
      if (['generating', 'archived'].includes(q.status)) throw conflict('این سؤال در وضعیت فعلی قابل ویرایش نیست.');
      const cur = parseVersion(await db.get('SELECT * FROM question_versions WHERE id = ?', [q.current_version_id]));
      const data = validateManual({ ...cur, table: cur.table_data, ...body, options: body.options ?? cur.options, evidence: [] });
      const refs = Array.isArray(body.source_refs) ? body.source_refs : cur.source_refs;
      const r = await recheck(data, refs, id);
      const quality = { ...(cur.quality || {}), checks: r.checks, maxSimilarity: r.maxSimilarity, similarTo: r.similarTo, ai_review_of_version: cur.quality?.ai_review_of_version ?? cur.version_no, rechecked_at: now() };
      return db.tx(async () => {
        const vid = await insertVersion(id, { ...data, field: body.field ?? cur.field, grade: body.grade ?? cur.grade, subject: body.subject ?? cur.subject, chapter: body.chapter ?? cur.chapter, topic: body.topic ?? cur.topic, image_path: cur.image_path, source_refs: refs },
          { origin: 'edit', userId: user.id, note: body.change_note || null, quality, qualityScore: cur.quality_score });
        const to = q.status === 'rejected' ? 'pending_review' : (q.status === 'approved' ? 'pending_review' : q.status === 'needs_revision' ? 'pending_review' : q.status);
        await db.run('UPDATE questions SET status = ?, updated_at = ? WHERE id = ?', [to, now(), id]);
        await event(id, user.id, 'edited', q.status, to, body.change_note);
        await audit(db, { userId: user.id, action: 'question.edit', entity: 'question', entityId: id, details: { version: vid }, ip });
        return vid;
      });
    },

    async approve(ids, user, ip, { override = false, note } = {}) {
      const results = [];
      await db.tx(async () => {
        for (const id of ids) {
          const q = await db.get('SELECT q.id, q.status, q.current_version_id, v.quality FROM questions q LEFT JOIN question_versions v ON v.id = q.current_version_id WHERE q.id = ?', [id]);
          if (!q) { results.push({ id, ok: false, error: 'یافت نشد' }); continue; }
          if (!['pending_review', 'needs_revision'].includes(q.status)) { results.push({ id, ok: false, error: 'وضعیت سؤال قابل تأیید نیست' }); continue; }
          const blockers = (safeJson(q.quality, {})?.checks || []).filter(c => !c.ok && c.severity === 'blocker');
          if ((q.status === 'needs_revision' || blockers.length) && !override) { results.push({ id, ok: false, error: 'سؤال ایراد مسدودکننده دارد؛ ابتدا اصلاح کنید یا تأیید آگاهانه بدهید.' }); continue; }
          await db.run("UPDATE questions SET status = 'approved', approved_version_id = current_version_id, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?", [user.id, now(), now(), id]);
          await event(id, user.id, override && (q.status === 'needs_revision' || blockers.length) ? 'approved_override' : 'approved', q.status, 'approved', note);
          results.push({ id, ok: true });
        }
      });
      await audit(db, { userId: user.id, action: 'question.approve', entity: 'question', details: { ids, override }, ip });
      return results;
    },

    async reject(id, reason, user, ip) {
      const q = await db.get('SELECT * FROM questions WHERE id = ?', [id]);
      if (!q) throw notFound();
      if (!['pending_review', 'needs_revision'].includes(q.status)) throw conflict('فقط سؤال در انتظار بررسی قابل رد است.');
      if (q.approved_version_id) {
        // رد ویرایش جدید یک سؤال تأییدشده: بازگشت به نسخه تأییدشده
        await db.run("UPDATE questions SET status = 'approved', current_version_id = approved_version_id, updated_at = ? WHERE id = ?", [now(), id]);
        await event(id, user.id, 'edit_rejected', q.status, 'approved', reason);
      } else {
        await db.run("UPDATE questions SET status = 'rejected', reject_reason = ?, updated_at = ? WHERE id = ?", [reason || null, now(), id]);
        await event(id, user.id, 'rejected', q.status, 'rejected', reason);
      }
      await audit(db, { userId: user.id, action: 'question.reject', entity: 'question', entityId: id, ip });
    },

    async setArchived(id, archived, user, ip) {
      const q = await db.get('SELECT * FROM questions WHERE id = ?', [id]);
      if (!q) throw notFound();
      if (archived) {
        if (q.status === 'generating') throw conflict('سؤال در حال تولید است.');
        await db.run("UPDATE questions SET status = 'archived', updated_at = ? WHERE id = ?", [now(), id]);
        await event(id, user.id, 'archived', q.status, 'archived');
      } else {
        if (q.status !== 'archived') throw conflict('سؤال آرشیو نشده است.');
        const to = q.approved_version_id && q.approved_version_id === q.current_version_id ? 'approved' : 'pending_review';
        await db.run('UPDATE questions SET status = ?, updated_at = ? WHERE id = ?', [to, now(), id]);
        await event(id, user.id, 'unarchived', 'archived', to);
      }
      await audit(db, { userId: user.id, action: archived ? 'question.archive' : 'question.unarchive', entity: 'question', entityId: id, ip });
    },

    async setTags(id, tags, user) {
      const clean = [...new Set((Array.isArray(tags) ? tags : []).map(t => String(t).trim().slice(0, 40)).filter(Boolean))].slice(0, 30);
      const r = await db.run('UPDATE questions SET tags = ?, updated_at = ? WHERE id = ?', [JSON.stringify(clean), now(), id]);
      if (!r.changes) throw notFound();
      await event(id, user.id, 'tags', null, null, clean.join('، '));
      return clean;
    },

    async duplicates(threshold) {
      const th = threshold || await settings.get('duplicate_threshold');
      const sigs = await bankSignatures();
      const pairs = [];
      for (let i = 0; i < sigs.length; i++) for (let j = i + 1; j < sigs.length; j++) {
        const s = similarity(sigs[i].sig, sigs[j].sig);
        if (s >= th * 0.85) pairs.push({ a: sigs[i].question_id, b: sigs[j].question_id, similarity: Math.round(s * 100) / 100 });
      }
      return pairs.sort((x, y) => y.similarity - x.similarity).slice(0, 200);
    },

    async version(versionId) { return parseVersion(await db.get('SELECT * FROM question_versions WHERE id = ?', [versionId])); },
  };
  return svc;
}
