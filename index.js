// لایه پایگاه داده با رابط async یکسان برای SQLite (تست‌شده) و PostgreSQL.
// همه کوئری‌ها با placeholder «?» نوشته می‌شوند؛ آداپتور Postgres آن‌ها را به $n تبدیل می‌کند.
import { AsyncLocalStorage } from 'node:async_hooks';
import { migrate } from './schema.js';

const als = new AsyncLocalStorage();

class SqliteAdapter {
  constructor(file) { this.file = file; this.dialect = 'sqlite'; this._queue = Promise.resolve(); }
  async open() {
    const { DatabaseSync } = await import('node:sqlite');
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
  }
  _norm(params) { return params.map(v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v); }
  async _gate() {
    // اگر تراکنشی در جریان است و این فراخوانی داخل آن نیست، صبر کن تا تمام شود.
    const ctx = als.getStore();
    if (ctx && ctx.db === this) return;
    while (this._txActive) await this._txActive;
  }
  async all(sql, params = []) { await this._gate(); return this.db.prepare(sql).all(...this._norm(params)).map(r => ({ ...r })); }
  async get(sql, params = []) { await this._gate(); const r = this.db.prepare(sql).get(...this._norm(params)); return r ? { ...r } : undefined; }
  async run(sql, params = []) {
    await this._gate();
    const info = this.db.prepare(sql).run(...this._norm(params));
    return { changes: Number(info.changes), lastId: Number(info.lastInsertRowid) };
  }
  async insert(sql, params = []) { const r = await this.get(sql + ' RETURNING id', params); return r.id; }
  async exec(sql) { await this._gate(); this.db.exec(sql); }
  async tx(fn) {
    const ctx = als.getStore();
    if (ctx && ctx.db === this) return fn(); // تراکنش تودرتو = همان تراکنش
    while (this._txActive) await this._txActive;
    let release; this._txActive = new Promise(r => (release = r));
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const out = await als.run({ db: this }, fn);
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw e;
    } finally { this._txActive = null; release(); }
  }
  async backup(target) { await this._gate(); this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`); }
  async close() { this.db?.close(); }
}

class PostgresAdapter {
  // توجه: این آداپتور در محیط توسعه فعلی (بدون دسترسی به Postgres) اجرا نشده است. پیش از استقرار، npm test را با DB_DRIVER=postgres اجرا کنید.
  constructor(url) { this.url = url; this.dialect = 'postgres'; }
  async open() {
    let pg;
    try { pg = (await import('pg')).default; } catch { throw new Error('برای DB_DRIVER=postgres بسته pg را نصب کنید: npm install pg'); }
    pg.types.setTypeParser(20, v => Number(v)); // BIGINT → Number
    pg.types.setTypeParser(1700, v => Number(v));
    this.pool = new pg.Pool({ connectionString: this.url, max: 15 });
  }
  _sql(sql) { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); }
  _norm(params) { return params.map(v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v); }
  _client() { const c = als.getStore(); return c && c.db === this ? c.client : this.pool; }
  async all(sql, p = []) { return (await this._client().query(this._sql(sql), this._norm(p))).rows; }
  async get(sql, p = []) { return (await this.all(sql, p))[0]; }
  async run(sql, p = []) { const r = await this._client().query(this._sql(sql), this._norm(p)); return { changes: r.rowCount, lastId: null }; }
  async insert(sql, p = []) { const r = await this.get(sql + ' RETURNING id', p); return r.id; }
  async exec(sql) { await this._client().query(sql); }
  async tx(fn) {
    const ctx = als.getStore();
    if (ctx && ctx.db === this) return fn();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await als.run({ db: this, client }, fn);
      await client.query('COMMIT');
      return out;
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
  }
  async backup() { throw new Error('برای Postgres از pg_dump استفاده کنید (docs/DEPLOY.md).'); }
  async close() { await this.pool?.end(); }
}

export async function openDb(cfg) {
  const db = cfg.db.driver === 'postgres' ? new PostgresAdapter(cfg.db.url) : new SqliteAdapter(cfg.db.sqliteFile);
  await db.open();
  await migrate(db);
  return db;
}
