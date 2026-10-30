import { api, state } from './common.js';
const $ = (id) => document.getElementById(id);
api('GET', '/api/auth/me').then(me => {
  if (me.app) { $('brand').textContent = me.app.name; $('tagline').textContent = me.app.tagline || ''; document.title = 'ورود | ' + me.app.name; }
  if (me.user) location.href = me.user.role === 'admin' ? '/admin/' : '/student/';
  if (me.revoked) $('err').textContent = 'نشست قبلی شما به‌دلیل ورود از دستگاه دیگر بسته شد.';
}).catch(() => {});
$('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('err').textContent = ''; $('go').disabled = true;
  try {
    const r = await api('POST', '/api/auth/login', { username: $('u').value.trim(), password: $('p').value });
    state.csrf = r.csrf;
    location.href = r.redirect;
  } catch (err) { $('err').textContent = err.message; $('go').disabled = false; }
});
