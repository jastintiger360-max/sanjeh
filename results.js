import { el, svgEl, api, fail, fa, faNum, jdate, LABELS, duration } from '/assets/common.js';
import { page, go } from './app.js';

function histogram(bins) {
  const W = 560, H = 200, pad = 28, max = Math.max(1, ...bins.map(b => b.n)); const bw = (W - pad * 2) / bins.length;
  return svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'توزیع درصدها' },
    ...bins.map((b, i) => { const h = (b.n / max) * (H - pad * 2); const x = W - pad - (i + 1) * bw; return [svgEl('rect', { x: x + 3, y: H - pad - h, width: bw - 6, height: Math.max(h, 1), rx: 3, fill: 'oklch(0.53 0.17 18)', opacity: 0.25 + 0.75 * (b.n / max) }),
      b.n ? svgEl('text', { x: x + bw / 2, y: H - pad - h - 5, 'text-anchor': 'middle' }, fa(b.n)) : null, svgEl('text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle' }, fa(b.from))]; }).flat());
}
function lineChart(series, labels) {
  const W = 620, H = 220, pad = 34;
  const all = series.flatMap(s => s.values).filter(v => v != null); const max = Math.max(100, ...all), min = Math.min(0, ...all);
  const x = i => W - pad - (labels.length === 1 ? (W - 2 * pad) / 2 : i * (W - 2 * pad) / (labels.length - 1)); const y = v => H - pad - (v - min) / (max - min) * (H - 2 * pad);
  const colors = ['oklch(0.53 0.17 18)', 'oklch(0.29 0.012 260)', 'oklch(0.52 0.12 150)', 'oklch(0.62 0.14 70)'];
  return svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart' },
    svgEl('line', { x1: pad, x2: W - pad, y1: y(0), y2: y(0), stroke: 'oklch(0.9 0.008 18)' }),
    ...labels.map((l, i) => svgEl('text', { x: x(i), y: H - 8, 'text-anchor': 'middle' }, l.slice(0, 16))),
    ...series.map((s, si) => [svgEl('polyline', { points: s.values.map((v, i) => v == null ? null : `${x(i)},${y(v)}`).filter(Boolean).join(' '), fill: 'none', stroke: colors[si % 4], 'stroke-width': 2.5 }),
      ...s.values.map((v, i) => v == null ? null : svgEl('circle', { cx: x(i), cy: y(v), r: 4, fill: colors[si % 4] }))]).flat());
}

export async function resultsView() {
  let exams; try { exams = (await api('GET', '/api/admin/exams')).filter(e => e.status !== 'draft'); } catch (e) { return fail(e); }
  page('نتایج و تحلیل عملکرد', el('a', { class: 'btn', href: '#compare' }, 'مقایسه آزمون‌ها'),
    el('section', { class: 'card' }, exams.length ? el('table', { class: 't' }, el('tr', {}, ['آزمون', 'زمان', 'تحویل‌شده', ''].map(h => el('th', {}, h))),
      exams.map(e => el('tr', { class: 'click', onclick: () => go('#results/' + e.id) }, el('td', {}, el('strong', {}, e.title)), el('td', { class: 'small' }, jdate(e.start_at)), el('td', { class: 'num' }, fa(e.finished_count)), el('td', {}, 'مشاهده')))) : el('div', { class: 'empty' }, 'آزمون منتشرشده‌ای وجود ندارد.')));
}

export async function examResults(id) {
  let r; try { r = await api('GET', `/api/admin/exams/${id}/results`); } catch (e) { return fail(e); }
  const s = r.stats;
  page(`نتایج: ${r.exam.title}`, el('div', { class: 'row' }, el('a', { class: 'btn', href: `/api/admin/exams/${id}/results.xlsx` }, 'خروجی Excel'), el('a', { class: 'btn', href: '#exams/' + id }, 'آزمون')),
    el('section', { class: 'hero-strip' }, el('div', { class: 'stat lead' }, el('span', { class: 'v num' }, s.mean != null ? faNum(s.mean, 1) + '٪' : '—'), el('span', { class: 'l' }, 'میانگین درصد')),
      el('div', { class: 'stat', style: { padding: '18px 20px' } }, el('span', { class: 'v num' }, `${fa(r.participation.finished)} / ${fa(r.participation.assigned_students)}`), el('span', { class: 'l' }, 'شرکت‌کننده / اختصاص‌یافته')),
      el('div', { class: 'stat', style: { padding: '18px 20px' } }, el('span', { class: 'v num' }, s.median != null ? faNum(s.median, 1) : '—'), el('span', { class: 'l' }, 'میانه')),
      el('div', { class: 'stat', style: { padding: '18px 20px' } }, el('span', { class: 'v num' }, s.sd != null ? faNum(s.sd, 1) : '—'), el('span', { class: 'l' }, `انحراف معیار • بیشینه ${faNum(s.max, 1)} • کمینه ${faNum(s.min, 1)}`))),
    el('div', { class: 'grid g2', style: { marginTop: '16px', alignItems: 'start' } },
      el('section', { class: 'card' }, el('h3', {}, 'توزیع درصدها'), histogram(r.histogram), r.negatives ? el('p', { class: 'small muted' }, `${fa(r.negatives)} نفر درصد منفی دارند (در نمودار در بازه صفر).`) : null),
      el('section', { class: 'card' }, el('h3', {}, 'سطح دشواری سؤال‌ها در عمل'), el('div', { class: 'ladder' }, Object.entries(r.by_difficulty).map(([k, o]) => el('div', { class: 'r' }, el('span', {}, LABELS.difficulty[k]), el('div', { class: 'track' }, el('i', { style: { width: (o.mean_p * 100) + '%', background: `var(--d${k})` } })), el('span', { class: 'num' }, faNum(o.mean_p * 100, 0) + '٪')))),
        el('p', { class: 'small muted', style: { marginTop: '8px' } }, 'درصد پاسخ صحیح در هر سطح طراحی‌شده؛ اگر سؤال «دشوار» پاسخ صحیح بالایی دارد، برچسب دشواری آن را بازنگری کنید.'))),
    el('section', { class: 'card scroll-x', style: { marginTop: '16px' } }, el('h3', {}, 'کارنامه شرکت‌کنندگان'), r.attempts.length ? el('table', { class: 't' }, el('tr', {}, ['رتبه', 'نام', 'وضعیت', 'نمره', 'درصد', 'ص / غ / ن', 'زمان', ''].map(h => el('th', {}, h))),
      r.attempts.map(a => el('tr', {}, el('td', { class: 'num' }, fa(a.rank ?? '—')), el('td', {}, a.full_name), el('td', {}, { submitted: 'تحویل', expired: 'پایان زمان', in_progress: 'در حال انجام', voided: 'باطل' }[a.status]),
        el('td', { class: 'num' }, a.score != null ? `${faNum(a.score)} / ${faNum(a.max_score)}` : '—'), el('td', { class: 'num' }, a.percent != null ? faNum(a.percent) + '٪' : '—'), el('td', { class: 'num' }, a.correct_count != null ? `${fa(a.correct_count)} / ${fa(a.wrong_count)} / ${fa(a.blank_count)}` : '—'),
        el('td', { class: 'num' }, duration(a.time_spent_ms)), el('td', {}, a.score != null ? el('a', { href: `/api/admin/attempts/${a.id}/report.html`, target: '_blank', rel: 'noopener' }, 'کارنامه / PDF') : null)))) : el('div', { class: 'empty' }, 'هنوز کسی آزمون را تحویل نداده است.')),
    el('section', { class: 'card scroll-x', style: { marginTop: '16px' } }, el('h3', {}, 'تحلیل سؤال‌ها'), el('table', { class: 't' }, el('tr', {}, ['#', 'سؤال', 'دشواری', 'ضریب دشواری (p)', 'ضریب تمیز', 'توزیع گزینه‌ها', 'نزده'].map(h => el('th', {}, h))),
      r.items.map(it => el('tr', {}, el('td', { class: 'num' }, fa(it.position)), el('td', { style: { maxWidth: '380px' } }, el('a', { href: '#q/' + it.question_id }, it.stem)), el('td', {}, LABELS.difficulty[it.difficulty]),
        el('td', { class: 'num' }, faNum(it.p)), el('td', { class: 'num' }, it.discrimination == null ? '—' : el('span', { class: 'badge ' + (it.discrimination < 0.2 ? 'bad' : it.discrimination < 0.3 ? 'warn' : 'ok') }, faNum(it.discrimination))),
        el('td', { class: 'small' }, it.distribution.map((n, k) => el('span', { style: { marginInlineEnd: '8px', fontWeight: k === it.correct_index ? 900 : 400, color: k === it.correct_index ? 'var(--ok)' : 'inherit' } }, `${fa(k + 1)}: ${fa(n)}`))), el('td', { class: 'num' }, fa(it.blank)))))));
}

export async function compareView() {
  let exams; try { exams = (await api('GET', '/api/admin/exams')).filter(e => e.status !== 'draft'); } catch (e) { return fail(e); }
  const checks = exams.map(e => ({ e, cb: el('input', { type: 'checkbox' }) }));
  const out = el('div');
  async function run() {
    const ids = checks.filter(c => c.cb.checked).map(c => c.e.id); if (ids.length < 2) return out.replaceChildren(el('p', { class: 'muted' }, 'حداقل دو آزمون انتخاب کنید.'));
    try {
      const r = await api('GET', '/api/admin/compare?exams=' + ids.join(','));
      out.replaceChildren(el('section', { class: 'card', style: { marginTop: '14px' } }, el('h3', {}, 'میانگین درصد آزمون‌ها'), lineChart([{ values: r.exams.map(e => e.stats.mean) }], r.exams.map(e => e.title))),
        el('section', { class: 'card scroll-x', style: { marginTop: '14px' } }, el('h3', {}, 'عملکرد دانش‌آموزان'), el('table', { class: 't' }, el('tr', {}, el('th', {}, 'دانش‌آموز'), r.exams.map(e => el('th', {}, e.title))),
          r.students.map(s => el('tr', {}, el('td', {}, s.full_name), r.exams.map(e => el('td', { class: 'num' }, s.percents[e.id] != null ? faNum(s.percents[e.id]) + '٪' : '—')))))));
    } catch (e) { fail(e); }
  }
  page('مقایسه آزمون‌ها', el('a', { class: 'btn', href: '#results' }, 'بازگشت'), el('section', { class: 'card' }, el('div', { class: 'checklist' }, checks.map(({ e, cb }) => el('label', {}, cb, e.title, el('span', { class: 'muted small' }, jdate(e.start_at))))),
    el('button', { class: 'btn primary', type: 'button', style: { marginTop: '10px' }, onclick: run }, 'مقایسه')), out);
}
