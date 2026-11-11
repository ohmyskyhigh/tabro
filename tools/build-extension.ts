import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const outdir = 'dist/browser-extension';
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: {
    'service-worker': 'apps/browser-extension/src/service-worker.ts',
    options: 'apps/browser-extension/src/options.ts'
  },
  outdir,
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  sourcemap: true,
  minify: false,
  logLevel: 'info'
});

cpSync('apps/browser-extension/manifest.json', `${outdir}/manifest.json`);
cpSync('apps/browser-extension/options.html', `${outdir}/options.html`);
cpSync('apps/browser-extension/options.css', `${outdir}/options.css`);
