import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { build } from 'esbuild';

// A source archive has no .git directory: its documented build must supply
// the immutable revision explicitly. Never point a modified bundle upstream.
let revision = process.env.SETTLEMAKER_SOURCE_REVISION;
if (revision === undefined) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  if (realpathSync(root) !== realpathSync(process.cwd()))
    throw new Error('Source archive builds require SETTLEMAKER_SOURCE_REVISION');
  revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}
if (!/^[0-9a-f]{40}$/.test(revision))
  throw new Error('SETTLEMAKER_SOURCE_REVISION must be a full Git commit');

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  outfile: 'dist/settlemaker.browser.js',
  banner: {
    js: `/* settlemaker — GPL-3.0-only. Corresponding source: https://github.com/dfezzie/settlemaker/tree/${revision} */`,
  },
});
