import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root: root + 'apps/free-web',
  plugins: [react()],
  resolve: { alias: {
    '@contracts': root + 'packages/contracts/index.ts',
    '@features': root + 'apps/web/src/features',
    '@ui': root + 'packages/ui/index.tsx',
  } },
  build: { outDir: root + 'dist/web', emptyOutDir: true },
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:8787' } },
});
