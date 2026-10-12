import { spawnSync } from 'node:child_process';
// Official instructions: https://developers.cloudflare.com/agent-setup/prompt.md
// Run in an environment allowed to write the user's Codex/skills configuration.
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
run('npx', ['-y', 'skills', 'add', 'cloudflare/skills', '--skill', '*', '--yes', '--global']);
run('codex', ['mcp', 'add', 'cloudflare', '--url', 'https://mcp.cloudflare.com/mcp']);
run('codex', ['mcp', 'login', 'cloudflare']);
console.log('Cloudflare skills and MCP configured. Restart Codex to load the MCP tools.');
