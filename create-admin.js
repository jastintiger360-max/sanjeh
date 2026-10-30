// استفاده: node scripts/create-admin.js <username> <password> [full name]
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { hashPassword, validatePasswordStrength } from '../src/auth/password.js';
const [username, password, ...name] = process.argv.slice(2);
if (!username || !password) { console.error('usage: create-admin <username> <password> [full name]'); process.exit(1); }
const err = validatePasswordStrength(password); if (err || password.length < 12) { console.error(err || 'رمز مدیر باید حداقل ۱۲ کاراکتر باشد.'); process.exit(1); }
const db = await openDb(loadConfig());
const t = Date.now();
const ex = await db.get('SELECT id FROM users WHERE username = ?', [username.toLowerCase()]);
if (ex) await db.run("UPDATE users SET password_hash = ?, role = 'admin', active = 1, updated_at = ? WHERE id = ?", [await hashPassword(password), t, ex.id]);
else await db.run("INSERT INTO users(username, full_name, role, password_hash, created_at, updated_at) VALUES (?,?,'admin',?,?,?)", [username.toLowerCase(), name.join(' ') || 'مدیر', await hashPassword(password), t, t]);
console.log('ok'); await db.close();
