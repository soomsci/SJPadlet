import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({resolve:{alias:{'@contracts':root+'packages/contracts/index.ts','@db':root+'packages/db/index.ts','@server':root+'packages/server','@features':root+'apps/web/src/features','@ui':root+'packages/ui/index.tsx'}},test:{include:['tests/**/*.test.{ts,tsx}'],fileParallelism:false,env:{NODE_ENV:'test',DATABASE_PATH:'memory://',APP_URL:'http://localhost:3000'}}});
