import { now } from '../http/util.js';

export const DEFAULT_SETTINGS = {
  app_name: 'سنجه',
  app_tagline: 'طراحی سؤال، بانک سؤال و آزمون آنلاین',
  ai_model: null,                    // از میان AI_ALLOWED_MODELS
  ai_pricing: {},                    // { "model": { "input": دلار به ازای ۱ میلیون توکن ورودی, "output": ... } }
  max_questions_per_request: 10,
  questions_per_call: 3,
  retrieval_top_k: 8,
  evidence_min_chars: 600,
  duplicate_threshold: 0.75,
  single_session_students: true,
  default_negative_ratio: 1 / 3,
  autosave_interval_sec: 10,
  submit_grace_sec: 20,
};

export function createSettings(db) {
  let cache = null;
  async function all() {
    if (!cache) {
      const rows = await db.all('SELECT key, value FROM settings');
      cache = { ...DEFAULT_SETTINGS };
      for (const r of rows) try { cache[r.key] = JSON.parse(r.value); } catch {}
    }
    return cache;
  }
  return {
    all,
    async get(k) { return (await all())[k]; },
    async set(values) {
      for (const [k, val] of Object.entries(values)) {
        if (!(k in DEFAULT_SETTINGS)) continue;
        await db.run('INSERT INTO settings(key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [k, JSON.stringify(val), now()]);
      }
      cache = null;
      return all();
    },
  };
}
