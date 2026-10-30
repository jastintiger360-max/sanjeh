import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db/index.js';
import { Router } from './http/router.js';
import { HttpError, sendJson, clientIp, now } from './http/util.js';
import { securityHeaders, RateLimiter } from './http/security.js';
import { loadSession } from './auth/sessions.js';
import { hashPassword } from './auth/password.js';
import { createSettings } from './services/settings.js';
import { createAi } from './ai/provider.js';
import { createSourceService } from './services/sources.js';
import { createQuestionService } from './services/questions.js';
import { createPipeline } from './ai/pipeline.js';
import { createExamService } from './services/exams.js';
import { createAttemptService } from './services/attempts.js';
import { createAnalytics } from './services/analytics.js';
import { createStudentService } from './services/students.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { studentRoutes } from './routes/student.js';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json' };

async function serveStatic(req, res, rel) {
  const file = path.resolve(PUBLIC, '.' + rel);
  if (!file.startsWith(PUBLIC + path.sep)) return false;
  try {
    const st = await fs.stat(file); if (!st.isFile()) return false;
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': rel.endsWith('.html') ? 'no-store' : 'no-cache' });
    res.end(await fs.readFile(file));
    return true;
  } catch { return false; }
}

export async function createApp(cfg) {
  const db = await openDb(cfg);
  const ctx = { cfg, db, limiter: new RateLimiter() };
  ctx.settings = createSettings(db);
  ctx.ai = createAi(ctx);
  ctx.sources = createSourceService(ctx);
  ctx.questions = createQuestionService(ctx);
  ctx.pipeline = createPipeline(ctx);
  ctx.exams = createExamService(ctx);
  ctx.attempts = createAttemptService(ctx);
  ctx.analytics = createAnalytics(ctx);
  ctx.students = createStudentService(ctx);

  // مدیر اولیه
  const admins = await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
  if (!admins.n && cfg.admin.username && cfg.admin.password) {
    const t = now();
    await db.run("INSERT INTO users(username, full_name, role, password_hash, created_at, updated_at) VALUES (?,?,'admin',?,?,?)", [cfg.admin.username.toLowerCase(), 'مدیر سامانه', await hashPassword(cfg.admin.password), t, t]);
    console.log(`[sanjeh] مدیر اولیه «${cfg.admin.username}» ساخته شد.`);
  }

  const router = new Router();
  authRoutes(router, ctx); adminRoutes(router, ctx); studentRoutes(router, ctx);
  router.get('/healthz', async (req, res) => sendJson(res, 200, { ok: true, db: db.dialect, ai: ctx.ai.enabled() }));

  const https = cfg.publicOrigin.startsWith('https://');
  const server = http.createServer(async (req, res) => {
    req.ip = clientIp(req);
    securityHeaders(res, { https });
    let url;
    try { url = new URL(req.url, 'http://local'); } catch { res.writeHead(400); return res.end(); }
    req.query = url.searchParams;
    const p = url.pathname;
    try {
      req.session = await loadSession(ctx, req);
      if (p.startsWith('/api/')) {
        const rl = ctx.limiter.check('api:' + (req.session?.sid || req.ip), 600, 60_000);
        if (!rl.ok) throw new HttpError(429, 'درخواست‌ها بیش از حد مجاز است.');
        if (!['GET', 'HEAD'].includes(req.method)) {
          // CSRF: کوکی SameSite=Strict + توکن سرآیند + بررسی Origin
          const origin = req.headers.origin;
          if (origin && cfg.publicOrigin && origin !== cfg.publicOrigin) throw new HttpError(403, 'مبدأ درخواست مجاز نیست.');
          if (p === '/api/auth/login') { if (req.headers['x-requested-with'] !== 'sanjeh') throw new HttpError(403, 'درخواست نامعتبر.'); }
          else if (req.session?.user && req.headers['x-csrf-token'] !== req.session.csrf) throw new HttpError(403, 'توکن امنیتی نامعتبر است؛ صفحه را دوباره بارگذاری کنید.', { code: 'CSRF' });
        }
        if (p.startsWith('/api/admin/') && req.method === 'POST' && p.endsWith('/jobs')) {
          const g = ctx.limiter.check('gen:' + req.session?.user?.id, 30, 3600_000);
          if (!g.ok) throw new HttpError(429, 'سقف درخواست تولید در ساعت پر شده است.');
        }
        const m = router.match(req.method, p);
        if (!m) throw new HttpError(404, 'مسیر یافت نشد.');
        if (m.methodNotAllowed) throw new HttpError(405, 'روش درخواست مجاز نیست.');
        req.params = m.params;
        for (const h of m.handlers) { await h(req, res); if (res.writableEnded || res.headersSent) break; }
        return;
      }
      if (p === '/healthz') { const m = router.match('GET', p); return m.handlers[0](req, res); }
      // صفحات
      if (p === '/' ) { res.writeHead(302, { Location: req.session?.user?.role === 'admin' ? '/admin/' : req.session?.user ? '/student/' : '/login' }); return res.end(); }
      if (p === '/login') return void (await serveStatic(req, res, '/login.html'));
      if (p === '/admin' || p.startsWith('/admin/')) {
        // کد پنل مدیریت فقط به نشست مدیر تحویل داده می‌شود
        if (req.session?.user?.role !== 'admin') { res.writeHead(302, { Location: '/login?next=admin' }); return res.end(); }
        const rel = p === '/admin' || p === '/admin/' ? '/admin/index.html' : p;
        if (await serveStatic(req, res, rel)) return;
      }
      if (p === '/student' || p.startsWith('/student/')) {
        const rel = p === '/student' || p === '/student/' ? '/student/index.html' : p;
        if (await serveStatic(req, res, rel)) return;
      }
      if (p.startsWith('/assets/') && await serveStatic(req, res, p)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('یافت نشد');
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, ...e.extra });
      if (e?.code === 'AI_UNAVAILABLE') return sendJson(res, 503, { error: e.message, code: 'AI_DISABLED' });
      if (e?.code === 'AI_CALL') return sendJson(res, 502, { error: e.message });
      console.error('[sanjeh] خطای داخلی', e);
      if (!res.headersSent) sendJson(res, 500, { error: 'خطای داخلی سرور.' }); else res.end();
    }
  });
  server.requestTimeout = 15 * 60_000;
  server.headersTimeout = 30_000;

  const sweeper = setInterval(() => ctx.attempts.sweep().catch(e => console.error('sweep', e)), 15_000); sweeper.unref();
  const cleaner = setInterval(() => db.run('DELETE FROM sessions WHERE expires_at < ? OR (revoked = 1 AND last_seen < ?)', [now(), now() - 86400_000]).catch(() => {}), 3600_000); cleaner.unref();
  await ctx.pipeline.recoverOnBoot();

  return { server, ctx, async close() { clearInterval(sweeper); clearInterval(cleaner); ctx.pipeline.stop(); await new Promise(r => server.close(r)); await db.close(); } };
}
