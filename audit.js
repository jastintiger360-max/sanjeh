export async function audit(db, { userId = null, action, entity = null, entityId = null, details = null, ip = null }) {
  await db.run('INSERT INTO audit_logs(user_id, action, entity, entity_id, details, ip, created_at) VALUES (?,?,?,?,?,?,?)',
    [userId, action, entity, entityId == null ? null : String(entityId), details ? JSON.stringify(details) : null, ip, Date.now()]);
}
