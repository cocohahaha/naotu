// 把 CLI 和 MCP server 打成两个独立的 .mjs（依赖全部打进去，不依赖 node_modules）
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

await build({
  entryPoints: { naotu: 'cli/naotu.ts', mcp: 'cli/mcp.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir: 'dist-cli',
  outExtension: { '.js': '.mjs' },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'warning',
});

for (const f of ['dist-cli/naotu.mjs', 'dist-cli/mcp.mjs']) chmodSync(f, 0o755);
console.log('built dist-cli/naotu.mjs, dist-cli/mcp.mjs');
