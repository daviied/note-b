// Bundles the web clients into public/build. `--watch` rebuilds on change.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const options = {
  entryPoints: { pc: 'web/pc/main.js', tablet: 'web/tablet/main.js' },
  bundle: true,
  format: 'esm',
  outdir: 'public/build',
  minify: !watch,
  sourcemap: true,
  target: ['es2020', 'safari15'],
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
