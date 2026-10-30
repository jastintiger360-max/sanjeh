// ابزار تست: سرور جعلی سازگار با OpenAI فقط برای آزمون خودکار (در کد برنامه هیچ خروجی ساختگی وجود ندارد).
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const W = s => String(s).replace(/\s+/g, ' ').trim();
export function fakeAiServer() {
  const keyByStem = new Map();
  const state = { calls: [], mode: 'good', delayMs: 0 };
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const j = JSON.parse(body || '{}');
    state.calls.push({ path: req.url, auth: req.headers.authorization, model: j.model });
    if (state.delayMs) await new Promise(r => setTimeout(r, state.delayMs));
    if (req.url.endsWith('/embeddings')) return reply(res, { data: j.input.map(() => ({ embedding: [1, 0, 0] })), usage: { prompt_tokens: 5 } });
    const sys = j.messages[0].content; const user = j.messages[1].content;
    let content;
    if (sys.includes('طراح ارشد')) {
      if (state.mode === 'refuse') content = JSON.stringify({ questions: [], refusal: 'شواهد کافی نیست' });
      else {
        const chunks = [...user.matchAll(/<chunk id="(\d+)"[^>]*>\n([\s\S]*?)\n<\/chunk>/g)].map(m => ({ id: +m[1], text: m[2] }));
        const n = Number(user.match(/تعداد سؤال در این درخواست: (\d+)/)[1]);
        const qs = [];
        for (let i = 0; i < n; i++) {
          const c = chunks[i % chunks.length];
          const sentence = c.text.split(/[.\n]/).map(s => s.trim()).filter(s => s.length > 40)[i % 3] || c.text.slice(0, 80);
          const stem = `[تست ${state.calls.length}-${i}] با توجه به متن، کدام عبارت درباره «${sentence.slice(0, 25)}» درست است؟`;
          const good = state.mode !== 'bad';
          const base = sentence.slice(0, 70);
          const options = good ? [
            { text: base, rationale: 'مطابق متن منبع درست است' },
            { text: 'برخلاف متن، ' + sentence.slice(12, 72), rationale: 'برداشت وارونه از متن؛ خطای مفهومی رایج' },
            { text: sentence.slice(0, 40) + ' فقط در شرایط خاص رخ نمی‌دهد', rationale: 'تعمیم نادرست شرایط' },
            { text: 'ارتباطی میان ' + sentence.slice(5, 57) + ' وجود ندارد', rationale: 'نفی رابطه‌ای که متن بیان کرده' },
          ] : [{ text: 'الف', rationale: '' }, { text: 'الف', rationale: '' }, { text: 'ب', rationale: '' }, { text: 'یک گزینه بسیار بسیار طولانی که به‌وضوح پاسخ را لو می‌دهد و از بقیه بلندتر است', rationale: '' }];
          const correct = good ? 0 : 3;
          keyByStem.set(W(stem), W(options[correct].text));
          qs.push({ qtype: 'mcq', stem, options, correct_index: correct, explanation: 'طبق متن منبع، گزینه اول عیناً با متن مطابقت دارد و سایر گزینه‌ها با متن مغایرند.',
            difficulty: 2, cognitive_level: 'understand', evidence: [{ chunk_id: c.id, quote: good ? sentence.slice(0, 120) : 'نقل قولی که در متن وجود ندارد اصلا و ابدا' }] });
        }
        content = JSON.stringify({ questions: qs, refusal: null });
      }
    } else if (sys.includes('منتقد')) {
      content = JSON.stringify({ scores: { source_alignment: 9, answer_correctness: 9, distractor_quality: 8, clarity: 9, explanation_quality: 8, difficulty_fit: 8, language: 9 },
        estimated_difficulty: 2, estimated_cognitive_level: 'understand', issues: [], verdict: 'pass', summary: 'قابل قبول' });
    } else if (sys.includes('داوطلب ممتاز')) {
      const stem = user.match(/صورت سؤال: (.*)/)[1].trim();
      const opts = [...user.matchAll(/^(\d)\) (.*)$/gm)].map(m => ({ label: +m[1], text: m[2].trim() }));
      const key = keyByStem.get(W(stem));
      const pick = opts.find(o => W(o.text) === key)?.label || 1;
      content = JSON.stringify({ reasoning: 'بر اساس متن', answer: pick, confidence: 0.9, options: opts.map(o => ({ label: o.label, verdict: o.label === pick ? 'correct' : 'incorrect', reason: '' })), multiple_correct: false, ambiguous: false, insufficient_evidence: false });
    } else content = '{}';
    reply(res, { choices: [{ message: { content } }], usage: { prompt_tokens: 1000, completion_tokens: 400 } });
  });
  function reply(res, obj) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, state, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

export async function tmpDir() { return fs.mkdtemp(path.join(os.tmpdir(), 'sanjeh-test-')); }

export class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = ''; }
  async req(method, url, body, { raw = false, headers = {} } = {}) {
    const h = { ...headers }; if (this.cookie) h.cookie = this.cookie; if (this.csrf && !h['x-csrf-token']) h['x-csrf-token'] = this.csrf;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(this.base + url, { method, headers: h, body: payload, redirect: 'manual' });
    const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    if (raw) return res;
    const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, text };
  }
  async login(username, password) {
    const r = await this.req('POST', '/api/auth/login', { username, password }, { headers: { 'x-requested-with': 'sanjeh' } });
    if (r.status === 200) this.csrf = r.data.csrf;
    return r;
  }
  get(u) { return this.req('GET', u); } post(u, b = {}) { return this.req('POST', u, b); } put(u, b) { return this.req('PUT', u, b); } patch(u, b) { return this.req('PATCH', u, b); } del(u) { return this.req('DELETE', u); }
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function until(fn, ms = 20000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await sleep(100); } }
