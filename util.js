import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
export const bad = (m, extra) => new HttpError(400, m, extra);
export const forbidden = (m = 'دسترسی مجاز نیست.') => new HttpError(403, m);
export const notFound = (m = 'یافت نشد.') => new HttpError(404, m);
export const conflict = (m, extra) => new HttpError(409, m, extra);

export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'حجم درخواست بیش از حد مجاز است.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, limit = 2 * 1024 * 1024) {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) throw bad('نوع محتوا باید JSON باشد.');
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw bad('JSON نامعتبر است.'); }
}

// تجزیه multipart/form-data (برای بارگذاری فایل)
export async function readMultipart(req, limit) {
  const ct = req.headers['content-type'] || '';
  const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!ct.startsWith('multipart/form-data') || !m) throw bad('درخواست باید multipart باشد.');
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const buf = await readBody(req, limit);
  const fields = {}; const files = [];
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const next = buf.indexOf(boundary, pos + boundary.length);
    if (next === -1) break;
    const part = buf.subarray(pos + boundary.length + 2, next - 2); // حذف \r\n
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd > -1) {
      const head = part.subarray(0, headEnd).toString('utf8');
      const body = part.subarray(headEnd + 4);
      const name = head.match(/name="([^"]*)"/i)?.[1];
      const filename = head.match(/filename\*?="?([^";\r\n]*)"?/i)?.[1];
      const type = head.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim();
      if (filename !== undefined && filename !== '') files.push({ field: name, filename: decodeURIComponent(filename), type, data: Buffer.from(body) });
      else if (name) fields[name] = body.toString('utf8');
    }
    pos = next;
  }
  return { fields, files };
}

export const now = () => Date.now();
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
export const safeJson = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };

export function clientIp(req) {
  // اگر پشت reverse proxy مطمئن هستید TRUST_PROXY=1 را تنظیم کنید.
  if (process.env.TRUST_PROXY === '1') {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

// اعتبارسنجی ساده و صریح ورودی‌ها
export const v = {
  str(val, name, { min = 0, max = 10000, optional = false } = {}) {
    if (val === undefined || val === null || val === '') { if (optional) return null; throw bad(`«${name}» الزامی است.`); }
    if (typeof val !== 'string') throw bad(`«${name}» باید متن باشد.`);
    const s = val.trim();
    if (s.length < min || s.length > max) throw bad(`طول «${name}» باید بین ${min} و ${max} باشد.`);
    return s;
  },
  int(val, name, { min = -Infinity, max = Infinity, optional = false } = {}) {
    if (val === undefined || val === null || val === '') { if (optional) return null; throw bad(`«${name}» الزامی است.`); }
    const n = Number(val);
    if (!Number.isInteger(n) || n < min || n > max) throw bad(`«${name}» باید عدد صحیح بین ${min} و ${max} باشد.`);
    return n;
  },
  num(val, name, { min = -Infinity, max = Infinity, optional = false } = {}) {
    if (val === undefined || val === null || val === '') { if (optional) return null; throw bad(`«${name}» الزامی است.`); }
    const n = Number(val);
    if (!Number.isFinite(n) || n < min || n > max) throw bad(`«${name}» نامعتبر است.`);
    return n;
  },
  oneOf(val, name, list, { optional = false } = {}) {
    if ((val === undefined || val === null || val === '') && optional) return null;
    if (!list.includes(val)) throw bad(`مقدار «${name}» نامعتبر است.`);
    return val;
  },
  bool(val) { return val === true || val === 1 || val === '1' || val === 'true'; },
  ids(val, name) {
    if (!Array.isArray(val)) throw bad(`«${name}» باید فهرست باشد.`);
    return val.map(x => v.int(x, name, { min: 1 }));
  },
};
