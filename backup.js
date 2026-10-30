// پشتیبان‌گیری آنلاین از SQLite به همراه فایل‌های منابع. برای Postgres از pg_dump استفاده کنید.
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
const cfg = loadConfig();
if (cfg.db.driver !== 'sqlite') { console.error('برای Postgres: pg_dump "$DATABASE_URL" > backup.sql و کپی پوشه DATA_DIR/storage'); process.exit(1); }
const db = await openDb(cfg);
const dir = path.join(cfg.dataDir, 'backups'); await fs.mkdir(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = path.join(dir, `sanjeh-${stamp}.db`);
await db.backup(file); await db.close();
await fs.cp(cfg.storageDir, path.join(dir, `storage-${stamp}`), { recursive: true });
console.log('backup:', file);
