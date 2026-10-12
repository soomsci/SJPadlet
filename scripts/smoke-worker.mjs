import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const binary = require('workerd').default;
const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const folder = mkdtempSync(join(tmpdir(), 'moa-worker-smoke-'));
let status = 1;
try {
  copyFileSync(new URL('../dist/worker/index.js', import.meta.url), join(folder, 'worker.mjs'));
  copyFileSync(new URL('../tests/runtime/worker-smoke.mjs', import.meta.url), join(folder, 'smoke.mjs'));
  writeFileSync(join(folder, 'config.capnp'), `
using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "smoke", worker = .smokeWorker)]
);
const smokeWorker :Workerd.Worker = (
  modules = [
    (name = "smoke.mjs", esModule = embed "smoke.mjs"),
    (name = "worker.mjs", esModule = embed "worker.mjs")
  ],
  compatibilityDate = ${JSON.stringify(config.compatibility_date)},
  compatibilityFlags = [${config.compatibility_flags.map(flag => JSON.stringify(flag)).join(', ')}]
);
`);
  // No sockets, real credentials, provider connections, or production data.
  const result = spawnSync(binary, ['test', join(folder, 'config.capnp')], { stdio: 'inherit' });
  status = result.status ?? 1;
} finally { rmSync(folder, { recursive: true, force: true }); }
process.exit(status);
