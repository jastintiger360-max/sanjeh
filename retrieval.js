// بازیابی بخش‌های مرتبط منابع: BM25 (همیشه) + embedding (اختیاری)
import { tokens, normalize } from './textnorm.js';

const tokCache = new Map(); // chunkId -> tokens
export function invalidateSource(chunkIds = null) { if (!chunkIds) tokCache.clear(); else for (const id of chunkIds) tokCache.delete(id); }
function toks(c) { let t = tokCache.get(c.id); if (!t) { t = tokens(c.text); tokCache.set(c.id, t); } return t; }

export async function loadChunks(db, { sourceIds, chapters, topics, pageFrom, pageTo, includeFlagged = false, onlyUsable = true }) {
  const where = []; const params = [];
  if (sourceIds?.length) { where.push(`c.source_id IN (${sourceIds.map(() => '?').join(',')})`); params.push(...sourceIds); }
  if (onlyUsable) where.push("s.status = 'ready' AND s.validation_status <> 'rejected'");
  if (!includeFlagged) where.push('c.flagged = 0');
  if (pageFrom != null) { where.push('c.page_end >= ?'); params.push(pageFrom); }
  if (pageTo != null) { where.push('c.page_start <= ?'); params.push(pageTo); }
  const rows = await db.all(`SELECT c.id, c.source_id, c.ord, c.page_start, c.page_end, c.chapter, c.topic, c.heading, c.text, c.norm_text, c.flagged, c.embedding,
      s.title AS source_title, s.authority FROM source_chunks c JOIN sources s ON s.id = c.source_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.source_id, c.ord`, params);
  const match = (val, list) => !list?.length || list.some(x => normalize(val || '').includes(normalize(x)));
  return rows.filter(r => match(r.chapter, chapters) && (match(r.topic, topics) || match(r.heading, topics) || (topics?.length && topics.some(t => r.norm_text.includes(normalize(t))))));
}

export function bm25(chunks, query, { k1 = 1.4, b = 0.75 } = {}) {
  const q = [...new Set(tokens(query))];
  if (!q.length || !chunks.length) return chunks.map(c => ({ chunk: c, score: 0 }));
  const N = chunks.length; const df = new Map(); let total = 0;
  const tfs = chunks.map(c => { const t = toks(c); total += t.length; const tf = new Map(); for (const w of t) tf.set(w, (tf.get(w) || 0) + 1); for (const w of new Set(t)) df.set(w, (df.get(w) || 0) + 1); return { tf, len: t.length }; });
  const avg = total / N || 1;
  return chunks.map((c, i) => {
    let s = 0; const { tf, len } = tfs[i];
    for (const w of q) {
      const f = tf.get(w); if (!f) continue;
      const n = df.get(w); const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * len / avg));
    }
    // تطابق عبارت دقیق امتیاز اضافه دارد
    const phrase = normalize(query);
    if (phrase.length > 4 && c.norm_text.includes(phrase)) s += 3;
    return { chunk: c, score: s };
  });
}

const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / (Math.sqrt(x * y) || 1); };

export async function retrieve(db, ai, filters, query, { topK = 8, maxChars = 14000, offset = 0 } = {}) {
  const chunks = await loadChunks(db, filters);
  let scored = bm25(chunks, query || '');
  if (query && ai?.embeddingsEnabled() && chunks.some(c => c.embedding)) {
    try {
      const [qv] = await ai.embed([query], { stage: 'embed_query' });
      const maxB = Math.max(...scored.map(s => s.score), 1e-9);
      scored = scored.map(s => { const e = s.chunk.embedding ? JSON.parse(s.chunk.embedding) : null; return { ...s, score: 0.5 * (s.score / maxB) + 0.5 * (e ? cosine(qv, e) : 0) }; });
    } catch { /* در صورت خطا فقط BM25 */ }
  }
  let ranked;
  // فیلترها (منبع/فصل/صفحه) محدوده مجاز را تعیین می‌کنند؛ عبارت جست‌وجو فقط ترتیب اهمیت را مشخص می‌کند
  if (query && scored.some(s => s.score > 0)) ranked = [...scored].sort((a, b) => b.score - a.score);
  else {
    // بدون عبارت جست‌وجو: پوشش یکنواخت بازه انتخاب‌شده (با چرخش برای تنوع)
    ranked = scored.map(s => ({ ...s, score: 0 }));
    if (ranked.length) { const o = offset % ranked.length; ranked = ranked.slice(o).concat(ranked.slice(0, o)); }
  }
  const out = []; let chars = 0;
  for (const r of ranked) { if (out.length >= topK || chars + r.chunk.text.length > maxChars) break; out.push(r); chars += r.chunk.text.length; }
  return { results: out, totalCandidates: chunks.length, totalChars: chars };
}

export function snippet(text, query, len = 220) {
  const n = text; const q = (query || '').trim();
  let i = q ? n.indexOf(q) : -1;
  if (i < 0 && q) { const t = q.split(/\s+/)[0]; i = n.indexOf(t); }
  if (i < 0) return n.slice(0, len);
  const s = Math.max(0, i - len / 2);
  return (s > 0 ? '…' : '') + n.slice(s, s + len) + (s + len < n.length ? '…' : '');
}
