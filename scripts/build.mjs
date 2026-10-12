import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const prod = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/renderer', { recursive: true });

const common = { bundle: true, sourcemap: !prod, minify: prod, logLevel: 'info', target: 'es2023' };

const builds = [
  { ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js', platform: 'node', format: 'cjs', external: ['electron'] },
  { ...common, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.js', platform: 'node', format: 'cjs', external: ['electron'] },
  { ...common, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js', platform: 'browser', format: 'iife' },
];

const copyStatic = () => {
  cpSync('src/renderer/index.html', 'dist/renderer/index.html');
  cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');
};

copyStatic();
if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
