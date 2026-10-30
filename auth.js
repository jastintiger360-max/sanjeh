import { readJson, sendJson, now, HttpError, bad, v } from '../http/util.js';
import { verifyPassword, hashPassword, validatePasswordStrength, DUMMY_HASH } from '../auth/password.js';
import { createSession, sessionCookie } from '../auth/sessions.js';
import { audit } from '../services/audit.js';

export function authRoutes(r, ctx) {
  const { db, limiter, settings } = ctx;

  r.post('/api/auth/login', async (req, res) => {
    const body = await readJson(req, 10_000);
    const username = String(body.username || '').trim().toLowerCase().slice(0, 60);
    const password = String(body.password || '');
    const ipKey = limiter.check('login-ip:' + req.ip, 20, 15 * 60_000);
    const userKey = limiter.check('login-user:' + username, 10, 15 * 60_000);
    if (!ipKey.ok || !userKey.ok) throw new HttpError(429, 'تعداد تلاش‌های ورود بیش از حد است. چند دقیقه بعد دوباره تلاش کنید.');
    const u = await db.get('SELECT * FROM users WHERE username = ?', [username]);
    const ok = await verifyPassword(password, u?.password_hash || DUMMY_HASH);
    if (u && u.locked_until && u.locked_until > now()) throw new HttpError(423, 'حساب به‌دلیل تلاش‌های ناموفق موقتاً قفل شده است.');
    if (!u || !ok || !u.active) {
      if (u) {
        const fails = u.failed_logins + 1;
        await db.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', [fails, fails >= 8 ? now() + 15 * 60_000 : null, u.id]);
      }
      await audit(db, { userId: u?.id || null, action: 'auth.login_failed', details: { username }, ip: req.ip });
      throw new HttpError(401, u && !u.active && ok ? 'حساب کاربری غیرفعال است.' : 'نام کاربری یا رمز عبور نادرست است.');
    }
    await db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [u.id]);
    const { token, csrf } = await createSession(ctx, u, req);
    await audit(db, { userId: u.id, action: 'auth.login', ip: req.ip });
    sendJson(res, 200, { user: { id: u.id, fullName: u.full_name, role: u.role, mustChangePassword: !!u.must_change_password }, csrf, redirect: u.role === 'admin' ? '/admin/' : '/student/' },
      { 'Set-Cookie': sessionCookie(ctx, token, ctx.cfg.session.ttlHours * 3600) });
  });

  r.post('/api/auth/logout', async (req, res) => {
    if (req.session?.sid) await db.run('UPDATE sessions SET revoked = 1 WHERE id = ?', [req.session.sid]);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(ctx, '', 0) });
  });

  r.get('/api/auth/me', async (req, res) => {
    const s = await settings.all();
    if (!req.session?.user) return sendJson(res, 200, { user: null, revoked: !!req.session?.revoked, app: { name: s.app_name, tagline: s.app_tagline } });
    sendJson(res, 200, { user: req.session.user, csrf: req.session.csrf, server_now: now(), app: { name: s.app_name, tagline: s.app_tagline } });
  });

  r.post('/api/auth/password', async (req, res) => {
    if (!req.session?.user) throw new HttpError(401, 'لطفاً وارد شوید.');
    const body = await readJson(req, 10_000);
    const u = await db.get('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
    if (!(await verifyPassword(String(body.current || ''), u.password_hash))) throw bad('رمز فعلی نادرست است.');
    const err = validatePasswordStrength(body.next); if (err) throw bad(err);
    await db.run('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?', [await hashPassword(body.next), now(), u.id]);
    await db.run('UPDATE sessions SET revoked = 1 WHERE user_id = ? AND id <> ?', [u.id, req.session.sid]);
    await audit(db, { userId: u.id, action: 'auth.password_change', ip: req.ip });
    sendJson(res, 200, { ok: true });
  });
}
