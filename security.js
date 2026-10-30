// سرآیندهای امنیتی و محدودکننده نرخ درخواست
export function securityHeaders(res, { https }) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob:", "connect-src 'self'",
    "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

export class RateLimiter {
  // پنجره لغزان ساده در حافظه؛ برای چند نمونه سرور از Redis یا محدودیت reverse proxy استفاده کنید.
  constructor() { this.hits = new Map(); setInterval(() => this.sweep(), 60_000).unref(); }
  check(key, limit, windowMs) {
    const t = Date.now();
    let arr = this.hits.get(key);
    if (!arr) { arr = []; this.hits.set(key, arr); }
    while (arr.length && arr[0] <= t - windowMs) arr.shift();
    if (arr.length >= limit) return { ok: false, retryAfter: Math.ceil((arr[0] + windowMs - t) / 1000) };
    arr.push(t);
    return { ok: true };
  }
  sweep() { const t = Date.now(); for (const [k, a] of this.hits) if (!a.length || a[a.length - 1] < t - 3600_000) this.hits.delete(k); }
}
