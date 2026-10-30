import { loadConfig } from './config.js';
import { createApp } from './app.js';

const cfg = loadConfig();
const app = await createApp(cfg);
app.server.listen(cfg.port, cfg.host, () => {
  console.log(`[sanjeh] در حال اجرا روی http://${cfg.host}:${cfg.port}  | پایگاه داده: ${cfg.db.driver} | هوش مصنوعی: ${app.ctx.ai.enabled() ? 'فعال' : 'غیرفعال (کلید تنظیم نشده)'}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { console.log('[sanjeh] در حال توقف…'); await app.close(); process.exit(0); });
