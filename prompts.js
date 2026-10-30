// پرامپت‌های سه نقش مستقل: طراح، منتقد سخت‌گیر، حل‌کننده مستقل
export const DIFFICULTY = {
  1: { name: 'آسان', spec: 'سنجش درک پایه‌ای و فهم مفاهیم مستقیم؛ تشخیص روابط واضح با استدلال محدود. نباید رونویسی جمله کتاب باشد؛ دانش‌آموز باید مفهوم را فهمیده باشد، نه فقط جمله را به خاطر بسپارد.' },
  2: { name: 'متوسط', spec: 'تحلیل بیشتر، مقایسه مفاهیم، تشخیص ارتباط میان چند گزاره، استنباط از متن و به‌کارگیری اطلاعات برای پاسخ‌گویی.' },
  3: { name: 'دشوار', spec: 'ترکیب چند مفهوم، استدلال چندمرحله‌ای، تحلیل دقیق گزاره‌ها، ارتباط میان بخش‌های مختلف منبع؛ گزینه‌های انحرافی علمی و نزدیک به هم که فقط با تسلط واقعی تفکیک می‌شوند.' },
  4: { name: 'چالشی و پیشرفته', spec: 'استدلال چندمرحله‌ای عمیق، ترکیب چند مبحث (فقط اگر مجاز باشد)، تحلیل روابط غیرمستقیم، بررسی حالت‌های مختلف یک مفهوم، تشخیص تفاوت‌های ظریف علمی؛ گزینه‌های بسیار نزدیک اما قطعاً قابل تفکیک؛ سنجش تسلط فراتر از حفظیات.' },
};
export const COGNITIVE = { remember: 'یادآوری', understand: 'درک', apply: 'کاربرد', analyze: 'تحلیل', evaluate: 'ارزیابی' };
export const QTYPES = {
  mcq: 'چهارگزینه‌ای تک‌پاسخی',
  statement: 'مبتنی بر گزاره (چند مورد از گزاره‌ها صحیح/نادرست است)',
  multipart: 'چندبخشی (چند جای خالی یا چند بخش که گزینه‌ها ترکیب پاسخ آن‌هاست)',
  passage: 'دارای متن یا سناریو',
  image: 'مبتنی بر تصویر (توصیف دقیق تصویر/شکل موجود در منبع)',
  table: 'دارای جدول یا نمودار (داده‌ها در قالب جدول ارائه شود)',
  calc: 'محاسباتی و تحلیلی',
};
export const COMBINATION = { single: 'فقط یک مفهوم/بخش', intra: 'ترکیب چند مفهوم از یک فصل', cross: 'ترکیب چند فصل/مبحث انتخاب‌شده' };
export const TARGETS = { konkur: 'کنکور سراسری', final: 'امتحان نهایی/پایانی', quiz: 'آزمون کلاسی', olympiad: 'المپیاد/پیشرفته' };
export const OPTION_COMPLEXITY = { standard: 'استاندارد', close: 'نزدیک به هم', very_close: 'بسیار نزدیک (تفاوت‌های ظریف علمی)' };

const OUTPUT_SCHEMA = `{
  "questions": [{
    "qtype": "mcq|statement|multipart|passage|image|table|calc",
    "passage": "متن/سناریو یا توصیف تصویر (در صورت نیاز، وگرنه null)",
    "table": {"headers": ["..."], "rows": [["..."]]} یا null,
    "statements": [{"label": "الف", "text": "...", "is_true": true}] یا null,
    "stem": "صورت سؤال",
    "options": [{"text": "گزینه ۱", "rationale": "چرا درست/نادرست است و کدام خطای مفهومی را هدف گرفته"}, {"text": "...", "rationale": "..."}, {"text": "...", "rationale": "..."}, {"text": "...", "rationale": "..."}],
    "correct_index": 0,
    "numeric_answer": null,
    "explanation": "پاسخ تشریحی گام‌به‌گام با ارجاع به شواهد",
    "difficulty": 1,
    "cognitive_level": "remember|understand|apply|analyze|evaluate",
    "chapter": "...", "topic": "...",
    "evidence": [{"chunk_id": 12, "quote": "نقل‌قول عینی و کوتاه (حداکثر ۲۵۰ نویسه) از همان بخش که درستی پاسخ را ثابت می‌کند"}]
  }],
  "refusal": null
}`;

export function generatorPrompt(p, evidence, avoidStems = []) {
  const d = DIFFICULTY[p.difficulty];
  const system = `تو یک طراح ارشد سؤال آزمون‌های استاندارد ${TARGETS[p.target] || 'آموزشی'} در ایران هستی. وظیفه‌ات طراحی سؤال‌های چهارگزینه‌ای دقیق، علمی و منصفانه است.

قوانین قطعی:
۱. فقط و فقط از «شواهد» ارائه‌شده استفاده کن.${p.allowExternal ? ' استفاده محدود از دانش عمومی هم‌سطح کتاب درسی مجاز است، اما پاسخ صحیح باید با شواهد اثبات شود.' : ' استفاده از هر اطلاعاتی خارج از شواهد ممنوع است.'}
۲. اگر شواهد برای طراحی سؤال قطعی کافی نیست، سؤال نساز و در «refusal» دلیل را بنویس. ساختن سؤال مبهم یا حدسی ممنوع است.
۳. هر سؤال دقیقاً یک پاسخ صحیح دارد. سه گزینه دیگر باید بی‌تردید نادرست باشند، اما نه مضحک و بی‌ربط.
۴. گزینه‌های انحرافی را از خطاهای مفهومی محتمل دانش‌آموز، برداشت‌های ناقص، جابه‌جایی علت و معلول، تعمیم نادرست و تفاوت‌های علمی مرتبط بساز.
۵. ممنوع: طول بسیار متفاوت گزینه صحیح، تکرار واژه‌های صورت سؤال فقط در گزینه صحیح، نشانه‌های دستوری که پاسخ را لو می‌دهند، گزینه‌های هم‌معنا، «همه موارد»/«هیچ‌کدام»، ابهام در محدوده زمانی/مکانی/علمی، چند پاسخ صحیح.
۶. دشواری را با مهارت شناختی لازم بساز، نه با طولانی‌کردن متن، جمله‌های پیچیده یا ابهام.
۷. سطح دشواری (۱ تا ۴) و سطح شناختی دو ویژگی مستقل‌اند و هر دو را صادقانه ثبت کن.
۸. برای هر سؤال، شواهد را با chunk_id و نقل‌قول «عینی» (کپی دقیق از متن همان بخش) ذکر کن. این نقل‌قول به‌صورت نرم‌افزاری با متن منبع مقایسه می‌شود.
۹. در سؤالات گزاره‌ای، is_true هر گزاره را مشخص کن و گزینه صحیح باید دقیقاً تعداد/ترکیب درست را نشان دهد.
۱۰. در سؤالات محاسباتی، numeric_answer را عددی بنویس و گزینه صحیح باید همان مقدار را داشته باشد.
۱۱. نگارش فارسی معیار، با «ی» و «ک» فارسی و نیم‌فاصله صحیح. صورت سؤال پرسشی به «؟» ختم شود.
۱۲. خروجی فقط JSON مطابق قالب زیر باشد، بدون هیچ متن اضافه:
${OUTPUT_SCHEMA}`;
  const user = `مشخصات درخواست:
- رشته: ${p.field || '—'} | پایه: ${p.grade || '—'} | درس: ${p.subject || '—'}
- فصل/مباحث: ${[...(p.chapters || []), ...(p.topics || [])].join('، ') || 'مطابق شواهد'}
- تعداد سؤال در این درخواست: ${p.batchCount}
- نوع سؤال: ${QTYPES[p.qtype]}
- سطح دشواری: ${p.difficulty} (${d.name}) — ${d.spec}
- سطح شناختی هدف: ${COGNITIVE[p.cognitive] || 'متناسب با دشواری'}
- میزان ترکیبی‌بودن: ${COMBINATION[p.combination]}
- آزمون هدف: ${TARGETS[p.target]}
- پیچیدگی گزینه‌ها: ${OPTION_COMPLEXITY[p.optionComplexity]}
${p.style ? `- سبک طراحی: ${p.style}\n` : ''}${avoidStems.length ? `\nاین سؤال‌ها قبلاً ساخته شده‌اند؛ سؤال تکراری یا بسیار مشابه نساز:\n${avoidStems.map(s => '• ' + s.slice(0, 160)).join('\n')}\n` : ''}
شواهد مجاز (فقط از این‌ها استفاده کن):
${evidence.map(e => `<chunk id="${e.id}" source="${e.source_title}" pages="${e.page_start}-${e.page_end}" chapter="${e.chapter || ''}" topic="${e.topic || ''}">\n${e.text}\n</chunk>`).join('\n\n')}`;
  return { system, user };
}

export function criticPrompt(q, evidence, requested) {
  const system = `تو منتقد بسیار سخت‌گیر و مستقل سؤالات کنکور هستی. سؤال را طراحی نکرده‌ای و هیچ تعهدی به تأیید آن نداری. هر ایراد را صریح بگو. فقط بر اساس شواهد داوری کن.
امتیاز هر معیار از ۰ تا ۱۰ است. خروجی فقط JSON:
{"scores": {"source_alignment": 0, "answer_correctness": 0, "distractor_quality": 0, "clarity": 0, "explanation_quality": 0, "difficulty_fit": 0, "language": 0},
 "estimated_difficulty": 1, "estimated_cognitive_level": "remember|understand|apply|analyze|evaluate",
 "option_checks": [{"index": 0, "verdict": "correct|incorrect|debatable", "note": "..."}],
 "issues": [{"severity": "blocker|major|minor", "criterion": "...", "text": "..."}],
 "verdict": "pass|revise|reject", "summary": "..."}`;
  const user = `دشواری درخواستی: ${requested.difficulty} (${DIFFICULTY[requested.difficulty].name}) | سطح شناختی درخواستی: ${COGNITIVE[requested.cognitive] || '—'}
بررسی کن: انطباق با منبع، صحت علمی پاسخ، بررسی مستقل تک‌تک گزینه‌ها، یکتابودن پاسخ، ابهام صورت سؤال، کیفیت گزینه‌های انحرافی، تناسب دشواری، کیفیت پاسخ تشریحی، نگارش.

سؤال:
${formatQuestion(q, true)}

شواهد:
${evidence.map(e => `<chunk id="${e.id}" pages="${e.page_start}-${e.page_end}">\n${e.text}\n</chunk>`).join('\n\n')}`;
  return { system, user };
}

export function solverPrompt(q, order, evidence) {
  const system = `تو یک داوطلب ممتاز و دقیق هستی که باید سؤال را فقط با تکیه بر شواهد حل کنی. پاسخ صحیح را نمی‌دانی. ابتدا مستقل استدلال کن، سپس تک‌تک گزینه‌ها را بسنج.
خروجی فقط JSON:
{"reasoning": "استدلال کوتاه", "answer": 1, "confidence": 0.0, "options": [{"label": 1, "verdict": "correct|incorrect|debatable", "reason": "..."}],
 "multiple_correct": false, "ambiguous": false, "insufficient_evidence": false, "notes": "..."}`;
  const user = `${formatQuestion({ ...q, options: order.map(i => q.options[i]) }, false)}

شواهد:
${evidence.map(e => `<chunk id="${e.id}">\n${e.text}\n</chunk>`).join('\n\n')}`;
  return { system, user };
}

export function formatQuestion(q, withKey) {
  let s = '';
  if (q.passage) s += `متن/سناریو: ${q.passage}\n`;
  if (q.table?.headers) s += `جدول:\n${q.table.headers.join(' | ')}\n${(q.table.rows || []).map(r => r.join(' | ')).join('\n')}\n`;
  if (q.statements?.length) s += q.statements.map(st => `${st.label}) ${st.text}${withKey ? ` [${st.is_true ? 'درست' : 'نادرست'}]` : ''}`).join('\n') + '\n';
  s += `صورت سؤال: ${q.stem}\n`;
  s += q.options.map((o, i) => `${i + 1}) ${o.text}${withKey && o.rationale ? `   — توضیح طراح: ${o.rationale}` : ''}`).join('\n');
  if (withKey) s += `\nپاسخ اعلام‌شده توسط طراح: گزینه ${q.correct_index + 1}\nپاسخ تشریحی: ${q.explanation}`;
  return s;
}
