import { now, bad, notFound, conflict, v } from '../http/util.js';
import { hashPassword, validatePasswordStrength } from '../auth/password.js';
import { audit } from './audit.js';

export function createStudentService(ctx) {
  const { db } = ctx;
  return {
    async list() {
      const users = await db.all("SELECT id, username, full_name, active, field, grade, phone, notes, created_at, (SELECT COUNT(*) FROM attempts WHERE user_id = users.id AND status IN ('submitted','expired')) AS exams_done FROM users WHERE role = 'student' ORDER BY full_name");
      const mem = await db.all('SELECT gm.user_id, g.id, g.name FROM group_members gm JOIN student_groups g ON g.id = gm.group_id');
      for (const u of users) u.groups = mem.filter(m => m.user_id === u.id).map(m => ({ id: m.id, name: m.name }));
      return users;
    },
    async create(body, user, ip) {
      const username = v.str(body.username, 'نام کاربری', { min: 3, max: 50 }).toLowerCase();
      if (!/^[a-z0-9._-]+$/.test(username)) throw bad('نام کاربری فقط حروف لاتین، عدد و . _ - باشد.');
      const err = validatePasswordStrength(body.password); if (err) throw bad(err);
      if (await db.get('SELECT id FROM users WHERE username = ?', [username])) throw conflict('این نام کاربری قبلاً ثبت شده است.');
      const t = now();
      const id = await db.insert("INSERT INTO users(username, full_name, role, password_hash, active, field, grade, phone, notes, created_at, updated_at) VALUES (?,?,'student',?,1,?,?,?,?,?,?)",
        [username, v.str(body.full_name, 'نام و نام خانوادگی', { min: 2, max: 120 }), await hashPassword(body.password), body.field || null, body.grade || null, body.phone || null, body.notes || null, t, t]);
      if (Array.isArray(body.group_ids)) for (const g of v.ids(body.group_ids, 'گروه')) await db.run('INSERT INTO group_members(group_id, user_id) VALUES (?,?) ON CONFLICT DO NOTHING', [g, id]);
      await audit(db, { userId: user.id, action: 'student.create', entity: 'user', entityId: id, ip });
      return id;
    },
    async update(id, body, user, ip) {
      const s = await db.get("SELECT id FROM users WHERE id = ? AND role = 'student'", [id]);
      if (!s) throw notFound('دانش‌آموز یافت نشد.');
      const sets = []; const p = [];
      if ('full_name' in body) { sets.push('full_name = ?'); p.push(v.str(body.full_name, 'نام', { min: 2, max: 120 })); }
      for (const k of ['field', 'grade', 'phone', 'notes']) if (k in body) { sets.push(`${k} = ?`); p.push(body[k] ? String(body[k]).slice(0, 500) : null); }
      if ('active' in body) { sets.push('active = ?'); p.push(v.bool(body.active) ? 1 : 0); }
      if (body.password) { const err = validatePasswordStrength(body.password); if (err) throw bad(err); sets.push('password_hash = ?', 'failed_logins = 0', 'locked_until = NULL'); p.push(await hashPassword(body.password)); }
      if (sets.length) await db.run(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...p, now(), id]);
      if (body.password || ('active' in body && !v.bool(body.active))) await db.run('UPDATE sessions SET revoked = 1 WHERE user_id = ?', [id]);
      if (Array.isArray(body.group_ids)) {
        await db.run('DELETE FROM group_members WHERE user_id = ?', [id]);
        for (const g of v.ids(body.group_ids, 'گروه')) await db.run('INSERT INTO group_members(group_id, user_id) VALUES (?,?) ON CONFLICT DO NOTHING', [g, id]);
      }
      await audit(db, { userId: user.id, action: 'student.update', entity: 'user', entityId: id, details: { fields: Object.keys(body).filter(k => k !== 'password'), password_reset: !!body.password }, ip });
    },
    async groups() { return db.all('SELECT g.*, (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS members FROM student_groups g ORDER BY name'); },
    async createGroup(body, user, ip) {
      const name = v.str(body.name, 'نام گروه', { min: 2, max: 100 });
      if (await db.get('SELECT id FROM student_groups WHERE name = ?', [name])) throw conflict('گروهی با این نام وجود دارد.');
      const id = await db.insert('INSERT INTO student_groups(name, description, created_at) VALUES (?,?,?)', [name, body.description || null, now()]);
      await audit(db, { userId: user.id, action: 'group.create', entity: 'group', entityId: id, ip });
      return id;
    },
    async updateGroup(id, body, user, ip) {
      if (!(await db.get('SELECT id FROM student_groups WHERE id = ?', [id]))) throw notFound();
      if ('name' in body) await db.run('UPDATE student_groups SET name = ? WHERE id = ?', [v.str(body.name, 'نام گروه', { min: 2, max: 100 }), id]);
      if ('description' in body) await db.run('UPDATE student_groups SET description = ? WHERE id = ?', [body.description || null, id]);
      if (Array.isArray(body.member_ids)) {
        await db.run('DELETE FROM group_members WHERE group_id = ?', [id]);
        for (const u of v.ids(body.member_ids, 'اعضا')) { if (!(await db.get("SELECT id FROM users WHERE id = ? AND role='student'", [u]))) throw bad('عضو نامعتبر'); await db.run('INSERT INTO group_members(group_id, user_id) VALUES (?,?)', [id, u]); }
      }
      await audit(db, { userId: user.id, action: 'group.update', entity: 'group', entityId: id, ip });
    },
    async deleteGroup(id, user, ip) { await db.run('DELETE FROM student_groups WHERE id = ?', [id]); await audit(db, { userId: user.id, action: 'group.delete', entity: 'group', entityId: id, ip }); },
  };
}
