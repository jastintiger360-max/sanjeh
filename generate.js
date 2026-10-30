import { el, api, toast, fail, fa, faNum, jdate, LABELS } from '/assets/common.js';
import { page, go } from './app.js';
import { AUTH } from './sources.js';

const TARGETS = { konkur: 'کنکور سراسری', final: 'امتحان نهایی', quiz: 'آزمون کلاسی', olympiad: 'المپیاد' };
const COMBO = { single: 'تک‌مفهومی', intra: 'ترکیب در یک فصل', cross: 'ترکیب چند فصل/مبحث' };
const OPTC = { standard: 'استاندارد', close: 'نزدیک به هم', very_close: 'بسیار نزدیک' };
const JOB = { queued: ['در صف', 'plain'], running: ['در حال تولید', 'warn'], completed: ['کامل', 'ok'], failed: ['ناموفق', 'bad'], cancelled: ['متوقف‌شده', 'plain'], refused: ['امتناع (شواهد ناکافی)', 'bad'] };

function seg(options, value, onChange) {
  const box = el('div', { class: 'seg', role: 'radiogroup' });
  const render = () => box.replaceChildren(...Object.entries(options).map(([k, v]) => el('button', { type: 'button', class: String(k) === String(value) ? 'on' : '', onclick: () => { value = k; onChange(k); render(); } }, v)));
  render(); return box;
}

export async function generateView() {
  let sources, ai, struct, jobs;
  try { [sources, ai, struct, jobs] = await Promise.all([api('GET', '/api/admin/sources'), api('GET', '/api/admin/ai/status'), api('GET', '/api/admin/structure-options'), api('GET', '/api/admin/jobs')]); } catch (e) { return fail(e); }
  const ready = sources.filter(s => s.status === 'ready' && s.validation_status !== 'rejected');
  const st = { difficulty: 2, qtype: 'mcq' };
  const srcChecks = ready.map(s => ({ s, cb: el('input', { type: 'checkbox', onchange: renderTopics }) }));
  const topicsBox = el('div', { class: 'checklist' });
  const chapterChecks = new Map(); const topicChecks = new Map();
  function renderTopics() {
    const ids = new Set(srcChecks.filter(x => x.cb.checked).map(x => x.s.id));
    const rows = struct.chapters.filter(r => ids.has(r.source_id));
    const chapters = [...new Set(rows.map(r => r.chapter).filter(Boolean))];
    topicsBox.replaceChildren(...(chapters.length ? chapters.flatMap(ch => {
      if (!chapterChecks.has(ch)) chapterChecks.set(ch, el('input', { type: 'checkbox' }));
      const tps = [...new Set(rows.filter(r => r.chapter === ch).map(r => r.topic).filter(Boolean))];
      return [el('label', { style: { fontWeight: 700 } }, chapterChecks.get(ch), ch), ...tps.map(t => { if (!topicChecks.has(t)) topicChecks.set(t, el('input', { type: 'checkbox' })); return el('label', { style: { paddingInlineStart: '22px' } }, topicChecks.get(t), t); })];
    }) : [el('span', { class: 'muted small' }, ids.size ? 'فصل/مبحثی در منابع انتخاب‌شده شناسایی نشده؛ کل منبع یا بازه صفحات استفاده می‌شود.' : 'ابتدا منبع را انتخاب کنید.')]));
  }
  const f = {
    count: el('input', { type: 'number', value: 5, min: 1, max: 50 }), pf: el('input', { type: 'number', placeholder: 'از صفحه' }), pt: el('input', { type: 'number', placeholder: 'تا صفحه' }),
    query: el('input', { type: 'text', placeholder: 'مثلاً: آنزیم‌های معده' }),
    cognitive: el('select', {}, el('option', { value: '' }, 'متناسب با دشواری'), Object.entries(LABELS.cognitive).map(([k, v]) => el('option', { value: k }, v))),
    combination: el('select', {}, Object.entries(COMBO).map(([k, v]) => el('option', { value: k }, v))), target: el('select', {}, Object.entries(TARGETS).map(([k, v]) => el('option', { value: k }, v))),
    oc: el('select', {}, Object.entries(OPTC).map(([k, v]) => el('option', { value: k }, v))), style: el('input', { type: 'text', placeholder: 'اختیاری؛ مثلاً «سبک سؤالات کنکور ۱۴۰۲، بدون حفظیات عددی»' }),
    field: el('input', { type: 'text' }), grade: el('input', { type: 'text' }), subject: el('input', { type: 'text' }), ext: el('input', { type: 'checkbox' }), flagged: el('input', { type: 'checkbox' }),
  };
  const btn = el('button', { class: 'btn primary', type: 'button', disabled: !ai.enabled, onclick: () => submit(false) }, 'شروع تولید');
  async function submit(force) {
    const source_ids = srcChecks.filter(x => x.cb.checked).map(x => x.s.id);
    const meta = ready.find(s => source_ids.includes(s.id)) || {};
    const body = { source_ids, chapters: [...chapterChecks].filter(([, c]) => c.checked).map(([k]) => k), topics: [...topicChecks].filter(([, c]) => c.checked).map(([k]) => k),
      page_from: f.pf.value || null, page_to: f.pt.value || null, query: f.query.value || null, count: Number(f.count.value), difficulty: Number(st.difficulty), qtype: st.qtype,
      cognitive_level: f.cognitive.value || null, combination: f.combination.value, target: f.target.value, option_complexity: f.oc.value, style: f.style.value || null,
      field: f.field.value || meta.field || null, grade: f.grade.value || meta.grade || null, subject: f.subject.value || meta.subject || null, allow_external: f.ext.checked, include_flagged: f.flagged.checked, force };
    try { await api('POST', '/api/admin/jobs', body); toast('درخواست تولید ثبت شد.'); generateView(); }
    catch (e) {
      if (e.data?.code === 'DUPLICATE_JOB') { const again = el('button', { class: 'btn sm', type: 'button', onclick: () => submit(true) }, 'تکرار آگاهانه'); toast(e.message); btn.after(again); }
      else fail(e);
    }
  }
  const running = jobs.some(j => ['queued', 'running'].includes(j.status));
  if (running) setTimeout(() => location.hash === '#generate' && refreshJobs(), 2500);
  const jobsBox = el('section', { class: 'card scroll-x', style: { marginTop: '16px' } }, jobsTable(jobs));
  async function refreshJobs() { try { const j = await api('GET', '/api/admin/jobs'); jobsBox.replaceChildren(jobsTable(j)); if (j.some(x => ['queued', 'running'].includes(x.status))) setTimeout(() => location.hash === '#generate' && refreshJobs(), 2500); } catch {} }
  page('تولید هوشمند سؤال', null,
    !ai.enabled ? el('div', { class: 'banner bad' }, 'تولید هوشمند فعال نیست. کلید API و مدل‌های مجاز باید در تنظیمات امن سرور (متغیرهای محیطی) تعریف شوند. هیچ خروجی ساختگی نمایش داده نمی‌شود.')
      : el('div', { class: 'banner ok' }, `مدل طراح: ${ai.model} • منتقد و حل‌کننده مستقل: ${ai.reviewModel || ai.model}${ai.reviewModel ? '' : ' (برای استقلال بیشتر، مدل بازبین جداگانه تعریف کنید)'}`),
    el('div', { class: 'grid g2', style: { marginTop: '14px', alignItems: 'start' } },
      el('section', { class: 'card' }, el('h3', {}, '۱. منابع و محدوده'),
        ready.length ? el('div', { class: 'checklist' }, srcChecks.map(({ s, cb }) => el('label', {}, cb, s.title, el('span', { class: 'badge ' + (s.authority === 'official' ? 'ok' : 'plain') }, AUTH[s.authority]), s.flagged_count ? el('span', { class: 'badge warn' }, `${fa(s.flagged_count)} صفحه مشکوک`) : null)))
          : el('div', { class: 'empty' }, 'منبع آماده‌ای وجود ندارد. ', el('a', { href: '#sources' }, 'بارگذاری منبع')),
        el('label', { class: 'field', style: { marginTop: '12px' } }, el('span', {}, 'فصل‌ها و مباحث'), topicsBox),
        el('div', { class: 'grid g2' }, el('label', { class: 'field' }, el('span', {}, 'صفحات مجاز (چاپی)'), el('div', { class: 'row' }, f.pf, f.pt)), el('label', { class: 'field' }, el('span', {}, 'تمرکز محتوایی (اختیاری)'), f.query)),
        el('label', { class: 'check' }, f.flagged, 'استفاده از صفحات علامت‌خورده (توصیه نمی‌شود)'), el('br'),
        el('label', { class: 'check' }, f.ext, 'اجازه دانش عمومی هم‌سطح کتاب (پاسخ همچنان باید با منبع اثبات شود)')),
      el('section', { class: 'card' }, el('h3', {}, '۲. مشخصات سؤال'),
        el('label', { class: 'field' }, el('span', {}, 'سطح دشواری'), seg(LABELS.difficulty, st.difficulty, v => (st.difficulty = +v))),
        el('label', { class: 'field' }, el('span', {}, 'نوع سؤال'), seg(LABELS.qtype, st.qtype, v => (st.qtype = v))),
        el('div', { class: 'grid g2' }, el('label', { class: 'field' }, el('span', {}, 'تعداد سؤال'), f.count), el('label', { class: 'field' }, el('span', {}, 'سطح شناختی'), f.cognitive),
          el('label', { class: 'field' }, el('span', {}, 'میزان ترکیبی‌بودن'), f.combination), el('label', { class: 'field' }, el('span', {}, 'آزمون هدف'), f.target),
          el('label', { class: 'field' }, el('span', {}, 'پیچیدگی گزینه‌ها'), f.oc), el('label', { class: 'field' }, el('span', {}, 'درس'), f.subject),
          el('label', { class: 'field' }, el('span', {}, 'رشته'), f.field), el('label', { class: 'field' }, el('span', {}, 'پایه'), f.grade)),
        el('label', { class: 'field' }, el('span', {}, 'سبک طراحی'), f.style),
        el('div', { class: 'row' }, btn, el('span', { class: 'muted small' }, 'هر سؤال: ۱ فراخوانی طراح (گروهی) + منتقد + حل‌کننده مستقل')))),
    jobsBox);
  renderTopics();
}

function jobsTable(jobs) {
  if (!jobs.length) return el('div', { class: 'empty' }, 'هنوز درخواست تولیدی ثبت نشده است.');
  return el('table', { class: 't' }, el('tr', {}, ['#', 'زمان', 'مشخصات', 'وضعیت', 'تولید', 'فراخوانی', 'توکن', 'هزینه', ''].map(h => el('th', {}, h))),
    jobs.map(j => el('tr', {}, el('td', { class: 'num' }, fa(j.id)), el('td', {}, jdate(j.created_at)),
      el('td', { class: 'small' }, `${LABELS.difficulty[j.params.difficulty]} • ${LABELS.qtype[j.params.qtype]}${j.params.variantOf ? ' • نسخه متفاوت' : ''}`, el('div', { class: 'muted' }, [...(j.params.chapters || []), ...(j.params.topics || [])].join('، '))),
      el('td', {}, el('span', { class: 'badge ' + JOB[j.status][1] }, j.status === 'running' ? el('span', { class: 'spinner', style: { width: '10px', height: '10px', verticalAlign: 'middle' } }) : null, ' ', JOB[j.status][0]),
        j.error || j.refused_reason ? el('div', { class: 'small muted', style: { maxWidth: '280px' } }, j.error || j.refused_reason) : null),
      el('td', { class: 'num' }, `${fa(j.produced_count)} / ${fa(j.requested_count)}`), el('td', { class: 'num' }, fa(j.calls)), el('td', { class: 'num small' }, `${fa(j.prompt_tokens)} / ${fa(j.completion_tokens)}`), el('td', { class: 'num' }, '$' + faNum(j.est_cost, 3)),
      el('td', {}, el('div', { class: 'row' },
        ['queued', 'running'].includes(j.status) ? el('button', { class: 'btn sm danger', type: 'button', onclick: async () => { try { await api('POST', `/api/admin/jobs/${j.id}/cancel`); toast('توقف درخواست شد.'); } catch (e) { fail(e); } } }, 'توقف') : null,
        ['failed', 'cancelled'].includes(j.status) ? el('button', { class: 'btn sm', type: 'button', onclick: async () => { try { await api('POST', `/api/admin/jobs/${j.id}/retry`); toast('ادامه تولید آغاز شد.'); generateView(); } catch (e) { fail(e); } } }, 'ادامه') : null,
        j.produced_count ? el('button', { class: 'btn sm', type: 'button', onclick: () => go('#review?job=' + j.id) }, 'سؤال‌ها') : null)))));
}
