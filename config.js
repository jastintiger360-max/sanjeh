import path from 'node:path';
import fs from 'node:fs';

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv(path.resolve(process.cwd(), '.env'));

const env = (k, d = '') => (process.env[k] ?? d);
const bool = (k, d) => { const v = process.env[k]; return v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v); };

export function loadConfig(overrides = {}) {
  const dataDir = path.resolve(overrides.dataDir || env('DATA_DIR', './data'));
  const cfg = {
    env: env('NODE_ENV', 'development'),
    port: Number(overrides.port ?? env('PORT', '8080')),
    host: env('HOST', '127.0.0.1'),
    publicOrigin: env('PUBLIC_ORIGIN', ''),
    dataDir,
    storageDir: path.join(dataDir, 'storage'),
    db: {
      driver: env('DB_DRIVER', 'sqlite'),
      url: env('DATABASE_URL', ''),
      sqliteFile: overrides.sqliteFile || path.join(dataDir, 'sanjeh.db'),
    },
    admin: { username: env('ADMIN_USERNAME', ''), password: env('ADMIN_PASSWORD', '') },
    ai: {
      provider: env('AI_PROVIDER', 'openai'),
      baseUrl: env('AI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
      apiKey: env('AI_API_KEY', ''),
      allowedModels: env('AI_ALLOWED_MODELS', '').split(',').map(s => s.trim()).filter(Boolean),
      defaultModel: env('AI_DEFAULT_MODEL', ''),
      reviewModel: env('AI_REVIEW_MODEL', ''),
      jsonMode: bool('AI_JSON_MODE', true),
      timeoutMs: Number(env('AI_TIMEOUT_MS', '120000')),
      embeddingModel: env('AI_EMBEDDING_MODEL', ''),
    },
    ocrLangs: env('OCR_LANGS', 'fas+eng'),
    session: { ttlHours: Number(env('SESSION_TTL_HOURS', '12')), idleMinutes: Number(env('SESSION_IDLE_MINUTES', '120')) },
    maxUploadBytes: Number(env('MAX_UPLOAD_MB', '200')) * 1024 * 1024,
    ...overrides.extra,
  };
  if (cfg.ai.defaultModel && !cfg.ai.allowedModels.includes(cfg.ai.defaultModel)) cfg.ai.allowedModels.unshift(cfg.ai.defaultModel);
  if (cfg.env === 'production' && cfg.admin.password && cfg.admin.password.length < 12) {
    throw new Error('ADMIN_PASSWORD باید حداقل ۱۲ کاراکتر باشد.');
  }
  fs.mkdirSync(cfg.storageDir, { recursive: true });
  return cfg;
}
