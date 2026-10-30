// اتصال به مدل‌های هوش مصنوعی فقط سمت سرور. کلید هرگز به کلاینت ارسال نمی‌شود.
export class AiUnavailableError extends Error { constructor(m) { super(m); this.code = 'AI_UNAVAILABLE'; } }
export class AiCallError extends Error { constructor(m, retryable = true) { super(m); this.code = 'AI_CALL'; this.retryable = retryable; } }

export function createAi(ctx) {
  const { cfg, db, settings } = ctx;
  const controllers = new Map(); // jobId -> Set<AbortController>

  const enabled = () => !!cfg.ai.apiKey && !!cfg.ai.baseUrl && cfg.ai.allowedModels.length > 0;

  async function model() {
    const sel = await settings.get('ai_model');
    return cfg.ai.allowedModels.includes(sel) ? sel : (cfg.ai.defaultModel || cfg.ai.allowedModels[0]);
  }
  async function price(m, pt, ct) {
    const p = (await settings.get('ai_pricing'))?.[m];
    if (!p) return 0;
    return (pt * (Number(p.input) || 0) + ct * (Number(p.output) || 0)) / 1e6;
  }

  async function fetchWithRetry(url, init, jobId, tries = 3) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('timeout')), cfg.ai.timeoutMs);
      if (jobId) { if (!controllers.has(jobId)) controllers.set(jobId, new Set()); controllers.get(jobId).add(ac); }
      try {
        const res = await fetch(url, { ...init, signal: ac.signal });
        const text = await res.text();
        if (res.ok) return JSON.parse(text);
        const retryable = res.status === 429 || res.status >= 500;
        lastErr = new AiCallError(`سرویس هوش مصنوعی خطای ${res.status} داد: ${text.slice(0, 200)}`, retryable);
        if (!retryable) throw lastErr;
      } catch (e) {
        if (e instanceof AiCallError && !e.retryable) throw e;
        if (ac.signal.aborted && ac.signal.reason?.message === 'cancelled') throw new AiCallError('تولید متوقف شد.', false);
        lastErr = e instanceof AiCallError ? e : new AiCallError(`ارتباط با سرویس هوش مصنوعی برقرار نشد: ${e.message}`);
      } finally { clearTimeout(timer); controllers.get(jobId)?.delete(ac); }
      await new Promise(r => setTimeout(r, 800 * 2 ** i));
    }
    throw lastErr;
  }

  async function chat({ system, user, temperature = 0.3, json = true, stage, jobId, modelOverride, maxTokens = 6000 }) {
    if (!enabled()) throw new AiUnavailableError('تولید هوشمند فعال نیست: کلید یا تنظیمات سرویس هوش مصنوعی روی سرور تعریف نشده است.');
    const m = modelOverride || await model();
    const t0 = Date.now();
    let content, pt = 0, ct = 0;
    try {
      if (cfg.ai.provider === 'anthropic') {
        const data = await fetchWithRetry(`${cfg.ai.baseUrl}/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': cfg.ai.apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: m, max_tokens: maxTokens, temperature, system, messages: [{ role: 'user', content: user }] }),
        }, jobId);
        content = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        pt = data.usage?.input_tokens || 0; ct = data.usage?.output_tokens || 0;
      } else {
        const body = { model: m, temperature, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
        if (json && cfg.ai.jsonMode) body.response_format = { type: 'json_object' };
        const data = await fetchWithRetry(`${cfg.ai.baseUrl}/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.ai.apiKey}` }, body: JSON.stringify(body),
        }, jobId);
        content = data.choices?.[0]?.message?.content || '';
        pt = data.usage?.prompt_tokens || 0; ct = data.usage?.completion_tokens || 0;
      }
    } catch (e) {
      await db.run('INSERT INTO ai_calls(job_id, stage, model, prompt_tokens, completion_tokens, est_cost, duration_ms, ok, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [jobId || null, stage, m, 0, 0, 0, Date.now() - t0, 0, String(e.message).slice(0, 300), Date.now()]);
      throw e;
    }
    const cost = await price(m, pt, ct);
    await db.run('INSERT INTO ai_calls(job_id, stage, model, prompt_tokens, completion_tokens, est_cost, duration_ms, ok, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [jobId || null, stage, m, pt, ct, cost, Date.now() - t0, 1, null, Date.now()]);
    if (jobId) await db.run('UPDATE generation_jobs SET calls = calls + 1, prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ?, est_cost = est_cost + ? WHERE id = ?', [pt, ct, cost, jobId]);
    return { content, model: m, usage: { pt, ct, cost } };
  }

  return {
    enabled, model,
    status: async () => ({ enabled: enabled(), provider: cfg.ai.provider, models: cfg.ai.allowedModels, model: enabled() ? await model() : null, reviewModel: cfg.ai.reviewModel || null, embeddings: !!cfg.ai.embeddingModel }),
    chat,
    reviewModel: () => cfg.ai.reviewModel || null,
    embeddingsEnabled: () => enabled() && !!cfg.ai.embeddingModel && cfg.ai.provider === 'openai',
    async embed(texts, { stage = 'embed', jobId } = {}) {
      const data = await fetchWithRetry(`${cfg.ai.baseUrl}/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.ai.apiKey}` }, body: JSON.stringify({ model: cfg.ai.embeddingModel, input: texts }) }, jobId);
      const pt = data.usage?.prompt_tokens || 0;
      await db.run('INSERT INTO ai_calls(job_id, stage, model, prompt_tokens, completion_tokens, est_cost, duration_ms, ok, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [jobId || null, stage, cfg.ai.embeddingModel, pt, 0, await price(cfg.ai.embeddingModel, pt, 0), 0, 1, null, Date.now()]);
      return data.data.map(d => d.embedding);
    },
    abortJob(jobId) { for (const ac of controllers.get(jobId) || []) ac.abort(new Error('cancelled')); controllers.delete(jobId); },
  };
}

// استخراج مقاوم JSON از پاسخ مدل
export function parseJsonLoose(s) {
  if (!s) throw new Error('پاسخ خالی');
  try { return JSON.parse(s); } catch {}
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) try { return JSON.parse(fenced[1]); } catch {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error('پاسخ مدل JSON معتبر نیست.');
}
