// موتور تولید سؤال: بازیابی شواهد ← طراح ← آزمون‌های قطعی ← منتقد مستقل ← حل‌کننده مستقل ← جمع‌بندی نرم‌افزاری
import crypto from 'node:crypto';
import { now, bad, conflict, HttpError, v, safeJson } from '../http/util.js';
import { retrieve } from '../services/retrieval.js';
import { generatorPrompt, criticPrompt, solverPrompt, QTYPES, COGNITIVE, COMBINATION, TARGETS, OPTION_COMPLEXITY } from './prompts.js';
import { parseJsonLoose, AiUnavailableError } from './provider.js';
import { runChecks, sanitizeQuestion } from './checks.js';
import { audit } from '../services/audit.js';

export function validateParams(body, maxCount) {
  const p = {
    sourceIds: v.ids(body.source_ids || [], 'منابع'),
    chapters: (body.chapters || []).map(String).filter(Boolean).slice(0, 20),
    topics: (body.topics || []).map(String).filter(Boolean).slice(0, 20),
    pageFrom: v.int(body.page_from, 'از صفحه', { min: -1000, optional: true }),
    pageTo: v.int(body.page_to, 'تا صفحه', { min: -1000, optional: true }),
    query: v.str(body.query, 'عبارت جست‌وجو', { max: 500, optional: true }),
    count: v.int(body.count, 'تعداد سؤال', { min: 1, max: maxCount }),
    qtype: v.oneOf(body.qtype || 'mcq', 'نوع سؤال', Object.keys(QTYPES)),
    difficulty: v.int(body.difficulty, 'سطح دشواری', { min: 1, max: 4 }),
    cognitive: v.oneOf(body.cognitive_level || null, 'سطح شناختی', Object.keys(COGNITIVE), { optional: true }),
    combination: v.oneOf(body.combination || 'single', 'ترکیبی‌بودن', Object.keys(COMBINATION)),
    target: v.oneOf(body.target || 'konkur', 'آزمون هدف', Object.keys(TARGETS)),
    optionComplexity: v.oneOf(body.option_complexity || 'standard', 'پیچیدگی گزینه‌ها', Object.keys(OPTION_COMPLEXITY)),
    style: v.str(body.style, 'سبک طراحی', { max: 500, optional: true }),
    field: v.str(body.field, 'رشته', { max: 100, optional: true }),
    grade: v.str(body.grade, 'پایه', { max: 100, optional: true }),
    subject: v.str(body.subject, 'درس', { max: 100, optional: true }),
    allowExternal: v.bool(body.allow_external),
    includeFlagged: v.bool(body.include_flagged),
    variantOf: v.int(body.variant_of, 'سؤال مبنا', { min: 1, optional: true }),
  };
  if (!p.sourceIds.length) throw bad('حداقل یک منبع انتخاب کنید.');
  if (p.pageFrom != null && p.pageTo != null && p.pageTo < p.pageFrom) throw bad('بازه صفحات نامعتبر است.');
  if (p.combination === 'cross' && p.chapters.length + p.topics.length < 2) throw bad('برای ترکیب چند مبحث، حداقل دو فصل یا مبحث انتخاب کنید.');
  return p;
}

function shuffleOrder(seed) {
  const order = [0, 1, 2, 3];
  const h = crypto.createHash('sha256').update(String(seed)).digest();
  for (let i = 3; i > 0; i--) { const j = h[i] % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  return order;
}

export function aggregate({ q, checks, critic, solver, solverOrder, requested, maxSimilarity }) {
  const issues = [];
  const failed = checks.filter(c => !c.ok);
  for (const c of failed) issues.push({ severity: c.severity, source: 'software', text: c.text });
  let solverAgrees = null;
  if (solver) {
    const picked = Number(solver.answer) - 1;
    const mapped = picked >= 0 && picked < 4 ? solverOrder[picked] : -1;
    solverAgrees = mapped === q.correct_index;
    if (!solverAgrees) issues.push({ severity: 'blocker', source: 'solver', text: `حل‌کننده مستقل گزینه ${mapped + 1} را انتخاب کرد، نه گزینه ${q.correct_index + 1}.` });
    if (solver.multiple_correct) issues.push({ severity: 'blocker', source: 'solver', text: 'حل‌کننده مستقل بیش از یک گزینه را قابل دفاع دانست.' });
    if (solver.ambiguous) issues.push({ severity: 'major', source: 'solver', text: 'حل‌کننده مستقل صورت سؤال را مبهم دانست.' });
    if (solver.insufficient_evidence) issues.push({ severity: 'blocker', source: 'solver', text: 'حل‌کننده مستقل شواهد را برای پاسخ قطعی کافی ندانست.' });
    const debatable = (solver.options || []).filter(o => o.verdict === 'debatable').map(o => solverOrder[Number(o.label) - 1] + 1);
    if (debatable.length) issues.push({ severity: 'major', source: 'solver', text: `گزینه(های) ${debatable.join('، ')} از نظر حل‌کننده قابل بحث است.` });
  } else issues.push({ severity: 'major', source: 'system', text: 'ارزیابی حل‌کننده مستقل انجام نشد.' });
  if (critic) {
    for (const i of critic.issues || []) issues.push({ severity: ['blocker', 'major', 'minor'].includes(i.severity) ? i.severity : 'minor', source: 'critic', text: `${i.criterion ? i.criterion + ': ' : ''}${i.text}` });
    if (critic.verdict === 'reject') issues.push({ severity: 'blocker', source: 'critic', text: 'منتقد سؤال را ردکردنی دانست.' });
    if (Number(critic.estimated_difficulty) && Math.abs(Number(critic.estimated_difficulty) - requested.difficulty) >= 2) issues.push({ severity: 'major', source: 'critic', text: `دشواری برآوردشده (${critic.estimated_difficulty}) با سطح درخواستی (${requested.difficulty}) فاصله زیادی دارد.` });
  } else issues.push({ severity: 'major', source: 'system', text: 'ارزیابی منتقد انجام نشد.' });

  const s = critic?.scores || {};
  const sc = (k) => Math.max(0, Math.min(10, Number(s[k]) || 0));
  const pen = failed.filter(c => c.id.startsWith('cue.') || c.id.startsWith('options.')).reduce((a, c) => a + (c.severity === 'minor' ? 1 : 2), 0);
  const verified = checks.find(c => c.id === 'evidence.verified')?.ok;
  const report = {
    source_alignment: critic ? (sc('source_alignment') + (verified ? 10 : 0)) / 2 : (verified ? 5 : 0),
    answer_correctness: critic ? sc('answer_correctness') * (solverAgrees === false ? 0.3 : solverAgrees == null ? 0.7 : 1) : (solverAgrees ? 6 : 0),
    distractor_quality: Math.max(0, (critic ? sc('distractor_quality') : 5) - pen),
    clarity: Math.max(0, (critic ? sc('clarity') : 5) - (solver?.ambiguous ? 3 : 0)),
    explanation_quality: critic ? sc('explanation_quality') : 0,
    difficulty_fit: critic ? sc('difficulty_fit') : 0,
    similarity: Math.round((1 - maxSimilarity) * 100) / 10,
  };
  const W = { source_alignment: 2, answer_correctness: 3, distractor_quality: 2, clarity: 1.5, explanation_quality: 1, difficulty_fit: 1, similarity: 0.5 };
  const score = Object.entries(W).reduce((a, [k, w]) => a + report[k] * w, 0) / Object.values(W).reduce((a, b) => a + b, 0) * 10;
  const hasBlocker = issues.some(i => i.severity === 'blocker');
  const status = hasBlocker || critic?.verdict === 'reject' || critic?.verdict === 'revise' || !critic || !solver ? 'needs_revision' : 'pending_review';
  return { status, score: Math.round(score * 10) / 10, report, issues, solverAgrees };
}

export function createPipeline(ctx) {
  const { db, ai, settings, questions } = ctx;
  let running = false; let stopped = false;

  async function cancelled(jobId) { return !!(await db.get('SELECT cancel_requested FROM generation_jobs WHERE id = ?', [jobId]))?.cancel_requested; }

  async function processJob(job) {
    const p = safeJson(job.params);
    const s = await settings.all();
    await db.run("UPDATE generation_jobs SET status='running', started_at=COALESCE(started_at, ?), attempts = attempts + 1, error = NULL, model = ?, review_model = ? WHERE id = ?",
      [now(), await ai.model(), ai.reviewModel() || await ai.model(), job.id]);
    const query = [p.query, ...(p.topics || []), ...(p.chapters || [])].filter(Boolean).join(' ');
    const filters = { sourceIds: p.sourceIds, chapters: p.combination === 'cross' ? null : p.chapters, topics: p.combination === 'cross' ? null : p.topics, pageFrom: p.pageFrom, pageTo: p.pageTo, includeFlagged: p.includeFlagged };
    const pool = await retrieve(db, ai, filters, query, { topK: s.retrieval_top_k * 3, maxChars: 60000 });
    if (pool.totalChars < s.evidence_min_chars) {
      const reason = pool.totalCandidates === 0 ? 'در بازه/مبحث انتخاب‌شده هیچ بخش قابل‌استفاده‌ای در منابع یافت نشد (ممکن است صفحات علامت‌خورده باشند).' : `شواهد کافی نیست (${pool.totalChars} نویسه؛ حداقل ${s.evidence_min_chars}). بازه یا منابع را گسترش دهید.`;
      await db.run("UPDATE generation_jobs SET status='refused', refused_reason=?, finished_at=? WHERE id=?", [reason, now(), job.id]);
      return;
    }
    const base = p.variantOf ? await questions.get(p.variantOf).catch(() => null) : null;
    let produced = (await db.get('SELECT produced_count AS n FROM generation_jobs WHERE id = ?', [job.id])).n;
    let batchIdx = 0; let emptyBatches = 0;
    while (produced < p.count) {
      if (await cancelled(job.id)) break;
      const batchCount = Math.min(s.questions_per_call, p.count - produced);
      const win = s.retrieval_top_k; const start = (batchIdx * win) % Math.max(1, pool.results.length - win + 1);
      const evidence = pool.results.slice(start, start + win).map(r => r.chunk);
      const evidenceById = new Map(evidence.map(c => [c.id, c]));
      const avoid = (await db.all(`SELECT v.stem FROM questions q JOIN question_versions v ON v.id = q.current_version_id WHERE q.status <> 'rejected' AND (q.job_id = ? OR v.subject = ?) ORDER BY q.id DESC LIMIT 25`, [job.id, p.subject || '']))
        .map(r => r.stem);
      if (base) avoid.unshift(base.current.stem);
      const prompt = generatorPrompt({ ...p, batchCount }, evidence, avoid);
      if (base) prompt.user += `\n\nاین درخواست برای ساخت «نسخه متفاوت» از سؤال زیر است؛ همان هدف سنجش را با صورت و گزینه‌های متفاوت طراحی کن:\n${base.current.stem}`;
      const gen = await ai.chat({ ...prompt, temperature: 0.7, stage: 'generate', jobId: job.id, maxTokens: 2500 * batchCount + 1000 });
      let parsed;
      try { parsed = parseJsonLoose(gen.content); } catch { parsed = { questions: [] }; }
      const list = Array.isArray(parsed.questions) ? parsed.questions : [];
      if (!list.length) {
        emptyBatches++;
        if (parsed.refusal || emptyBatches >= 2) {
          const reason = parsed.refusal ? `مدل از تولید سؤال قطعی خودداری کرد: ${String(parsed.refusal).slice(0, 400)}` : 'مدل خروجی معتبر تولید نکرد.';
          await db.run(`UPDATE generation_jobs SET status = ?, refused_reason = ?, finished_at = ? WHERE id = ?`, [produced ? 'completed' : 'refused', reason, now(), job.id]);
          return;
        }
        batchIdx++; continue;
      }
      for (const raw of list.slice(0, batchCount)) {
        if (await cancelled(job.id)) break;
        const q = sanitizeQuestion(raw);
        if (![1, 2, 3, 4].includes(q.difficulty)) q.difficulty = p.difficulty;
        if (!(q.cognitive_level in COGNITIVE)) q.cognitive_level = p.cognitive || 'understand';
        const bank = await questions.bankSignatures();
        const det = runChecks(q, { evidenceById, bank, dupThreshold: s.duplicate_threshold });
        const usedEvidence = evidence.filter(c => q.evidence.some(e => e.chunk_id === c.id));
        const evForReview = usedEvidence.length ? usedEvidence : evidence;
        let critic = null, solver = null;
        const order = shuffleOrder(`${job.id}-${produced}-${q.stem}`);
        const structuralOk = det.checks.filter(c => c.id.startsWith('structure.') && c.severity === 'blocker').every(c => c.ok);
        if (structuralOk) {
          const reviewModel = ai.reviewModel() || undefined;
          try { critic = parseJsonLoose((await ai.chat({ ...criticPrompt(q, evForReview, p), temperature: 0.1, stage: 'critic', jobId: job.id, modelOverride: reviewModel, maxTokens: 2500 })).content); } catch (e) { if (e instanceof AiUnavailableError) throw e; }
          if (await cancelled(job.id)) break;
          try { solver = parseJsonLoose((await ai.chat({ ...solverPrompt(q, order, evForReview), temperature: 0, stage: 'solver', jobId: job.id, modelOverride: reviewModel, maxTokens: 2000 })).content); } catch (e) { if (e instanceof AiUnavailableError) throw e; }
        }
        const agg = aggregate({ q, checks: det.checks, critic, solver, solverOrder: order, requested: p, maxSimilarity: det.maxSimilarity });
        const refs = det.evidence.filter(e => e.valid_chunk).map(e => ({ source_id: e.source_id, chunk_id: e.chunk_id, page_start: e.page_start, page_end: e.page_end, quote: e.quote, verified: e.verified }));
        const quality = { checks: det.checks, critic, solver: solver ? { ...solver, display_order: order } : null, aggregate: agg.report, issues: agg.issues, solver_agrees: agg.solverAgrees,
          maxSimilarity: det.maxSimilarity, similarTo: det.similarTo, requested: { difficulty: p.difficulty, cognitive: p.cognitive }, ai_review_of_version: 1, models: { generator: gen.model, reviewer: ai.reviewModel() || gen.model } };
        const chapter = q.chapter || usedEvidence[0]?.chapter || p.chapters?.[0] || null;
        const topic = q.topic || usedEvidence[0]?.topic || p.topics?.[0] || null;
        await questions.createGenerated({ jobId: job.id, userId: job.created_by, data: { ...q, table: q.table }, refs, quality, qualityScore: agg.score, status: agg.status,
          meta: { field: p.field, grade: p.grade, subject: p.subject, chapter, topic, variantOf: p.variantOf || null } });
        produced++;
        await db.run('UPDATE generation_jobs SET produced_count = ? WHERE id = ?', [produced, job.id]);
      }
      batchIdx++;
      if (batchIdx > p.count * 2 + 2) break; // جلوگیری از حلقه بی‌پایان و هزینه کنترل‌نشده
    }
    const final = (await cancelled(job.id)) ? 'cancelled' : 'completed';
    await db.run('UPDATE generation_jobs SET status = ?, finished_at = ? WHERE id = ?', [final, now(), job.id]);
  }

  async function loop() {
    if (running || stopped) return; running = true;
    try {
      for (;;) {
        const job = await db.get("SELECT * FROM generation_jobs WHERE status = 'queued' AND cancel_requested = 0 ORDER BY id LIMIT 1");
        if (!job) break;
        try { await processJob(job); }
        catch (e) {
          const msg = e instanceof AiUnavailableError ? e.message : `خطا در تولید: ${String(e.message).slice(0, 400)}`;
          const st = (await cancelled(job.id)) ? 'cancelled' : 'failed';
          await db.run('UPDATE generation_jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?', [st, msg, now(), job.id]);
        }
      }
    } finally { running = false; }
  }

  return {
    async create(body, user, ip) {
      if (!ai.enabled()) throw new HttpError(503, 'تولید هوشمند فعال نیست: سرویس هوش مصنوعی روی سرور پیکربندی نشده است.', { code: 'AI_DISABLED' });
      const p = validateParams(body, await settings.get('max_questions_per_request'));
      const hash = crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex');
      const dup = await db.get("SELECT id, status, created_at FROM generation_jobs WHERE params_hash = ? AND (status IN ('queued','running') OR (status = 'completed' AND created_at > ?)) ORDER BY id DESC LIMIT 1", [hash, now() - 10 * 60_000]);
      if (dup && !body.force) throw conflict('درخواست مشابهی به‌تازگی ثبت شده است. برای تکرار، «تکرار آگاهانه» را انتخاب کنید.', { code: 'DUPLICATE_JOB', jobId: dup.id });
      const id = await db.insert('INSERT INTO generation_jobs(created_by, params, params_hash, status, requested_count, provider, created_at) VALUES (?,?,?,?,?,?,?)',
        [user.id, JSON.stringify(p), hash, 'queued', p.count, ctx.cfg.ai.provider, now()]);
      await audit(db, { userId: user.id, action: 'generation.create', entity: 'job', entityId: id, details: { count: p.count, difficulty: p.difficulty }, ip });
      setImmediate(loop);
      return id;
    },
    async cancel(id, user) {
      const r = await db.run("UPDATE generation_jobs SET cancel_requested = 1, status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END, finished_at = CASE WHEN status = 'queued' THEN ? ELSE finished_at END WHERE id = ? AND status IN ('queued','running')", [now(), id]);
      if (!r.changes) throw conflict('این درخواست در حال اجرا نیست.');
      ai.abortJob(id);
      await audit(db, { userId: user.id, action: 'generation.cancel', entity: 'job', entityId: id });
    },
    async retry(id, user) {
      if (!ai.enabled()) throw new HttpError(503, 'تولید هوشمند فعال نیست.', { code: 'AI_DISABLED' });
      const r = await db.run("UPDATE generation_jobs SET status = 'queued', cancel_requested = 0, error = NULL, refused_reason = NULL, finished_at = NULL WHERE id = ? AND status IN ('failed','cancelled')", [id]);
      if (!r.changes) throw conflict('فقط درخواست ناموفق یا متوقف‌شده قابل ازسرگیری است.');
      await audit(db, { userId: user.id, action: 'generation.retry', entity: 'job', entityId: id });
      setImmediate(loop);
    },
    async list() {
      return (await db.all('SELECT * FROM generation_jobs ORDER BY id DESC LIMIT 100')).map(j => ({ ...j, params: safeJson(j.params) }));
    },
    async get(id) {
      const j = await db.get('SELECT * FROM generation_jobs WHERE id = ?', [id]);
      if (!j) return null;
      j.params = safeJson(j.params);
      j.calls_log = await db.all('SELECT stage, model, prompt_tokens, completion_tokens, est_cost, duration_ms, ok, error, created_at FROM ai_calls WHERE job_id = ? ORDER BY id', [id]);
      return j;
    },
    async recoverOnBoot() { await db.run("UPDATE generation_jobs SET status = 'queued' WHERE status = 'running'"); setImmediate(loop); },
    async idle() { while (running || (await db.get("SELECT 1 AS x FROM generation_jobs WHERE status IN ('queued','running') LIMIT 1"))) await new Promise(r => setTimeout(r, 50)); },
    stop() { stopped = true; },
  };
}
