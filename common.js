// ابزار مشترک کلاینت: ساخت امن DOM (بدون innerHTML)، API با توکن CSRF، تاریخ شمسی، اعداد فارسی
export const state = { csrf: null, user: null, app: { name: 'سنجه' } };

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k === 'value') n.value = v;
    else if (k === 'checked') n.checked = !!v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
export const svgEl = (tag, attrs = {}, ...children) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); for (const c of children.flat()) if (c) n.append(c instanceof Node ? c : document.createTextNode(String(c))); return n; };

export const fa = (x) => (x == null ? '—' : String(x).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]).replace(/\./g, '٫'));
export const faNum = (x, d = 2) => (x == null || Number.isNaN(+x) ? '—' : fa(Math.round(+x * 10 ** d) / 10 ** d));
const dtf = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { dateStyle: 'medium', timeStyle: 'short' });
const df = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { dateStyle: 'medium' });
export const jdate = (t) => (t ? dtf.format(new Date(t)) : '—');
export const jday = (t) => (t ? df.format(new Date(t)) : '—');
export const toLocalInput = (t) => { if (!t) return ''; const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
export const fromLocalInput = (s) => (s ? new Date(s).getTime() : null);
export const duration = (ms) => { if (ms == null) return '—'; const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return fa((h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0')); };

export class ApiError extends Error { constructor(status, data) { super(data?.error || 'خطا'); this.status = status; this.data = data || {}; } }
export async function api(method, url, body, { form = false } = {}) {
  const headers = {};
  if (state.csrf) headers['x-csrf-token'] = state.csrf;
  if (url === '/api/auth/login') headers['x-requested-with'] = 'sanjeh';
  let payload;
  if (form) payload = body; else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, typeof data === 'object' ? data : { error: data });
  return data;
}
export async function boot(role) {
  const me = await api('GET', '/api/auth/me');
  state.app = me.app || state.app;
  document.title = state.app.name;
  if (!me.user || me.user.role !== role) { location.href = '/login' + (role === 'admin' ? '?next=admin' : ''); return null; }
  state.user = me.user; state.csrf = me.csrf;
  return me;
}
export async function logout() { try { await api('POST', '/api/auth/logout'); } catch {} location.href = '/login'; }

let toastWrap;
export function toast(msg, kind = '') {
  if (!toastWrap) { toastWrap = el('div', { class: 'toast-wrap', role: 'status', 'aria-live': 'polite' }); document.body.append(toastWrap); }
  const t = el('div', { class: 'toast ' + kind }, msg); toastWrap.append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3500);
}
export function modal(content, { onClose } = {}) {
  const back = el('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(); } });
  const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, content);
  back.append(box); document.body.append(back);
  const key = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', key);
  function close() { back.remove(); document.removeEventListener('keydown', key); onClose?.(); }
  return { close, box };
}
export function confirmBox(title, text, { ok = 'تأیید', danger = false } = {}) {
  return new Promise(resolve => {
    const m = modal([el('h3', {}, title), el('p', { class: 'muted', style: { whiteSpace: 'pre-line' } }, text),
      el('div', { class: 'row', style: { justifyContent: 'flex-end' } },
        el('button', { class: 'btn ghost', type: 'button', onclick: () => { m.close(); resolve(false); } }, 'انصراف'),
        el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'button', onclick: () => { m.close(); resolve(true); } }, ok))], { onClose: () => resolve(false) });
  });
}
export const fail = (e) => { toast(e?.message || 'خطا', 'err'); if (e?.status === 401) setTimeout(() => (location.href = '/login'), 1500); };
export function diffMeter(level) { return el('span', { class: 'diff', title: ['', 'آسان', 'متوسط', 'دشوار', 'چالشی'][level] }, [1, 2, 3, 4].map(i => el('i', { class: i <= level ? 'on' : '' }))); }
export const LABELS = {
  difficulty: { 1: 'آسان', 2: 'متوسط', 3: 'دشوار', 4: 'چالشی' },
  cognitive: { remember: 'یادآوری', understand: 'درک', apply: 'کاربرد', analyze: 'تحلیل', evaluate: 'ارزیابی' },
  qtype: { mcq: 'چهارگزینه‌ای', statement: 'گزاره‌ای', multipart: 'چندبخشی', passage: 'متن/سناریو', image: 'تصویری', table: 'جدول/نمودار', calc: 'محاسباتی' },
  status: { generating: 'در حال تولید', pending_review: 'در انتظار بررسی', needs_revision: 'نیازمند اصلاح', approved: 'تأییدشده', rejected: 'ردشده', archived: 'آرشیوشده' },
};
export function statusBadge(s) { const k = { approved: 'ok', needs_revision: 'bad', pending_review: 'warn', rejected: 'plain', archived: 'plain' }[s] || ''; return el('span', { class: 'badge ' + k }, LABELS.status[s] || s); }
