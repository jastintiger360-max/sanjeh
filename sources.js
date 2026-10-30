import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256, now, bad, notFound, conflict, v } from '../http/util.js';
import { extractFile } from './extract.js';
import { chunkPages } from './chunker.js';
import { invalidateSource, loadChunks, bm25, snippet } from './retrieval.js';
import { normalize } from './textnorm.js';
import { audit } from './audit.js';

export const SOURCE_TYPES = ['textbook', 'handout', 'word', 'text', 'scan', 'other'];
export const AUTHORITIES = ['official', 'supplementary', 'personal'];
const ALLOWED_EXT = ['.pdf', '.docx', '.txt', '.md', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'];
const META = ['title', 'field', 'grade', 'subject', 'book_code', 'print_year', 'edition', 'chapter', 'lesson_no', 'source_type'];

export function createSourceService(ctx) {
  const { db, cfg } = ctx;
  const queue = []; let busy = false; const forceOcr = new Set();

  async function pump() {
    if (busy) return; busy = true;
    try { while (queue.length) await processSource(queue.shift()).catch(() => {}); } finally { busy = false; }
  }

  async function processSource(id) {
    const s = await db.get('SELECT * FROM sources WHERE id = ?', [id]);
    if (!s) return;
    await db.run("UPDATE sources SET status='processing', error=NULL, updated_at=? WHERE id=?", [now(), id]);
    try {
      const pages = await extractFile(s.file_path, { mime: s.mime, name: s.file_name, langs: cfg.ocrLangs, forceOcr: forceOcr.has(id) });
      forceOcr.delete(id);
      await db.tx(async () => {
        await db.run('DELETE FROM source_pages WHERE source_id = ?', [id]);
        for (const p of pages) await db.run('INSERT INTO source_pages(source_id, page_no, text, method, confidence, flagged, flag_reason, has_table, has_formula) VALUES (?,?,?,?,?,?,?,?,?)',
          [id, p.page_no, p.text, p.method, p.confidence, p.flagged ? 1 : 0, p.flag_reason, p.has_table ? 1 : 0, p.has_formula ? 1 : 0]);
      });
      await rechunk(id);
      if (ctx.ai?.embeddingsEnabled()) await embedSource(id).catch(e => console.warn('embedding failed', e.message));
    } catch (e) {
      await db.run("UPDATE sources SET status='failed', error=?, updated_at=? WHERE id=?", [String(e.message).slice(0, 500), now(), id]);
    }
  }

  async function rechunk(id) {
    const s = await db.get('SELECT page_offset FROM sources WHERE id = ?', [id]);
    const pages = await db.all('SELECT page_no, text, flagged FROM source_pages WHERE source_id = ? ORDER BY page_no', [id]);
    const old = await db.all('SELECT id FROM source_chunks WHERE source_id = ?', [id]);
    const chunks = chunkPages(pages, { offset: s.page_offset || 0 });
    await db.tx(async () => {
      await db.run('DELETE FROM source_chunks WHERE source_id = ?', [id]);
      for (const c of chunks) await db.run('INSERT INTO source_chunks(source_id, ord, page_start, page_end, chapter, topic, heading, text, norm_text, char_count, flagged) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [id, c.ord, c.page_start, c.page_end, c.chapter, c.topic, c.heading, c.text, c.norm_text, c.char_count, c.flagged]);
      const flaggedCount = pages.filter(p => p.flagged).length;
      await db.run("UPDATE sources SET status='ready', page_count=?, chunk_count=?, flagged_count=?, updated_at=? WHERE id=?", [pages.length, chunks.length, flaggedCount, now(), id]);
    });
    invalidateSource(old.map(o => o.id));
  }

  async function embedSource(id) {
    const chunks = await db.all('SELECT id, text FROM source_chunks WHERE source_id = ? AND embedding IS NULL ORDER BY ord', [id]);
    for (let i = 0; i < chunks.length; i += 32) {
      const batch = chunks.slice(i, i + 32);
      const vecs = await ctx.ai.embed(batch.map(c => c.text), { stage: 'embed_source' });
      for (let j = 0; j < batch.length; j++) await db.run('UPDATE source_chunks SET embedding = ? WHERE id = ?', [JSON.stringify(vecs[j]), batch[j].id]);
    }
  }

  return {
    async upload({ file, fields, user, ip }) {
      if (!file) throw bad('فایلی ارسال نشده است.');
      const ext = path.extname(file.filename).toLowerCase();
      if (!ALLOWED_EXT.includes(ext)) throw bad('نوع فایل مجاز نیست.');
      const hash = sha256(file.data);
      const dup = await db.get('SELECT id, title FROM sources WHERE sha256 = ?', [hash]);
      if (dup) throw conflict(`این فایل قبلاً با عنوان «${dup.title}» بارگذاری شده است.`, { sourceId: dup.id });
      const dir = path.join(cfg.storageDir, 'sources'); await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, hash + ext);
      await fs.writeFile(filePath, file.data, { mode: 0o600 });
      const meta = {}; for (const k of META) meta[k] = fields[k] ? String(fields[k]).trim().slice(0, 300) : null;
      if (!meta.title) meta.title = path.basename(file.filename, ext);
      meta.source_type = SOURCE_TYPES.includes(meta.source_type) ? meta.source_type : (ext === '.docx' ? 'word' : ext === '.txt' ? 'text' : 'textbook');
      const t = now();
      const id = await db.insert(`INSERT INTO sources(title, field, grade, subject, book_code, print_year, edition, chapter, lesson_no, source_type, page_from, page_to, page_offset,
         authority, validation_status, file_name, file_path, mime, sha256, size_bytes, status, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [meta.title, meta.field, meta.grade, meta.subject, meta.book_code, meta.print_year, meta.edition, meta.chapter, meta.lesson_no, meta.source_type,
          fields.page_from ? Number(fields.page_from) || null : null, fields.page_to ? Number(fields.page_to) || null : null, Number(fields.page_offset) || 0,
          // هر منبع جدید ابتدا «شخصی و تأییدنشده» است؛ رسمی‌شدن فقط پس از بررسی
          'personal', 'unverified', file.filename.slice(0, 250), filePath, file.type || null, hash, file.data.length, 'uploaded', user.id, t, t]);
      await audit(db, { userId: user.id, action: 'source.upload', entity: 'source', entityId: id, details: { file: file.filename, size: file.data.length }, ip });
      if (fields.force_ocr === '1' || fields.force_ocr === 'true') forceOcr.add(id);
      queue.push(id); pump();
      return id;
    },
    reprocess(id, { ocr = false } = {}) { if (ocr) forceOcr.add(id); queue.push(id); pump(); },
    async waitIdle() { while (busy || queue.length) await new Promise(r => setTimeout(r, 50)); },
    async list() {
      return db.all(`SELECT id, title, field, grade, subject, book_code, print_year, edition, chapter, lesson_no, page_from, page_to, page_offset, source_type, authority,
        validation_status, file_name, size_bytes, status, error, page_count, chunk_count, flagged_count, created_at, updated_at FROM sources ORDER BY created_at DESC`);
    },
    async get(id) {
      const s = await db.get(`SELECT id, title, field, grade, subject, book_code, print_year, edition, chapter, lesson_no, page_from, page_to, page_offset, source_type, authority,
        validation_status, file_name, mime, size_bytes, status, error, page_count, chunk_count, flagged_count, created_at, updated_at FROM sources WHERE id = ?`, [id]);
      if (!s) throw notFound('منبع یافت نشد.');
      s.flagged_pages = await db.all('SELECT page_no, flag_reason, method, confidence FROM source_pages WHERE source_id = ? AND flagged = 1 ORDER BY page_no', [id]);
      s.structure = await db.all('SELECT chapter, topic, MIN(page_start) AS page_start, MAX(page_end) AS page_end, COUNT(*) AS chunks FROM source_chunks WHERE source_id = ? GROUP BY chapter, topic ORDER BY MIN(ord)', [id]);
      return s;
    },
    async update(id, body, user, ip) {
      const s = await db.get('SELECT * FROM sources WHERE id = ?', [id]);
      if (!s) throw notFound('منبع یافت نشد.');
      const sets = []; const params = [];
      for (const k of META) if (k in body) { sets.push(`${k} = ?`); params.push(k === 'title' ? v.str(body[k], 'نام منبع', { min: 1, max: 300 }) : (body[k] == null || body[k] === '' ? null : String(body[k]).slice(0, 300))); }
      for (const k of ['page_from', 'page_to']) if (k in body) { sets.push(`${k} = ?`); params.push(v.int(body[k], 'بازه صفحات', { min: 0, max: 100000, optional: true })); }
      let rechunkNeeded = false;
      if ('page_offset' in body) { sets.push('page_offset = ?'); params.push(v.int(body.page_offset, 'اختلاف شماره صفحه', { min: -1000, max: 1000 })); rechunkNeeded = true; }
      const validation = 'validation_status' in body ? v.oneOf(body.validation_status, 'وضعیت اعتبارسنجی', ['unverified', 'verified', 'rejected']) : s.validation_status;
      const authority = 'authority' in body ? v.oneOf(body.authority, 'نوع اعتبار', AUTHORITIES) : s.authority;
      if (authority === 'official' && validation !== 'verified') throw bad('منبع فقط پس از تأیید اعتبار می‌تواند «رسمی» باشد.');
      if (validation === 'verified' && s.status !== 'ready') throw bad('منبع هنوز پردازش نشده است.');
      if (validation === 'verified' && s.flagged_count > 0 && !body.acknowledge_flags) throw bad(`این منبع ${s.flagged_count} صفحه علامت‌خورده دارد؛ برای تأیید، بررسی صفحات را تأیید کنید.`, { code: 'FLAGS' });
      sets.push('validation_status = ?', 'authority = ?', 'updated_at = ?'); params.push(validation, authority, now());
      await db.run(`UPDATE sources SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
      await audit(db, { userId: user.id, action: 'source.update', entity: 'source', entityId: id, details: { validation, authority }, ip });
      if (rechunkNeeded && s.status === 'ready') await rechunk(id);
      return this.get(id);
    },
    async pages(id, { from = 1, to = 20 } = {}) {
      return db.all('SELECT page_no, text, method, confidence, flagged, flag_reason, has_table, has_formula FROM source_pages WHERE source_id = ? AND page_no BETWEEN ? AND ? ORDER BY page_no', [id, from, to]);
    },
    async updatePage(id, pageNo, { text, flagged }, user, ip) {
      const p = await db.get('SELECT id FROM source_pages WHERE source_id = ? AND page_no = ?', [id, pageNo]);
      if (!p) throw notFound('صفحه یافت نشد.');
      await db.run('UPDATE source_pages SET text = COALESCE(?, text), flagged = ?, flag_reason = CASE WHEN ? = 0 THEN NULL ELSE flag_reason END, method = CASE WHEN ? IS NULL THEN method ELSE ? END WHERE id = ?',
        [text ?? null, flagged ? 1 : 0, flagged ? 1 : 0, text ?? null, 'manual', p.id]);
      await audit(db, { userId: user.id, action: 'source.page_edit', entity: 'source', entityId: id, details: { pageNo, flagged: !!flagged, edited: text != null }, ip });
      await rechunk(id);
    },
    async setStructure(id, ranges, user, ip) {
      // ranges: [{page_from, page_to, chapter, topic}]  — شماره صفحات چاپی
      if (!Array.isArray(ranges)) throw bad('ساختار نامعتبر است.');
      await db.tx(async () => {
        for (const r of ranges) {
          const a = v.int(r.page_from, 'از صفحه', { min: -1000 }), b = v.int(r.page_to, 'تا صفحه', { min: a });
          await db.run('UPDATE source_chunks SET chapter = COALESCE(?, chapter), topic = COALESCE(?, topic) WHERE source_id = ? AND page_start >= ? AND page_end <= ?',
            [r.chapter || null, r.topic || null, id, a, b]);
        }
      });
      await audit(db, { userId: user.id, action: 'source.structure', entity: 'source', entityId: id, details: { ranges: ranges.length }, ip });
    },
    async remove(id, user, ip) {
      const used = await db.get("SELECT COUNT(*) AS n FROM question_versions WHERE source_refs LIKE ?", [`%"source_id":${id},%`]);
      if (used.n) throw conflict('این منبع در سؤال‌ها استفاده شده و قابل حذف نیست؛ می‌توانید آن را «ردشده» علامت بزنید.');
      const s = await db.get('SELECT file_path FROM sources WHERE id = ?', [id]); if (!s) throw notFound();
      await db.run('DELETE FROM sources WHERE id = ?', [id]);
      await fs.rm(s.file_path, { force: true });
      invalidateSource();
      await audit(db, { userId: user.id, action: 'source.delete', entity: 'source', entityId: id, ip });
    },
    async search({ q, sourceIds, chapter, pageFrom, pageTo, limit = 30 }) {
      const chunks = await loadChunks(db, { sourceIds, chapters: chapter ? [chapter] : null, pageFrom, pageTo, includeFlagged: true, onlyUsable: false });
      let res;
      if (q) {
        const nq = normalize(q);
        res = bm25(chunks, q).filter(r => r.score > 0 || r.chunk.norm_text.includes(nq)).sort((a, b) => b.score - a.score);
      } else res = chunks.map(c => ({ chunk: c, score: 0 }));
      return res.slice(0, limit).map(r => ({ chunk_id: r.chunk.id, source_id: r.chunk.source_id, source_title: r.chunk.source_title, page_start: r.chunk.page_start, page_end: r.chunk.page_end,
        chapter: r.chunk.chapter, topic: r.chunk.topic, flagged: !!r.chunk.flagged, score: Math.round(r.score * 100) / 100, snippet: snippet(r.chunk.text, q) }));
    },
    async chunk(id) { return db.get('SELECT c.id, c.source_id, s.title AS source_title, c.page_start, c.page_end, c.chapter, c.topic, c.heading, c.text, c.flagged FROM source_chunks c JOIN sources s ON s.id=c.source_id WHERE c.id = ?', [id]); },
  };
}
