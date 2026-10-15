// Self-hosted daily job (the Cloudflare Worker runs the same work from its Cron trigger).
import { runMaintenance } from '../packages/server/operations';

await runMaintenance();
console.log(JSON.stringify({ code: 'MAINTENANCE_DONE', at: new Date().toISOString() }));
process.exit(0);
