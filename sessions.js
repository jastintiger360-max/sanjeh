import { randomToken, sha256, now, HttpError, parseCookies } from '../http/util.js';

export const COOKIE = 'snj_sid';

export async function createSession(ctx, user, req) {
  const { db, cfg, settings } = ctx;
  const token = randomToken(32);
  const csrf = randomToken(24);
  const t = now();
  // سیاست ورود هم‌زمان دانش‌آموز: با ورود جدید، نشست‌های قبلی باطل می‌شوند (قابل تنظیم)
  if (user.role === 'student' && (await settings.get('single_session_students')) !== false) {
    await db.run('UPDATE sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0', [user.id]);
  }
  await db.run('INSERT INTO sessions(id, user_id, csrf, created_at, last_seen, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?,?)',
    [sha256(token), user.id, csrf, t, t, t + cfg.session.ttlHours * 3600_000, req.ip, String(req.headers['user-agent'] || '').slice(0, 300)]);
  return { token, csrf };
}

export function sessionCookie(ctx, token, maxAgeSec) {
  const secure = ctx.cfg.publicOrigin.startsWith('https://') ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}

export async function loadSession(ctx, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token || token.length > 100) return null;
  const { db, cfg } = ctx;
  const s = await db.get(`SELECT s.id, s.user_id, s.csrf, s.last_seen, s.expires_at, s.revoked, u.username, u.full_name, u.role, u.active
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`, [sha256(token)]);
  if (!s) return null;
  const t = now();
  if (s.revoked) return { revoked: true };
  if (!s.active || s.expires_at < t || s.last_seen < t - cfg.session.idleMinutes * 60_000) return null;
  if (t - s.last_seen > 60_000) await db.run('UPDATE sessions SET last_seen = ? WHERE id = ?', [t, s.id]);
  return { sid: s.id, csrf: s.csrf, user: { id: s.user_id, username: s.username, fullName: s.full_name, role: s.role } };
}

export function requireRole(role) {
  return (req) => {
    if (!req.session?.user) throw new HttpError(401, req.session?.revoked ? 'این نشست به‌دلیل ورود از دستگاه دیگر بسته شد.' : 'لطفاً وارد شوید.', { code: req.session?.revoked ? 'SESSION_REVOKED' : 'AUTH' });
    if (req.session.user.role !== role) throw new HttpError(403, 'دسترسی مجاز نیست.');
  };
}
