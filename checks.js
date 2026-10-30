// آزمون‌های قطعی نرم‌افزاری روی هر سؤال (مستقل از مدل هوش مصنوعی)
import { normalize, tokens, similarity, fixLetters } from '../services/textnorm.js';
import { COGNITIVE } from './prompts.js';

const ABSOLUTE = ['همیشه', 'هرگز', 'فقط', 'تنها', 'همه', 'هیچ', 'قطعا', 'کاملا'];
const CATCH_ALL = /(همه\s*(موارد|گزینه)|هیچ\s*(کدام|یک)|موارد\s*الف\s*و\s*ب)/;

export function sanitizeQuestion(q) {
  const fx = s => (s == null ? s : fixLetters(String(s)).replace(/ {2,}/g, ' ').trim());
  return {
    qtype: q.qtype || 'mcq', stem: fx(q.stem || ''), passage: fx(q.passage) || null,
    table: q.table && Array.isArray(q.table.headers) ? { headers: q.table.headers.map(fx), rows: (q.table.rows || []).map(r => r.map(fx)) } : null,
    statements: Array.isArray(q.statements) && q.statements.length ? q.statements.map((s, i) => ({ label: fx(s.label) || String(i + 1), text: fx(s.text), is_true: !!s.is_true })) : null,
    options: (q.options || []).map(o => (typeof o === 'string' ? { text: fx(o), rationale: '' } : { text: fx(o.text), rationale: fx(o.rationale) || '' })),
    correct_index: Number(q.correct_index), numeric_answer: q.numeric_answer ?? null, explanation: fx(q.explanation || ''),
    difficulty: Number(q.difficulty), cognitive_level: q.cognitive_level, chapter: fx(q.chapter) || null, topic: fx(q.topic) || null,
    evidence: Array.isArray(q.evidence) ? q.evidence.map(e => ({ chunk_id: Number(e.chunk_id), quote: String(e.quote || '').slice(0, 600) })) : [],
  };
}

const num = s => { const m = normalize(s).match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };

export function verifyQuote(quote, chunkText) {
  const q = normalize(quote), c = normalize(chunkText);
  if (q.length < 12) return { ok: false, ratio: 0 };
  if (c.includes(q)) return { ok: true, ratio: 1 };
  // نسبت توکن‌های نقل‌قول که به همان ترتیب در متن آمده‌اند
  const qt = q.split(' '), ct = c.split(' ');
  let best = 0;
  for (let i = 0; i < ct.length; i++) {
    let k = 0, j = i;
    for (const w of qt) { const f = ct.indexOf(w, j); if (f !== -1 && f - j < 4) { k++; j = f + 1; } }
    best = Math.max(best, k / qt.length);
    if (best === 1) break;
  }
  return { ok: best >= 0.85, ratio: Math.round(best * 100) / 100 };
}

export function runChecks(q, { evidenceById, bank = [], dupThreshold = 0.75 }) {
  const out = []; // {id, ok, severity: blocker|major|minor, text}
  const add = (id, ok, severity, text) => out.push({ id, ok, severity, text });

  add('structure.options', q.options.length === 4 && q.options.every(o => o.text?.length > 0), 'blocker', 'دقیقاً چهار گزینه غیرخالی');
  add('structure.key', Number.isInteger(q.correct_index) && q.correct_index >= 0 && q.correct_index <= 3, 'blocker', 'کلید پاسخ معتبر (یک گزینه)');
  add('structure.stem', q.stem.length >= 10, 'blocker', 'صورت سؤال کامل');
  add('structure.explanation', q.explanation.length >= 30, 'major', 'پاسخ تشریحی کافی');
  add('structure.rationales', q.options.filter((o, i) => i !== q.correct_index).every(o => (o.rationale || '').length >= 8), 'major', 'دلیل رد هر گزینه نادرست ثبت شده است');
  add('structure.meta', [1, 2, 3, 4].includes(q.difficulty) && q.cognitive_level in COGNITIVE, 'blocker', 'سطح دشواری و سطح شناختی معتبر');
  if (q.options.length !== 4 || !(q.correct_index >= 0 && q.correct_index <= 3)) return { checks: out, maxSimilarity: 0, similarTo: null, evidence: [] };

  // گزینه‌های تکراری یا هم‌معنا
  let maxOpt = 0;
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) maxOpt = Math.max(maxOpt, normalize(q.options[i].text) === normalize(q.options[j].text) ? 1 : similarity(q.options[i].text, q.options[j].text));
  add('options.distinct', maxOpt < 0.9, maxOpt >= 0.98 ? 'blocker' : 'major', `گزینه‌ها تکراری یا تقریباً یکسان نیستند (بیشینه شباهت ${Math.round(maxOpt * 100)}٪)`);

  // نشانه طول
  const lens = q.options.map(o => o.text.length);
  const others = lens.filter((_, i) => i !== q.correct_index);
  const avg = others.reduce((a, b) => a + b, 0) / 3;
  const ratio = avg ? lens[q.correct_index] / avg : 1;
  add('cue.length', ratio <= 1.5 && ratio >= 0.5, 'major', `طول گزینه صحیح نسبت به میانگین سایر گزینه‌ها متعادل است (${ratio.toFixed(2)})`);
  const longestUnique = lens[q.correct_index] === Math.max(...lens) && lens.filter(l => l === Math.max(...lens)).length === 1 && ratio > 1.25;
  add('cue.longest', !longestUnique, 'minor', 'گزینه صحیح به‌وضوح بلندترین گزینه نیست');

  // تکرار واژه‌های صورت سؤال فقط در گزینه صحیح
  const stemT = new Set(tokens(q.stem));
  const optT = q.options.map(o => new Set(tokens(o.text)));
  const echo = [...optT[q.correct_index]].filter(w => stemT.has(w) && optT.every((s, i) => i === q.correct_index || !s.has(w)));
  add('cue.echo', echo.length === 0, 'major', echo.length ? `واژه(های) «${echo.join('، ')}» از صورت سؤال فقط در گزینه صحیح تکرار شده است` : 'تکرار واژه صورت سؤال فقط در گزینه صحیح وجود ندارد');

  // واژه‌های مطلق فقط در گزینه‌های غلط
  const absIn = q.options.map(o => ABSOLUTE.some(w => normalize(o.text).split(' ').includes(normalize(w))));
  const absOnlyWrong = absIn.filter((x, i) => x && i !== q.correct_index).length >= 2 && !absIn[q.correct_index];
  add('cue.absolute', !absOnlyWrong, 'minor', 'واژه‌های مطلق (همیشه، هرگز، فقط…) نشانه پاسخ نیستند');
  add('cue.catchall', !q.options.some(o => CATCH_ALL.test(normalize(o.text))), 'major', 'گزینه‌های «همه موارد/هیچ‌کدام» استفاده نشده است');

  // سؤال گزاره‌ای: سازگاری تعداد گزاره‌های درست با کلید
  if (q.statements?.length && /چند\s*(مورد|عبارت|گزاره)/.test(normalize(q.stem))) {
    const trueCount = q.statements.filter(s => s.is_true).length;
    const falseAsked = /(نادرست|غلط)/.test(normalize(q.stem));
    const expected = falseAsked ? q.statements.length - trueCount : trueCount;
    add('logic.statements', num(q.options[q.correct_index].text) === expected, 'blocker', `تعداد گزاره‌های ${falseAsked ? 'نادرست' : 'درست'} (${expected}) با گزینه صحیح سازگار است`);
    const nums = q.options.map(o => num(o.text));
    add('logic.statements_unique', new Set(nums).size === 4, 'blocker', 'گزینه‌های عددی سؤال گزاره‌ای متمایزند');
  }
  // سؤال محاسباتی: پاسخ عددی در گزینه صحیح
  if (q.qtype === 'calc' && q.numeric_answer != null && q.numeric_answer !== '') {
    const target = Number(String(q.numeric_answer).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
    const got = num(q.options[q.correct_index].text);
    add('logic.numeric', got != null && Math.abs(got - target) <= Math.abs(target) * 1e-6 + 1e-9, 'blocker', `پاسخ عددی (${q.numeric_answer}) در گزینه صحیح آمده است`);
    add('logic.numeric_unique', q.options.filter(o => { const n = num(o.text); return n != null && Math.abs(n - target) <= Math.abs(target) * 1e-6 + 1e-9; }).length === 1, 'blocker', 'فقط یک گزینه مقدار عددی صحیح را دارد');
  }

  // استناد به شواهد و تطبیق عینی نقل‌قول
  const ev = q.evidence.map(e => {
    const c = evidenceById.get(e.chunk_id);
    if (!c) return { ...e, valid_chunk: false, verified: false, ratio: 0 };
    const r = verifyQuote(e.quote, c.text);
    return { ...e, valid_chunk: true, verified: r.ok, ratio: r.ratio, source_id: c.source_id, page_start: c.page_start, page_end: c.page_end };
  });
  add('evidence.cited', ev.length > 0 && ev.every(e => e.valid_chunk), 'blocker', 'همه استنادها به بخش‌های مجاز ارائه‌شده است');
  add('evidence.verified', ev.some(e => e.verified), 'blocker', `نقل‌قول شاهد عیناً در متن منبع یافت شد (${ev.filter(e => e.verified).length} از ${ev.length})`);

  // نگارش
  add('lang.question_mark', /[؟?:]\s*$/.test(q.stem) || /[…\.]{2,}|\.\.\./.test(q.stem) || q.stem.includes('____'), 'minor', 'صورت سؤال با علامت مناسب پایان یافته است');
  const persianRatio = (q.stem.match(/[\u0600-\u06FF]/g) || []).length / Math.max(1, (q.stem.match(/\p{L}/gu) || []).length);
  add('lang.persian', persianRatio > 0.6, 'minor', 'متن سؤال فارسی است');
  add('lang.length', q.stem.length <= (q.passage ? 600 : 450), 'minor', 'صورت سؤال بی‌دلیل طولانی نیست');

  // شباهت با بانک
  let maxSim = 0, similarTo = null;
  const sig = q.stem + ' ' + q.options[q.correct_index].text;
  for (const b of bank) { const s = similarity(sig, b.sig); if (s > maxSim) { maxSim = s; similarTo = b.question_id; } }
  add('similarity.bank', maxSim < dupThreshold, 'blocker', `شباهت با سؤال‌های موجود: ${Math.round(maxSim * 100)}٪`);
  return { checks: out, maxSimilarity: maxSim, similarTo, evidence: ev };
}
