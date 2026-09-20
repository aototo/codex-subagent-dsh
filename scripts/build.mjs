import { builtinModules } from 'node:module';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { build } from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(repoRoot, 'plugins', 'codex-subagent-dsh', 'runtime');
const companionOutdir = path.join(repoRoot, 'plugins', 'codex-subagent-dsh', 'dsh-companion');
const externals = [...new Set(
  builtinModules.flatMap((name) => {
    const bareName = name.replace(/^node:/, '');
    return [bareName, `node:${bareName}`];
  }),
)];

await mkdir(outdir, { recursive: true });
await mkdir(companionOutdir, { recursive: true });

const result = await build({
  absWorkingDir: repoRoot,
  entryPoints: {
    server: 'src/mcp-server.ts',
    connect: 'src/connect.ts',
  },
  outdir,
  outExtension: { '.js': '.mjs' },
  entryNames: '[name]',
  bundle: true,
  packages: 'bundle',
  platform: 'node',
  format: 'esm',
  target: ['node22.13'],
  external: externals,
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  legalComments: 'eof',
  sourcemap: false,
  metafile: true,
  logLevel: 'info',
});

await build({
  absWorkingDir: repoRoot,
  entryPoints: { index: 'src/dsh-companion.ts' },
  outdir: companionOutdir,
  outExtension: { '.js': '.mjs' },
  entryNames: '[name]',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node22.13'],
  external: ['@deepseek-ai/*', ...externals],
  legalComments: 'eof',
  sourcemap: false,
  logLevel: 'info',
});

// Ship dependency license texts with the self-contained distribution.
const packageRoots = new Set(Object.keys(result.metafile.inputs).flatMap((input) => {
  const match = input.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/);
  return match ? [match[1]] : [];
}));
const notices = ['# Third-party notices', '', 'Generated from dependencies included in runtime/server.mjs and runtime/connect.mjs.', ''];
for (const packageName of [...packageRoots].sort()) {
  const directory = path.join(repoRoot, 'node_modules', packageName);
  const info = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const files = (await readdir(directory)).filter(name => /^(license|licence|copying|notice)([.-]|$)/i.test(name));
  if (!files.length) throw new Error(`Missing license text for bundled dependency ${packageName}`);
  notices.push(`## ${info.name}@${info.version}`, '', `License: ${info.license ?? 'See text below'}`, '');
  for (const name of files.sort()) notices.push(`### ${name}`, '', await readFile(path.join(directory, name), 'utf8'), '');
}
await writeFile(path.join(outdir, 'THIRD_PARTY_NOTICES.md'), notices.join('\n'));
